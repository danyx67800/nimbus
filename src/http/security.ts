import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { csrfFor, resolveSession, type SessionRow, type UserRow } from '../auth/sessions.js';
import type { Config } from '../config.js';
import { constantTimeEqual, randomToken, sha256Hex } from '../crypto.js';
import type { Db } from '../db.js';
import { forbidden, HttpError, unauthorized } from '../errors.js';
import type { Secrets } from '../secrets.js';
import { parseCookies } from '../util.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: { session: SessionRow; user: UserRow } | null;
    cspNonce: string;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const CONTENT_PREFIXES = ['/api/files/content', '/api/public/shares'];

export function isContentPath(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return CONTENT_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function requestOrigin(req: FastifyRequest): string | null {
  const protocol = req.protocol;
  const host = req.headers.host;
  if (!host) return null;
  return `${protocol}://${host}`;
}

export function isAllowedOrigin(req: FastifyRequest, origin: string, config: Config): boolean {
  const expected = requestOrigin(req);
  if (!expected) return false;
  try {
    const parsed = new URL(origin);
    if (parsed.username || parsed.password) return false;
    if (parsed.origin === expected) return true;
    return config.extraOrigins.includes(parsed.origin);
  } catch {
    return false;
  }
}

const ORIGIN_EXEMPT = new Set(['/mcp', '/oauth/token', '/oauth/register', '/oauth/revoke']);

export function enforceOrigin(req: FastifyRequest, config: Config): void {
  if (SAFE_METHODS.has(req.method)) return;
  if (ORIGIN_EXEMPT.has((req.url.split('?')[0] ?? '').replace(/\/$/, ''))) return;
  const origin = req.headers.origin;
  if (!origin) return; // non-browser clients; CSRF/session tokens still apply
  if (!isAllowedOrigin(req, origin, config)) {
    throw forbidden('Origine della richiesta non consentita');
  }
}

export function cspFor(_config: Config, nonce: string, https: boolean): string {
  const directives = [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (https) directives.push('upgrade-insecure-requests');
  return directives.join('; ');
}

export function contentSecurityHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy':
      "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; media-src blob:; object-src 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'private, no-store',
  };
}

export function registerSecurity(app: FastifyInstance, options: { config: Config; db: Db; secrets: Secrets }): void {
  const { config, db, secrets } = options;

  app.decorateRequest('auth', null);
  app.decorateRequest('cspNonce', '');

  app.addHook('onRequest', async (req, reply) => {
    const nonce = randomToken(16);
    req.cspNonce = nonce;
    const https = req.protocol === 'https';
    if (config.requireHttps && !https && req.url !== '/healthz') {
      throw new HttpError(426, 'https_required', 'Questa istanza richiede HTTPS.', true);
    }
    reply.header('Content-Security-Policy', cspFor(config, nonce, https));
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header(
      'Permissions-Policy',
      'camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=(), usb=(), serial=(), browsing-topics=()',
    );
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('X-Permitted-Cross-Domain-Policies', 'none');
    if (https) reply.header('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    enforceOrigin(req, config);
  });

  app.addHook('preHandler', async (req) => {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[config.cookieName];
    const resolved = resolveSession(db, token);
    req.auth = resolved;
    if (!resolved) return;
    const path = (req.url.split('?')[0] ?? '').replace(/\/$/, '');
    const csrfExempt =
      path === '/api/auth/login' ||
      path === '/api/auth/2fa' ||
      path === '/api/auth/webauthn/login/verify' ||
      path === '/api/setup' ||
      path === '/oauth/authorize/decision' ||
      path === '/oauth/register' ||
      path === '/oauth/token' ||
      path === '/oauth/revoke' ||
      /^\/api\/invites\/[^/]+\/redeem$/.test(path) ||
      /^\/api\/public\/shares\/[^/]+\/unlock$/.test(path);
    if (!SAFE_METHODS.has(req.method) && !csrfExempt) {
      const provided = req.headers[config.csrfHeader];
      const value = Array.isArray(provided) ? provided[0] : provided;
      if (!value || !/^[A-Za-z0-9_-]{20,100}$/.test(value)) {
        throw forbidden('Token CSRF mancante o non valido');
      }
      const expectedHash = sha256Hex(csrfFor(secrets.csrfKey, resolved.session.id));
      if (
        !constantTimeEqual(sha256Hex(value), resolved.session.csrf_hash) &&
        !constantTimeEqual(sha256Hex(value), expectedHash)
      ) {
        throw forbidden('Token CSRF non valido');
      }
    }
  });
}

export function requireAuth(req: FastifyRequest): { session: SessionRow; user: UserRow } {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

export function requireAdmin(req: FastifyRequest): { session: SessionRow; user: UserRow } {
  const auth = requireAuth(req);
  if (auth.user.role !== 'admin') throw forbidden('Richiesta riservata agli amministratori');
  return auth;
}

export function csrfForSession(secrets: Secrets, sessionId: string): string {
  return csrfFor(secrets.csrfKey, sessionId);
}

export function headerHost(req: FastifyRequest): string {
  return (req.headers.host ?? '').toLowerCase();
}

export function replyNoStore(reply: FastifyReply): FastifyReply {
  return reply.header('Cache-Control', 'no-store');
}
