import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { hmacSha1Base64 } from '../crypto.js';
import { enforceRate } from '../http/helpers.js';
import { requireAuth } from '../http/security.js';

export function registerCallRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/calls/ice', async (req) => {
    const { user } = requireAuth(req);
    enforceRate(ctx.limiter, `ice:${user.id}`, 60, 60 * 60_000);
    if (ctx.config.turnUrls.length === 0) {
      return {
        configured: false,
        iceServers: [],
        maxParticipants: 4,
        media: 'p2p-dtls-srtp',
        note: 'TURN non configurato: le chiamate funzionano solo sulla stessa rete locale.',
      };
    }
    const expires = Math.floor(Date.now() / 1000) + ctx.config.turnTtlSeconds;
    const username = `${expires}:${user.id}`;
    const credential = hmacSha1Base64(ctx.secrets.turnSecret, username);
    return {
      configured: true,
      ttl: ctx.config.turnTtlSeconds,
      iceServers: [{ urls: ctx.config.turnUrls, username, credential }],
      maxParticipants: 4,
      media: 'p2p-dtls-srtp',
    };
  });
}
