import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { constantTimeEqual, randomToken, sha256Hex } from '../crypto.js';
import type { Db } from '../db.js';
import { badRequest, forbidden } from '../errors.js';
import { enforceRate, parseBody } from '../http/helpers.js';
import { requestOrigin, requireAuth } from '../http/security.js';
import { escapeHtml, newId, nowMs, sanitizePlainText } from '../util.js';

const SCOPES = ['board'];
const DEFAULT_SCOPE = 'board';
const ACCESS_TTL_MS = 60 * 60_000;
const REFRESH_TTL_MS = 90 * 24 * 60 * 60_000;
const CODE_TTL_MS = 5 * 60_000;
const MAX_CLIENTS = 200;

type ClientRow = {
  id: string;
  name: string;
  redirect_uris: string;
  created_at: number;
  last_used_at: number | null;
};

export interface McpUser {
  id: string;
  username: string;
  display_name: string;
}

export interface McpTokenAuth {
  user: McpUser;
  clientId: string;
  scope: string;
}

const registrationSchema = z.object({
  client_name: z.string().trim().min(1).max(100).optional(),
  redirect_uris: z.array(z.string().min(8).max(2000)).min(1).max(10),
});

function originOf(req: FastifyRequest): string {
  return requestOrigin(req) ?? `http://${req.headers.host ?? 'localhost'}`;
}

function sendJson(reply: FastifyReply, status: number, value: unknown): FastifyReply {
  return reply
    .code(status)
    .header('Cache-Control', 'no-store')
    .header('Pragma', 'no-cache')
    .type('application/json; charset=utf-8')
    .send(JSON.stringify(value));
}

function oauthError(reply: FastifyReply, status: number, error: string, description: string): FastifyReply {
  return sendJson(reply, status, { error, error_description: description });
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

export function isAllowedRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

function clientById(db: Db, clientId: string): ClientRow | null {
  return (db.prepare('SELECT * FROM mcp_clients WHERE id = ?').get(clientId) as ClientRow | undefined) ?? null;
}

function clientRedirects(client: ClientRow): string[] {
  try {
    const parsed = JSON.parse(client.redirect_uris) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function bodyValue(body: unknown, key: string): string {
  if (!body || typeof body !== 'object') return '';
  const raw = (body as Record<string, unknown>)[key];
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number') return String(raw);
  return '';
}

function normalizeScope(value: string): string | null {
  if (!value) return DEFAULT_SCOPE;
  const requested = value
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (requested.length === 0) return DEFAULT_SCOPE;
  if (requested.some((entry) => !SCOPES.includes(entry))) return null;
  return [...new Set(requested)].join(' ');
}

function issueTokens(
  ctx: AppContext,
  clientId: string,
  userId: string,
  scope: string,
): { access_token: string; token_type: 'Bearer'; expires_in: number; refresh_token: string; scope: string } {
  const access = randomToken(32);
  const refresh = randomToken(48);
  const now = nowMs();
  ctx.db
    .prepare(
      `INSERT INTO mcp_tokens (id, token_hash, kind, client_id, user_id, scope, created_at, expires_at)
       VALUES (?, ?, 'access', ?, ?, ?, ?, ?)`,
    )
    .run(newId(), sha256Hex(access), clientId, userId, scope, now, now + ACCESS_TTL_MS);
  ctx.db
    .prepare(
      `INSERT INTO mcp_tokens (id, token_hash, kind, client_id, user_id, scope, created_at, expires_at)
       VALUES (?, ?, 'refresh', ?, ?, ?, ?, ?)`,
    )
    .run(newId(), sha256Hex(refresh), clientId, userId, scope, now, now + REFRESH_TTL_MS);
  ctx.db.prepare('UPDATE mcp_clients SET last_used_at = ? WHERE id = ?').run(now, clientId);
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: Math.floor(ACCESS_TTL_MS / 1000),
    refresh_token: refresh,
    scope,
  };
}

export function resolveMcpToken(db: Db, token: string): McpTokenAuth | null {
  if (token.length < 20 || token.length > 200) return null;
  const row = db
    .prepare(
      `SELECT t.client_id, t.scope, t.expires_at, t.revoked_at,
              u.id AS user_id, u.username, u.display_name, u.disabled
       FROM mcp_tokens t JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = ? AND t.kind = 'access'`,
    )
    .get(sha256Hex(token)) as Record<string, unknown> | undefined;
  if (!row) return null;
  if (row.revoked_at !== null || Number(row.expires_at) <= nowMs() || Number(row.disabled) !== 0) return null;
  db.prepare('UPDATE mcp_clients SET last_used_at = ? WHERE id = ?').run(nowMs(), String(row.client_id));
  return {
    user: { id: String(row.user_id), username: String(row.username), display_name: String(row.display_name) },
    clientId: String(row.client_id),
    scope: String(row.scope),
  };
}

type AuthorizeParams = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scope: string;
};

function readAuthorizeParams(source: unknown): AuthorizeParams {
  const responseType = bodyValue(source, 'response_type');
  if (responseType !== 'code') throw badRequest('response_type non supportato');
  const clientId = bodyValue(source, 'client_id');
  const redirectUri = bodyValue(source, 'redirect_uri');
  const codeChallenge = bodyValue(source, 'code_challenge');
  const codeChallengeMethod = bodyValue(source, 'code_challenge_method');
  if (!clientId || !redirectUri) throw badRequest('client_id e redirect_uri sono obbligatori');
  if (codeChallengeMethod !== 'S256') throw badRequest('PKCE S256 è obbligatorio');
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) throw badRequest('code_challenge non valido');
  const scope = normalizeScope(bodyValue(source, 'scope'));
  if (!scope) throw badRequest('scope non supportato');
  return {
    clientId,
    redirectUri,
    codeChallenge,
    state: bodyValue(source, 'state').slice(0, 500),
    scope,
  };
}

