import type { Db } from './db.js';
import { nowMs } from './util.js';

export type AuditAction =
  | 'login.success'
  | 'login.failed'
  | 'login.locked'
  | 'login.2fa_required'
  | 'logout'
  | 'logout.all'
  | 'session.revoked'
  | 'setup.completed'
  | 'admin.user.created'
  | 'admin.user.updated'
  | 'admin.user.disabled'
  | 'admin.user.password_reset'
  | 'admin.invite.created'
  | 'admin.invite.revoked'
  | 'invite.redeemed'
  | 'file.uploaded'
  | 'file.deleted'
  | 'file.purged'
  | 'file.restored'
  | 'file.version_restored'
  | 'share.created'
  | 'share.revoked'
  | 'public_link.created'
  | 'public_link.revoked'
  | 'public_link.downloaded'
  | 'chat.message_sent'
  | 'chat.attachment_shared'
  | 'quick_share.offer'
  | 'quick_share.accepted'
  | 'quick_share.declined'
  | 'quick_share.delivered'
  | 'quick_share.fallback'
  | 'user.blocked'
  | 'user.unblocked'
  | 'user.reported'
  | '2fa.enabled'
  | '2fa.disabled'
  | 'passkey.added'
  | 'passkey.removed'
  | 'password.changed';

export interface AuditInput {
  actorId: string | null;
  action: AuditAction;
  targetType?: string | null;
  targetId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  meta?: Record<string, unknown> | null;
}

export function audit(db: Db, input: AuditInput): void {
  try {
    db.prepare(
      `INSERT INTO audit (actor_id, action, target_type, target_id, ip, user_agent, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.actorId,
      input.action,
      input.targetType ?? null,
      input.targetId ?? null,
      input.ip ?? null,
      (input.userAgent ?? '').slice(0, 250) || null,
      input.meta ? JSON.stringify(input.meta).slice(0, 2000) : null,
      nowMs(),
    );
  } catch {
    // Audit failures must never leak or break the request path; the caller's logger records them elsewhere.
  }
}
