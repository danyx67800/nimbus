import * as webpush from 'web-push';
import type { Config } from './config.js';
import type { PushPort } from './context.js';
import type { Db } from './db.js';
import type { Logger } from './logger.js';

interface StoredSubscription {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export class PushService implements PushPort {
  readonly publicKey: string;

  constructor(
    private readonly config: Config,
    private readonly db: Db,
    private readonly logger: Logger,
    vapid: { publicKey: string; privateKey: string },
  ) {
    this.publicKey = vapid.publicKey;
    webpush.setVapidDetails('mailto:admin@localhost', vapid.publicKey, vapid.privateKey);
  }

  notifyUser(userId: string, payload: { title: string; body: string; url?: string; tag?: string }): void {
    const subscriptions = this.db
      .prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ? LIMIT 20')
      .all(userId) as unknown as StoredSubscription[];
    if (subscriptions.length === 0) return;
    const body = JSON.stringify({
      title: payload.title,
      body: payload.body,
      url: payload.url ?? '/',
      tag: payload.tag ?? 'nimbus',
      icon: '/icon.svg',
    });
    for (const subscription of subscriptions) {
      void webpush
        .sendNotification(
          { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
          body,
          { TTL: 3600, urgency: 'normal' },
        )
        .catch((error: { statusCode?: number }) => {
          if (error.statusCode === 404 || error.statusCode === 410) {
            this.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(subscription.id);
            return;
          }
          this.logger.warn('push delivery failed', { statusCode: error.statusCode ?? 'unknown' });
        });
    }
  }

  subscribe(userId: string, input: { endpoint: string; p256dh: string; auth: string }): void {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
      )
      .run(crypto.randomUUID(), userId, input.endpoint, input.p256dh, input.auth, Date.now());
  }

  unsubscribe(userId: string, endpoint: string): void {
    this.db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, endpoint);
  }

  get configRef(): Config {
    return this.config;
  }
}
