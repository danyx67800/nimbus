import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { hashPassword, validatePassword, verifyAgainstDummy, verifyPassword } from '../auth/passwords.js';
import {
  createSession,
  publicUser,
  revokeAllSessions,
  revokeSession,
  setSessionCookie,
  type UserRow,
} from '../auth/sessions.js';
import { generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, otpauthUrl, verifyTotp } from '../auth/totp.js';
import { shouldUseSecureCookie } from '../config.js';
import type { AppContext } from '../context.js';
import { randomToken, sha256Hex, unwrapKey, wrapKey } from '../crypto.js';
import { badRequest, conflict, forbidden, HttpError, notFound, unauthorized } from '../errors.js';
import { clientIp, enforceRate, parseBody, requestUserAgent } from '../http/helpers.js';
import { csrfForSession, requireAuth } from '../http/security.js';
import { assertUuid, nowMs, sanitizeFileName, sanitizePlainText } from '../util.js';

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

const credentialsSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(300),
});

const setupSchema = z.object({
  username: z.string().trim().toLowerCase().regex(USERNAME_RE),
  displayName: z.string().trim().min(1).max(100),
  password: z.string().min(12).max(256),
});

function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

function sessionPayload(ctx: AppContext, user: UserRow, sessionId: string, expiresAt: number): Record<string, unknown> {
  return {
    user: publicUser(user),
    csrfToken: csrfForSession(ctx.secrets, sessionId),
    expiresAt,
  };
}

function setCookieFor(
  ctx: AppContext,
  reply: FastifyReply,
  req: FastifyRequest,
  token: string,
  expiresAt: number,
): void {
  const secure = shouldUseSecureCookie(ctx.config, req.protocol, req.hostname);
  setSessionCookie(reply, ctx.config, token, expiresAt, secure);
}

function authUser(db: AppContext['db'], id: string): UserRow | null {
  const row = db
    .prepare(
      `SELECT id, username, display_name, role, quota_bytes, used_bytes, disabled, totp_enabled,
              presence, read_receipts, quick_share, locale, theme, password_changed_at, created_at, updated_at
       FROM users WHERE id = ?`,
    )
    .get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: String(row.id),
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
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

function totpSecretFor(ctx: AppContext, user: UserRow): string | null {
  const row = ctx.db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(user.id) as
    | { totp_secret: string | null }
    | undefined;
  if (!row?.totp_secret) return null;
  try {
    return unwrapKey(ctx.secrets.masterKey, row.totp_secret, `totp:${user.id}`).toString('utf8');
  } catch {
    return null;
  }
}

function isLocalHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.lan') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.home') ||
    hostname.endsWith('.home.arpa') ||
    hostname.endsWith('.test') ||
    hostname.endsWith('.example') ||
    hostname.endsWith('.invalid')
  );
}

function relyingParty(req: FastifyRequest, ctx: AppContext): { origin: string; rpId: string } {
  const originHeader = req.headers.origin;
  if (!originHeader) throw badRequest('Origine mancante per WebAuthn');
  let parsed: URL;
  try {
    parsed = new URL(originHeader);
  } catch {
    throw badRequest('Origine non valida');
  }
  const host = req.headers.host;
  if (!host || parsed.host.toLowerCase() !== host.toLowerCase()) throw forbidden('Origine WebAuthn non corrispondente');
  if (!ctx.config.extraOrigins.includes(parsed.origin) && parsed.origin !== `${req.protocol}://${host}`) {
    throw forbidden('Origine WebAuthn non consentita');
  }
  // RP_ID is optional and only useful for a stable custom domain. If it does
  // not cover the hostname the browser is currently on, ignore it: a stale
  // value (for example "umbrel.local" while the app is opened through another
  // name) makes the browser reject every WebAuthn ceremony.
  const hostname = parsed.hostname.toLowerCase();
  const configuredRpId = ctx.config.rpId?.toLowerCase().replace(/\.$/, '') ?? null;
  // Chromium requires both the page host and the RP ID to be under a PSL
  // registry. Local names (.local, .lan, .home, …) are not, so a parent suffix
  // such as "umbrel.local" is rejected on "nimbus.umbrel.local": there the RP
  // ID must match the host exactly. Keep suffix sharing for public domains.
  const configuredMatchesHost =
    configuredRpId !== null &&
    (hostname === configuredRpId ||
      (configuredRpId.includes('.') &&
        !isLocalHostname(hostname) &&
        !isLocalHostname(configuredRpId) &&
        hostname.endsWith(`.${configuredRpId}`)));
  const rpId = configuredMatchesHost ? configuredRpId : hostname;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rpId) || rpId.includes(':')) {
    throw badRequest('Le passkey richiedono un nome host (non un indirizzo IP). Usa un dominio HTTPS.');
  }
  return { origin: parsed.origin, rpId };
}

