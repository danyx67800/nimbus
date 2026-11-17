import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import {
  type Client,
  createRuntime,
  createUser,
  makeAdmin,
  type TestRuntime,
  waitForClose,
  waitForMessage,
} from './helpers.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('realtime security and quick share', () => {
  let context: TestRuntime;
  let admin: Client;
  let alice: Client;
  let bob: Client;
  let aliceId: string;
  let bobId: string;
  let aliceWs: WebSocket;
  let bobWs: WebSocket;

  before(async () => {
    context = await createRuntime();
    admin = await makeAdmin(context.base);
    alice = await createUser(admin, 'alice', 'RainbowUnicorn42!');
    bob = await createUser(admin, 'bob', 'BlueMountain88!');
    aliceId = String(
      (context.runtime.ctx.db.prepare('SELECT id FROM users WHERE username = ?').get('alice') as { id: string }).id,
    );
    bobId = String(
      (context.runtime.ctx.db.prepare('SELECT id FROM users WHERE username = ?').get('bob') as { id: string }).id,
    );
    aliceWs = await alice.connectWs();
    bobWs = await bob.connectWs();
  });

  after(async () => {
    aliceWs.close();
    bobWs.close();
    await sleep(50);
    await context.close();
  });

  it('rejects websocket connections with a foreign origin', async () => {
    const socket = new WebSocket(`${context.base.replace(/^http/, 'ws')}/ws`, {
      headers: { Cookie: alice.cookieHeader(), Origin: 'https://evil.example' },
    });
    const code = await waitForClose(socket);
    assert.equal(code, 4403);
  });

  it('rejects unauthenticated websocket connections', async () => {
    const socket = new WebSocket(`${context.base.replace(/^http/, 'ws')}/ws`, { headers: { Origin: context.base } });
    const code = await waitForClose(socket);
    assert.equal(code, 4401);
  });

  it('completes an online quick share over authenticated signaling', async () => {
    const transferId = crypto.randomUUID();
    const content = Buffer.from('image-bytes');
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');

    const offerPromise = waitForMessage(bobWs, 'qs:offer');
    aliceWs.send(
      JSON.stringify({
        type: 'qs:offer',
        transferId,
        to: bobId,
        fileName: 'foto.png',
        size: content.length,
        mime: 'image/png',
        sha256,
      }),
    );
    const offer = await offerPromise;
    assert.equal(offer.transferId, transferId);
    assert.equal((offer.from as { id: string }).id, aliceId);

    const acceptedPromise = waitForMessage(aliceWs, 'qs:accepted');
    bobWs.send(JSON.stringify({ type: 'qs:accept', transferId }));
    await acceptedPromise;

    const signalPromise = waitForMessage(bobWs, 'qs:signal');
    aliceWs.send(
      JSON.stringify({
        type: 'qs:signal',
        transferId,
        data: { sdp: { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n' } },
      }),
    );
    const signal = await signalPromise;
    assert.equal(signal.from, aliceId);

    const answerPromise = waitForMessage(aliceWs, 'qs:signal');
    bobWs.send(JSON.stringify({ type: 'qs:signal', transferId, data: { sdp: { type: 'answer', sdp: 'v=0\r\n' } } }));
    await answerPromise;

    const deliveredPromise = waitForMessage(aliceWs, 'qs:delivered');
    bobWs.send(JSON.stringify({ type: 'qs:complete', transferId, ok: true }));
    const delivered = await deliveredPromise;
    assert.equal(delivered.transferId, transferId);

    const status = await alice.request<{ transfer: { status: string } }>(`/api/quick-share/${transferId}`);
    assert.equal(status.status, 200);
    assert.equal(status.body.transfer.status, 'delivered');
  });

  it('refuses to relay signaling for arbitrary users', async () => {
    const transferId = crypto.randomUUID();
    aliceWs.send(JSON.stringify({ type: 'qs:signal', transferId, data: { sdp: {} } }));
    const error = await waitForMessage(aliceWs, 'error');
    assert.match(String(error.message), /non trovato/i);
  });

  it('falls back to a chat attachment when the recipient is offline', async () => {
    bobWs.close();
    await waitForClose(bobWs).catch(() => undefined);
    await sleep(100);
    assert.equal(context.runtime.ctx.hub.isOnline(bobId), false);

    const content = Buffer.from('offline delivery payload');
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');
    const offline = await alice.request<{ transferId: string }>('/api/quick-share/offline', {
      method: 'POST',
      csrf: true,
      body: {
        toUserId: bobId,
        fileName: 'offline.txt',
        size: content.length,
        mime: 'text/plain',
        sha256,
      },
    });
    assert.equal(offline.status, 200);

    const uploaded = await alice.upload('offline.txt', content);
    assert.equal(uploaded.status, 200);
    const fallback = await alice.request<{
      status: string;
      roomId: string;
      message: { id: string; attachments: Array<{ fileId: string; name: string }> };
    }>(`/api/quick-share/${offline.body.transferId}/fallback`, {
      method: 'POST',
      csrf: true,
      body: { fileId: uploaded.body.item.id },
    });
    assert.equal(fallback.status, 200);
    assert.equal(fallback.body.status, 'delivered_chat');
    assert.equal(fallback.body.message.attachments[0]?.fileId, uploaded.body.item.id);

    const rooms = await bob.request<{ rooms: Array<{ id: string; lastMessage: { id: string } | null }> }>(
      '/api/chat/rooms',
    );
    const room = rooms.body.rooms.find((entry) => entry.id === fallback.body.roomId);
    assert.ok(room);
    const messages = await bob.request<{
      messages: Array<{ id: string; attachments: Array<{ fileId: string }> }>;
    }>(`/api/chat/rooms/${fallback.body.roomId}/messages`);
    const message = messages.body.messages.find((entry) => entry.id === fallback.body.message.id);
    assert.ok(message);
    assert.equal(message.attachments[0]?.fileId, uploaded.body.item.id);
    const download = await bob.download(uploaded.body.item.id);
    assert.equal(download.status, 200);
    assert.equal(download.data.toString(), content.toString());

    const tooLate = await alice.request(`/api/quick-share/${offline.body.transferId}/fallback`, {
      method: 'POST',
      csrf: true,
      body: { fileId: uploaded.body.item.id },
    });
    assert.equal(tooLate.status, 400);
  });

  it('blocks quick share offers between blocked users', async () => {
    const block = await bob.request(`/api/users/${aliceId}/block`, { method: 'POST', csrf: true, body: {} });
    assert.equal(block.status, 200);
    const content = Buffer.from('blocked');
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');
    const denied = await alice.request('/api/quick-share/offline', {
      method: 'POST',
      csrf: true,
      body: { toUserId: bobId, fileName: 'blocked.txt', size: content.length, mime: 'text/plain', sha256 },
    });
    assert.equal(denied.status, 403);
  });
});
