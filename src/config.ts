import fs from 'node:fs';
import path from 'node:path';

export interface Branding {
  name: string;
  slug: string;
  version: string;
  tagline: string;
  description: string;
  developer: string;
  website: string;
  repo: string;
  support: string;
  defaultLocale: string;
  port: number;
}

const FALLBACK_BRANDING: Branding = {
  name: 'Nimbus',
  slug: 'nimbus',
  version: '1.3.4',
  tagline: 'I tuoi file, le tue chat, le tue chiamate. Sul tuo server.',
  description: 'Spazio personale self-hosted.',
  developer: 'Nimbus Self-hosted',
  website: 'https://github.com/danyx67800/nimbus',
  repo: 'https://github.com/danyx67800/nimbus',
  support: 'https://github.com/danyx67800/nimbus/issues',
  defaultLocale: 'it',
  port: 3456,
};

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export interface Config {
  branding: Branding;
  env: string;
  isTest: boolean;
  dataDir: string;
  dbPath: string;
  filesDir: string;
  tmpDir: string;
  secretsDir: string;
  host: string;
  port: number;
  contentPort: number;
  publicContentOrigin: string | null;
  trustProxy: boolean;
  requireHttps: boolean;
  secureCookies: 'auto' | 'always';
  extraOrigins: string[];
  setupWindowMinutes: number;
  sessionTtlDays: number;
  maxUploadBytes: number;
  maxQuickShareBytes: number;
  maxJsonBodyBytes: number;
  defaultQuotaBytes: number;
  turnSecret: string | null;
  turnUrls: string[];
  turnTtlSeconds: number;
  turnRealm: string;
  clamavHost: string | null;
  clamavPort: number;
  rpId: string | null;
  appVersion: string;
  logLevel: string;
  cookieName: string;
  csrfHeader: string;
}

export function loadBranding(): Branding {
  const file = process.env.NIMBUS_CONFIG ?? path.resolve(process.cwd(), 'app.config.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Branding>;
    return { ...FALLBACK_BRANDING, ...raw, port: Number(raw.port) || FALLBACK_BRANDING.port };
  } catch {
    return FALLBACK_BRANDING;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const branding = loadBranding();
  const dataDir = path.resolve(env.DATA_DIR ?? 'data');
  const turnHost = env.TURN_HOST?.trim();
  const turnUrls = (env.TURN_URLS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (turnUrls.length === 0 && turnHost) {
    turnUrls.push(
      `turn:${turnHost}:${int(env.TURN_PORT, 3478)}?transport=udp`,
      `turn:${turnHost}:${int(env.TURN_PORT, 3478)}?transport=tcp`,
    );
  }
  return {
    branding,
    env: env.NODE_ENV ?? 'development',
    isTest: env.NIMBUS_TEST === '1',
    dataDir,
    dbPath: path.join(dataDir, `${branding.slug}.db`),
    filesDir: path.join(dataDir, 'files'),
    tmpDir: path.join(dataDir, 'tmp'),
    secretsDir: path.join(dataDir, 'secrets'),
    host: env.HOST ?? '0.0.0.0',
    port: int(env.PORT, 3000),
    contentPort: int(env.CONTENT_PORT, 0),
    publicContentOrigin: env.PUBLIC_CONTENT_ORIGIN?.replace(/\/+$/, '') ?? null,
    trustProxy: bool(env.TRUST_PROXY, true),
    requireHttps: bool(env.REQUIRE_HTTPS, false),
    secureCookies: env.SECURE_COOKIES === 'always' ? 'always' : 'auto',
    extraOrigins: (env.EXTRA_ORIGINS ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
    setupWindowMinutes: int(env.SETUP_WINDOW_MINUTES, 60),
    sessionTtlDays: int(env.SESSION_TTL_DAYS, 14),
    maxUploadBytes: int(env.MAX_UPLOAD_BYTES, 2 * 1024 * 1024 * 1024),
    maxQuickShareBytes: int(env.MAX_QUICK_SHARE_BYTES, 2 * 1024 * 1024 * 1024),
    maxJsonBodyBytes: int(env.MAX_JSON_BODY_BYTES, 256 * 1024),
    defaultQuotaBytes: int(env.DEFAULT_QUOTA_BYTES, 20 * 1024 * 1024 * 1024),
    turnSecret: env.TURN_SECRET?.trim() || null,
    turnUrls,
    turnTtlSeconds: int(env.TURN_TTL_SECONDS, 3600),
    turnRealm: env.TURN_REALM ?? branding.slug,
    clamavHost: env.CLAMAV_HOST?.trim() || null,
    clamavPort: int(env.CLAMAV_PORT, 3310),
    rpId: env.RP_ID?.trim() || null,
    appVersion: env.APP_VERSION || branding.version,
    logLevel: env.LOG_LEVEL ?? (env.NODE_ENV === 'test' ? 'error' : 'info'),
    cookieName: `${branding.slug}_session`,
    csrfHeader: 'x-csrf-token',
  };
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

export function shouldUseSecureCookie(config: Config, protocol: string, hostname: string): boolean {
  if (config.secureCookies === 'always') return true;
  return protocol === 'https' || isLoopbackHost(hostname);
}
