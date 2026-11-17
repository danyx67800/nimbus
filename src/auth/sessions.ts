import type { Config } from '../config.js';
import { hmacSha256, randomToken, sha256Hex } from '../crypto.js';
import type { Db } from '../db.js';
import { newId, nowMs } from '../util.js';

export interface SessionRow {
  id: string;
  user_id: string;
  csrf_hash: string;
  ip: string;
  user_agent: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  revoked_at: number | null;
}

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  role: 'admin' | 'user';
  quota_bytes: number;
  used_bytes: number;
  disabled: number;
  totp_enabled: number;
  presence: 'online' | 'away' | 'dnd' | 'hidden';
  read_receipts: number;
  quick_share: number;
  locale: string;
  theme: string;
  password_changed_at: number;
  created_at: number;
  updated_at: number;
}

export interface SessionBundle {
  token: string;
  csrfToken: string;
  sessionId: string;
  expiresAt: number;
}

export function csrfFor(csrfKey: Buffer, sessionId: string): string {
  return hmacSha256(csrfKey, `csrf:${sessionId}`).toString('base64url');
}

export function createSession(
  db: Db,
  config: Config,
  secrets: { csrfKey: Buffer },
  input: { userId: string; ip: string; userAgent: string },
): SessionBundle {
  const id = newId();
  const token = randomToken(32);
  const csrfToken = csrfFor(secrets.csrfKey, id);
  const now = nowMs();
  const expiresAt = now + config.sessionTtlDays * 24 * 60 * 60 * 1000;
  db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, csrf_hash, ip, user_agent, created_at, last_seen_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.userId,
    sha256Hex(token),
    sha256Hex(csrfToken),
    input.ip.slice(0, 100),
    input.userAgent.slice(0, 250),
    now,
    now,
    expiresAt,
  );
  return { token, csrfToken, sessionId: id, expiresAt };
}

export function resolveSession(db: Db, token: string | undefined): { session: SessionRow; user: UserRow } | null {
  if (!token || token.length < 20 || token.length > 200) return null;
  const row = db
    .prepare(
      `SELECT s.id, s.user_id, s.csrf_hash, s.ip, s.user_agent, s.created_at, s.last_seen_at, s.expires_at, s.revoked_at,
              u.id AS u_id, u.username, u.display_name, u.role, u.quota_bytes, u.used_bytes, u.disabled,
              u.totp_enabled, u.presence, u.read_receipts, u.quick_share, u.locale, u.theme,
              u.password_changed_at, u.created_at AS u_created_at, u.updated_at AS u_updated_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    )
    .get(sha256Hex(token)) as Record<string, unknown> | undefined;
  if (!row) return null;
  const now = nowMs();
  if (Number(row.expires_at) <= now || row.revoked_at !== null || Number(row.disabled) !== 0) return null;
  if (now - Number(row.last_seen_at) > 5 * 60_000) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now, String(row.id));
  }
  return {
    session: {
      id: String(row.id),
      user_id: String(row.user_id),
      csrf_hash: String(row.csrf_hash),
      ip: String(row.ip),
      user_agent: String(row.user_agent),
      created_at: Number(row.created_at),
      last_seen_at: Number(row.last_seen_at),
      expires_at: Number(row.expires_at),
      revoked_at: null,
    },
    user: {
      id: String(row.u_id),
      username: String(row.username),
      display_name: String(row.display_name),
      role: row.role === 'admin' ? 'admin' : 'user',
      quota_bytes: Number(row.quota_bytes),
      used_bytes: Number(row.used_bytes),
      disabled: Number(row.disabled),
      totp_enabled: Number(row.totp_enabled),
      presence: row.presence as UserRow['presence'],
      read_receipts: Number(row.read_receipts),
      quick_share: Number(row.quick_share),
      locale: String(row.locale),
      theme: String(row.theme),
      password_changed_at: Number(row.password_changed_at),
      created_at: Number(row.u_created_at),
      updated_at: Number(row.u_updated_at),
    },
  };
}

export function revokeSession(db: Db, sessionId: string): void {
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(nowMs(), sessionId);
}

export function revokeAllSessions(db: Db, userId: string, exceptSessionId?: string): void {
  const now = nowMs();
  if (exceptSessionId) {
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL').run(
      now,
      userId,
      exceptSessionId,
    );
  } else {
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, userId);
  }
}

export function purgeExpiredSessions(db: Db): void {
  const cutoff = nowMs() - 30 * 24 * 60 * 60 * 1000;
  db.prepare('DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)').run(
    nowMs(),
    cutoff,
  );
}

export function setSessionCookie(
  reply: { setCookie: (name: string, value: string, options: Record<string, unknown>) => unknown },
  config: Config,
  token: string,
  expiresAt: number,
  secure: boolean,
): void {
  reply.setCookie(config.cookieName, token, {
    path: '/',
    httpOnly: true,
    secure,
    sameSite: 'strict',
    maxAge: Math.max(1, Math.floor((expiresAt - nowMs()) / 1000)),
    expires: new Date(expiresAt),
  });
}

export function clearSessionCookie(
  reply: { clearCookie: (name: string, options: Record<string, unknown>) => unknown },
  config: Config,
  secure: boolean,
): void {
  reply.clearCookie(config.cookieName, { path: '/', httpOnly: true, sameSite: 'strict', secure });
}

export function publicUser(user: UserRow): Record<string, unknown> {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
    quotaBytes: user.quota_bytes,
    usedBytes: user.used_bytes,
    totpEnabled: Boolean(user.totp_enabled),
    presence: user.presence,
    readReceipts: Boolean(user.read_receipts),
    quickShare: Boolean(user.quick_share),
    locale: user.locale,
    theme: user.theme,
    createdAt: user.created_at,
  };
}
