import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { forbidden, unauthorized } from '../errors.js';
import { requestOrigin, requireAuth } from '../http/security.js';
import { type McpTokenAuth, resolveMcpToken } from './oauth.js';
import { boardTools, executeBoardTool } from './tools.js';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST_PROTOCOL = PROTOCOL_VERSIONS[0] ?? '2025-06-18';

type RpcId = string | number | null;

type RpcRequest = {
  jsonrpc?: string;
  id?: RpcId;
  method?: string;
  params?: Record<string, unknown>;
};

function originOf(req: FastifyRequest): string {
  return requestOrigin(req) ?? `http://${req.headers.host ?? 'localhost'}`;
}

function rpcResult(reply: FastifyReply, id: RpcId, result: unknown): FastifyReply {
  return reply
    .header('Cache-Control', 'no-store')
    .type('application/json; charset=utf-8')
    .send(JSON.stringify({ jsonrpc: '2.0', id, result }));
}

function rpcError(reply: FastifyReply, status: number, id: RpcId, code: number, message: string): FastifyReply {
  return reply
    .code(status)
    .header('Cache-Control', 'no-store')
    .type('application/json; charset=utf-8')
    .send(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
}

function bearerFrom(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(value.trim());
  return match?.[1] ?? null;
}

function authenticate(ctx: AppContext, req: FastifyRequest): McpTokenAuth | null {
  const token = bearerFrom(req);
  if (!token) return null;
  return resolveMcpToken(ctx.db, token);
}

function parseArgs(params: Record<string, unknown> | undefined): Record<string, unknown> {
  const value = params?.arguments;
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function registerMcpRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/mcp', async (req, reply) => {
    const auth = authenticate(ctx, req);
    if (!auth) {
      const resource = `${originOf(req)}/.well-known/oauth-protected-resource`;
      return reply
        .code(401)
        .header('WWW-Authenticate', `Bearer error="invalid_token", resource_metadata="${resource}"`)
        .header('Cache-Control', 'no-store')
        .type('application/json; charset=utf-8')
        .send(
          JSON.stringify({
            error: 'unauthorized',
            message: 'Token MCP mancante o scaduto. Autorizza l’app da Impostazioni → IA e MCP.',
          }),
        );
    }
    if (!auth.scope.split(/\s+/).includes('board')) {
      return rpcError(reply, 403, null, -32003, 'Il token non ha il permesso bacheca');
    }
    const message = req.body as RpcRequest | null;
    if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.method !== 'string') {
      return rpcError(reply, 400, null, -32600, 'Richiesta JSON-RPC non valida');
    }
    const isNotification = !Object.hasOwn(message, 'id');
    const id = message.id ?? null;
    if (isNotification) {
      // notifications/initialized and notifications/cancelled need no result.
      return reply.code(202).header('Cache-Control', 'no-store').send();
    }
    const params = message.params && typeof message.params === 'object' ? message.params : {};
    switch (message.method) {
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        return rpcResult(reply, id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'nimbus-board', title: 'Nimbus Bacheca', version: ctx.config.appVersion },
          instructions:
            'Strumenti per la bacheca Kanban di Nimbus: leggi progetti, colonne, schede, attività e commenti e gestiscili per conto dell’utente autenticato. Usa board_list_projects o board_get per scoprire ID e stato, poi crea, aggiorna o sposta schede. Le azioni sono limitate ai progetti accessibili dall’utente; le eliminazioni sono definitive.',
        });
      }
      case 'ping':
        return rpcResult(reply, id, {});
      case 'tools/list':
        return rpcResult(reply, id, {
          tools: boardTools.map(({ run: _run, ...tool }) => tool),
        });
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        if (!name) return rpcError(reply, 400, id, -32602, 'Nome dello strumento mancante');
        try {
          const output = executeBoardTool(ctx, auth.user, name, parseArgs(params));
          return rpcResult(reply, id, {
            content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
            structuredContent: output,
            isError: false,
          });
        } catch (error) {
          const text = error instanceof Error ? error.message : 'Errore durante l’esecuzione';
          ctx.logger.warn('mcp tool failed', { tool: name, user: auth.user.id, error: text });
          return rpcResult(reply, id, {
            content: [{ type: 'text', text }],
            isError: true,
          });
        }
      }
      case 'resources/list':
        return rpcResult(reply, id, { resources: [] });
      case 'prompts/list':
        return rpcResult(reply, id, { prompts: [] });
      default:
        return rpcError(reply, 200, id, -32601, `Metodo non supportato: ${message.method}`);
    }
  });

  app.get('/mcp', async (_req, reply) =>
    reply.code(405).header('Allow', 'POST').header('Cache-Control', 'no-store').send(),
  );
  app.delete('/mcp', async (_req, reply) =>
    reply.code(405).header('Allow', 'POST').header('Cache-Control', 'no-store').send(),
  );

  app.get('/api/mcp/clients', async (req) => {
    const { user } = requireAuth(req);
    const now = Date.now();
    const rows = ctx.db
      .prepare(
        `SELECT c.id, c.name, c.created_at, c.last_used_at,
                (SELECT MAX(t.created_at) FROM mcp_tokens t
                  WHERE t.client_id = c.id AND t.user_id = ? AND t.revoked_at IS NULL) AS connected_at
         FROM mcp_clients c
         WHERE EXISTS (
           SELECT 1 FROM mcp_tokens t
           WHERE t.client_id = c.id AND t.user_id = ? AND t.revoked_at IS NULL AND t.expires_at > ?
         )
         ORDER BY connected_at DESC`,
      )
      .all(user.id, user.id, now) as Array<{
      id: string;
      name: string;
      created_at: number;
      last_used_at: number | null;
      connected_at: number | null;
    }>;
    return {
      clients: rows.map((row) => ({
        id: row.id,
        name: row.name,
        connectedAt: row.connected_at === null ? null : Number(row.connected_at),
        lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
      })),
    };
  });

  app.delete('/api/mcp/clients/:clientId', async (req) => {
    const { user } = requireAuth(req);
    const clientId = (req.params as { clientId?: string }).clientId ?? '';
    if (!clientId || clientId.length > 100) throw unauthorized('Client non valido');
    const client = ctx.db.prepare('SELECT id FROM mcp_clients WHERE id = ?').get(clientId) as
      | { id: string }
      | undefined;
    if (!client) return { ok: true };
    ctx.db
      .prepare('UPDATE mcp_tokens SET revoked_at = ? WHERE client_id = ? AND user_id = ? AND revoked_at IS NULL')
      .run(Date.now(), clientId, user.id);
    ctx.db.prepare('DELETE FROM mcp_auth_codes WHERE client_id = ? AND user_id = ?').run(clientId, user.id);
    return { ok: true };
  });

  app.post('/api/mcp/revoke-all', async (req) => {
    const { user } = requireAuth(req);
    const now = Date.now();
    ctx.db.prepare('UPDATE mcp_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, user.id);
    ctx.db.prepare('DELETE FROM mcp_auth_codes WHERE user_id = ?').run(user.id);
    return { ok: true };
  });

  app.get('/api/mcp/info', async (req) => {
    const { user } = requireAuth(req);
    if (user.disabled !== 0) throw forbidden('Account disabilitato');
    return {
      endpoint: `${originOf(req)}/mcp`,
      authorizationServer: originOf(req),
      scopes: ['board'],
      tools: boardTools.map((tool) => ({ name: tool.name, title: tool.title })),
    };
  });
}
