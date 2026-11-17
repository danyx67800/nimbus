import { audit } from '../audit.js';
import type { AppContext } from '../context.js';
import { forbidden, notFound } from '../errors.js';
import { type FileRow, fileJson, getFile } from '../files/access.js';
import { newId, nowMs } from '../util.js';

export interface ChatMember {
  room_id: string;
  user_id: string;
  role: string;
  last_read_at: number;
  read_receipts: number;
  muted: number;
}

export function getMembership(db: AppContext['db'], roomId: string, userId: string): ChatMember | null {
  const row = db.prepare('SELECT * FROM chat_members WHERE room_id = ? AND user_id = ?').get(roomId, userId) as
    | ChatMember
    | undefined;
  return row ?? null;
}

export function requireMembership(db: AppContext['db'], roomId: string, userId: string): ChatMember {
  const member = getMembership(db, roomId, userId);
  if (!member) throw notFound('Conversazione non trovata');
  return member;
}

export function isBlockedBetween(db: AppContext['db'], a: string, b: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1`,
    )
    .get(a, b, b, a);
  return Boolean(row);
}

export function roomMemberIds(db: AppContext['db'], roomId: string): string[] {
  const rows = db.prepare('SELECT user_id FROM chat_members WHERE room_id = ?').all(roomId) as Array<{
    user_id: string;
  }>;
  return rows.map((row) => row.user_id);
}

export function findDirectRoom(db: AppContext['db'], a: string, b: string): string | null {
  const row = db
    .prepare(
      `SELECT r.id FROM chat_rooms r
       JOIN chat_members m1 ON m1.room_id = r.id AND m1.user_id = ?
       JOIN chat_members m2 ON m2.room_id = r.id AND m2.user_id = ?
       WHERE r.kind = 'dm' AND (SELECT COUNT(*) FROM chat_members m WHERE m.room_id = r.id) = 2
       LIMIT 1`,
    )
    .get(a, b) as { id: string } | undefined;
  return row?.id ?? null;
}

export function createDirectRoom(ctx: AppContext, a: string, b: string): string {
  if (isBlockedBetween(ctx.db, a, b)) throw forbidden('Conversazione non disponibile');
  const existing = findDirectRoom(ctx.db, a, b);
  if (existing) return existing;
  const id = newId();
  const now = nowMs();
  ctx.db.exec('BEGIN IMMEDIATE');
  try {
    ctx.db
      .prepare("INSERT INTO chat_rooms (id, kind, created_by, created_at, updated_at) VALUES (?, 'dm', ?, ?, ?)")
      .run(id, a, now, now);
    ctx.db
      .prepare("INSERT INTO chat_members (room_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)")
      .run(id, a, now);
    ctx.db
      .prepare("INSERT INTO chat_members (room_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)")
      .run(id, b, now);
    ctx.db.exec('COMMIT');
  } catch (error) {
    ctx.db.exec('ROLLBACK');
    throw error;
  }
  return id;
}

export interface MessagePayload {
  id: string;
  roomId: string;
  senderId: string;
  body: string;
  replyToId: string | null;
  createdAt: number;
}

export interface AttachmentInfo {
  fileId: string;
  name: string;
  size: number;
  mime: string;
  kind: string;
}

export interface OutgoingMessage {
  id: string;
  roomId: string;
  sender: { id: string; username: string; displayName: string };
  body: string;
  replyToId: string | null;
  createdAt: number;
  attachments: AttachmentInfo[];
  reactions: Array<{ emoji: string; count: number; mine: boolean }>;
}

export function messageAttachments(db: AppContext['db'], messageId: string): AttachmentInfo[] {
  const rows = db
    .prepare(
      `SELECT f.id, f.name, f.size, f.mime, f.kind FROM message_attachments a JOIN files f ON f.id = a.file_id
       WHERE a.message_id = ? AND f.deleted_at IS NULL`,
    )
    .all(messageId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    fileId: String(row.id),
    name: String(row.name),
    size: Number(row.size),
    mime: String(row.mime),
    kind: String(row.kind),
  }));
}

export function messageReactions(
  db: AppContext['db'],
  messageId: string,
  viewerId: string,
): Array<{ emoji: string; count: number; mine: boolean }> {
  const rows = db
    .prepare('SELECT emoji, user_id, COUNT(*) OVER (PARTITION BY emoji) AS n FROM reactions WHERE message_id = ?')
    .all(messageId) as Array<{ emoji: string; user_id: string; n: number }>;
  const byEmoji = new Map<string, { emoji: string; count: number; mine: boolean }>();
  for (const row of rows) {
    const entry = byEmoji.get(row.emoji) ?? { emoji: row.emoji, count: Number(row.n), mine: false };
    if (row.user_id === viewerId) entry.mine = true;
    byEmoji.set(row.emoji, entry);
  }
  return [...byEmoji.values()];
}

export function toOutgoingMessage(
  db: AppContext['db'],
  row: { id: string; room_id: string; sender_id: string; body: string; reply_to_id: string | null; created_at: number },
  viewerId: string,
): OutgoingMessage {
  const sender = db.prepare('SELECT username, display_name FROM users WHERE id = ?').get(row.sender_id) as
    | { username: string; display_name: string }
    | undefined;
  return {
    id: row.id,
    roomId: row.room_id,
    sender: {
      id: row.sender_id,
      username: sender?.username ?? '',
      displayName: sender?.display_name ?? '',
    },
    body: row.body,
    replyToId: row.reply_to_id,
    createdAt: row.created_at,
    attachments: messageAttachments(db, row.id),
    reactions: messageReactions(db, row.id, viewerId),
  };
}

export interface SendMessageInput {
  roomId: string;
  senderId: string;
  body: string;
  replyToId?: string | null;
  attachmentFileIds?: string[];
}

export function sendMessage(
  ctx: AppContext,
  input: SendMessageInput,
): { message: OutgoingMessage; memberIds: string[] } {
  const { db } = ctx;
  requireMembership(db, input.roomId, input.senderId);
  const memberIds = roomMemberIds(db, input.roomId);
  const otherMembers = memberIds.filter((id) => id !== input.senderId);
  if (input.roomId) {
    const room = db.prepare('SELECT kind FROM chat_rooms WHERE id = ?').get(input.roomId) as
      | { kind: string }
      | undefined;
    if (room?.kind === 'dm' && otherMembers[0] && isBlockedBetween(db, input.senderId, otherMembers[0])) {
      throw forbidden('Non puoi inviare messaggi a questo utente');
    }
  }

  const attachments: FileRow[] = [];
  for (const fileId of input.attachmentFileIds ?? []) {
    const file = getFile(db, fileId);
    if (!file || file.deleted_at !== null || file.kind !== 'file') throw notFound('Allegato non trovato');
    if (file.owner_id !== input.senderId) throw forbidden('Puoi allegare solo file che possiedi');
    if (file.scan_status !== 'clean') throw forbidden('Allegato non disponibile');
    attachments.push(file);
  }
  if (!input.body.trim() && attachments.length === 0) throw forbidden('Messaggio vuoto');

  if (input.replyToId) {
    const reply = db.prepare('SELECT id, room_id FROM messages WHERE id = ?').get(input.replyToId) as
      | { id: string; room_id: string }
      | undefined;
    if (!reply || reply.room_id !== input.roomId) throw notFound('Messaggio citato non trovato');
  }

  const id = newId();
  const now = nowMs();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      'INSERT INTO messages (id, room_id, sender_id, body, reply_to_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, input.roomId, input.senderId, input.body, input.replyToId ?? null, now);
    for (const file of attachments) {
      db.prepare('INSERT INTO message_attachments (message_id, file_id) VALUES (?, ?)').run(id, file.id);
      for (const memberId of otherMembers) {
        db.prepare(
          `INSERT INTO file_shares (id, file_id, user_id, permission, origin, created_by, created_at)
           VALUES (?, ?, ?, 'read', 'chat', ?, ?)
           ON CONFLICT(file_id, user_id) DO UPDATE SET permission =
             CASE WHEN file_shares.permission = 'write' THEN 'write' ELSE excluded.permission END`,
        ).run(newId(), file.id, memberId, input.senderId, now);
      }
    }
    db.prepare('UPDATE chat_rooms SET updated_at = ? WHERE id = ?').run(now, input.roomId);
    db.prepare('UPDATE chat_members SET last_read_at = ? WHERE room_id = ? AND user_id = ?').run(
      now,
      input.roomId,
      input.senderId,
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as {
    id: string;
    room_id: string;
    sender_id: string;
    body: string;
    reply_to_id: string | null;
    created_at: number;
  };
  const message = toOutgoingMessage(db, row, input.senderId);
  for (const memberId of memberIds) {
    if (memberId === input.senderId) continue;
    ctx.hub.sendToUser(memberId, { type: 'message:new', message: toOutgoingMessage(db, row, memberId) });
    if (!ctx.hub.isOnline(memberId)) {
      ctx.push.notifyUser(memberId, {
        title: ctx.config.branding.name,
        body: `Nuovo messaggio da ${message.sender.displayName}`,
        url: `/chat/${input.roomId}`,
        tag: `room-${input.roomId}`,
      });
    }
  }
  audit(db, {
    actorId: input.senderId,
    action: 'chat.message_sent',
    targetType: 'room',
    targetId: input.roomId,
    meta: { messageId: id, attachments: attachments.length },
  });
  if (attachments.length > 0) {
    audit(db, {
      actorId: input.senderId,
      action: 'chat.attachment_shared',
      targetType: 'message',
      targetId: id,
      meta: { files: attachments.map((file) => file.id) },
    });
  }
  return { message, memberIds };
}

export function roomSummary(ctx: AppContext, roomId: string, userId: string): Record<string, unknown> {
  const { db } = ctx;
  const member = requireMembership(db, roomId, userId);
  const room = db.prepare('SELECT * FROM chat_rooms WHERE id = ?').get(roomId) as
    | { id: string; kind: string; name: string | null; created_at: number; updated_at: number }
    | undefined;
  if (!room) throw notFound('Conversazione non trovata');
  const members = db
    .prepare(
      `SELECT m.user_id, m.last_read_at, m.read_receipts, u.username, u.display_name, u.presence
       FROM chat_members m JOIN users u ON u.id = m.user_id WHERE m.room_id = ? ORDER BY u.display_name COLLATE NOCASE`,
    )
    .all(roomId) as Array<Record<string, unknown>>;
  const others = members.filter((row) => String(row.user_id) !== userId);
  const title = room.kind === 'dm' ? String(others[0]?.display_name ?? 'Chat') : (room.name ?? 'Gruppo');
  const last = db
    .prepare(
      `SELECT id, sender_id, body, created_at FROM messages WHERE room_id = ? AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(roomId) as { id: string; sender_id: string; body: string; created_at: number } | undefined;
  const unread = db
    .prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE room_id = ? AND sender_id != ? AND created_at > ? AND deleted_at IS NULL`,
    )
    .get(roomId, userId, Number(member.last_read_at)) as { n: number };
  return {
    id: room.id,
    kind: room.kind,
    name: room.name,
    title,
    updatedAt: room.updated_at,
    unread: Number(unread.n),
    readReceipts: Boolean(member.read_receipts),
    muted: Boolean(member.muted),
    members: members.map((row) => ({
      id: String(row.user_id),
      username: String(row.username),
      displayName: String(row.display_name),
      status: ctx.hub.isOnline(String(row.user_id)) ? String(row.presence) : 'offline',
    })),
    lastMessage: last
      ? {
          id: last.id,
          senderId: last.sender_id,
          preview: last.body.slice(0, 120),
          createdAt: last.created_at,
        }
      : null,
  };
}

export function assertUserVisible(db: AppContext['db'], userId: string): void {
  const user = db.prepare('SELECT id FROM users WHERE id = ? AND disabled = 0').get(userId);
  if (!user) throw notFound('Utente non trovato');
}

export function attachmentFileJson(db: AppContext['db'], fileId: string, viewerId: string): Record<string, unknown> {
  const file = getFile(db, fileId);
  if (!file) throw notFound('File non trovato');
  return fileJson(db, file, viewerId);
}