function validateClientRequest(db: Db, params: AuthorizeParams): { client: ClientRow; params: AuthorizeParams } {
  const client = clientById(db, params.clientId);
  if (!client) throw badRequest('Client OAuth sconosciuto');
  if (!clientRedirects(client).includes(params.redirectUri))
    throw badRequest('redirect_uri non registrata per il client');
  return { client, params };
}

function page(title: string, nonce: string, body: string): string {
  return `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style nonce="${escapeHtml(nonce)}">
:root{color-scheme:dark light;--bg:#0b0716;--panel:#151021;--line:#2b2240;--text:#f4f1fb;--muted:#a79fbd;--accent:#8f6cf5;--accent-strong:#7a54ec}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(1200px 600px at 20% 0%,#2a1b4d 0%,transparent 60%),var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.card{width:100%;max-width:440px;background:var(--panel);border:1px solid var(--line);border-radius:20px;padding:28px;box-shadow:0 30px 80px rgba(0,0,0,.45)}
.head{display:flex;gap:12px;align-items:center;margin-bottom:22px}.mark{width:38px;height:38px;border-radius:12px;background:linear-gradient(135deg,#a78bfa,#6d3ff2);display:grid;place-items:center;font-weight:700;font-size:18px}
.muted{color:var(--muted);font-size:13px}h1{font-size:21px;margin:0 0 10px;letter-spacing:-.01em}p{margin:0 0 14px}
ul{margin:0 0 20px;padding-left:18px;color:var(--muted);font-size:13px}li{margin-bottom:4px}
.account{display:flex;align-items:center;gap:10px;padding:12px 14px;border:1px solid var(--line);border-radius:14px;background:rgba(255,255,255,.03);margin-bottom:18px;font-size:14px}
.dot{width:8px;height:8px;border-radius:50%;background:#4ade80}
form{display:flex;gap:10px;margin-top:6px}button{flex:1;border-radius:12px;border:1px solid var(--line);padding:12px 14px;font:inherit;font-weight:600;cursor:pointer;background:transparent;color:var(--text)}
button.primary{background:linear-gradient(135deg,var(--accent),var(--accent-strong));border-color:transparent}
button.secondary{color:var(--muted)}
.foot{margin:18px 0 0;font-size:12px;color:var(--muted);text-align:center}
.error{border:1px solid #5b2333;background:#2a1119;color:#ffb4c4;border-radius:12px;padding:12px 14px;font-size:13px;margin-bottom:16px}
</style></head><body><main class="card">${body}</main></body></html>`;
}

