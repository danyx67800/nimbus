import { sha256Hex, signValue, verifySignedValue } from './crypto.js';
import type { Db } from './db.js';
import type { Secrets } from './secrets.js';

export interface PublicLinkRow {
  id: string;
  file_id: string;
  password_hash: string | null;
  expires_at: number | null;
  max_downloads: number | null;
  downloads: number;
  created_by: string;
  created_at: number;
  revoked_at: number | null;
}

export interface PublicFileRow {
  id: string;
  name: string;
  size: number;
  mime: string;
  kind: string;
  version: number;
  wrapped_key: string | null;
  storage_path: string | null;
  scan_status: string;
  deleted_at: number | null;
}

export function lookupLink(db: Db, token: string): PublicLinkRow | null {
  if (typeof token !== 'string' || token.length < 20 || token.length > 120) return null;
  const row = db
    .prepare(
      `SELECT id, file_id, password_hash, expires_at, max_downloads, downloads, created_by, created_at, revoked_at
       FROM public_links WHERE token_hash = ?`,
    )
    .get(sha256Hex(token)) as PublicLinkRow | undefined;
  return row ?? null;
}

export function getLinkFile(db: Db, link: PublicLinkRow): PublicFileRow | null {
  const row = db
    .prepare(
      `SELECT id, name, size, mime, kind, version, wrapped_key, storage_path, scan_status, deleted_at
       FROM files WHERE id = ?`,
    )
    .get(link.file_id) as PublicFileRow | undefined;
  if (!row || row.kind !== 'file' || row.deleted_at !== null) return null;
  return row;
}

export function linkIsUsable(link: PublicLinkRow): boolean {
  if (link.revoked_at !== null) return false;
  if (link.expires_at !== null && link.expires_at <= Date.now()) return false;
  if (link.max_downloads !== null && link.downloads >= link.max_downloads) return false;
  return true;
}

interface AccessPayload {
  l: string;
  f: string;
  exp: number;
}

export function issueAccessToken(secrets: Secrets, link: PublicLinkRow): string {
  return signValue(
    { l: link.id, f: link.file_id, exp: Date.now() + 30 * 60_000 } satisfies AccessPayload,
    secrets.shareKey,
  );
}

export function verifyAccessToken(secrets: Secrets, token: string | undefined): AccessPayload | null {
  if (typeof token !== 'string' || token.length < 20 || token.length > 500) return null;
  const payload = verifySignedValue<AccessPayload>(token, secrets.shareKey);
  if (!payload || typeof payload.l !== 'string' || typeof payload.f !== 'string') return null;
  if (!Number.isFinite(payload.exp) || payload.exp < Date.now()) return null;
  return payload;
}

export function recordDownload(db: Db, link: PublicLinkRow): boolean {
  const now = Date.now();
  const result = db
    .prepare(
      `UPDATE public_links SET downloads = downloads + 1
       WHERE id = ? AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)
         AND (max_downloads IS NULL OR downloads < max_downloads)`,
    )
    .run(link.id, now);
  return Number(result.changes) > 0;
}
