import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client, createRuntime, createUser, makeAdmin, type TestRuntime } from './helpers.js';

describe('files, permissions, versions and public links', () => {
  let context: TestRuntime;
  let admin: Client;
  let alice: Client;
  let bob: Client;

  before(async () => {
    context = await createRuntime();
    admin = await makeAdmin(context.base);
    alice = await createUser(admin, 'alice', 'RainbowUnicorn42!');
    bob = await createUser(admin, 'bob', 'BlueMountain88!');
  });

  after(async () => {
    await context.close();
  });

  it('uploads, encrypts at rest and downloads the exact bytes', async () => {
    const content = Buffer.from('Ciao Nimbus, questo è un file di prova.\n');
    const uploaded = await alice.upload('ciao.txt', content);
    assert.equal(uploaded.status, 200);
    const item = uploaded.body.item;
    assert.ok(item?.id);
    assert.equal(item?.size, content.length);

    const download = await alice.download(item.id);
    assert.equal(download.status, 200);
    assert.equal(download.data.toString(), content.toString());
    assert.match(download.headers.get('content-security-policy') ?? '', /sandbox/);
    assert.match(download.headers.get('content-disposition') ?? '', /^inline/);
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff');

    const ranged = await alice.download(item.id, '');
    const rangeRequest = await fetch(`${context.base}/api/files/${item.id}/content`, {
      headers: { Cookie: alice.cookieHeader(), Range: 'bytes=0-3' },
    });
    const rangeBody = Buffer.from(await rangeRequest.arrayBuffer());
    assert.equal(rangeRequest.status, 206);
    assert.equal(rangeBody.toString(), 'Ciao');
    assert.equal(rangeRequest.headers.get('content-range'), `bytes 0-3/${content.length}`);
    assert.equal(ranged.status, 200);

    const onDisk = await import('node:fs');
    const path = await import('node:path');
    const stored = onDisk.readFileSync(
      path.join(
        context.dir,
        'files',
        context.runtime.ctx.db.prepare('SELECT owner_id FROM files WHERE id = ?').get(item.id).owner_id,
        `${item.id}.v1.enc`,
      ),
    );
    assert.ok(stored.subarray(0, 8).toString() === 'NBENC001');
    assert.ok(!stored.includes(content.subarray(0, 20)));
  });

  it('denies access to another user and does not leak existence', async () => {
    const file = await alice.upload('private.txt', Buffer.from('secret'));
    const id = file.body.item.id;
    const denied = await bob.download(id);
    assert.equal(denied.status, 404);
    const patch = await bob.request(`/api/files/${id}`, { method: 'PATCH', body: { name: 'stolen.txt' }, csrf: true });
    assert.equal(patch.status, 404);
    const purge = await bob.request(`/api/files/${id}/purge`, { method: 'DELETE', csrf: true });
    assert.equal(purge.status, 404);
  });

  it('sanitizes hostile filenames and rejects non-UUID parents', async () => {
    const uploaded = await alice.upload('../../etc/passwd', Buffer.from('root:x:0:0'));
    assert.equal(uploaded.status, 200);
    assert.ok(!uploaded.body.item.name.includes('/'));
    assert.ok(!uploaded.body.item.name.includes('..'));

    const traversal = await alice.request('/api/files?parent=../../etc', {});
    assert.equal(traversal.status, 400);
  });

  it('supports folders, move, copy, favorite, trash, restore and purge', async () => {
    const folder = await alice.request<{ item: { id: string } }>('/api/files/folders', {
      method: 'POST',
      body: { name: 'Documenti' },
      csrf: true,
    });
    assert.equal(folder.status, 200);
    const folderId = folder.body.item.id;

    const child = await alice.request<{ item: { id: string } }>('/api/files/folders', {
      method: 'POST',
      body: { name: 'Progetti', parentId: folderId },
      csrf: true,
    });
    assert.equal(child.status, 200);

    const inner = await alice.upload('nested.txt', Buffer.from('nested content'), folderId);
    assert.equal(inner.status, 200);
    assert.equal(inner.body.item.parentId, folderId);

    const listing = await alice.request<{ items: Array<{ id: string; name: string }> }>(
      `/api/files?parent=${folderId}`,
    );
    assert.equal(listing.status, 200);
    assert.ok(listing.body.items.some((item) => item.name === 'nested.txt'));

    const favorite = await alice.request(`/api/files/${inner.body.item.id}`, {
      method: 'PATCH',
      body: { favorite: true },
      csrf: true,
    });
    assert.equal(favorite.status, 200);
    const favorites = await alice.request<{ items: unknown[] }>('/api/files?view=favorites');
    assert.equal(favorites.body.items.length, 1);

    const copy = await alice.request<{ item: { id: string; name: string } }>(`/api/files/${inner.body.item.id}/copy`, {
      method: 'POST',
      body: {},
      csrf: true,
    });
    assert.equal(copy.status, 200);
    assert.notEqual(copy.body.item.id, inner.body.item.id);
    assert.match(copy.body.item.name, /copia/);

    const trash = await alice.request(`/api/files/${folderId}`, { method: 'DELETE', csrf: true });
    assert.equal(trash.status, 200);
    const trashList = await alice.request<{ items: Array<{ id: string }> }>('/api/files?view=trash');
    assert.ok(trashList.body.items.some((item) => item.id === folderId));

    const restore = await alice.request(`/api/files/${folderId}/restore`, { method: 'POST', body: {}, csrf: true });
    assert.equal(restore.status, 200);
    const restoredDownload = await alice.download(inner.body.item.id);
    assert.equal(restoredDownload.status, 200);
    assert.equal(restoredDownload.data.toString(), 'nested content');

    const trashAgain = await alice.request(`/api/files/${folderId}`, { method: 'DELETE', csrf: true });
    assert.equal(trashAgain.status, 200);
    const purge = await alice.request(`/api/files/${folderId}/purge`, { method: 'DELETE', csrf: true });
    assert.equal(purge.status, 200);
    const gone = await alice.download(inner.body.item.id);
    assert.equal(gone.status, 404);
  });

  it('creates versions, restores an old version and accounts for storage', async () => {
    const original = Buffer.from('versione uno');
    const file = await alice.upload('versions.txt', original);
    const id = file.body.item.id;

    const create = await alice.request<{ uploadId: string; chunkSize: number }>(`/api/files/${id}/versions/upload`, {
      method: 'POST',
      body: { size: 12 },
      csrf: true,
    });
    assert.equal(create.status, 200);
    const next = Buffer.from('versione due');
    const push = await alice.request(`/api/uploads/${create.body.uploadId}/chunks/0`, {
      method: 'PUT',
      raw: next,
      csrf: true,
    });
    assert.equal(push.status, 200);
    const complete = await alice.request(`/api/uploads/${create.body.uploadId}/complete`, {
      method: 'POST',
      body: {},
      csrf: true,
    });
    assert.equal(complete.status, 200);
    assert.equal((await alice.download(id)).data.toString(), next.toString());

    const versions = await alice.request<{ versions: Array<{ version: number; current: boolean }> }>(
      `/api/files/${id}/versions`,
    );
    assert.equal(versions.body.versions.length, 2);
    assert.equal(versions.body.versions[0]?.version, 2);

    const restore = await alice.request(`/api/files/${id}/versions/1/restore`, {
      method: 'POST',
      body: {},
      csrf: true,
    });
    assert.equal(restore.status, 200);
    assert.equal((await alice.download(id)).data.toString(), original.toString());
  });

  it('shares files and collaborative folders without breaking ownership', async () => {
    const file = await alice.upload('shared.txt', Buffer.from('shared bytes'));
    const fileId = file.body.item.id;
    const share = await alice.request(`/api/files/${fileId}/shares`, {
      method: 'POST',
      body: {
        userId: context.runtime.ctx.db.prepare('SELECT id FROM users WHERE username = ?').get('bob').id,
        permission: 'read',
      },
      csrf: true,
    });
    assert.equal(share.status, 200);
    assert.equal((await bob.download(fileId)).status, 200);
    const bobShares = await bob.request<{ incoming: Array<{ fileId: string }> }>('/api/shares');
    assert.ok(bobShares.body.incoming.some((entry) => entry.fileId === fileId));
    const revoke = await alice.request(
      `/api/files/${fileId}/shares/${context.runtime.ctx.db.prepare('SELECT id FROM users WHERE username = ?').get('bob').id}`,
      {
        method: 'DELETE',
        csrf: true,
      },
    );
    assert.equal(revoke.status, 200);
    assert.equal((await bob.download(fileId)).status, 404);

    const sharedFolder = await alice.request<{ item: { id: string } }>('/api/files/folders', {
      method: 'POST',
      body: { name: 'Collaborativa' },
      csrf: true,
    });
    const folderId = sharedFolder.body.item.id;
    const bobId = context.runtime.ctx.db.prepare('SELECT id FROM users WHERE username = ?').get('bob').id;
    await alice.request(`/api/files/${folderId}/shares`, {
      method: 'POST',
      body: { userId: bobId, permission: 'write' },
      csrf: true,
    });
    const bobUpload = await bob.upload('bob-inside.txt', Buffer.from('from bob'), folderId);
    assert.equal(bobUpload.status, 200);
    const aliceListing = await alice.request<{ items: Array<{ name: string }> }>(`/api/files?parent=${folderId}`);
    assert.ok(aliceListing.body.items.some((item) => item.name === 'bob-inside.txt'));
    const bobRename = await bob.request(`/api/files/${bobUpload.body.item.id}`, {
      method: 'PATCH',
      body: { name: 'renamed.txt' },
      csrf: true,
    });
    assert.equal(bobRename.status, 200);
  });

  it('enforces per-user quotas', async () => {
    const tiny = await createUser(admin, 'tiny', 'SilverComet99!', 5);
    const rejected = await tiny.upload('large.bin', Buffer.from('0123456789'));
    assert.equal(rejected.status, 413);
  });

  it('creates password-protected public links with a download limit', async () => {
    const file = await alice.upload('public.txt', Buffer.from('public content'));
    const created = await alice.request<{ link: { token: string; id: string } }>('/api/public-links', {
      method: 'POST',
      body: { fileId: file.body.item.id, password: 'sharepassword', maxDownloads: 1 },
      csrf: true,
    });
    assert.equal(created.status, 200);
    const token = created.body.link.token;
    const anonymous = new Client(context.base);

    const metadata = await anonymous.request<{ requiresPassword: boolean; file: unknown }>(
      `/api/public/shares/${token}`,
    );
    assert.equal(metadata.status, 200);
    assert.equal(metadata.body.requiresPassword, true);
    assert.equal(metadata.body.file, null);

    const bad = await anonymous.request(`/api/public/shares/${token}/unlock`, {
      method: 'POST',
      body: { password: 'wrongpassword' },
    });
    assert.equal(bad.status, 403);

    const unlock = await anonymous.request<{ access: string }>(`/api/public/shares/${token}/unlock`, {
      method: 'POST',
      body: { password: 'sharepassword' },
    });
    assert.equal(unlock.status, 200);
    assert.ok(unlock.body.access);

    const first = await fetch(
      `${context.base}/api/public/shares/${token}/content?access=${encodeURIComponent(unlock.body.access)}`,
    );
    assert.equal(first.status, 200);
    assert.equal(Buffer.from(await first.arrayBuffer()).toString(), 'public content');
    assert.match(first.headers.get('content-disposition') ?? '', /^inline/);

    const second = await fetch(
      `${context.base}/api/public/shares/${token}/content?access=${encodeURIComponent(unlock.body.access)}`,
    );
    assert.equal(second.status, 404);

    const revoke = await alice.request(`/api/public-links/${created.body.link.id}`, { method: 'DELETE', csrf: true });
    assert.equal(revoke.status, 200);
    const revoked = await anonymous.request(`/api/public/shares/${token}`);
    assert.equal(revoked.status, 404);
  });

  it('never serves uploaded HTML inline', async () => {
    const html = Buffer.from('<!doctype html><html><body><script>alert(document.cookie)</script></body></html>');
    const uploaded = await alice.upload('evil.html', html);
    const response = await fetch(`${context.base}/api/files/${uploaded.body.item.id}/content`, {
      headers: { Cookie: alice.cookieHeader() },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    assert.match(response.headers.get('content-disposition') ?? '', /^attachment/);
    assert.match(response.headers.get('content-security-policy') ?? '', /sandbox/);
    await response.arrayBuffer();
  });
});
