import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { hashPassword, validatePassword } from '../auth/passwords.js';
import { revokeSession } from '../auth/sessions.js';
import type { AppContext } from '../context.js';
import { randomToken, sha256Hex } from '../crypto.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { clientIp, enforceRate, parseBody, requestUserAgent } from '../http/helpers.js';
import { requireAdmin } from '../http/security.js';
import { assertUuid, nowMs, sanitizePlainText } from '../util.js';

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

const createUserSchema = z.object({
  username: z.string().trim().toLowerCase().regex(USERNAME_RE),
  displayName: z.string().trim().min(1).max(100),
  password: z.string().min(12).max(256),
  role: z.enum(['admin', 'user']).default('user'),
  quotaBytes: z.number().int().min(0).max(1_000_000_000_000_000).optional(),
});

export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config } = ctx;

  const activeAdminCount = (): number => {
    const row = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get() as {
      n: number;
    };
    return Number(row.n);
  };

  const userJson = (row: Record<string, unknown>): Record<string, unknown> => ({
    id: String(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    role: String(row.role),
    quotaBytes: Number(row.quota_bytes),
    usedBytes: Number(row.used_bytes),
    disabled: Boolean(Number(row.disabled)),
    totpEnabled: Boolean(Number(row.totp_enabled)),
    presence: String(row.presence),
    createdAt: Number(row.created_at),
  });

  app.get('/api/admin/users', async (req) => {
    requireAdmin(req);
    const rows = db
      .prepare(
        `SELECT id, username, display_name, role, quota_bytes, used_bytes, disabled, totp_enabled, presence, created_at
         FROM users ORDER BY created_at ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    return { users: rows.map(userJson) };
  });

  app.post('/api/admin/users', async (req) => {
    const admin = requireAdmin(req).user;
    enforceRate(ctx.limiter, `admin-create:${admin.id}`, 30, 60 * 60_000);
    const body = parseBody(createUserSchema, req.body);
    const error = validatePassword(body.password, body.username);
    if (error) throw badRequest(error, 'weak_password');
    if (db.prepare('SELECT id FROM users WHERE username = ?').get(body.username))
      throw conflict('Nome utente non disponibile');
    const id = crypto.randomUUID();
    const now = nowMs();
    db.prepare(
      `INSERT INTO users (id, username, display_name, password_hash, role, quota_bytes, password_changed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      body.username,
      sanitizePlainText(body.displayName, 100),
      await hashPassword(body.password),
      body.role,
      body.quotaBytes ?? config.defaultQuotaBytes,
      now,
      now,
      now,
    );
    audit(db, {
      actorId: admin.id,
      action: 'admin.user.created',
      targetType: 'user',
      targetId: id,
      ip: clientIp(req),
      userAgent: requestUserAgent(req),
      meta: { role: body.role, quotaBytes: body.quotaBytes ?? config.defaultQuotaBytes },
    });
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Record<string, unknown>;
    return { user: userJson(row) };
  });

  app.patch('/api/admin/users/:id', async (req) => {
    const admin = requireAdmin(req).user;
    const id = assertUuid((req.params as { id?: string }).id, 'user');
    const body = parseBody(
      z.object({
        displayName: z.string().trim().min(1).max(100).optional(),
        role: z.enum(['admin', 'user']).optional(),
        quotaBytes: z.number().int().min(0).max(1_000_000_000_000_000).optional(),
        disabled: z.boolean().optional(),
      }),
      req.body,
    );
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!target) throw notFound('Utente non trovato');
    const demoting = body.role === 'user' && target.role === 'admin';
    const disabling = body.disabled === true && Number(target.disabled) === 0;
    if (
      (demoting || disabling) &&
      target.role === 'admin' &&
      Number(target.disabled) === 0 &&
      activeAdminCount() <= 1
    ) {
      throw conflict('Deve rimanere almeno un amministratore attivo');
    }
    if (id === admin.id && body.disabled === true) throw badRequest('Non puoi disabilitare il tuo account');
    if (id === admin.id && body.role === 'user') throw badRequest('Non puoi rimuovere il tuo ruolo admin');
    const now = nowMs();
    db.prepare(
      `UPDATE users SET display_name = ?, role = ?, quota_bytes = ?, disabled = ?, updated_at = ? WHERE id = ?`,
    ).run(
      body.displayName ? sanitizePlainText(body.displayName, 100) : String(target.display_name),
      body.role ?? String(target.role),
      body.quotaBytes ?? Number(target.quota_bytes),
      body.disabled === undefined ? Number(target.disabled) : body.disabled ? 1 : 0,
      now,
      id,
    );
    if (disabling) {
      db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, id);
    }
    audit(db, {
      actorId: admin.id,
      action: disabling ? 'admin.user.disabled' : 'admin.user.updated',
      targetType: 'user',
      targetId: id,
      ip: clientIp(req),
      userAgent: requestUserAgent(req),
      meta: { role: body.role, disabled: body.disabled, quotaBytes: body.quotaBytes },
    });
    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Record<string, unknown>;
    return { user: userJson(updated) };
  });

  app.post('/api/admin/users/:id/password', async (req) => {
    const admin = requireAdmin(req).user;
    enforceRate(ctx.limiter, `admin-reset:${admin.id}`, 30, 60 * 60_000);
    const id = assertUuid((req.params as { id?: string }).id, 'user');
    const body = parseBody(z.object({ password: z.string().min(12).max(256) }), req.body);
    const target = db.prepare('SELECT username FROM users WHERE id = ?').get(id) as { username: string } | undefined;
    if (!target) throw notFound('Utente non trovato');
    const error = validatePassword(body.password, target.username);
    if (error) throw badRequest(error, 'weak_password');
    const now = nowMs();
    db.prepare('UPDATE users SET password_hash = ?, password_changed_at = ?, updated_at = ? WHERE id = ?').run(
      await hashPassword(body.password),
      now,
      now,
      id,
    );
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, id);
    audit(db, {
      actorId: admin.id,
      action: 'admin.user.password_reset',
      targetType: 'user',
      targetId: id,
      ip: clientIp(req),
      userAgent: requestUserAgent(req),
    });
    return { ok: true };
  });

  app.get('/api/admin/sessions', async (req) => {
    requireAdmin(req);
    const rows = db
      .prepare(
        `SELECT s.id, s.ip, s.user_agent, s.created_at, s.last_seen_at, s.expires_at,
                u.id AS user_id, u.username, u.display_name
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.revoked_at IS NULL AND s.expires_at > ?
         ORDER BY s.last_seen_at DESC LIMIT 300`,
      )
      .all(nowMs()) as Array<Record<string, unknown>>;
    return {
      sessions: rows.map((row) => ({
        id: String(row.id),
        userId: String(row.user_id),
        username: String(row.username),
        displayName: String(row.display_name),
        ip: String(row.ip),
        userAgent: String(row.user_agent),
        createdAt: Number(row.created_at),
        lastSeenAt: Number(row.last_seen_at),
        expiresAt: Number(row.expires_at),
      })),
    };
  });

  app.delete('/api/admin/sessions/:id', async (req) => {
    const admin = requireAdmin(req).user;
    const id = assertUuid((req.params as { id?: string }).id, 'session');
    const row = db.prepare('SELECT id FROM sessions WHERE id = ?').get(id);
    if (!row) throw notFound('Sessione non trovata');
    revokeSession(db, id);
    audit(db, {
      actorId: admin.id,
      action: 'session.revoked',
      targetType: 'session',
      targetId: id,
      ip: clientIp(req),
      userAgent: requestUserAgent(req),
      meta: { byAdmin: true },
    });
    return { ok: true };
  });

  app.get('/api/admin/audit', async (req) => {
    requireAdmin(req);
    const query = req.query as { limit?: string; before?: string; action?: string };
    const limit = Math.min(200, Math.max(1, Number.parseInt(query.limit ?? '100', 10) || 100));
    const before = Number.parseInt(query.before ?? '', 10);
    const rows = db
      .prepare(
        `SELECT a.id, a.actor_id, a.action, a.target_type, a.target_id, a.ip, a.user_agent, a.meta, a.created_at,
                u.username AS actor_username
         FROM audit a LEFT JOIN users u ON u.id = a.actor_id
         WHERE (? = 0 OR a.id < ?) AND (? = '' OR a.action = ?)
         ORDER BY a.id DESC LIMIT ?`,
      )
      .all(
        Number.isFinite(before) ? before : 0,
        Number.isFinite(before) ? before : 0,
        query.action ?? '',
        query.action ?? '',
        limit,
      ) as Array<Record<string, unknown>>;
    return {
      entries: rows.map((row) => ({
        id: Number(row.id),
        actorId: row.actor_id ? String(row.actor_id) : null,
        actorUsername: row.actor_username ? String(row.actor_username) : null,
        action: String(row.action),
        targetType: row.target_type ? String(row.target_type) : null,
        targetId: row.target_id ? String(row.target_id) : null,
        ip: row.ip ? String(row.ip) : null,
        userAgent: row.user_agent ? String(row.user_agent) : null,
        meta: row.meta ? (JSON.parse(String(row.meta)) as unknown) : null,
        createdAt: Number(row.created_at),
      })),
    };
  });

  app.post('/api/admin/invites', async (req) => {
    const admin = requireAdmin(req).user;
    enforceRate(ctx.limiter, `admin-invite:${admin.id}`, 30, 60 * 60_000);
    const body = parseBody(
      z.object({
        role: z.enum(['admin', 'user']).default('user'),
        expiresInHours: z.number().int().min(1).max(168).default(24),
      }),
      req.body,
    );
    const token = randomToken(32);
    const id = crypto.randomUUID();
    const now = nowMs();
    const expiresAt = now + body.expiresInHours * 60 * 60_000;
    db.prepare(
      'INSERT INTO invites (id, token_hash, created_by, role, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, sha256Hex(token), admin.id, body.role, expiresAt, now);
    audit(db, {
      actorId: admin.id,
      action: 'admin.invite.created',
      targetType: 'invite',
      targetId: id,
      ip: clientIp(req),
      userAgent: requestUserAgent(req),
      meta: { role: body.role, expiresInHours: body.expiresInHours },
    });
    return { invite: { id, token, role: body.role, expiresAt, url: `/invite/${token}` } };
  });

  app.get('/api/admin/invites', async (req) => {
    requireAdmin(req);
    const rows = db
      .prepare(
        `SELECT i.id, i.role, i.expires_at, i.used_at, i.created_at, i.used_by, u.username AS creator
         FROM invites i LEFT JOIN users u ON u.id = i.created_by ORDER BY i.created_at DESC LIMIT 100`,
      )
      .all() as Array<Record<string, unknown>>;
    return {
      invites: rows.map((row) => ({
        id: String(row.id),
        role: String(row.role),
        expiresAt: Number(row.expires_at),
        usedAt: row.used_at ? Number(row.used_at) : null,
        createdAt: Number(row.created_at),
        creator: row.creator ? String(row.creator) : null,
      })),
    };
  });

  app.delete('/api/admin/invites/:id', async (req) => {
    const admin = requireAdmin(req).user;
    const id = assertUuid((req.params as { id?: string }).id, 'invite');
    const result = db.prepare('DELETE FROM invites WHERE id = ? AND used_at IS NULL').run(id);
    if (Number(result.changes) === 0) throw notFound('Invito non trovato');
    audit(db, {
      actorId: admin.id,
      action: 'admin.invite.revoked',
      targetType: 'invite',
      targetId: id,
      ip: clientIp(req),
      userAgent: requestUserAgent(req),
    });
    return { ok: true };
  });

  app.get('/api/admin/reports', async (req) => {
    requireAdmin(req);
    const rows = db
      .prepare(
        `SELECT r.id, r.reason, r.message_id, r.created_at, r.resolved_at,
                rp.username AS reporter, tp.username AS target
         FROM reports r
         JOIN users rp ON rp.id = r.reporter_id
         JOIN users tp ON tp.id = r.target_user_id
         ORDER BY r.resolved_at IS NOT NULL, r.created_at DESC LIMIT 200`,
      )
      .all() as Array<Record<string, unknown>>;
    return {
      reports: rows.map((row) => ({
        id: String(row.id),
        reporter: String(row.reporter),
        target: String(row.target),
        reason: String(row.reason),
        messageId: row.message_id ? String(row.message_id) : null,
        createdAt: Number(row.created_at),
        resolvedAt: row.resolved_at ? Number(row.resolved_at) : null,
      })),
    };
  });

  app.post('/api/admin/reports/:id/resolve', async (req) => {
    requireAdmin(req);
    const id = assertUuid((req.params as { id?: string }).id, 'report');
    const result = db
      .prepare('UPDATE reports SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL')
      .run(nowMs(), id);
    if (Number(result.changes) === 0) throw notFound('Segnalazione non trovata');
    return { ok: true };
  });

  app.get('/api/admin/stats', async (req) => {
    requireAdmin(req);
    const users = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(used_bytes), 0) AS used FROM users').get() as {
      n: number;
      used: number;
    };
    const files = db.prepare('SELECT COUNT(*) AS n FROM files WHERE kind = ? AND deleted_at IS NULL').get('file') as {
      n: number;
    };
    const sessions = db
      .prepare('SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL AND expires_at > ?')
      .get(nowMs()) as {
      n: number;
    };
    const dbStats = db.prepare('PRAGMA page_count').get() as { page_count: number };
    const dbPage = db.prepare('PRAGMA page_size').get() as { page_size: number };
    return {
      stats: {
        users: Number(users.n),
        usedBytes: Number(users.used),
        files: Number(files.n),
        activeSessions: Number(sessions.n),
        databaseBytes: Number(dbStats.page_count) * Number(dbPage.page_size),
        uptimeSeconds: Math.floor((nowMs() - ctx.startedAt) / 1000),
      },
    };
  });
}
