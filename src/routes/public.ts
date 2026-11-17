import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { verifyPassword } from '../auth/passwords.js';
import type { AppContext } from '../context.js';
import { forbidden, notFound, unauthorized } from '../errors.js';
import { sendContent } from '../files/content.js';
import { enforceRate, parseBody } from '../http/helpers.js';
import {
  getLinkFile,
  issueAccessToken,
  linkIsUsable,
  lookupLink,
  recordDownload,
  verifyAccessToken,
} from '../public-links.js';

export type PublicDeps = Pick<AppContext, 'config' | 'db' | 'secrets' | 'limiter' | 'logger'>;

function linkFromParams(deps: PublicDeps, token: string): NonNullable<ReturnType<typeof lookupLink>> {
  const link = lookupLink(deps.db, token);
  if (!link || !linkIsUsable(link)) throw notFound('Link non disponibile o scaduto');
  return link;
}

export function registerPublicRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/public/shares/:token', async (req) => {
    enforceRate(ctx.limiter, `public-meta:${req.ip}`, 120, 60_000);
    const token = String((req.params as { token?: string }).token ?? '');
    const link = linkFromParams(ctx, token);
    const file = getLinkFile(ctx.db, link);
    if (!file) throw notFound('File non disponibile');
    if (file.scan_status !== 'clean') throw notFound('File non disponibile');
    return {
      requiresPassword: Boolean(link.password_hash),
      appName: ctx.config.branding.name,
      expiresAt: link.expires_at,
      downloadsLeft: link.max_downloads === null ? null : Math.max(0, link.max_downloads - link.downloads),
      file: link.password_hash ? null : { name: file.name, size: file.size, mime: file.mime },
      contentOrigin: ctx.config.publicContentOrigin,
    };
  });

  app.post('/api/public/shares/:token/unlock', async (req) => {
    const token = String((req.params as { token?: string }).token ?? '');
    const key = `public-unlock:${req.ip}:${token.slice(-12)}`;
    enforceRate(ctx.limiter, key, 30, 15 * 60_000, 'Troppi tentativi. Attendi prima di riprovare.');
    const link = linkFromParams(ctx, token);
    const file = getLinkFile(ctx.db, link);
    if (!file) throw notFound('File non disponibile');
    if (link.password_hash) {
      const body = parseBody(z.object({ password: z.string().min(1).max(256) }), req.body);
      if (!(await verifyPassword(body.password, link.password_hash))) {
        audit(ctx.db, {
          actorId: null,
          action: 'public_link.downloaded',
          targetType: 'file',
          targetId: link.file_id,
          ip: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
          meta: { linkId: link.id, failedPassword: true },
        });
        throw forbidden('Password non corretta');
      }
    }
    ctx.limiter.reset(key);
    const access = issueAccessToken(ctx.secrets, link);
    return {
      access,
      expiresIn: 30 * 60,
      file: { name: file.name, size: file.size, mime: file.mime },
      contentOrigin: ctx.config.publicContentOrigin,
      downloadsLeft: link.max_downloads === null ? null : Math.max(0, link.max_downloads - link.downloads),
    };
  });

  app.get('/api/public/shares/:token/content', async (req, reply) => publicContentHandler(ctx, req, reply));
}

export async function publicContentHandler(
  deps: PublicDeps,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  enforceRate(deps.limiter, `public-content:${req.ip}`, 120, 60_000);
  const token = String((req.params as { token?: string }).token ?? '');
  const query = req.query as { access?: string; download?: string };
  const access = verifyAccessToken(deps.secrets, query.access);
  if (!access) throw unauthorized('Accesso scaduto: riapri il link.');
  const link = lookupLink(deps.db, token);
  if (!link || !linkIsUsable(link) || link.id !== access.l || link.file_id !== access.f) {
    throw notFound('Link non disponibile o scaduto');
  }
  const file = getLinkFile(deps.db, link);
  if (!file || file.scan_status !== 'clean') throw notFound('File non disponibile');
  const range = req.headers.range;
  const track = !range || /^bytes=0-/.test(range);
  if (track && !recordDownload(deps.db, link)) throw notFound('Limite di download raggiunto');
  if (track) {
    audit(deps.db, {
      actorId: null,
      action: 'public_link.downloaded',
      targetType: 'file',
      targetId: file.id,
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
      meta: { linkId: link.id },
    });
  }
  return sendContent(
    reply,
    deps,
    {
      id: file.id,
      name: file.name,
      size: file.size,
      mime: file.mime,
      version: file.version,
      wrapped_key: file.wrapped_key,
      storage_path: file.storage_path,
      scan_status: file.scan_status,
    },
    { inline: query.download !== '1' && query.download !== 'true', rangeHeader: range },
  );
}