function storeChallenge(
  ctx: AppContext,
  kind: string,
  userId: string | null,
  data: Record<string, unknown>,
): { challengeId: string; token: string } {
  const id = randomToken(24);
  const expiresAt = nowMs() + 5 * 60_000;
  ctx.db
    .prepare(
      'INSERT INTO auth_challenges (id, user_id, kind, token_hash, data, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(id, userId, kind, sha256Hex(id), JSON.stringify(data), nowMs(), expiresAt);
  return { challengeId: id, token: id };
}

function takeChallenge(
  ctx: AppContext,
  challengeId: string,
  kind: string,
  userId: string | null,
): Record<string, unknown> | null {
  if (typeof challengeId !== 'string' || challengeId.length < 16 || challengeId.length > 80) return null;
  const row = ctx.db
    .prepare('SELECT id, user_id, data, expires_at, used_at FROM auth_challenges WHERE token_hash = ? AND kind = ?')
    .get(sha256Hex(challengeId), kind) as
    | { id: string; user_id: string | null; data: string; expires_at: number; used_at: number | null }
    | undefined;
  if (!row || row.used_at !== null || Number(row.expires_at) < nowMs()) return null;
  if (row.user_id !== userId) return null;
  ctx.db.prepare('UPDATE auth_challenges SET used_at = ? WHERE id = ?').run(nowMs(), row.id);
  try {
    return JSON.parse(row.data) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { config, db, secrets, logger } = ctx;
  const setupCompleted = (): boolean => {
    const count = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    return Number(count.n) > 0;
  };
  const setupWindowOpen = (): boolean =>
    !setupCompleted() && nowMs() - ctx.startedAt < config.setupWindowMinutes * 60_000;

  app.get('/api/config', async () => ({
    appName: config.branding.name,
    version: config.appVersion,
    tagline: config.branding.tagline,
    defaultLocale: config.branding.defaultLocale,
    needsSetup: !setupCompleted(),
    setupWindowOpen: setupWindowOpen(),
    maxUploadBytes: config.maxUploadBytes,
    maxQuickShareBytes: config.maxQuickShareBytes,
    turnConfigured: config.turnUrls.length > 0,
    vapidPublicKey: ctx.push.publicKey,
    features: { passkeys: true, push: true },
  }));

  app.get('/api/setup/status', async () => ({
    needsSetup: !setupCompleted(),
    setupWindowOpen: setupWindowOpen(),
    appName: config.branding.name,
  }));

  app.post('/api/setup', async (req, reply) => {
    enforceRate(ctx.limiter, `setup:${clientIp(req)}`, 5, 15 * 60_000);
    if (setupCompleted()) throw conflict('Configurazione già completata');
    if (!setupWindowOpen()) {
      throw forbidden('La finestra di configurazione iniziale è scaduta. Riavvia il servizio per riaprirla.');
    }
    const body = parseBody(setupSchema, req.body);
    const username = normalizeUsername(body.username);
    const displayName = sanitizePlainText(body.displayName, 100);
    const passwordError = validatePassword(body.password, username);
    if (passwordError) throw badRequest(passwordError, 'weak_password');
    const passwordHash = await hashPassword(body.password);
    const id = crypto.randomUUID();
    const now = nowMs();
    db.prepare(
      `INSERT INTO users (id, username, display_name, password_hash, role, quota_bytes, password_changed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'admin', ?, ?, ?, ?)`,
    ).run(id, username, displayName, passwordHash, config.defaultQuotaBytes, now, now, now);
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
      'setup_completed_at',
      String(now),
    );
    const user = authUser(db, id);
    if (!user) throw new Error('Failed to create admin');
    const session = createSession(db, config, secrets, {
      userId: id,
      ip: clientIp(req),
      userAgent: requestUserAgent(req),
    });
    setCookieFor(ctx, reply, req, session.token, session.expiresAt);
    audit(db, {
      actorId: id,
      action: 'setup.completed',
      targetType: 'user',
      targetId: id,
      ip: clientIp(req),
      userAgent: requestUserAgent(req),
    });
    logger.info('initial setup completed', { username });
    return reply.send({ ...sessionPayload(ctx, user, session.sessionId, session.expiresAt), needsSetup: false });
  });

  app.post('/api/auth/login', async (req, reply) => {
    enforceRate(ctx.limiter, `login-ip:${clientIp(req)}`, 30, 15 * 60_000);
    const body = parseBody(credentialsSchema, req.body);
    const username = normalizeUsername(body.username);
    if (!USERNAME_RE.test(username)) {
      await verifyAgainstDummy(body.password);
      throw unauthorized('Credenziali non valide');
    }
    const lockKey = `${clientIp(req)}:${username}`;
    const lock = ctx.lockout.check(lockKey);
    if (lock.locked) {
      audit(db, {
        actorId: null,
        action: 'login.locked',
        ip: clientIp(req),
        userAgent: requestUserAgent(req),
        meta: { username },
      });
      throw new HttpError(429, 'locked', 'Troppi tentativi. Riprova più tardi.').withRetryAfter(lock.retryAfter);
    }
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      await verifyAgainstDummy(body.password);
      ctx.lockout.fail(lockKey);
      audit(db, {
        actorId: null,
        action: 'login.failed',
        ip: clientIp(req),
        userAgent: requestUserAgent(req),
        meta: { username },
      });
      throw unauthorized('Credenziali non valide');
    }
    const user = authUser(db, String(row.id));
    if (!user || user.disabled) {
      await verifyAgainstDummy(body.password);
      ctx.lockout.fail(lockKey);
      throw unauthorized('Credenziali non valide');
    }
    const valid = await verifyPassword(body.password, String(row.password_hash));
    if (!valid) {
      ctx.lockout.fail(lockKey);
      audit(db, {
        actorId: user.id,
        action: 'login.failed',
        targetType: 'user',
        targetId: user.id,
        ip: clientIp(req),
        userAgent: requestUserAgent(req),
        meta: { username },
      });
      throw unauthorized('Credenziali non valide');
    }
    ctx.lockout.succeed(lockKey);
    ctx.limiter.reset(`login-ip:${clientIp(req)}`);

    if (req.auth) revokeSession(db, req.auth.session.id);

    if (user.totp_enabled) {
      const challengeId = randomToken(24);
      const data = { attempts: 0 };
      db.prepare(
        'INSERT INTO auth_challenges (id, user_id, kind, token_hash, data, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(
        challengeId,
        user.id,
        'login-2fa',
        sha256Hex(challengeId),
        JSON.stringify(data),
        nowMs(),
        nowMs() + 5 * 60_000,
      );
      audit(db, {
        actorId: user.id,
        action: 'login.2fa_required',
        targetType: 'user',
        targetId: user.id,
        ip: clientIp(req),
        userAgent: requestUserAgent(req),
      });
      return reply.send({ twoFactorRequired: true, challengeId, methods: ['totp', 'recovery'] });
    }

    const session = createSession(db, config, secrets, {
      userId: user.id,
      ip: clientIp(req),
      userAgent: requestUserAgent(req),
    });
    setCookieFor(ctx, reply, req, session.token, session.expiresAt);
    audit(db, {
      actorId: user.id,
      action: 'login.success',
      targetType: 'user',
      targetId: user.id,
      ip: clientIp(req),
      userAgent: requestUserAgent(req),
      meta: { method: 'password' },
    });
    return reply.send(sessionPayload(ctx, user, session.sessionId, session.expiresAt));
  });

  app.post('/api/auth/2fa', async (req, reply) => {
    enforceRate(ctx.limiter, `2fa:${clientIp(req)}`, 20, 15 * 60_000);
    const body = parseBody(
      z.object({
        challengeId: z.string().min(16).max(80),
        code: z.string().min(4).max(20),
        method: z.enum(['totp', 'recovery']).default('totp'),
      }),
      req.body,
    );
    const row = db
      .prepare('SELECT id, user_id, data, expires_at, used_at FROM auth_challenges WHERE token_hash = ? AND kind = ?')
      .get(sha256Hex(body.challengeId), 'login-2fa') as
      | { id: string; user_id: string; data: string; expires_at: number; used_at: number | null }
      | undefined;
    if (!row || row.used_at || Number(row.expires_at) < nowMs()) throw unauthorized('Sfida scaduta. Accedi di nuovo.');
    const data = JSON.parse(row.data) as { attempts: number };
    if (data.attempts >= 5) throw unauthorized('Sfida non valida. Accedi di nuovo.');
    data.attempts += 1;
    db.prepare('UPDATE auth_challenges SET data = ? WHERE id = ?').run(JSON.stringify(data), row.id);
    const user = authUser(db, row.user_id);
    if (!user || user.disabled) throw unauthorized('Credenziali non valide');

    let valid = false;
    if (body.method === 'totp') {
      const secret = totpSecretFor(ctx, user);
      valid = Boolean(secret && verifyTotp(secret, body.code));
    } else {
      const hashed = hashRecoveryCode(secrets.codesKey, body.code);
      const code = db
        .prepare('SELECT id FROM recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL')
        .get(user.id, hashed) as { id: string } | undefined;
      if (code) {
        db.prepare('UPDATE recovery_codes SET used_at = ? WHERE id = ?').run(nowMs(), code.id);
        valid = true;
      }
    }
    if (!valid) {
      audit(db, {
        actorId: user.id,
        action: 'login.failed',
        targetType: 'user',
        targetId: user.id,
        ip: clientIp(req),
        userAgent: requestUserAgent(req),
        meta: { step: '2fa' },
      });
      throw unauthorized('Codice non valido');
    }
    db.prepare('UPDATE auth_challenges SET used_at = ? WHERE id = ?').run(nowMs(), row.id);
    const session = createSession(db, config, secrets, {
      userId: user.id,
      ip: clientIp(req),
      userAgent: requestUserAgent(req),
    });
    setCookieFor(ctx, reply, req, session.token, session.expiresAt);
    audit(db, {
      actorId: user.id,
      action: 'login.success',
      targetType: 'user',
      targetId: user.id,
      ip: clientIp(req),
      userAgent: requestUserAgent(req),
      meta: { method: body.method === 'totp' ? 'totp' : 'recovery' },
    });
    return reply.send(sessionPayload(ctx, user, session.sessionId, session.expiresAt));
  });

  app.get('/api/auth/me', async (req) => {
    const { user, session } = requireAuth(req);
    return { ...sessionPayload(ctx, user, session.id, session.expires_at) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const { session, user } = requireAuth(req);
    revokeSession(db, session.id);
    audit(db, {
      actorId: user.id,
      action: 'logout',
      targetType: 'session',
      targetId: session.id,
      ip: clientIp(req),
      userAgent: requestUserAgent(req),
    });
    reply.clearCookie(config.cookieName, { path: '/', httpOnly: true, sameSite: 'strict' });
    return reply.send({ ok: true });
  });

  app.post('/api/auth/logout-all', async (req, reply) => {
    const { user } = requireAuth(req);
    revokeAllSessions(db, user.id);
    audit(db, {
      actorId: user.id,
      action: 'logout.all',
      targetType: 'user',
      targetId: user.id,
      ip: clientIp(req),
      userAgent: requestUserAgent(req),
    });
    reply.clearCookie(config.cookieName, { path: '/', httpOnly: true, sameSite: 'strict' });
    return reply.send({ ok: true });
  });

  app.get('/api/auth/sessions', async (req) => {
    const { user, session } = requireAuth(req);
    const rows = db
      .prepare(
        `SELECT id, ip, user_agent, created_at, last_seen_at, expires_at FROM sessions
         WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC`,
      )
      .all(user.id, nowMs()) as Array<Record<string, unknown>>;
    return {
      sessions: rows.map((row) => ({
        id: String(row.id),
        current: String(row.id) === session.id,
        ip: String(row.ip),
        userAgent: String(row.user_agent),
        createdAt: Number(row.created_at),
        lastSeenAt: Number(row.last_seen_at),
        expiresAt: Number(row.expires_at),
      })),
    };
  });

  app.delete('/api/auth/sessions/:id', async (req) => {
    const { user, session } = requireAuth(req);
    const id = assertUuid((req.params as { id?: string }).id, 'session');
    const target = db.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?').get(id, user.id) as
      | { id: string }
      | undefined;
    if (!target) throw notFound('Sessione non trovata');
    revokeSession(db, id);
    audit(db, {
      actorId: user.id,
      action: 'session.revoked',
      targetType: 'session',
      targetId: id,
      ip: clientIp(req),
      userAgent: requestUserAgent(req),
      meta: { self: id === session.id },
    });
    return { ok: true };
  });

  app.patch('/api/me', async (req) => {
    const { user } = requireAuth(req);
    const body = parseBody(
      z.object({
        displayName: z.string().trim().min(1).max(100).optional(),
        presence: z.enum(['online', 'away', 'dnd', 'hidden']).optional(),
        readReceipts: z.boolean().optional(),
        quickShare: z.boolean().optional(),
        locale: z.enum(['it', 'en']).optional(),
        theme: z.enum(['system', 'light', 'dark', 'black']).optional(),
      }),
      req.body,
    );
    const now = nowMs();
    db.prepare(
      `UPDATE users SET display_name = ?, presence = ?, read_receipts = ?, quick_share = ?, locale = ?, theme = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      body.displayName ? sanitizePlainText(body.displayName, 100) : user.display_name,
      body.presence ?? user.presence,
      body.readReceipts === undefined ? user.read_receipts : body.readReceipts ? 1 : 0,
      body.quickShare === undefined ? user.quick_share : body.quickShare ? 1 : 0,
      body.locale ?? user.locale,
      body.theme ?? user.theme,
      now,
      user.id,
    );
    const updated = authUser(db, user.id);
    if (!updated) throw notFound('Utente non trovato');
    ctx.hub.broadcast({ type: 'presence:update', user: publicUser(updated) });
    return { user: publicUser(updated) };
  });

  app.post('/api/auth/password', async (req, reply) => {
    const { user, session } = requireAuth(req);
    enforceRate(ctx.limiter, `password:${user.id}`, 10, 15 * 60_000);
    const body = parseBody(
      z.object({
        currentPassword: z.string().min(1).max(300),
        newPassword: z.string().min(12).max(256),
      }),
      req.body,
    );
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as { password_hash: string };
    if (!(await verifyPassword(body.currentPassword, row.password_hash)))
      throw unauthorized('Password attuale non valida');
    const error = validatePassword(body.newPassword, user.username);
    if (error) throw badRequest(error, 'weak_password');
    db.prepare('UPDATE users SET password_hash = ?, password_changed_at = ?, updated_at = ? WHERE id = ?').run(
      await hashPassword(body.newPassword),
      nowMs(),
      nowMs(),
      user.id,
    );
    revokeAllSessions(db, user.id, session.id);
    audit(db, {
      actorId: user.id,
      action: 'password.changed',
      targetType: 'user',
      targetId: user.id,
      ip: clientIp(req),
      userAgent: requestUserAgent(req),
    });
    return reply.send({ ok: true });
  });

  app.post('/api/auth/2fa/setup', async (req) => {
    const { user } = requireAuth(req);
    enforceRate(ctx.limiter, `2fa-setup:${user.id}`, 10, 15 * 60_000);
    const body = parseBody(z.object({ password: z.string().max(300).optional() }), req.body);
    if (user.totp_enabled) {
      const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as { password_hash: string };
      if (!body.password || !(await verifyPassword(body.password, row.password_hash))) {
        throw unauthorized('Conferma la password per rigenerare il secondo fattore');
      }
    }
    const secret = generateTotpSecret();
    const wrapped = wrapKey(secrets.masterKey, Buffer.from(secret, 'utf8'), `totp:${user.id}`);
    db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0, updated_at = ? WHERE id = ?').run(
      wrapped,
      nowMs(),
      user.id,
    );
    return {
      secret,
      otpauth: otpauthUrl(config.branding.name, user.username, secret),
    };
  });

  app.post('/api/auth/2fa/enable', async (req) => {
    const { user } = requireAuth(req);
    const body = parseBody(z.object({ code: z.string().min(6).max(10) }), req.body);
    const secret = totpSecretFor(ctx, user);
    if (!secret || !verifyTotp(secret, body.code)) throw badRequest('Codice non valido');
    const codes = generateRecoveryCodes();
    const now = nowMs();
    db.prepare('UPDATE users SET totp_enabled = 1, updated_at = ? WHERE id = ?').run(now, user.id);
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(user.id);
    for (const code of codes) {
      db.prepare('INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, ?)').run(
        crypto.randomUUID(),
        user.id,
        hashRecoveryCode(secrets.codesKey, code),
        now,
      );
    }
    audit(db, {
      actorId: user.id,
      action: '2fa.enabled',
      targetType: 'user',
      targetId: user.id,
      ip: clientIp(req),
      userAgent: requestUserAgent(req),
    });
    return { recoveryCodes: codes, enabled: true };
  });

  app.post('/api/auth/2fa/disable', async (req) => {
    const { user } = requireAuth(req);
    const body = parseBody(
      z.object({ password: z.string().min(1).max(300), code: z.string().min(6).max(20) }),
      req.body,
    );
    const row = db.prepare('SELECT password_hash, totp_secret FROM users WHERE id = ?').get(user.id) as {
      password_hash: string;
      totp_secret: string | null;
    };
    if (!(await verifyPassword(body.password, row.password_hash))) throw unauthorized('Password non valida');
    if (!row.totp_secret) throw badRequest('2FA non configurato');
    const secret = unwrapKey(secrets.masterKey, row.totp_secret, `totp:${user.id}`).toString('utf8');
    if (!verifyTotp(secret, body.code)) throw badRequest('Codice non valido');
    db.prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0, updated_at = ? WHERE id = ?').run(
      nowMs(),
      user.id,
    );
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(user.id);
    audit(db, {
      actorId: user.id,
      action: '2fa.disabled',
      targetType: 'user',
      targetId: user.id,
      ip: clientIp(req),
      userAgent: requestUserAgent(req),
    });
    return { enabled: false };
  });

  app.post('/api/auth/recovery-codes', async (req) => {
    const { user } = requireAuth(req);
    enforceRate(ctx.limiter, `recovery:${user.id}`, 5, 60 * 60_000);
    const body = parseBody(z.object({ password: z.string().min(1).max(300) }), req.body);
    if (!user.totp_enabled) throw badRequest('Abilita prima il secondo fattore');
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as { password_hash: string };
    if (!(await verifyPassword(body.password, row.password_hash))) throw unauthorized('Password non valida');
    const codes = generateRecoveryCodes();
    const now = nowMs();
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(user.id);
    for (const code of codes) {
      db.prepare('INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, ?)').run(
        crypto.randomUUID(),
        user.id,
        hashRecoveryCode(secrets.codesKey, code),
        now,
      );
    }
    return { recoveryCodes: codes };
  });

  // ---- Passkeys (WebAuthn) ----
  app.post('/api/auth/webauthn/register/options', async (req) => {
    const { user } = requireAuth(req);
    enforceRate(ctx.limiter, `webauthn-reg:${user.id}`, 10, 15 * 60_000);
    const { origin, rpId } = relyingParty(req, ctx);
    const existing = db
      .prepare('SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = ?')
      .all(user.id) as Array<{ credential_id: string; transports: string }>;
    const options = await generateRegistrationOptions({
      rpName: config.branding.name,
      rpID: rpId,
      userName: user.username,
      userDisplayName: user.display_name,
      userID: new TextEncoder().encode(user.id),
      attestationType: 'none',
      excludeCredentials: existing.map((credential) => ({
        id: credential.credential_id,
        transports: credential.transports ? (credential.transports.split(',') as never[]) : undefined,
      })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    const challenge = storeChallenge(ctx, 'webauthn-reg', user.id, { challenge: options.challenge, rpId, origin });
    return { challengeId: challenge.challengeId, options };
  });

  app.post('/api/auth/webauthn/register/verify', async (req) => {
    const { user } = requireAuth(req);
    const body = parseBody(
      z.object({ challengeId: z.string().min(16).max(80), response: z.unknown(), name: z.string().max(60).optional() }),
      req.body,
    );
    const data = takeChallenge(ctx, body.challengeId, 'webauthn-reg', user.id);
    if (!data) throw badRequest('Sfida WebAuthn scaduta');
    const verification = await verifyRegistrationResponse({
      response: body.response as never,
      expectedChallenge: String(data.challenge),
      expectedOrigin: String(data.origin),
      expectedRPID: String(data.rpId),
      requireUserVerification: true,
    });
    if (!verification.verified) throw badRequest('Registrazione passkey non valida');
    const credential = verification.registrationInfo.credential;
    db.prepare(
      `INSERT INTO webauthn_credentials (id, user_id, credential_id, public_key, counter, transports, name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(),
      user.id,
      credential.id,
      Buffer.from(credential.publicKey),
      credential.counter,
      (credential.transports ?? []).join(','),
      sanitizeFileName(body.name || 'Passkey'),
      nowMs(),
    );
    audit(db, {
      actorId: user.id,
      action: 'passkey.added',
      targetType: 'user',
      targetId: user.id,
      ip: clientIp(req),
      userAgent: requestUserAgent(req),
    });
    return { ok: true };
  });

  app.get('/api/auth/webauthn/credentials', async (req) => {
    const { user } = requireAuth(req);
    const rows = db
      .prepare(
        'SELECT id, name, created_at, last_used_at, transports FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at DESC',
      )
      .all(user.id) as Array<Record<string, unknown>>;
    return {
      credentials: rows.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        createdAt: Number(row.created_at),
        lastUsedAt: row.last_used_at ? Number(row.last_used_at) : null,
        transports: String(row.transports),
      })),
    };
  });

  app.delete('/api/auth/webauthn/credentials/:id', async (req) => {
    const { user } = requireAuth(req);
    const id = assertUuid((req.params as { id?: string }).id, 'credential');
    const result = db.prepare('DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?').run(id, user.id);
    if (Number(result.changes) === 0) throw notFound('Passkey non trovata');
    audit(db, {
      actorId: user.id,
      action: 'passkey.removed',
      targetType: 'user',
      targetId: user.id,
      ip: clientIp(req),
      userAgent: requestUserAgent(req),
    });
    return { ok: true };
  });

  app.post('/api/auth/webauthn/login/options', async (req) => {
    enforceRate(ctx.limiter, `webauthn-login:${clientIp(req)}`, 30, 15 * 60_000);
    const { origin, rpId } = relyingParty(req, ctx);
    const options = await generateAuthenticationOptions({ rpID: rpId, userVerification: 'required' });
    const challenge = storeChallenge(ctx, 'webauthn-auth', null, { challenge: options.challenge, rpId, origin });
    return { challengeId: challenge.challengeId, options };
  });

  app.post('/api/auth/webauthn/login/verify', async (req, reply) => {
    enforceRate(ctx.limiter, `webauthn-login-verify:${clientIp(req)}`, 20, 15 * 60_000);
    const body = parseBody(z.object({ challengeId: z.string().min(16).max(80), response: z.unknown() }), req.body);
    const data = takeChallenge(ctx, body.challengeId, 'webauthn-auth', null);
    if (!data) throw unauthorized('Sfida WebAuthn scaduta');
    const response = body.response as { id?: string };
    if (!response || typeof response.id !== 'string') throw unauthorized('Passkey non valida');
    const row = db
      .prepare(
        `SELECT c.id, c.user_id, c.credential_id, c.public_key, c.counter, c.transports, u.id AS u_id
         FROM webauthn_credentials c JOIN users u ON u.id = c.user_id
         WHERE c.credential_id = ? AND u.disabled = 0`,
      )
      .get(response.id) as Record<string, unknown> | undefined;
    if (!row) throw unauthorized('Passkey non valida');
    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verification = await verifyAuthenticationResponse({
        response: body.response as never,
        expectedChallenge: String(data.challenge),
        expectedOrigin: String(data.origin),
        expectedRPID: String(data.rpId),
        credential: {
          id: String(row.credential_id) as never,
          publicKey: new Uint8Array(row.public_key as Uint8Array),
          counter: Number(row.counter),
          transports: String(row.transports) ? (String(row.transports).split(',') as never[]) : undefined,
        },
        requireUserVerification: true,
      });
    } catch (error) {
      logger.warn('passkey verification failed', { error: error instanceof Error ? error.message : 'unknown' });
      throw unauthorized('Passkey non valida');
    }
    if (!verification.verified) throw unauthorized('Passkey non valida');
    db.prepare('UPDATE webauthn_credentials SET counter = ?, last_used_at = ? WHERE id = ?').run(
      verification.authenticationInfo.newCounter,
      nowMs(),
      String(row.id),
    );
    const user = authUser(db, String(row.user_id));
    if (!user) throw unauthorized('Utente non valido');
    const session = createSession(db, config, secrets, {
      userId: user.id,
      ip: clientIp(req),
      userAgent: requestUserAgent(req),
    });
    setCookieFor(ctx, reply, req, session.token, session.expiresAt);
    audit(db, {
      actorId: user.id,
      action: 'login.success',
      targetType: 'user',
      targetId: user.id,
      ip: clientIp(req),
      userAgent: requestUserAgent(req),
      meta: { method: 'passkey' },
    });
    return reply.send(sessionPayload(ctx, user, session.sessionId, session.expiresAt));
  });

  // ---- Invites ----
  app.get('/api/invites/:token/preview', async (req) => {
    const token = String((req.params as { token?: string }).token ?? '');
    const row = db
      .prepare('SELECT role, expires_at, used_at FROM invites WHERE token_hash = ?')
      .get(sha256Hex(token)) as { role: string; expires_at: number; used_at: number | null } | undefined;
    const valid = Boolean(row && !row.used_at && Number(row.expires_at) > nowMs());
    return {
      valid,
      role: valid ? row?.role : null,
      expiresAt: valid ? Number(row?.expires_at) : null,
      appName: config.branding.name,
    };
  });

  app.post('/api/invites/:token/redeem', async (req, reply) => {
    enforceRate(ctx.limiter, `invite:${clientIp(req)}`, 10, 15 * 60_000);
    const token = String((req.params as { token?: string }).token ?? '');
    const body = parseBody(
      z.object({
        username: z.string().trim().toLowerCase().regex(USERNAME_RE),
        displayName: z.string().trim().min(1).max(100),
        password: z.string().min(12).max(256),
      }),
      req.body,
    );
    const invite = db
      .prepare('SELECT id, role, expires_at, used_at FROM invites WHERE token_hash = ?')
      .get(sha256Hex(token)) as
      | { id: string; role: 'admin' | 'user'; expires_at: number; used_at: number | null }
      | undefined;
    if (!invite || invite.used_at || Number(invite.expires_at) < nowMs())
      throw badRequest('Invito non valido o scaduto');
    const error = validatePassword(body.password, body.username);
    if (error) throw badRequest(error, 'weak_password');
    const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(body.username);
    if (exists) throw conflict('Nome utente non disponibile');
    const passwordHash = await hashPassword(body.password);
    const id = crypto.randomUUID();
    const now = nowMs();
    try {
      db.exec('BEGIN IMMEDIATE');
      const claim = db
        .prepare('UPDATE invites SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL')
        .run(now, id, invite.id);
      if (Number(claim.changes) === 0) throw conflict('Invito già utilizzato');
      db.prepare(
        `INSERT INTO users (id, username, display_name, password_hash, role, quota_bytes, password_changed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        body.username,
        sanitizePlainText(body.displayName, 100),
        passwordHash,
        invite.role,
        config.defaultQuotaBytes,
        now,
        now,
        now,
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    const user = authUser(db, id);
    if (!user) throw new Error('Failed to create user');
    const session = createSession(db, config, secrets, {
      userId: id,
      ip: clientIp(req),
      userAgent: requestUserAgent(req),
    });
    setCookieFor(ctx, reply, req, session.token, session.expiresAt);
    audit(db, {
      actorId: id,
      action: 'invite.redeemed',
      targetType: 'invite',
      targetId: invite.id,
      ip: clientIp(req),
      userAgent: requestUserAgent(req),
    });
    return reply.send(sessionPayload(ctx, user, session.sessionId, session.expiresAt));
  });

  // ---- Contacts, blocks and reports ----
  app.get('/api/users', async (req) => {
    const { user } = requireAuth(req);
    const rows = db
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.presence, u.read_receipts, u.quick_share,
                EXISTS(SELECT 1 FROM blocks b WHERE b.blocker_id = ? AND b.blocked_id = u.id) AS blocked_by_me,
                EXISTS(SELECT 1 FROM blocks b2 WHERE b2.blocker_id = u.id AND b2.blocked_id = ?) AS blocked_me
         FROM users u WHERE u.disabled = 0 AND u.id != ? ORDER BY u.display_name COLLATE NOCASE`,
      )
      .all(user.id, user.id, user.id) as Array<Record<string, unknown>>;
    return {
      users: rows
        .filter((row) => !Number(row.blocked_me))
        .map((row) => {
          const connected = ctx.hub.isOnline(String(row.id));
          const presence = String(row.presence);
          return {
            id: String(row.id),
            username: String(row.username),
            displayName: String(row.display_name),
            status: !connected || presence === 'hidden' ? 'offline' : presence,
            blocked: Boolean(Number(row.blocked_by_me)),
            quickShare: Boolean(Number(row.quick_share)),
          };
        }),
    };
  });

  app.post('/api/users/:id/block', async (req) => {
    const { user } = requireAuth(req);
    const id = assertUuid((req.params as { id?: string }).id, 'user');
    if (id === user.id) throw badRequest('Non puoi bloccare te stesso');
    const target = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
    if (!target) throw notFound('Utente non trovato');
    db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)').run(
      user.id,
      id,
      nowMs(),
    );
    audit(db, {
      actorId: user.id,
      action: 'user.blocked',
      targetType: 'user',
      targetId: id,
      ip: clientIp(req),
      userAgent: requestUserAgent(req),
    });
    return { ok: true };
  });

  app.delete('/api/users/:id/block', async (req) => {
    const { user } = requireAuth(req);
    const id = assertUuid((req.params as { id?: string }).id, 'user');
    db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(user.id, id);
    audit(db, {
      actorId: user.id,
      action: 'user.unblocked',
      targetType: 'user',
      targetId: id,
      ip: clientIp(req),
      userAgent: requestUserAgent(req),
    });
    return { ok: true };
  });

  app.post('/api/reports', async (req) => {
    const { user } = requireAuth(req);
    enforceRate(ctx.limiter, `report:${user.id}`, 10, 60 * 60_000);
    const body = parseBody(
      z.object({
        targetUserId: z.string().uuid(),
        reason: z.string().trim().min(3).max(1000),
        messageId: z.string().uuid().optional(),
      }),
      req.body,
    );
    if (body.targetUserId === user.id) throw badRequest('Non puoi segnalare te stesso');
    const target = db.prepare('SELECT id FROM users WHERE id = ?').get(body.targetUserId);
    if (!target) throw notFound('Utente non trovato');
    db.prepare(
      'INSERT INTO reports (id, reporter_id, target_user_id, message_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      crypto.randomUUID(),
      user.id,
      body.targetUserId,
      body.messageId ?? null,
      sanitizePlainText(body.reason, 1000),
      nowMs(),
    );
    audit(db, {
      actorId: user.id,
      action: 'user.reported',
      targetType: 'user',
      targetId: body.targetUserId,
      ip: clientIp(req),
      userAgent: requestUserAgent(req),
    });
    return { ok: true };
  });
}
