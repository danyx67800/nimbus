import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { getMeta, openDatabase } from '../src/db.js';
import { type Client, createRuntime, createUser, makeAdmin, type TestRuntime } from './helpers.js';

interface Project {
  id: string;
  name: string;
  role: 'owner' | 'member';
  chatRoomId: string | null;
  memberCount: number;
}

interface Card {
  id: string;
  title: string;
  dueAt: number | null;
  dueComplete: boolean;
  coverFileId: string | null;
  labels: Array<{ id: string; name: string }>;
  assignees: Array<{ id: string }>;
  commentCount: number;
  attachmentCount: number;
  comments?: Array<{ id: string; body: string; author: { id: string } }>;
  attachments?: Array<{ id: string; fileId: string; isImage: boolean }>;
}

describe('shared projects, rich cards and project chat', () => {
  let context: TestRuntime;
  let admin: Client;
  let alice: Client;
  let bob: Client;
  let charlie: Client;

  before(async () => {
    context = await createRuntime();
    admin = await makeAdmin(context.base);
    alice = await createUser(admin, 'alice', 'RainbowUnicorn42!');
    bob = await createUser(admin, 'bob', 'BlueMountain88!');
    charlie = await createUser(admin, 'charlie', 'GreenForest77!');
  });

  after(async () => {
    await context.close();
  });

  it('creates a shared project, syncs its chat and protects it from outsiders', async () => {
    const initial = await alice.request<{ project: Project; projects: Project[] }>('/api/board');
    assert.equal(initial.status, 200);
    assert.equal(initial.body.project.role, 'owner');
    assert.ok(initial.body.projects.length >= 1);

    const created = await alice.request<{ project: Project }>('/api/projects', {
      method: 'POST',
      body: { name: 'Lancio sito', description: 'Foto, commenti e scadenze' },
      csrf: true,
    });
    assert.equal(created.status, 200);
    const project = created.body.project;
    assert.ok(project.id);
    assert.ok(project.chatRoomId);

    const bobId = context.runtime.ctx.db.prepare('SELECT id FROM users WHERE username = ?').get('bob') as {
      id: string;
    };
    const added = await alice.request<{ members: Array<{ id: string }> }>(`/api/projects/${project.id}/members`, {
      method: 'POST',
      body: { userId: bobId.id },
      csrf: true,
    });
    assert.equal(added.status, 200);
    assert.equal(added.body.members.length, 2);

    const bobBoard = await bob.request<{ project: Project; members: unknown[] }>(`/api/board?project=${project.id}`);
    assert.equal(bobBoard.status, 200);
    assert.equal(bobBoard.body.project.role, 'member');
    assert.equal(bobBoard.body.project.chatRoomId, project.chatRoomId);
    assert.equal(bobBoard.body.members.length, 2);

    const outsider = await charlie.request(`/api/board?project=${project.id}`);
    assert.equal(outsider.status, 404);

    const roomMembers = context.runtime.ctx.db
      .prepare('SELECT user_id, role FROM chat_members WHERE room_id = ? ORDER BY role DESC')
      .all(project.chatRoomId) as Array<{ user_id: string; role: string }>;
    assert.equal(roomMembers.length, 2);
    assert.equal(roomMembers[0]?.role, 'owner');

    const bobMessage = await bob.request<{ message: { body: string } }>(
      `/api/chat/rooms/${project.chatRoomId}/messages`,
      { method: 'POST', body: { body: 'Ciao dal progetto' }, csrf: true },
    );
    assert.equal(bobMessage.status, 200);
    assert.equal(bobMessage.body.message.body, 'Ciao dal progetto');
  });

  it('stores labels, assignees, due dates, photos, comments and makes them searchable', async () => {
    const created = await alice.request<{ project: Project }>('/api/projects', {
      method: 'POST',
      body: { name: 'Foto e commenti' },
      csrf: true,
    });
    const project = created.body.project;
    const bobId = context.runtime.ctx.db.prepare('SELECT id FROM users WHERE username = ?').get('bob') as {
      id: string;
    };
    const memberAdded = await alice.request(`/api/projects/${project.id}/members`, {
      method: 'POST',
      body: { userId: bobId.id },
      csrf: true,
    });
    assert.equal(memberAdded.status, 200);

    const column = await alice.request<{ column: { id: string } }>('/api/board/columns', {
      method: 'POST',
      body: { projectId: project.id, title: 'Da fare' },
      csrf: true,
    });
    assert.equal(column.status, 200);

    const label = await alice.request<{ label: { id: string } }>(`/api/projects/${project.id}/labels`, {
      method: 'POST',
      body: { name: 'Design', color: '#8f6cf5' },
      csrf: true,
    });
    assert.equal(label.status, 200);

    const card = await alice.request<{ card: Card }>('/api/board/cards', {
      method: 'POST',
      body: { columnId: column.body.column.id, title: 'Foto del lancio', description: 'Scegliere la copertina' },
      csrf: true,
    });
    assert.equal(card.status, 200);
    const cardId = card.body.card.id;
    const dueAt = Date.now() + 86_400_000;

    const due = await alice.request<{ card: Card }>(`/api/board/cards/${cardId}`, {
      method: 'PATCH',
      body: { dueAt, dueComplete: false },
      csrf: true,
    });
    assert.equal(due.status, 200);
    assert.equal(due.body.card.dueAt, dueAt);

    const labelAttached = await alice.request<{ labels: Array<{ id: string }> }>(`/api/board/cards/${cardId}/labels`, {
      method: 'POST',
      body: { labelId: label.body.label.id },
      csrf: true,
    });
    assert.equal(labelAttached.status, 200);
    assert.ok(labelAttached.body.labels.some((entry) => entry.id === label.body.label.id));

    const assigned = await alice.request<{ assignees: Array<{ id: string }> }>(`/api/board/cards/${cardId}/members`, {
      method: 'POST',
      body: { userId: bobId.id },
      csrf: true,
    });
    assert.equal(assigned.status, 200);
    assert.ok(assigned.body.assignees.some((entry) => entry.id === bobId.id));

    const photo = await alice.upload(
      'copertina.png',
      Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex'),
    );
    assert.equal(photo.status, 200);
    const attachment = await alice.request<{ attachment: { id: string; isImage: boolean } }>(
      `/api/board/cards/${cardId}/attachments`,
      { method: 'POST', body: { fileId: photo.body.item.id }, csrf: true },
    );
    assert.equal(attachment.status, 200);
    assert.equal(attachment.body.attachment.isImage, true);

    const cover = await alice.request<{ card: Card }>(`/api/board/cards/${cardId}`, {
      method: 'PATCH',
      body: { coverFileId: photo.body.item.id },
      csrf: true,
    });
    assert.equal(cover.status, 200);
    assert.equal(cover.body.card.coverFileId, photo.body.item.id);

    const bobDownload = await bob.download(photo.body.item.id);
    assert.equal(bobDownload.status, 200);

    const bobComment = await bob.request<{ comment: { id: string; body: string } }>(
      `/api/board/cards/${cardId}/comments`,
      { method: 'POST', body: { body: 'La foto mi piace!' }, csrf: true },
    );
    assert.equal(bobComment.status, 200);
    assert.equal(bobComment.body.comment.body, 'La foto mi piace!');

    const detail = await alice.request<{ card: Card }>(`/api/board/cards/${cardId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.card.commentCount, 1);
    assert.equal(detail.body.card.attachmentCount, 1);
    assert.equal(detail.body.card.comments?.[0]?.body, 'La foto mi piace!');
    assert.equal(detail.body.card.attachments?.[0]?.fileId, photo.body.item.id);

    const search = await bob.request<{ board: Array<{ cardId: string; projectId: string }> }>(
      '/api/search?q=Foto%20del%20lancio',
    );
    assert.equal(search.status, 200);
    assert.ok(search.body.board.some((item) => item.cardId === cardId && item.projectId === project.id));

    const removed = await alice.request(`/api/projects/${project.id}/members/${bobId.id}`, {
      method: 'DELETE',
      csrf: true,
    });
    assert.equal(removed.status, 200);
    assert.equal((await bob.request(`/api/board?project=${project.id}`)).status, 404);
    assert.equal((await bob.download(photo.body.item.id)).status, 404);
    const left = context.runtime.ctx.db
      .prepare('SELECT COUNT(*) AS n FROM chat_members WHERE room_id = ? AND user_id = ?')
      .get(project.chatRoomId, bobId.id) as { n: number };
    assert.equal(Number(left.n), 0);
  });
});

describe('schema v5 to v6 migration', () => {
  it('assigns existing board columns to a default project and keeps their cards', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-migration-'));
    const dbPath = path.join(dir, 'old.db');
    const old = new DatabaseSync(dbPath);
    old.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE board_columns (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        title TEXT NOT NULL,
        position INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE board_cards (
        id TEXT PRIMARY KEY,
        column_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'todo',
        position INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO meta (key, value) VALUES ('schema_version', '5');
      INSERT INTO users (id) VALUES ('u1');
      INSERT INTO board_columns (id, owner_id, title, position, created_at, updated_at)
        VALUES ('c1', 'u1', 'Da fare', 0, 1, 1);
      INSERT INTO board_cards (id, column_id, owner_id, title, position, created_at, updated_at)
        VALUES ('card1', 'c1', 'u1', 'Scheda esistente', 0, 1, 1);
    `);
    old.close();

    const migrated = openDatabase({ dbPath } as never);
    assert.equal(getMeta(migrated, 'schema_version'), '6');
    const project = migrated.prepare("SELECT id, name FROM projects WHERE owner_id = 'u1'").get() as {
      id: string;
      name: string;
    };
    assert.ok(project.id);
    assert.equal(project.name, 'Bacheca');
    const column = migrated.prepare("SELECT project_id FROM board_columns WHERE id = 'c1'").get() as {
      project_id: string;
    };
    assert.equal(column.project_id, project.id);
    const card = migrated.prepare("SELECT title FROM board_cards WHERE id = 'card1'").get() as { title: string };
    assert.equal(card.title, 'Scheda esistente');
    const member = migrated
      .prepare("SELECT role FROM project_members WHERE project_id = ? AND user_id = 'u1'")
      .get(project.id) as { role: string };
    assert.equal(member.role, 'owner');
    migrated.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
