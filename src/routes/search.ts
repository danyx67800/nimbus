import type { FastifyInstance } from 'fastify';
import { findDirectRoom } from '../chat/service.js';
import type { AppContext } from '../context.js';
import { enforceRate } from '../http/helpers.js';
import { requireAuth } from '../http/security.js';

const PEOPLE_LIMIT = 8;
const ROOM_LIMIT = 8;
const MESSAGE_LIMIT = 12;
const FILE_LIMIT = 8;
const BOARD_CARD_LIMIT = 6;
const BOARD_TASK_LIMIT = 6;
const BOARD_LIMIT = 10;

type PersonRow = {
  id: string;
  username: string;
  display_name: string;
  presence: string;
};

type RoomRow = {
  id: string;
  kind: 'dm' | 'group' | 'channel';
  name: string | null;
  title: string | null;
  updated_at: number;
  last_body: string | null;
  last_at: number | null;
};

type MessageRow = {
  id: string;
  room_id: string;
  room_title: string | null;
  room_kind: 'dm' | 'group' | 'channel';
  sender_id: string;
  sender_name: string;
  body: string;
  created_at: number;
};

type FileRow = {
  id: string;
  parent_id: string | null;
  name: string;
  kind: 'file' | 'folder';
  mime: string;
  size: number;
  updated_at: number;
};

type BoardCardRow = {
  id: string;
  title: string;
  description: string;
  status: string;
  column_title: string;
  project_id: string;
  project_name: string;
  updated_at: number;
};

type BoardTaskRow = {
  id: string;
  card_id: string;
  title: string;
  notes: string;
  status: string;
  card_title: string;
  column_title: string;
  project_id: string;
  project_name: string;
  updated_at: number;
};

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function snippet(value: string, max = 160): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function presenceFor(ctx: AppContext, userId: string, presence: string): string {
  if (!ctx.hub.isOnline(userId) || presence === 'hidden') return 'offline';
  return presence;
}

