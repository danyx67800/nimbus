import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { badRequest } from '../errors.js';
import { enforceRate, parseBody } from '../http/helpers.js';
import { requireAuth } from '../http/security.js';

export function registerPushRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/push/public-key', async () => ({ publicKey: ctx.push.publicKey }));

  app.post('/api/push/subscribe', async (req) => {
    const { user } = requireAuth(req);
    enforceRate(ctx.limiter, `push-sub:${user.id}`, 20, 60 * 60_000);
    const body = parseBody(
      z.object({
        endpoint: z.string().url().max(1000),
        keys: z.object({ p256dh: z.string().min(10).max(300), auth: z.string().min(4).max(100) }),
      }),
      req.body,
    );
    const endpointUrl = new URL(body.endpoint);
    if (endpointUrl.protocol !== 'https:') throw badRequest('Endpoint push non valido');
    ctx.db
      .prepare(
        `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
      )
      .run(crypto.randomUUID(), user.id, body.endpoint, body.keys.p256dh, body.keys.auth, Date.now());
    return { ok: true };
  });

  app.post('/api/push/unsubscribe', async (req) => {
    const { user } = requireAuth(req);
    const body = parseBody(z.object({ endpoint: z.string().max(1000) }), req.body);
    ctx.db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(user.id, body.endpoint);
    return { ok: true };
  });
}
