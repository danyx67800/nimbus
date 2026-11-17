import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { createDirectRoom, isBlockedBetween, sendMessage } from '../chat/service.js';
import type { AppContext } from '../context.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { getFile } from '../files/access.js';
import { clientIp, enforceRate, parseBody, requestUserAgent } from '../http/helpers.js';
import { requireAuth } from '../http/security.js';
import { assertUuid, newId, nowMs, sanitizeFileName } from '../util.js';

interface TransferRow {
  id: string;
  from_user: string;
  to_user: string;
  file_name: string;
  size: number;
  mime: string;
  sha256: string;
  status: string;
  message_id: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

const CHECKSUM = /^[a-f0-9]{64}$/i;
const ACTIVE_STATUSES = ['pending', 'accepted', 'offline', 'failed', 'declined', 'cancelled', 'timeout'];

function transferFor(ctx: AppContext, id: string): TransferRow {
  const row = ctx.db.prepare('SELECT * FROM transfers WHERE id = ?').get(id) as TransferRow | undefined;
  if (!row) throw notFound('Trasferimento non trovato');
  return row;
}

function assertParticipant(transfer: TransferRow, userId: string): void {
  if (transfer.from_user !== userId && transfer.to_user !== userId) throw notFound('Trasferimento non trovato');
}

function assertRecipient(ctx: AppContext, fromUser: string, toUserId: string): { id: string; displayName: string } {
  if (toUserId === fromUser) throw badRequest('Destinatario non valido');
  const row = ctx.db.prepare('SELECT id, display_name, quick_share, disabled FROM users WHERE id = ?').get(toUserId) as
    | { id: string; display_name: string; quick_share: number; disabled: number }
    | undefined;
  if (!row || row.disabled) throw notFound('Destinatario non trovato');
  if (!row.quick_share) throw forbidden('Il destinatario ha disattivato la condivisione rapida');
  if (isBlockedBetween(ctx.db, fromUser, toUserId)) throw forbidden('Trasferimento non consentito');
  return { id: row.id, displayName: row.display_name };
}

function validateTransferPayload(
  ctx: AppContext,
  body: {
    fileName: string;
    size: number;
    mime: string;
    sha256: string;
  },
): void {
  if (!Number.isSafeInteger(body.size) || body.size < 0 || body.size > ctx.config.maxQuickShareBytes) {
    throw badRequest('Dimensione non consentita');
  }
  if (!CHECKSUM.test(body.sha256)) throw badRequest('Checksum non valido');
}

export function registerQuickShareRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Offline recipients start a transfer server-side before the encrypted upload.
  app.post('/api/quick-share/offline', async (req) => {
    const { user } = requireAuth(req);
    enforceRate(ctx.limiter, `qs-rest:${user.id}`, 20, 10 * 60_000);
    const body = parseBody(
      z.object({
        toUserId: z.string().uuid(),
        fileName: z.string().min(1).max(200),
        size: z.number().int().min(0),
        mime: z.string().max(120).default('application/octet-stream'),
        sha256: z.string().regex(CHECKSUM),
      }),
      req.body,
    );
    validateTransferPayload(ctx, body);
    assertRecipient(ctx, user.id, body.toUserId);
    if (!ctx.hub.isOnline(body.toUserId) || ctx.hub.presenceFor(body.toUserId) === 'offline') {
      // Offline delivery is expected to go through chat.
    }
    const id = newId();
    const now = nowMs();
    ctx.db
      .prepare(
        `INSERT INTO transfers (id, from_user, to_user, file_name, size, mime, sha256, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'offline', ?, ?)`,
      )
      .run(
        id,
        user.id,
        body.toUserId,
        sanitizeFileName(body.fileName),
        body.size,
        body.mime,
        body.sha256.toLowerCase(),
        now,
        now,
      );
    audit(ctx.db, {
      actorId: user.id,
      action: 'quick_share.offer',
      targetType: 'transfer',
      targetId: id,
      meta: { to: body.toUserId, size: body.size, offline: true },
    });
    return { transferId: id };
  });

  app.post('/api/quick-share/:id/fallback', async (req) => {
    const { user } = requireAuth(req);
    enforceRate(ctx.limiter, `qs-fallback:${user.id}`, 30, 10 * 60_000);
    const id = assertUuid((req.params as { id?: string }).id, 'transfer');
    const body = parseBody(z.object({ fileId: z.string().uuid() }), req.body);
    const transfer = transferFor(ctx, id);
    if (transfer.from_user !== user.id) throw notFound('Trasferimento non trovato');
    if (!ACTIVE_STATUSES.includes(transfer.status)) throw badRequest('Trasferimento già completato');
    const file = getFile(ctx.db, body.fileId);
    if (!file || file.owner_id !== user.id || file.kind !== 'file' || file.deleted_at !== null) {
      throw notFound('File non trovato');
    }
    if (file.scan_status !== 'clean') throw forbidden('Il file non è disponibile');
    if (file.size !== transfer.size || file.checksum !== transfer.sha256) {
      throw badRequest('Il file caricato non corrisponde al trasferimento');
    }
    assertRecipient(ctx, user.id, transfer.to_user);
    const roomId = createDirectRoom(ctx, user.id, transfer.to_user);
    const sent = sendMessage(ctx, {
      roomId,
      senderId: user.id,
      body: '',
      attachmentFileIds: [file.id],
    });
    ctx.db
      .prepare("UPDATE transfers SET status = 'delivered_chat', message_id = ?, updated_at = ? WHERE id = ?")
      .run(sent.message.id, nowMs(), transfer.id);
    audit(ctx.db, {
      actorId: user.id,
      action: 'quick_share.fallback',
      targetType: 'transfer',
      targetId: transfer.id,
      ip: clientIp(req),
      userAgent: requestUserAgent(req),
      meta: { fileId: file.id, roomId, messageId: sent.message.id },
    });
    return {
      status: 'delivered_chat',
      message: sent.message,
      roomId,
    };
  });

  app.get('/api/quick-share/:id', async (req) => {
    const { user } = requireAuth(req);
    const id = assertUuid((req.params as { id?: string }).id, 'transfer');
    const transfer = transferFor(ctx, id);
    assertParticipant(transfer, user.id);
    return {
      transfer: {
        id: transfer.id,
        fromUserId: transfer.from_user,
        toUserId: transfer.to_user,
        fileName: transfer.file_name,
        size: transfer.size,
        mime: transfer.mime,
        sha256: transfer.sha256,
        status: transfer.status,
        messageId: transfer.message_id,
        createdAt: transfer.created_at,
      },
    };
  });

  app.get('/api/quick-share/limits', async (req) => {
    requireAuth(req);
    return {
      maxBytes: ctx.config.maxQuickShareBytes,
      offerTimeoutSeconds: 60,
      maxParticipantsPerCall: 4,
    };
  });
}
