import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { Readable } from 'node:stream';

export const CHUNK_SIZE = 1024 * 1024;
const MAGIC = Buffer.from('NBENC001', 'ascii');
const HEADER_SIZE = MAGIC.length + 4 + 8;
const NONCE_SIZE = 12;
const TAG_SIZE = 16;

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacSha256(key: Buffer | string, data: string | Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

export function hmacSha1Base64(key: Buffer | string, data: string): string {
  return createHmac('sha1', key).update(data).digest('base64');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function signValue(payload: object, key: Buffer): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = hmacSha256(key, encoded).toString('base64url');
  return `${encoded}.${signature}`;
}

export function verifySignedValue<T>(token: string, key: Buffer): T | null {
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;
  const expected = hmacSha256(key, encoded).toString('base64url');
  if (!constantTimeEqual(signature, expected)) return null;
  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

/** Wrap a per-file key with the instance master key. */
export function wrapKey(masterKey: Buffer, fileKey: Buffer, aad: string): string {
  const nonce = randomBytes(NONCE_SIZE);
  const cipher = createCipheriv('aes-256-gcm', masterKey, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(fileKey), cipher.final()]);
  return `v1.${nonce.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${ciphertext.toString('base64')}`;
}

export function unwrapKey(masterKey: Buffer, wrapped: string, aad: string): Buffer {
  const parts = wrapped.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Malformed wrapped key');
  const nonce = Buffer.from(parts[1] ?? '', 'base64');
  const tag = Buffer.from(parts[2] ?? '', 'base64');
  const ciphertext = Buffer.from(parts[3] ?? '', 'base64');
  if (nonce.length !== NONCE_SIZE || tag.length !== TAG_SIZE) throw new Error('Malformed wrapped key');
  const decipher = createDecipheriv('aes-256-gcm', masterKey, nonce);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function generateFileKey(): Buffer {
  return randomBytes(32);
}

function chunkAad(fileId: string, version: number, index: number): Buffer {
  return Buffer.from(`${fileId}:${version}:${index}`, 'utf8');
}

function encryptFrame(key: Buffer, plaintext: Buffer, aad: Buffer, index: number): Buffer {
  const nonce = randomBytes(NONCE_SIZE);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([
    Buffer.from([index & 0xff, (index >>> 8) & 0xff, (index >>> 16) & 0xff, 0]),
    nonce,
    ciphertext,
    cipher.getAuthTag(),
  ]);
}

async function decryptFrame(key: Buffer, frame: Buffer, aad: Buffer): Promise<Buffer> {
  const nonce = frame.subarray(0, NONCE_SIZE);
  const tag = frame.subarray(frame.length - TAG_SIZE);
  const ciphertext = frame.subarray(NONCE_SIZE, frame.length - TAG_SIZE);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Encrypt a readable stream into `destination` using AES-256-GCM per 1 MiB chunk.
 * Returns the plaintext SHA-256 and size. Partial files are removed on failure.
 */
export async function encryptStreamToFile(options: {
  source: Readable;
  destination: string;
  fileKey: Buffer;
  fileId: string;
  version: number;
  size: number;
}): Promise<{ sha256: string; size: number }> {
  const { source, destination, fileKey, fileId, version, size } = options;
  const handle = await fsp.open(destination, 'wx', 0o600);
  const hash = createHash('sha256');
  let written = 0;
  let index = 0;
  let pending: Buffer = Buffer.alloc(0);
  try {
    const header = Buffer.alloc(HEADER_SIZE);
    MAGIC.copy(header, 0);
    header.writeUInt32BE(CHUNK_SIZE, MAGIC.length);
    header.writeBigUInt64BE(BigInt(size), MAGIC.length + 4);
    await handle.write(header);

    const flush = async (chunk: Buffer): Promise<void> => {
      const frame = encryptFrame(fileKey, chunk, chunkAad(fileId, version, index), index);
      await handle.write(frame);
      index += 1;
    };

    for await (const raw of source) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
      hash.update(chunk);
      written += chunk.length;
      if (written > size) throw new Error('Uploaded data exceeds declared size');
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      while (pending.length >= CHUNK_SIZE) {
        await flush(pending.subarray(0, CHUNK_SIZE));
        pending = pending.subarray(CHUNK_SIZE);
      }
    }
    if (written !== size) throw new Error('Uploaded data does not match declared size');
    if (pending.length > 0) await flush(pending);
    await handle.sync();
    return { sha256: hash.digest('hex'), size: written };
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fsp.unlink(destination).catch(() => undefined);
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function readHeader(header: Buffer): { chunkSize: number; size: number } {
  if (header.length !== HEADER_SIZE || !header.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Invalid encrypted file header');
  }
  const chunkSize = header.readUInt32BE(MAGIC.length);
  const size = Number(header.readBigUInt64BE(MAGIC.length + 4));
  if (chunkSize <= 0 || chunkSize > 8 * 1024 * 1024 || !Number.isSafeInteger(size) || size < 0) {
    throw new Error('Invalid encrypted file metadata');
  }
  return { chunkSize, size };
}

/** Decrypt a byte range without loading the whole file. */
export async function* decryptRange(options: {
  path: string;
  fileKey: Buffer;
  fileId: string;
  version: number;
  start: number;
  end: number;
}): AsyncGenerator<Buffer> {
  const { path, fileKey, fileId, version, start, end } = options;
  const handle = await fsp.open(path, 'r');
  try {
    const headerBuffer = Buffer.alloc(HEADER_SIZE);
    await handle.read(headerBuffer, 0, HEADER_SIZE, 0);
    const header = readHeader(headerBuffer);
    const clampedEnd = Math.min(end, header.size - 1);
    if (start > clampedEnd || start >= header.size) return;
    const cipherChunkSize = header.chunkSize + NONCE_SIZE + TAG_SIZE + 4;
    let position = start;
    while (position <= clampedEnd) {
      const index = Math.floor(position / header.chunkSize);
      const offsetInChunk = position % header.chunkSize;
      const plainChunkLength = Math.min(header.chunkSize, header.size - index * header.chunkSize);
      const frameLength = plainChunkLength + NONCE_SIZE + TAG_SIZE + 4;
      const frame = Buffer.alloc(frameLength);
      const read = await handle.read(frame, 0, frameLength, HEADER_SIZE + index * cipherChunkSize);
      if (read.bytesRead !== frameLength) throw new Error('Encrypted file is truncated');
      const plain = await decryptFrame(fileKey, frame.subarray(4), chunkAad(fileId, version, index));
      const sliceEnd = Math.min(plainChunkLength, offsetInChunk + (clampedEnd - position + 1));
      yield plain.subarray(offsetInChunk, sliceEnd);
      position += sliceEnd - offsetInChunk;
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function decryptWholeFile(options: {
  path: string;
  fileKey: Buffer;
  fileId: string;
  version: number;
}): Promise<Buffer> {
  const handle = await fsp.open(options.path, 'r');
  try {
    const headerBuffer = Buffer.alloc(HEADER_SIZE);
    await handle.read(headerBuffer, 0, HEADER_SIZE, 0);
    const header = readHeader(headerBuffer);
    const cipherChunkSize = header.chunkSize + NONCE_SIZE + TAG_SIZE + 4;
    const parts: Buffer[] = [];
    const frame = Buffer.alloc(cipherChunkSize);
    const count = Math.ceil(header.size / header.chunkSize);
    for (let index = 0; index < count; index += 1) {
      const plainChunkLength = Math.min(header.chunkSize, header.size - index * header.chunkSize);
      const frameLength = plainChunkLength + NONCE_SIZE + TAG_SIZE + 4;
      const read = await handle.read(frame, 0, frameLength, HEADER_SIZE + index * cipherChunkSize);
      if (read.bytesRead !== frameLength) throw new Error('Encrypted file is truncated');
      parts.push(
        await decryptFrame(
          options.fileKey,
          frame.subarray(4, frameLength),
          chunkAad(options.fileId, options.version, index),
        ),
      );
    }
    return Buffer.concat(parts);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = fs.createReadStream(path);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd === '' ? size - 1 : Number(rawEnd);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size)
    return null;
  return { start, end: Math.min(end, size - 1) };
}