function head(subtitle: string): string {
  return `<div class="head"><span class="mark">N</span><div><strong>Nimbus</strong><div class="muted">${escapeHtml(subtitle)}</div></div></div>`;
}

function authorizePage(
  nonce: string,
  client: ClientRow,
  params: AuthorizeParams,
  user: { username: string; display_name: string },
): string {
  const hidden = [
    ['response_type', 'code'],
    ['client_id', params.clientId],
    ['redirect_uri', params.redirectUri],
    ['code_challenge', params.codeChallenge],
    ['code_challenge_method', 'S256'],
    ['state', params.state],
    ['scope', params.scope],
  ]
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name ?? '')}" value="${escapeHtml(value ?? '')}">`)
    .join('');
  return page(
    'Autorizza accesso · Nimbus',
    nonce,
    `${head('Richiesta di accesso MCP')}
<h1>Autorizzare «${escapeHtml(client.name)}»?</h1>
<p class="muted">Questa app potrà leggere e modificare la bacheca di Nimbus per tuo conto. Le azioni restano limitate ai progetti a cui hai accesso.</p>
<div class="account"><span class="dot"></span><div><strong>${escapeHtml(user.display_name)}</strong><div class="muted">@${escapeHtml(user.username)}</div></div></div>
<ul><li>Leggere bacheche, schede, attività e commenti</li><li>Creare e modificare schede, colonne ed etichette</li><li>Aggiungere commenti e assegnare membri</li></ul>
<form method="post" action="/oauth/authorize/decision">${hidden}
<button class="primary" name="decision" value="allow" type="submit">Autorizza</button>
<button class="secondary" name="decision" value="deny" type="submit">Annulla</button>
</form>
<p class="foot">Potrai revocare l'accesso da Impostazioni → IA e MCP.</p>`,
  );
}

function errorPage(nonce: string, message: string): string {
  return page(
    'Accesso non autorizzato · Nimbus',
    nonce,
    `${head('Accesso MCP')}<h1>Impossibile autorizzare</h1><div class="error">${escapeHtml(message)}</div><p class="foot">Torna al client e riprova.</p>`,
  );
}