export function registerSearchRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get('/api/search', async (req) => {
    const { user } = requireAuth(req);
    const rawQuery = (req.query as { q?: string }).q ?? '';
    const query = rawQuery.trim().slice(0, 200);
    if (!query) {
      return { query: '', people: [], rooms: [], messages: [], files: [], board: [] };
    }

    enforceRate(ctx.limiter, `search:${user.id}`, 90, 60_000);
    const term = `%${escapeLike(query)}%`;

    const peopleRows = db
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.presence
         FROM users u
         WHERE u.disabled = 0 AND u.id != ?
           AND (u.display_name LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\')
           AND NOT EXISTS (
             SELECT 1 FROM blocks b
             WHERE (b.blocker_id = ? AND b.blocked_id = u.id)
                OR (b.blocker_id = u.id AND b.blocked_id = ?)
           )
         ORDER BY u.display_name COLLATE NOCASE
         LIMIT ?`,
      )
      .all(user.id, term, term, user.id, user.id, PEOPLE_LIMIT) as unknown as PersonRow[];

    const roomsRows = db
      .prepare(
        `SELECT r.id, r.kind, r.name, r.updated_at,
                COALESCE(r.name, (
                  SELECT u2.display_name FROM chat_members cm2 JOIN users u2 ON u2.id = cm2.user_id
                  WHERE cm2.room_id = r.id AND cm2.user_id != ?
                  ORDER BY u2.display_name COLLATE NOCASE LIMIT 1
                )) AS title,
                (SELECT m.body FROM messages m
                 WHERE m.room_id = r.id AND m.deleted_at IS NULL
                 ORDER BY m.created_at DESC LIMIT 1) AS last_body,
                (SELECT m.created_at FROM messages m
                 WHERE m.room_id = r.id AND m.deleted_at IS NULL
                 ORDER BY m.created_at DESC LIMIT 1) AS last_at
         FROM chat_rooms r
         JOIN chat_members cm ON cm.room_id = r.id AND cm.user_id = ?
         WHERE (
           (r.kind = 'dm' AND EXISTS (
             SELECT 1 FROM chat_members cm2 JOIN users u2 ON u2.id = cm2.user_id
             WHERE cm2.room_id = r.id AND cm2.user_id != ?
               AND (u2.display_name LIKE ? ESCAPE '\\' OR u2.username LIKE ? ESCAPE '\\')
           ))
           OR (r.kind != 'dm' AND r.name LIKE ? ESCAPE '\\')
         )
         ORDER BY r.updated_at DESC
         LIMIT ?`,
      )
      .all(user.id, user.id, user.id, term, term, term, ROOM_LIMIT) as unknown as RoomRow[];

    const messageRows = db
      .prepare(
        `SELECT m.id, m.room_id, m.sender_id, m.body, m.created_at,
                u.display_name AS sender_name,
                r.kind AS room_kind,
                COALESCE(r.name, (
                  SELECT u2.display_name FROM chat_members cm2 JOIN users u2 ON u2.id = cm2.user_id
                  WHERE cm2.room_id = r.id AND cm2.user_id != ?
                  ORDER BY u2.display_name COLLATE NOCASE LIMIT 1
                )) AS room_title
         FROM messages m
         JOIN chat_rooms r ON r.id = m.room_id
         JOIN users u ON u.id = m.sender_id
         JOIN chat_members cm ON cm.room_id = m.room_id AND cm.user_id = ?
         WHERE m.deleted_at IS NULL AND m.body LIKE ? ESCAPE '\\'
           AND NOT EXISTS (
             SELECT 1 FROM blocks b WHERE b.blocker_id = ? AND b.blocked_id = m.sender_id
           )
         ORDER BY m.created_at DESC
         LIMIT ?`,
      )
      .all(user.id, user.id, term, user.id, MESSAGE_LIMIT) as unknown as MessageRow[];

    const fileRows = db
      .prepare(
        `SELECT id, parent_id, name, kind, mime, size, updated_at FROM files
         WHERE owner_id = ? AND deleted_at IS NULL AND name LIKE ? ESCAPE '\\'
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(user.id, term, FILE_LIMIT) as unknown as FileRow[];

    const boardCardRows = db
      .prepare(
        `SELECT c.id, c.title, c.description, c.status, c.updated_at, col.title AS column_title,
                p.id AS project_id, p.name AS project_name
         FROM board_cards c
         JOIN board_columns col ON col.id = c.column_id
         JOIN projects p ON p.id = col.project_id
         JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
         WHERE (c.title LIKE ? ESCAPE '\\' OR c.description LIKE ? ESCAPE '\\')
         ORDER BY c.updated_at DESC
         LIMIT ?`,
      )
      .all(user.id, term, term, BOARD_CARD_LIMIT) as unknown as BoardCardRow[];

    const boardTaskRows = db
      .prepare(
        `SELECT t.id, t.card_id, t.title, t.notes, t.status, t.updated_at,
                c.title AS card_title, col.title AS column_title,
                p.id AS project_id, p.name AS project_name
         FROM board_card_tasks t
         JOIN board_cards c ON c.id = t.card_id
         JOIN board_columns col ON col.id = c.column_id
         JOIN projects p ON p.id = col.project_id
         JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
         WHERE (t.title LIKE ? ESCAPE '\\' OR t.notes LIKE ? ESCAPE '\\')
         ORDER BY t.updated_at DESC
         LIMIT ?`,
      )
      .all(user.id, term, term, BOARD_TASK_LIMIT) as unknown as BoardTaskRow[];

    const board = [
      ...boardCardRows.map((row) => ({
        kind: 'card' as const,
        id: row.id,
        cardId: row.id,
        title: row.title,
        snippet: snippet(row.description),
        status: row.status,
        columnTitle: row.column_title,
        projectId: row.project_id,
        projectName: row.project_name,
        updatedAt: Number(row.updated_at),
      })),
      ...boardTaskRows.map((row) => ({
        kind: 'task' as const,
        id: row.id,
        cardId: row.card_id,
        title: row.title,
        snippet: snippet(row.notes),
        status: row.status,
        columnTitle: row.column_title,
        cardTitle: row.card_title,
        projectId: row.project_id,
        projectName: row.project_name,
        updatedAt: Number(row.updated_at),
      })),
    ]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, BOARD_LIMIT);

    return {
      query,
      people: peopleRows.map((row) => ({
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        status: presenceFor(ctx, row.id, row.presence),
        roomId: findDirectRoom(db, user.id, row.id),
      })),
      rooms: roomsRows.map((row) => ({
        id: row.id,
        kind: row.kind,
        title: row.title ?? 'Chat',
        updatedAt: Number(row.updated_at),
        lastMessage: row.last_body ? snippet(row.last_body, 100) : null,
        lastMessageAt: row.last_at === null ? null : Number(row.last_at),
      })),
      messages: messageRows.map((row) => ({
        id: row.id,
        roomId: row.room_id,
        roomTitle: row.room_title ?? 'Chat',
        roomKind: row.room_kind,
        senderId: row.sender_id,
        senderName: row.sender_name,
        body: snippet(row.body),
        createdAt: Number(row.created_at),
      })),
      files: fileRows.map((row) => ({
        id: row.id,
        parentId: row.parent_id,
        name: row.name,
        kind: row.kind,
        mime: row.mime,
        size: Number(row.size),
        updatedAt: Number(row.updated_at),
      })),
      board,
    };
  });
}
