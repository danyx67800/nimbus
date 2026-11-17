import type { FastifyInstance } from 'fastify';
import type { LoginLockout, RateLimiter } from './auth/rate-limit.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import type { Logger } from './logger.js';
import type { Secrets } from './secrets.js';

export interface PushPort {
  notifyUser(userId: string, payload: { title: string; body: string; url?: string; tag?: string }): void;
  publicKey: string;
}

export interface ScannerPort {
  enabled: boolean;
  scanBuffer(buffer: Buffer, label: string): Promise<{ clean: boolean; signature?: string }>;
  scanFile(path: string): Promise<{ clean: boolean; signature?: string }>;
}

export interface RealtimePort {
  attach(app: FastifyInstance): void;
  sendToUser(userId: string, payload: Record<string, unknown>): void;
  isOnline(userId: string): boolean;
  onlineUserIds(): string[];
  broadcast(payload: Record<string, unknown>): void;
  presenceFor(userId: string): string;
}

export interface AppContext {
  config: Config;
  db: Db;
  secrets: Secrets;
  logger: Logger;
  limiter: RateLimiter;
  lockout: LoginLockout;
  hub: RealtimePort;
  push: PushPort;
  scanner: ScannerPort;
  startedAt: number;
}
