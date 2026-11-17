import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client, createRuntime, makeAdmin, type TestRuntime } from './helpers.js';

describe('authentication and sessions', () => {
  let context: TestRuntime;
  let admin: Client;

  before(async () => {
    context = await createRuntime();
    admin = await makeAdmin(context.base);
  });

  after(async () => {
    await context.close();
  });

  it('exposes setup status and app config without authentication', async () => {
    const anonymous = new Client(context.base);
    const config = await anonymous.request<{ appName: string; needsSetup: boolean }>('/api/config');
    assert.equal(config.status, 200);
    assert.equal(config.body.appName, 'Nimbus');
    assert.equal(config.body.needsSetup, false);
    const unauthorized = await anonymous.request('/api/auth/me');
    assert.equal(unauthorized.status, 401);
  });

  it('rejects a second setup attempt', async () => {
    const anonymous = new Client(context.base);
    const response = await anonymous.request('/api/setup', {
      method: 'POST',
      body: { username: 'intruder', displayName: 'Intruder', password: 'AnotherLongPassword1!' },
    });
    assert.equal(response.status, 409);
  });

  it('returns the same generic error for unknown and existing users', async () => {
    const anonymous = new Client(context.base);
    const unknown = await anonymous.login('nosuchuser', 'WrongPassword123!');
    const existing = await anonymous.login('admin', 'WrongPassword123!');
    assert.equal(unknown.status, 401);
    assert.equal(existing.status, 401);
    assert.deepEqual(unknown.body, existing.body);
  });

  it('requires CSRF for mutating authenticated requests and rejects foreign origins', async () => {
    const noCsrf = await admin.request('/api/files/folders', { method: 'POST', body: { name: 'NoCsrf' } });
    assert.equal(noCsrf.status, 403);

    const foreign = await admin.request('/api/files/folders', {
      method: 'POST',
      body: { name: 'Foreign' },
      csrf: true,
      origin: 'https://evil.example',
    });
    assert.equal(foreign.status, 403);

    const ok = await admin.request<{ item: { id: string } }>('/api/files/folders', {
      method: 'POST',
      body: { name: 'Legit' },
      csrf: true,
    });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.item.id);
  });

  it('rotates the session token on login and revokes the previous one', async () => {
    const client = new Client(context.base);
    const first = await client.login('admin', 'CorrectHorseBattery42!');
    assert.equal(first.status, 200);
    const oldCookie = client.cookieHeader();
    const second = await client.login('admin', 'CorrectHorseBattery42!');
    assert.equal(second.status, 200);

    const stale = new Client(context.base);
    for (const pair of oldCookie.split('; ')) {
      const [key, value] = pair.split('=');
      if (key && value) stale.cookies.set(key, value);
    }
    const me = await stale.request('/api/auth/me');
    assert.equal(me.status, 401);
  });

  it('locks progressively after repeated failures', async () => {
    const anonymous = new Client(context.base);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await anonymous.login('lockedtarget', `Wrong-${attempt}-Password!`);
      assert.equal(response.status, 401);
    }
    const locked = await anonymous.login('lockedtarget', 'Wrong-6-Password!');
    assert.equal(locked.status, 429);
    assert.ok(locked.headers.get('retry-after'));
  });

  it('revokes all sessions on global logout', async () => {
    const client = new Client(context.base);
    const login = await client.login('admin', 'CorrectHorseBattery42!');
    assert.equal(login.status, 200);
    const other = new Client(context.base);
    await other.login('admin', 'CorrectHorseBattery42!');
    const logout = await client.request('/api/auth/logout-all', { method: 'POST', csrf: true });
    assert.equal(logout.status, 200);
    const me = await other.request('/api/auth/me');
    assert.equal(me.status, 401);
  });

  it('sets hardened security headers on the SPA shell', async () => {
    const anonymous = new Client(context.base);
    const response = await anonymous.request('/', { headers: { Accept: 'text/html' } });
    assert.equal(response.status, 200);
    assert.match(response.text, /Nimbus/);
    const csp = response.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /script-src 'self' 'nonce-/);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('permissions-policy') ?? '', /camera=\(self\)/);
  });
});
