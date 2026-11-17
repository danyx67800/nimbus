import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Config } from './config.js';
import { assertUuid } from './util.js';

const UUID_RE = /^[0-9a-f-]{36}$/i;

function userDir(config: Config, ownerId: string): string {
  assertUuid(ownerId, 'owner');
  const dir = path.join(config.filesDir, ownerId);
  if (path.dirname(dir) !== config.filesDir) throw new Error('Invalid storage root');
  return dir;
}

export function ensureUserDir(config: Config, ownerId: string): string {
  const dir = userDir(config, ownerId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function blobPath(config: Config, ownerId: string, fileId: string, version: number): string {
  assertUuid(fileId, 'file');
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('Invalid version');
  return path.join(userDir(config, ownerId), `${fileId}.v${version}.enc`);
}

export function uploadDir(config: Config, uploadId: string): string {
  assertUuid(uploadId, 'upload');
  const dir = path.join(config.tmpDir, uploadId);
  if (path.dirname(dir) !== config.tmpDir) throw new Error('Invalid temp path');
  return dir;
}

export function uploadChunkPath(config: Config, uploadId: string, index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('Invalid chunk index');
  return path.join(uploadDir(config, uploadId), `${index}.part`);
}

export async function removeUpload(config: Config, uploadId: string): Promise<void> {
  await fsp.rm(uploadDir(config, uploadId), { recursive: true, force: true });
}

export async function removeBlobIfExists(filePath: string): Promise<void> {
  await fsp.unlink(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

export function createTempFile(config: Config, suffix: string): string {
  const name = `${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`;
  return path.join(config.tmpDir, name);
}

export function isValidStoredPath(value: string): boolean {
  return value.length > 0 && !value.includes('\u0000') && !value.includes('..') && path.isAbsolute(value);
}

export { UUID_RE };
