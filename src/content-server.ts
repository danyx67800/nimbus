import Fastify, { type FastifyInstance } from 'fastify';
import type { AppContext } from './context.js';
import { isHttpError } from './errors.js';
import { type PublicDeps, publicContentHandler } from './routes/public.js';

/**
 * Optional second listener that serves only public file content. When placed
 * behind a separate hostname it isolates user-supplied bytes from the app origin.
 */
export async function buildContentServer(ctx: AppContext): Promise<FastifyInstance> {
  const deps: PublicDeps = {
    config: ctx.config,
    db: ctx.db,
    secrets: ctx.secrets,
    limiter: ctx.limiter,
    logger: ctx.logger,
  };
  const app = Fastify({
    logger: false,
    trustProxy: ctx.config.trustProxy,
    bodyLimit: 64 * 1024,
    disableRequestLogging: true,
  });

  app.addHook('onRequest', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'private, no-store');
    reply.header('X-Robots-Tag', 'noindex');
    reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/api/public/shares/:token/content', async (req, reply) => publicContentHandler(deps, req, reply));

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found' }));

  app.setErrorHandler((error, _req, reply) => {
    if (isHttpError(error)) {
      if (error.retryAfter) reply.header('Retry-After', String(error.retryAfter));
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    ctx.logger.error('content origin error', { error: error instanceof Error ? error.message : 'unknown' });
    return reply.code(500).send({ error: 'internal_error' });
  });

  return app;
}
