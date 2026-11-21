import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { Client, createRuntime, createUser, makeAdmin, type TestRuntime } from './helpers.js';

interface RpcToolResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

async function rpc(
  base: string,
  token: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function callTool(
  base: string,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = await rpc(base, token, 'tools/call', { name, arguments: args });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const result = response.body.result as RpcToolResult;
  assert.equal(result.isError, false, result.content?.[0]?.text);
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe('MCP board server with OAuth', () => {
  let context: TestRuntime;
  let admin: Client;
  let redirectUri: string;
  let verifier: string;
  let clientId: string;
  let accessToken: string;
  let refreshToken: string;
  let cardId: string;
  let columnId: string;
  let projectId: string;

  async function authorizeCode(session: Client = admin): Promise<string> {
    const challenge = challengeFor(verifier);
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'state-123',
      scope: 'board',
    });
    const page = await session.request(`/oauth/authorize?${query.toString()}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /Autorizzare/);
    const decision = await session.request('/oauth/authorize/decision', {
      method: 'POST',
      raw: Buffer.from(
        new URLSearchParams({
          response_type: 'code',
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state: 'state-123',
          scope: 'board',
          decision: 'allow',
        }).toString(),
      ),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(decision.status, 303, decision.text);
    const location = new URL(decision.headers.get('location') ?? '');
    assert.equal(location.origin + location.pathname, redirectUri);
    assert.equal(location.searchParams.get('state'), 'state-123');
    const code = location.searchParams.get('code');
    assert.ok(code);
    return code;
  }

  before(async () => {
    context = await createRuntime();
    admin = await makeAdmin(context.base);
    verifier = 'v'.repeat(48);
    redirectUri = `${context.base}/callback`;
    const registration = await admin.request<{
      client_id?: string;
      redirect_uris?: string[];
      token_endpoint_auth_method?: string;
    }>('/oauth/register', {
      method: 'POST',
      body: { client_name: 'Claude Test', redirect_uris: [redirectUri] },
      csrf: false,
    });
    assert.equal(registration.status, 201, registration.text);
    assert.ok(registration.body.client_id);
    assert.equal(registration.body.token_endpoint_auth_method, 'none');
    clientId = registration.body.client_id;

    const code = await authorizeCode();
    const token = await admin.request<{
      access_token?: string;
      refresh_token?: string;
      token_type?: string;
      scope?: string;
      error?: string;
    }>('/oauth/token', {
      method: 'POST',
      body: {
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      },
      csrf: false,
    });
    assert.equal(token.status, 200, token.text);
    assert.equal(token.body.token_type, 'Bearer');
    assert.equal(token.body.scope, 'board');
    accessToken = token.body.access_token ?? '';
    refreshToken = token.body.refresh_token ?? '';
    assert.ok(accessToken);
    assert.ok(refreshToken);
  });

  after(async () => {
    await context.close();
  });

  it('advertises OAuth discovery and challenges unauthenticated MCP calls', async () => {
    const metadata = await admin.request<Record<string, unknown>>('/.well-known/oauth-authorization-server');
    assert.equal(metadata.status, 200);
    assert.equal(metadata.body.issuer, context.base);
    assert.equal(metadata.body.registration_endpoint, `${context.base}/oauth/register`);
    assert.deepEqual(metadata.body.code_challenge_methods_supported, ['S256']);

    const resource = await admin.request<Record<string, unknown>>('/.well-known/oauth-protected-resource');
    assert.equal(resource.status, 200);
    assert.equal(resource.body.resource, `${context.base}/mcp`);

    const unauthorized = await fetch(`${context.base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    assert.equal(unauthorized.status, 401);
    assert.match(unauthorized.headers.get('www-authenticate') ?? '', /resource_metadata=/);

    const loginPage = await new Client(context.base).request(
      `/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challengeFor(verifier)}&code_challenge_method=S256`,
    );
    assert.equal(loginPage.status, 302);
    assert.match(loginPage.headers.get('location') ?? '', /^\/login\?next=/);
  });

  it('initializes the session, lists the board tools and exposes the board', async () => {
    const initialized = await rpc(context.base, accessToken, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    });
    assert.equal(initialized.status, 200);
    const initResult = initialized.body.result as Record<string, unknown>;
    assert.equal(initResult.protocolVersion, '2025-06-18');

    const listed = await rpc(context.base, accessToken, 'tools/list');
    const tools = (listed.body.result as { tools: Array<{ name: string }> }).tools;
    assert.ok(tools.some((tool) => tool.name === 'board_get'));
    assert.ok(tools.some((tool) => tool.name === 'board_create_card'));
    assert.ok(tools.some((tool) => tool.name === 'board_update_card'));

    const board = await callTool(context.base, accessToken, 'board_get');
    const project = board.project as { id: string; name: string };
    const columns = board.columns as Array<{ id: string; cards: unknown[] }>;
    assert.ok(project.id);
    assert.equal(project.name, 'Bacheca');
    assert.ok(columns.length >= 3);
    projectId = project.id;
    columnId = columns[0]!.id;
  });

  it('creates, moves, annotates and reads cards through MCP', async () => {
    const created = await callTool(context.base, accessToken, 'board_create_card', {
      columnId,
      title: 'Preparare il lancio',
      description: 'Bozza creata dall’AI',
      dueAt: '2030-01-02T10:00:00.000Z',
      labels: [],
    });
    const card = created.card as { id: string; status: string; dueAt: string };
    cardId = card.id;
    assert.equal(card.status, 'todo');
    assert.equal(card.dueAt, '2030-01-02T10:00:00.000Z');

    const task = await callTool(context.base, accessToken, 'board_add_task', {
      cardId,
      title: 'Scrivere l’annuncio',
    });
    const taskId = (task.task as { id: string }).id;
    await callTool(context.base, accessToken, 'board_update_task', { cardId, taskId, done: true });

    await callTool(context.base, accessToken, 'board_add_comment', { cardId, body: 'Creato via MCP' });
    const moved = await callTool(context.base, accessToken, 'board_update_card', { cardId, status: 'done' });
    const movedCard = moved.card as { status: string; tasks: Array<{ done: boolean }> };
    assert.equal(movedCard.status, 'done');
    assert.equal(movedCard.tasks[0]?.done, true);

    const detail = await callTool(context.base, accessToken, 'board_get_card', { cardId });
    const detailCard = detail.card as { comments: Array<{ body: string }> };
    assert.equal(detailCard.comments.length, 1);
    assert.equal(detailCard.comments[0]?.body, 'Creato via MCP');

    const search = await callTool(context.base, accessToken, 'board_search', { query: 'lancio' });
    const results = search.results as Array<{ cardId: string; projectId: string }>;
    assert.ok(results.some((row) => row.cardId === cardId && row.projectId === projectId));
  });

  it('rejects a wrong PKCE verifier and rotates refresh tokens', async () => {
    const code = await authorizeCode();
    const wrong = await admin.request<{ error?: string }>('/oauth/token', {
      method: 'POST',
      body: {
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: 'x'.repeat(48),
      },
      csrf: false,
    });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error, 'invalid_grant');

    const previous = refreshToken;
    const refreshed = await admin.request<{ access_token?: string; refresh_token?: string }>('/oauth/token', {
      method: 'POST',
      body: { grant_type: 'refresh_token', client_id: clientId, refresh_token: previous },
      csrf: false,
    });
    assert.equal(refreshed.status, 200, refreshed.text);
    assert.ok(refreshed.body.access_token);
    assert.notEqual(refreshed.body.refresh_token, previous);
    accessToken = refreshed.body.access_token ?? '';
    refreshToken = refreshed.body.refresh_token ?? '';

    const replay = await admin.request('/oauth/token', {
      method: 'POST',
      body: { grant_type: 'refresh_token', client_id: clientId, refresh_token: previous },
      csrf: false,
    });
    assert.equal(replay.status, 400);
  });

  it('keeps other users’ boards isolated and accepts form-encoded token requests', async () => {
    const bob = await createUser(admin, 'bob', 'BlueMountain88!');
    const code = await authorizeCode(bob);
    const exchanged = await bob.request<{ access_token?: string }>('/oauth/token', {
      method: 'POST',
      raw: Buffer.from(
        new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        }).toString(),
      ),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(exchanged.status, 200, exchanged.text);
    const bobToken = exchanged.body.access_token ?? '';
    assert.ok(bobToken);

    const bobBoard = await callTool(context.base, bobToken, 'board_get');
    assert.notEqual((bobBoard.project as { id: string }).id, projectId);

    const denied = await rpc(context.base, bobToken, 'tools/call', {
      name: 'board_get_card',
      arguments: { cardId },
    });
    assert.equal(denied.status, 200);
    assert.equal((denied.body.result as RpcToolResult).isError, true);
  });

  it('lists and revokes connected apps from the Nimbus session API', async () => {
    const list = await admin.request<{ clients: Array<{ id: string; name: string }> }>('/api/mcp/clients');
    assert.equal(list.status, 200);
    assert.ok(list.body.clients.some((client) => client.id === clientId && client.name === 'Claude Test'));

    const revoked = await admin.request(`/api/mcp/clients/${encodeURIComponent(clientId)}`, {
      method: 'DELETE',
      csrf: true,
    });
    assert.equal(revoked.status, 200);

    const denied = await fetch(`${context.base}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
    });
    assert.equal(denied.status, 401);
  });
});
