import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  assertUserVisible,
  createDirectRoom,
  isBlockedBetween,
  messageReactions,
  requireMembership,
  roomMemberIds,
  roomSummary,
  sendMessage,
  toOutgoingMessage,
} from '../chat/service.js';
import type { AppContext } from '../context.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { enforceRate, parseBody } from '../http/helpers.js';
import { requireAuth } from '../http/security.js';
import { assertUuid, newId, nowMs, sanitizePlainText } from '../util.js';

const MESSAGE_MAX = 8000;

export function registerChatRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get('/api/chat/rooms', async (req) => {
    const { user } = requireAuth(req);
    const rows = db
      .prepare(`SELECT room_id FROM chat_members WHERE user_id = ? ORDER BY joined_at DESC LIMIT 200`)
      .all(user.id) as Array<{ room_id: string }>;
    const rooms = rows.map((row) => roomSummary(ctx, row.room_id, user.id));
    const lastActivity = (room: Record<string, unknown>): number => {
      const last = room.lastMessage as { createdAt?: number } | null;
      return last?.createdAt ?? Number(room.updatedAt);
    };
    rooms.sort((a, b) => lastActivity(b) - lastActivity(a));
    return { rooms };
  });

  app.post('/api/chat/rooms', async (req) => {
    const { user } = requireAuth(req);
    enforceRate(ctx.limiter, `chat-room:${user.id}`, 30, 60 * 60_000);
    const body = parseBody(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('dm'), userId: z.string().uuid() }),
        z.object({
          kind: z.enum(['group', 'channel']),
          name: z.string().trim().min(1).max(80),
          memberIds: z.array(z.string().uuid()).min(0).max(49),
        }),
      ]),
      req.body,
    );
    if (body.kind === 'dm') {
      if (body.userId === user.id) throw badRequest('Non puoi chattare con te stesso');
      assertUserVisible(db, body.userId);
      if (isBlockedBetween(db, user.id, body.userId)) throw forbidden('Conversazione non disponibile');
      const roomId = createDirectRoom(ctx, user.id, body.userId);
      return { room: roomSummary(ctx, roomId, user.id) };
    }
    const ids = [...new Set(body.memberIds.filter((id) => id !== user.id))];
    if (ids.length + 1 > 50) throw badRequest('Troppi partecipanti');
    for (const id of ids) assertUserVisible(db, id);
    const roomId = newId();
    const now = nowMs();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        'INSERT INTO chat_rooms (id, kind, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(roomId, body.kind, sanitizePlainText(body.name, 80), user.id, now, now);
      db.prepare("INSERT INTO chat_members (room_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)").run(
        roomId,
        user.id,
        now,
      );
      for (const id of ids) {
        db.prepare("INSERT INTO chat_members (room_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)").run(
          roomId,
          id,
          now,
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    for (const id of ids) {
      ctx.hub.sendToUser(id, { type: 'room:created', roomId });
    }
    return { room: roomSummary(ctx, roomId, user.id) };
  });

  app.get('/api/chat/rooms/:id/messages', async (req) => {
    const { user } = requireAuth(req);
    const id = assertUuid((req.params as { id?: string }).id, 'room');
    requireMembership(db, id, user.id);
    const query = req.query as { before?: string; limit?: string; q?: string };
    const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
    const before = Number.parseInt(query.before ?? '', 10);
    const members = db
      .prepare('SELECT user_id, last_read_at, read_receipts FROM chat_members WHERE room_id = ?')
      .all(id) as Array<{ user_id: string; last_read_at: number; read_receipts: number }>;
    let rows: Array<{
      id: string;
      room_id: string;
      sender_id: string;
      body: string;
      reply_to_id: string | null;
      created_at: number;
    }>;
    if (query.q && query.q.trim()) {
      const term = query.q
        .trim()
        .slice(0, 200)
        .replace(/[\\%_]/g, (char) => `\\${char}`);
      rows = db
        .prepare(
          `SELECT id, room_id, sender_id, body, reply_to_id, created_at FROM messages
           WHERE room_id = ? AND deleted_at IS NULL AND body LIKE ? ESCAPE '\\'
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(id, `%${term}%`, limit) as typeof rows;
    } else {
      rows = db
        .prepare(
          `SELECT id, room_id, sender_id, body, reply_to_id, created_at FROM messages
           WHERE room_id = ? AND deleted_at IS NULL AND (? = 0 OR created_at < ?)
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(id, Number.isFinite(before) ? before : 0, Number.isFinite(before) ? before : 0, limit) as typeof rows;
    }
    const messages = rows.reverse().map((row) => {
      const message = toOutgoingMessage(db, row, user.id);
      const reply = row.reply_to_id
        ? (db
            .prepare(
              `SELECT m.body, m.sender_id, u.display_name FROM messages m JOIN users u ON u.id = m.sender_id
               WHERE m.id = ? AND m.room_id = ? AND m.deleted_at IS NULL`,
            )
            .get(row.reply_to_id, id) as { body: string; display_name: string } | undefined)
        : undefined;
      const readBy = members.filter(
        (member) =>
          member.user_id !== row.sender_id &&
          Number(member.read_receipts) === 1 &&
          Number(member.last_read_at) >= row.created_at,
      ).length;
      return {
        ...message,
        replyTo: reply ? { body: reply.body.slice(0, 200), senderName: reply.display_name } : null,
        readBy,
      };
    });
    return { messages, hasMore: rows.length >= limit };
  });

  app.post('/api/chat/rooms/:id/messages', async (req) => {
    const { user } = requireAuth(req);
    enforceRate(ctx.limiter, `message:${user.id}`, 120, 60_000);
    const id = assertUuid((req.params as { id?: string }).id, 'room');
    requireMembership(db, id, user.id);
    const body = parseBody(
      z.object({
        body: z.string().max(MESSAGE_MAX).default(''),
        replyToId: z.string().uuid().nullable().optional(),
        attachmentFileIds: z.array(z.string().uuid()).max(10).optional(),
      }),
      req.body,
    );
    const text = body.body.trim() === '' ? '' : sanitizePlainText(body.body, MESSAGE_MAX);
    const result = sendMessage(ctx, {
      roomId: id,
      senderId: user.id,
      body: text,
      replyToId: body.replyToId ?? null,
      attachmentFileIds: body.attachmentFileIds ?? [],
    });
    return { message: result.message };
  });

  app.delete('/api/messages/:id', async (req) => {
    const { user } = requireAuth(req);
    const id = assertUuid((req.params as { id?: string }).id, 'message');
    const row = db.prepare('SELECT id, room_id, sender_id, created_at FROM messages WHERE id = ?').get(id) as
      | { id: string; room_id: string; sender_id: string; created_at: number }
      | undefined;
    if (!row) throw notFound('Messaggio non trovato');
    if (row.sender_id !== user.id) throw forbidden('Puoi eliminare solo i tuoi messaggi');
    requireMembership(db, row.room_id, user.id);
    const cutoff = nowMs() - 24 * 60 * 60_000;
    if (row.created_at < cutoff) throw forbidden('Puoi eliminare solo i messaggi delle ultime 24 ore');
    db.prepare("UPDATE messages SET body = '', deleted_at = ? WHERE id = ?").run(nowMs(), id);
    for (const memberId of roomMemberIds(db, row.room_id)) {
      ctx.hub.sendToUser(memberId, { type: 'message:deleted', roomId: row.room_id, messageId: id });
    }
    return { ok: true };
  });

  app.post('/api/messages/:id/reactions', async (req) => {
    const { user } = requireAuth(req);
    enforceRate(ctx.limiter, `reaction:${user.id}`, 120, 60_000);
    const id = assertUuid((req.params as { id?: string }).id, 'message');
    const body = parseBody(z.object({ emoji: z.string().min(1).max(16) }), req.body);
    const message = db.prepare('SELECT id, room_id FROM messages WHERE id = ? AND deleted_at IS NULL').get(id) as
      | { id: string; room_id: string }
      | undefined;
    if (!message) throw notFound('Messaggio non trovato');
    requireMembership(db, message.room_id, user.id);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately rejecting control characters in emoji
    if (/[\u0000-\u001f\u007f]/.test(body.emoji)) throw badRequest('Reazione non valida');
    const existing = db
      .prepare('SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?')
      .get(id, user.id, body.emoji);
    if (existing) {
      db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(
        id,
        user.id,
        body.emoji,
      );
    } else {
      db.prepare('INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)').run(
        id,
        user.id,
        body.emoji,
        nowMs(),
      );
    }
    for (const memberId of roomMemberIds(db, message.room_id)) {
      ctx.hub.sendToUser(memberId, {
        type: 'message:reactions',
        roomId: message.room_id,
        messageId: id,
        reactions: messageReactions(db, id, memberId),
      });
    }
    return { reactions: messageReactions(db, id, user.id) };
  });

  app.post('/api/chat/rooms/:id/read', async (req) => {
    const { user } = requireAuth(req);
    const id = assertUuid((req.params as { id?: string }).id, 'room');
    const member = requireMembership(db, id, user.id);
    const body = parseBody(z.object({ messageId: z.string().uuid().optional() }), req.body);
    let readAt = nowMs();
    if (body.messageId) {
      const message = db
        .prepare('SELECT created_at FROM messages WHERE id = ? AND room_id = ?')
        .get(body.messageId, id) as { created_at: number } | undefined;
      if (message) readAt = message.created_at;
    }
    db.prepare('UPDATE chat_members SET last_read_at = ? WHERE room_id = ? AND user_id = ?').run(readAt, id, user.id);
    if (member.read_receipts) {
      for (const memberId of roomMemberIds(db, id)) {
        if (memberId === user.id) continue;
        ctx.hub.sendToUser(memberId, { type: 'read:update', roomId: id, userId: user.id, lastReadAt: readAt });
      }
    }
    return { ok: true, lastReadAt: readAt };
  });

  app.patch('/api/chat/rooms/:id', async (req) => {
    const { user } = requireAuth(req);
    const id = assertUuid((req.params as { id?: string }).id, 'room');
    const member = requireMembership(db, id, user.id);
    const body = parseBody(
      z.object({
        name: z.string().trim().min(1).max(80).optional(),
        readReceipts: z.boolean().optional(),
        muted: z.boolean().optional(),
      }),
      req.body,
    );
    const room = db.prepare('SELECT kind, created_by FROM chat_rooms WHERE id = ?').get(id) as
      | { kind: string; created_by: string }
      | undefined;
    if (!room) throw notFound('Conversazione non trovata');
    if (body.name !== undefined) {
      if (room.kind === 'dm') throw badRequest('Le chat dirette non hanno un nome');
      if (room.created_by !== user.id && member.role !== 'owner') throw forbidden('Solo il creatore può rinominare');
      db.prepare('UPDATE chat_rooms SET name = ?, updated_at = ? WHERE id = ?').run(
        sanitizePlainText(body.name, 80),
        nowMs(),
        id,
      );
    }
    if (body.readReceipts !== undefined) {
      db.prepare('UPDATE chat_members SET read_receipts = ? WHERE room_id = ? AND user_id = ?').run(
        body.readReceipts ? 1 : 0,
        id,
        user.id,
      );
    }
    if (body.muted !== undefined) {
      db.prepare('UPDATE chat_members SET muted = ? WHERE room_id = ? AND user_id = ?').run(
        body.muted ? 1 : 0,
        id,
        user.id,
      );
    }
    return { room: roomSummary(ctx, id, user.id) };
  });
}
