import fs from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { isHttpError } from '../errors.js';
import { registerMcpAuthRoutes } from '../mcp/oauth.js';
import { registerMcpRoutes } from '../mcp/server.js';
import { registerAdminRoutes } from '../routes/admin.js';
import { registerAuthRoutes } from '../routes/auth.js';
import { registerBoardRoutes } from '../routes/board.js';
import { registerCallRoutes } from '../routes/calls.js';
import { registerChatRoutes } from '../routes/chat.js';
import { registerFileRoutes } from '../routes/files.js';
import { registerPublicRoutes } from '../routes/public.js';
import { registerPushRoutes } from '../routes/push.js';
import { registerQuickShareRoutes } from '../routes/quickshare.js';
import { registerSearchRoutes } from '../routes/search.js';
import { escapeHtml } from '../util.js';
import { registerSecurity } from './security.js';

const FALLBACK_HTML = `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nimbus</title><link rel="stylesheet" href="/assets/styles.css"></head>
<body><main><h1>Nimbus</h1><p>Interfaccia non compilata. Esegui <code>npm run build:web</code>.</p></main>
<script type="module" src="/assets/app.js"></script></body></html>`;

function webRoot(): string {
  return process.env.NIMBUS_WEB_ROOT ?? path.resolve(process.cwd(), 'dist/web');
}

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const { config } = ctx;
  const root = webRoot();
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });

  let indexTemplate = FALLBACK_HTML;
  try {
    indexTemplate = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  } catch {
    ctx.logger.warn('web build not found; serving fallback HTML', { root });
  }
  const renderIndex = (req: FastifyRequest): string => {
    const nonce = escapeHtml(req.cspNonce);
    return indexTemplate
      .replaceAll('__APP_NAME__', escapeHtml(config.branding.name))
      .replaceAll('__APP_VERSION__', escapeHtml(config.appVersion))
      .replaceAll('__APP_TAGLINE__', escapeHtml(config.branding.tagline))
      .replaceAll('__CSP_NONCE__', nonce);
  };

  const app = Fastify({
    logger: false,
    trustProxy: config.trustProxy,
    bodyLimit: config.maxJsonBodyBytes,
    routerOptions: { maxParamLength: 200, ignoreTrailingSlash: false },
  });

  app.setErrorHandler((error, req, reply) => {
    if (isHttpError(error)) {
      if (error.retryAfter) reply.header('Retry-After', String(error.retryAfter));
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    const statusCode =
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : 500;
    if (statusCode === 413) {
      return reply.code(413).send({ error: 'payload_too_large', message: 'Contenuto troppo grande' });
    }
    if (statusCode === 415) {
      return reply.code(415).send({ error: 'unsupported_media_type', message: 'Tipo di contenuto non supportato' });
    }
    if (statusCode === 400) {
      return reply.code(400).send({ error: 'bad_request', message: 'Richiesta non valida' });
    }
    ctx.logger.error('unhandled request error', {
      path: req.url.split('?')[0],
      method: req.method,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return reply.code(500).send({ error: 'internal_error', message: 'Errore interno del server' });
  });

  await app.register(cookie);
  await app.register(websocket, {
    options: { maxPayload: 128 * 1024, perMessageDeflate: false, clientTracking: false },
  });
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => {
    done(null, payload);
  });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(String(body))));
  });

  registerSecurity(app, { config, db: ctx.db, secrets: ctx.secrets });
  ctx.hub.attach(app);

  registerAuthRoutes(app, ctx);
  registerMcpAuthRoutes(app, ctx);
  registerMcpRoutes(app, ctx);
  registerAdminRoutes(app, ctx);
  registerBoardRoutes(app, ctx);
  registerFileRoutes(app, ctx);
  registerChatRoutes(app, ctx);
  registerSearchRoutes(app, ctx);
  registerCallRoutes(app, ctx);
  registerQuickShareRoutes(app, ctx);
  registerPublicRoutes(app, ctx);
  registerPushRoutes(app, ctx);

  await app.register(fastifyStatic, {
    root: path.join(root, 'assets'),
    prefix: '/assets/',
    decorateReply: false,
    cacheControl: true,
    maxAge: 3600,
  });

  const sendIndex = (req: FastifyRequest, reply: FastifyReply): FastifyReply =>
    reply.header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(renderIndex(req));

  app.get('/', async (req, reply) => sendIndex(req, reply));

  app.get('/sw.js', async (_req, reply) => {
    try {
      const contents = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
      return reply
        .header('Cache-Control', 'no-cache')
        .header('Service-Worker-Allowed', '/')
        .type('text/javascript; charset=utf-8')
        .send(contents);
    } catch {
      return reply.code(404).send();
    }
  });

  app.get('/offline.html', async (_req, reply) => {
    try {
      return reply
        .header('Cache-Control', 'public, max-age=3600')
        .type('text/html; charset=utf-8')
        .send(fs.readFileSync(path.join(root, 'offline.html'), 'utf8'));
    } catch {
      return reply.code(404).send();
    }
  });

  app.get('/manifest.webmanifest', async (_req, reply) => {
    const name = config.branding.name;
    return reply
      .header('Cache-Control', 'no-cache')
      .type('application/manifest+json')
      .send(
        JSON.stringify({
          name,
          short_name: name.slice(0, 12),
          description: config.branding.tagline,
          lang: config.branding.defaultLocale,
          start_url: '/',
          scope: '/',
          display: 'standalone',
          orientation: 'any',
          background_color: '#0a0714',
          theme_color: '#0a0714',
          categories: ['productivity', 'utilities'],
          icons: [
            { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
            { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
          ],
          shortcuts: [
            { name: 'File', url: '/files' },
            { name: 'Chat', url: '/chat' },
          ],
        }),
      );
  });

  app.get('/icon.svg', async (_req, reply) => {
    const initial = escapeHtml(config.branding.name.trim().charAt(0).toUpperCase() || 'N');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="${escapeHtml(
      config.branding.name,
    )}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8f6cf5"/><stop offset="1" stop-color="#6a45dd"/></linearGradient></defs>
<rect width="512" height="512" rx="112" fill="url(#g)"/>
<path d="M120 356c46-24 59-83 112-112 25-14 54-18 86-12 31 6 51 21 74 16" fill="none" stroke="#ffffff" stroke-opacity="0.28" stroke-width="26" stroke-linecap="round"/>
<circle cx="390" cy="142" r="74" fill="#ffffff" fill-opacity="0.16"/>
<text x="256" y="330" text-anchor="middle" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-size="230" font-weight="700" fill="#ffffff">${initial}</text>
</svg>`;
    return reply.header('Cache-Control', 'public, max-age=86400').type('image/svg+xml').send(svg);
  });

  app.get('/robots.txt', async (_req, reply) => reply.type('text/plain').send('User-agent: *\nDisallow: /\n'));

  app.get('/healthz', async () => {
    ctx.db.prepare('SELECT 1 AS ok').get();
    return {
      status: 'ok',
      name: config.branding.name,
      version: config.appVersion,
      uptime: Math.floor((Date.now() - ctx.startedAt) / 1000),
    };
  });

  app.setNotFoundHandler((req, reply) => {
    const pathname = req.url.split('?')[0] ?? '';
    if (pathname.startsWith('/api/') || pathname === '/ws') {
      return reply.code(404).send({ error: 'not_found', message: 'Risorsa non trovata' });
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && (req.headers.accept ?? '').includes('text/html')) {
      return sendIndex(req, reply);
    }
    return reply.code(404).send({ error: 'not_found' });
  });

  return app;
}
