import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as webpush from 'web-push';
import type { Config } from './config.js';
import type { Logger } from './logger.js';

export interface Secrets {
  masterKey: Buffer;
  shareKey: Buffer;
  codesKey: Buffer;
  csrfKey: Buffer;
  vapidPublicKey: string;
  vapidPrivateKey: string;
  turnSecret: string;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

function readOrCreate(file: string, bytes: number): Buffer {
  try {
    const contents = fs.readFileSync(file);
    if (contents.length < bytes) throw new Error(`secret file ${path.basename(file)} is truncated`);
    fs.chmodSync(file, 0o600);
    return contents.subarray(0, bytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const value = randomBytes(bytes);
    const fd = fs.openSync(file, 'wx', 0o600);
    try {
      fs.writeSync(fd, value);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(file, 0o600);
    return value;
  }
}

function readOrCreateJson<T>(file: string, create: () => T): T {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as T;
    fs.chmodSync(file, 0o600);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const value = create();
    const fd = fs.openSync(file, 'wx', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(value));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(file, 0o600);
    return value;
  }
}

export function loadSecrets(config: Config, logger: Logger): Secrets {
  ensureDir(config.dataDir);
  for (const dir of [config.secretsDir, config.filesDir, config.tmpDir]) ensureDir(dir);

  const masterKey = readOrCreate(path.join(config.secretsDir, 'master.key'), 32);
  const shareKey = readOrCreate(path.join(config.secretsDir, 'share.key'), 32);
  const codesKey = readOrCreate(path.join(config.secretsDir, 'recovery.key'), 32);
  const csrfKey = readOrCreate(path.join(config.secretsDir, 'csrf.key'), 32);

  const vapid = readOrCreateJson(path.join(config.secretsDir, 'vapid.json'), () => webpush.generateVAPIDKeys());

  let turnSecret = config.turnSecret;
  if (!turnSecret) {
    const file = path.join(config.secretsDir, 'turn.secret');
    turnSecret = readOrCreate(file, 32).toString('hex');
  }

  logger.info('secrets ready', { directory: config.secretsDir, turnFromEnv: Boolean(config.turnSecret) });
  return {
    masterKey,
    shareKey,
    codesKey,
    csrfKey,
    vapidPublicKey: vapid.publicKey,
    vapidPrivateKey: vapid.privateKey,
    turnSecret,
  };
}
