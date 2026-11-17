import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { LoginLockout, RateLimiter } from './auth/rate-limit.js';
import { purgeExpiredSessions } from './auth/sessions.js';
import { ClamAvScanner } from './clamav.js';
import { type Config, loadConfig } from './config.js';
import { buildContentServer } from './content-server.js';
import type { AppContext } from './context.js';
import { openDatabase } from './db.js';
import { buildApp } from './http/app.js';
import { createLogger } from './logger.js';
import { PushService } from './push.js';
import { RealtimeHub } from './realtime/hub.js';
import { loadSecrets } from './secrets.js';
import { nowMs } from './util.js';

export interface NimbusRuntime {
  app: FastifyInstance;
  contentApp: FastifyInstance | null;
  ctx: AppContext;
  url: string;
  contentUrl: string | null;
  port: number;
  contentPort: number | null;
  close: () => Promise<void>;
}

function cleanupStaleUploads(config: Config, db: AppContext['db'], logger: AppContext['logger']): void {
  try {
    const entries = fs.readdirSync(config.tmpDir, { withFileTypes: true });
    const cutoff = nowMs() - 24 * 60 * 60 * 1000;
    for (const entry of entries) {
      const target = path.join(config.tmpDir, entry.name);
      try {
        const stat = fs.statSync(target);
        if (stat.mtimeMs < cutoff) {
          fs.rmSync(target, { recursive: true, force: true });
          if (entry.isDirectory()) db.prepare('DELETE FROM uploads WHERE id = ?').run(entry.name);
        }
      } catch {
        // best effort
      }
    }
    db.prepare("DELETE FROM uploads WHERE status = 'complete' AND updated_at < ?").run(cutoff);
    const active = db.prepare("SELECT id FROM uploads WHERE status = 'active'").all() as Array<{ id: string }>;
    for (const upload of active) {
      if (!fs.existsSync(path.join(config.tmpDir, upload.id)))
        db.prepare('DELETE FROM uploads WHERE id = ?').run(upload.id);
    }
  } catch (error) {
    logger.warn('stale upload cleanup failed', { error: error instanceof Error ? error.message : 'unknown' });
  }
}

export async function startNimbus(env: NodeJS.ProcessEnv = process.env): Promise<NimbusRuntime> {
  const config = loadConfig(env);
  const logger = createLogger(config.logLevel);
  const secrets = loadSecrets(config, logger);
  const db = openDatabase(config);
  const push = new PushService(config, db, logger, {
    publicKey: secrets.vapidPublicKey,
    privateKey: secrets.vapidPrivateKey,
  });
  const scanner = new ClamAvScanner(config, logger);
  const limiter = new RateLimiter();
  const lockout = new LoginLockout();
  const startedAt = nowMs();
  const base = {
    config,
    db,
    secrets,
    logger,
    limiter,
    lockout,
    push,
    scanner,
    startedAt,
  };
  const hub = new RealtimeHub(base);
  const ctx: AppContext = { ...base, hub };

  cleanupStaleUploads(config, db, logger);
  purgeExpiredSessions(db);

  const app = await buildApp(ctx);
  await app.listen({ host: config.host, port: config.port });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  const url = `${config.requireHttps ? 'https' : 'http'}://${host}:${port}`;

  let contentApp: FastifyInstance | null = null;
  let contentPort: number | null = null;
  let contentUrl: string | null = null;
  if (config.contentPort > 0) {
    contentApp = await buildContentServer(ctx);
    await contentApp.listen({ host: config.host, port: config.contentPort });
    contentPort = config.contentPort;
    contentUrl = `http://${host}:${contentPort}`;
    if (config.publicContentOrigin) contentUrl = config.publicContentOrigin;
  } else if (config.publicContentOrigin) {
    logger.warn(
      'PUBLIC_CONTENT_ORIGIN is set but CONTENT_PORT is 0; links will not resolve through the separate origin',
      {
        origin: config.publicContentOrigin,
      },
    );
  }

  const cleanupInterval = setInterval(() => {
    try {
      purgeExpiredSessions(db);
      lockout.cleanup();
    } catch (error) {
      logger.warn('periodic cleanup failed', { error: error instanceof Error ? error.message : 'unknown' });
    }
  }, 60 * 60_000);
  cleanupInterval.unref();

  const users = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  if (Number(users.n) === 0) {
    logger.warn('first-run setup is open; complete it from the browser now', {
      minutes: config.setupWindowMinutes,
      url,
    });
  }
  if (config.turnUrls.length === 0) {
    logger.warn('TURN is not configured; calls will only work on the local network');
  }
  if (config.clamavHost) logger.info('ClamAV scanning enabled', { host: config.clamavHost, port: config.clamavPort });

  logger.info('service listening', {
    url,
    contentUrl,
    version: config.appVersion,
    httpsRequired: config.requireHttps,
  });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearInterval(cleanupInterval);
    hub.stop();
    await Promise.allSettled([app.close(), contentApp?.close()]);
    db.close();
  };

  return { app, contentApp, ctx, url, contentUrl, port, contentPort, close };
}