export function registerMcpAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  const metadata = (req: FastifyRequest): Record<string, unknown> => {
    const origin = originOf(req);
    return {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      revocation_endpoint: `${origin}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: SCOPES,
      service_documentation: `${origin}/settings`,
      ui_locales_supported: ['it', 'en'],
    };
  };

  const protectedResource = (req: FastifyRequest): Record<string, unknown> => {
    const origin = originOf(req);
    return {
      resource: `${origin}/mcp`,
      resource_name: 'Nimbus Bacheca',
      authorization_servers: [origin],
      scopes_supported: SCOPES,
      bearer_methods_supported: ['header'],
      resource_documentation: `${origin}/settings`,
    };
  };

  app.get('/.well-known/oauth-authorization-server', async (req, reply) => sendJson(reply, 200, metadata(req)));
  app.get('/.well-known/oauth-authorization-server/mcp', async (req, reply) => sendJson(reply, 200, metadata(req)));
  app.get('/.well-known/oauth-protected-resource', async (req, reply) => sendJson(reply, 200, protectedResource(req)));
  app.get('/.well-known/oauth-protected-resource/mcp', async (req, reply) =>
    sendJson(reply, 200, protectedResource(req)),
  );

  app.post('/oauth/register', async (req, reply) => {
    enforceRate(ctx.limiter, `mcp-register:${req.ip}`, 20, 60 * 60_000);
    const body = parseBody(registrationSchema, req.body);
    const redirectUris = [...new Set(body.redirect_uris)];
    if (redirectUris.some((uri) => !isAllowedRedirectUri(uri))) {
      return oauthError(
        reply,
        400,
        'invalid_redirect_uri',
        'Le redirect URI devono usare HTTPS (o HTTP solo su localhost)',
      );
    }
    const count = db.prepare('SELECT COUNT(*) AS n FROM mcp_clients').get() as { n: number };
    if (Number(count.n) >= MAX_CLIENTS) {
      return oauthError(reply, 429, 'temporarily_unavailable', 'Troppi client registrati su questa istanza');
    }
    const id = randomToken(24);
    const now = nowMs();
    const name = body.client_name ? sanitizePlainText(body.client_name, 100) : 'App MCP';
    db.prepare('INSERT INTO mcp_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)').run(
      id,
      name,
      JSON.stringify(redirectUris),
      now,
    );
    return sendJson(reply, 201, {
      client_id: id,
      client_id_issued_at: Math.floor(now / 1000),
      client_name: name,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: DEFAULT_SCOPE,
    });
  });

  app.get('/oauth/authorize', async (req, reply) => {
    let params: AuthorizeParams;
    let client: ClientRow;
    try {
      params = readAuthorizeParams(req.query);
      ({ client } = validateClientRequest(db, params));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Richiesta non valida';
      return reply
        .code(400)
        .header('Cache-Control', 'no-store')
        .type('text/html; charset=utf-8')
        .send(errorPage(req.cspNonce, message));
    }
    if (!req.auth) {
      const next = req.url.startsWith('/oauth/authorize') ? req.url : '/';
      return reply
        .code(302)
        .header('Location', `/login?next=${encodeURIComponent(next)}`)
        .header('Cache-Control', 'no-store')
        .send();
    }
    if (req.auth.user.disabled !== 0) {
      return reply
        .code(403)
        .header('Cache-Control', 'no-store')
        .type('text/html; charset=utf-8')
        .send(errorPage(req.cspNonce, 'Account disabilitato'));
    }
    db.prepare('DELETE FROM mcp_auth_codes WHERE expires_at < ?').run(nowMs() - 24 * 60 * 60_000);
    return reply
      .header('Cache-Control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(
        authorizePage(req.cspNonce, client, params, {
          username: req.auth.user.username,
          display_name: req.auth.user.display_name,
        }),
      );
  });

  app.post('/oauth/authorize/decision', async (req, reply) => {
    const auth = requireAuth(req);
    let params: AuthorizeParams;
    let client: ClientRow;
    try {
      params = readAuthorizeParams(req.body);
      ({ client } = validateClientRequest(db, params));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Richiesta non valida';
      return reply
        .code(400)
        .header('Cache-Control', 'no-store')
        .type('text/html; charset=utf-8')
        .send(errorPage(req.cspNonce, message));
    }
    if (auth.user.disabled !== 0) throw forbidden('Account disabilitato');
    const target = new URL(params.redirectUri);
    if (bodyValue(req.body, 'decision') !== 'allow') {
      target.searchParams.set('error', 'access_denied');
      target.searchParams.set('error_description', 'Accesso negato dall’utente');
      if (params.state) target.searchParams.set('state', params.state);
      return reply.code(303).header('Location', target.toString()).header('Cache-Control', 'no-store').send();
    }
    const code = randomToken(32);
    const now = nowMs();
    db.prepare(
      `INSERT INTO mcp_auth_codes (id, code_hash, client_id, user_id, redirect_uri, code_challenge, scope, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId(),
      sha256Hex(code),
      client.id,
      auth.user.id,
      params.redirectUri,
      params.codeChallenge,
      params.scope,
      now,
      now + CODE_TTL_MS,
    );
    db.prepare('UPDATE mcp_clients SET last_used_at = ? WHERE id = ?').run(now, client.id);
    target.searchParams.set('code', code);
    if (params.state) target.searchParams.set('state', params.state);
    return reply.code(303).header('Location', target.toString()).header('Cache-Control', 'no-store').send();
  });

  app.post('/oauth/token', async (req, reply) => {
    enforceRate(ctx.limiter, `mcp-token:${req.ip}`, 120, 60 * 60_000);
    reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache');
    const grantType = bodyValue(req.body, 'grant_type');
    const clientId = bodyValue(req.body, 'client_id');
    if (!clientId) return oauthError(reply, 400, 'invalid_request', 'client_id obbligatorio');
    const client = clientById(db, clientId);
    if (!client) return oauthError(reply, 400, 'invalid_client', 'Client sconosciuto');

    if (grantType === 'authorization_code') {
      const code = bodyValue(req.body, 'code');
      const redirectUri = bodyValue(req.body, 'redirect_uri');
      const verifier = bodyValue(req.body, 'code_verifier');
      if (!code || !verifier) {
        return oauthError(reply, 400, 'invalid_request', 'code e code_verifier sono obbligatori');
      }
      if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) {
        return oauthError(reply, 400, 'invalid_grant', 'code_verifier non valido');
      }
      const row = db
        .prepare(
          `SELECT id, client_id, user_id, redirect_uri, code_challenge, scope, expires_at, used_at
           FROM mcp_auth_codes WHERE code_hash = ?`,
        )
        .get(sha256Hex(code)) as
        | {
            id: string;
            client_id: string;
            user_id: string;
            redirect_uri: string;
            code_challenge: string;
            scope: string;
            expires_at: number;
            used_at: number | null;
          }
        | undefined;
      if (!row || row.client_id !== client.id || row.used_at !== null || Number(row.expires_at) <= nowMs()) {
        return oauthError(reply, 400, 'invalid_grant', 'Codice di autorizzazione non valido o scaduto');
      }
      if (row.redirect_uri !== redirectUri) {
        return oauthError(reply, 400, 'invalid_grant', 'redirect_uri non corrispondente');
      }
      const expected = createHash('sha256').update(verifier).digest('base64url');
      if (!constantTimeEqual(expected, row.code_challenge)) {
        return oauthError(reply, 400, 'invalid_grant', 'Verifica PKCE non superata');
      }
      const user = db.prepare('SELECT disabled FROM users WHERE id = ?').get(row.user_id) as
        | { disabled: number }
        | undefined;
      if (!user || Number(user.disabled) !== 0) {
        return oauthError(reply, 400, 'invalid_grant', 'Account non disponibile');
      }
      db.prepare('UPDATE mcp_auth_codes SET used_at = ? WHERE id = ?').run(nowMs(), row.id);
      return sendJson(reply, 200, issueTokens(ctx, client.id, row.user_id, row.scope));
    }

    if (grantType === 'refresh_token') {
      const refreshToken = bodyValue(req.body, 'refresh_token');
      if (!refreshToken) return oauthError(reply, 400, 'invalid_request', 'refresh_token obbligatorio');
      const row = db
        .prepare(
          `SELECT id, client_id, user_id, scope, expires_at, revoked_at
           FROM mcp_tokens WHERE token_hash = ? AND kind = 'refresh'`,
        )
        .get(sha256Hex(refreshToken)) as
        | {
            id: string;
            client_id: string;
            user_id: string;
            scope: string;
            expires_at: number;
            revoked_at: number | null;
          }
        | undefined;
      if (!row || row.client_id !== client.id || row.revoked_at !== null || Number(row.expires_at) <= nowMs()) {
        return oauthError(reply, 400, 'invalid_grant', 'Refresh token non valido o scaduto');
      }
      const user = db.prepare('SELECT disabled FROM users WHERE id = ?').get(row.user_id) as
        | { disabled: number }
        | undefined;
      if (!user || Number(user.disabled) !== 0) {
        return oauthError(reply, 400, 'invalid_grant', 'Account non disponibile');
      }
      db.prepare('UPDATE mcp_tokens SET revoked_at = ? WHERE id = ?').run(nowMs(), row.id);
      return sendJson(reply, 200, issueTokens(ctx, client.id, row.user_id, row.scope));
    }

    return oauthError(reply, 400, 'unsupported_grant_type', 'grant_type non supportato');
  });

  app.post('/oauth/revoke', async (req, reply) => {
    const token = bodyValue(req.body, 'token');
    const clientId = bodyValue(req.body, 'client_id');
    if (token) {
      const row = db.prepare('SELECT id, client_id FROM mcp_tokens WHERE token_hash = ?').get(sha256Hex(token)) as
        | { id: string; client_id: string }
        | undefined;
      if (row && (!clientId || row.client_id === clientId)) {
        db.prepare('UPDATE mcp_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(nowMs(), row.id);
      }
    }
    return reply.code(200).header('Cache-Control', 'no-store').send();
  });
}
