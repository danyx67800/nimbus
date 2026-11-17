import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { RateLimiter } from '../auth/rate-limit.js';
import { badRequest, tooManyRequests } from '../errors.js';

export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) throw badRequest('Dati non validi');
  return result.data;
}

export function enforceRate(
  limiter: RateLimiter,
  key: string,
  limit: number,
  windowMs: number,
  message = 'Troppi tentativi. Riprova più tardi.',
): void {
  const result = limiter.hit(key, limit, windowMs);
  if (!result.allowed) throw tooManyRequests(message, result.retryAfter);
}

export function clientIp(req: FastifyRequest): string {
  return req.ip || 'unknown';
}

export function requestUserAgent(req: FastifyRequest): string {
  const value = req.headers['user-agent'];
  return (Array.isArray(value) ? value[0] : value) ?? '';
}
