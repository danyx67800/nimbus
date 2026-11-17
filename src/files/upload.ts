import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { audit } from '../audit.js';
import type { UserRow } from '../auth/sessions.js';
import type { AppContext } from '../context.js';
import { encryptStreamToFile, generateFileKey, wrapKey } from '../crypto.js';
import { withTransaction } from '../db.js';
import { badRequest, conflict, HttpError, notFound, payloadTooLarge } from '../errors.js';
import { sniffContent } from '../sniff.js';
import { blobPath, ensureUserDir, removeUpload, uploadChunkPath, uploadDir } from '../storage.js';
import { newId, nowMs, sanitizeFileName } from '../util.js';
import { canWrite, type FileRow, getFile, requireFolderWrite } from './access.js';

export const UPLOAD_CHUNK_SIZE = 4 * 1024 * 1024;
const MAX_ACTIVE_UPLOADS = 8;

export interface CreateUploadInput {
  name: string;
  parentId: string | null;
  size: number;
  mime?: string;
  versionOf?: string;
}

interface UploadRow {
  id: string;
  owner_id: string;
  parent_id: string | null;
  name: string;
  size: number;
  mime: string;
  target_file_id: string;
  target_version: number;
  received_bytes: number;
  next_index: number;
  status: string;
}

export class UploadService {
  constructor(private readonly ctx: AppContext) {}

  private get(uploadId: string, userId: string): UploadRow {
    const row = this.ctx.db.prepare('SELECT * FROM uploads WHERE id = ? AND owner_id = ?').get(uploadId, userId) as
      | UploadRow
      | undefined;
    if (!row || row.status !== 'active') throw notFound('Upload non trovato');
    return row;
  }

  create(user: UserRow, input: CreateUploadInput): Record<string, unknown> {
    const { config, db } = this.ctx;
    const name = sanitizeFileName(input.name);
    const size = input.size;
    if (!Number.isSafeInteger(size) || size < 0) throw badRequest('Dimensione non valida');
    if (size > config.maxUploadBytes) throw payloadTooLarge('File oltre il limite consentito');
    const active = db
      .prepare("SELECT COUNT(*) AS n FROM uploads WHERE owner_id = ? AND status = 'active'")
      .get(user.id) as {
      n: number;
    };
    if (Number(active.n) >= MAX_ACTIVE_UPLOADS) throw new HttpError(429, 'too_many_uploads', 'Troppi upload in corso');
    if (user.used_bytes + size > user.quota_bytes) throw payloadTooLarge('Quota di spazio esaurita');

    let parentId: string | null = null;
    let targetVersion = 1;
    let fileId = newId();

    if (input.versionOf) {
      const file = getFile(db, input.versionOf);
      if (!file || file.owner_id !== user.id) throw notFound('File non trovato');
      if (file.kind !== 'file') throw badRequest('Non è un file');
      parentId = file.parent_id;
      targetVersion = file.version + 1;
      fileId = file.id;
    } else {
      if (input.parentId) {
        requireFolderWrite(db, input.parentId, user.id);
        parentId = input.parentId;
      }
    }

    const id = newId();
    const now = nowMs();
    db.prepare(
      `INSERT INTO uploads (id, owner_id, parent_id, name, size, mime, target_file_id, target_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      user.id,
      parentId,
      name,
      size,
      input.mime && input.mime.length <= 120 ? input.mime : 'application/octet-stream',
      fileId,
      targetVersion,
      now,
      now,
    );
    fs.mkdirSync(uploadDir(config, id), { recursive: true, mode: 0o700 });
    return {
      uploadId: id,
      chunkSize: UPLOAD_CHUNK_SIZE,
      chunksExpected: Math.ceil(size / UPLOAD_CHUNK_SIZE),
      nextIndex: 0,
      targetFileId: fileId,
      targetVersion,
    };
  }

  status(uploadId: string, userId: string): Record<string, unknown> {
    const upload = this.get(uploadId, userId);
    return {
      uploadId: upload.id,
      nextIndex: upload.next_index,
      receivedBytes: upload.received_bytes,
      size: upload.size,
      chunkSize: UPLOAD_CHUNK_SIZE,
    };
  }

  async addChunk(
    uploadId: string,
    userId: string,
    index: number,
    stream: AsyncIterable<Buffer>,
  ): Promise<Record<string, unknown>> {
    const { config, db } = this.ctx;
    const upload = this.get(uploadId, userId);
    const totalChunks = Math.ceil(upload.size / UPLOAD_CHUNK_SIZE);
    if (!Number.isSafeInteger(index) || index < 0 || index >= totalChunks) throw badRequest('Indice chunk non valido');
    const chunkPath = uploadChunkPath(config, uploadId, index);
    const expected = Math.min(UPLOAD_CHUNK_SIZE, upload.size - index * UPLOAD_CHUNK_SIZE);
    if (index < upload.next_index) {
      const stat = await fsp.stat(chunkPath).catch(() => null);
      if (stat && stat.size === expected) {
        return { uploadId, nextIndex: upload.next_index, receivedBytes: upload.received_bytes, duplicate: true };
      }
      throw conflict('Chunk già ricevuto ma non integro: riavvia l’upload', 'chunk_conflict');
    }
    if (index !== upload.next_index) throw conflict('Chunk fuori sequenza', 'chunk_out_of_order');

    const temp = `${chunkPath}.tmp`;
    const handle = await fsp.open(temp, 'w', 0o600);
    let written = 0;
    try {
      for await (const raw of stream) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
        written += chunk.length;
        if (written > expected) throw payloadTooLarge('Chunk più grande del previsto');
        await handle.write(chunk);
      }
      if (written !== expected) throw badRequest('Chunk incompleto');
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fsp.unlink(temp).catch(() => undefined);
      throw error;
    } finally {
      await handle.close().catch(() => undefined);
    }
    await fsp.rename(temp, chunkPath);
    db.prepare(
      'UPDATE uploads SET received_bytes = received_bytes + ?, next_index = next_index + 1, updated_at = ? WHERE id = ?',
    ).run(expected, nowMs(), uploadId);
    return { uploadId, nextIndex: upload.next_index + 1, receivedBytes: upload.received_bytes + expected };
  }

  async complete(uploadId: string, userId: string, clientSha256?: string): Promise<FileRow> {
    const { config, db, logger } = this.ctx;
    const upload = this.get(uploadId, userId);
    const totalChunks = Math.ceil(upload.size / UPLOAD_CHUNK_SIZE);
    if (upload.next_index !== totalChunks) throw badRequest('Upload incompleto');
    if (upload.received_bytes !== upload.size) throw badRequest('Dimensione upload non coerente');

    const plainTemp = `${uploadDir(config, uploadId)}/plain.bin`;
    const hash = createHash('sha256');
    const source = async function* (): AsyncGenerator<Buffer> {
      for (let index = 0; index < totalChunks; index += 1) {
        const stream = fs.createReadStream(uploadChunkPath(config, uploadId, index));
        for await (const chunk of stream) {
          const buffer = chunk as Buffer;
          hash.update(buffer);
          yield buffer;
        }
      }
    };

    try {
      await pipeline(Readable.from(source()), fs.createWriteStream(plainTemp, { mode: 0o600 }));
      const checksum = hash.digest('hex');
      if (clientSha256 && clientSha256.toLowerCase() !== checksum) {
        throw badRequest('Checksum del file non corrispondente', 'checksum_mismatch');
      }
      const head = Buffer.alloc(Math.min(8192, upload.size));
      if (upload.size > 0) {
        const handle = await fsp.open(plainTemp, 'r');
        try {
          await handle.read(head, 0, head.length, 0);
        } finally {
          await handle.close();
        }
      }
      const sniff = sniffContent(head);
      if (this.ctx.scanner.enabled) {
        const scan = await this.ctx.scanner.scanFile(plainTemp);
        if (!scan.clean) {
          logger.warn('upload rejected by malware scanner', { uploadId, signature: scan.signature ?? 'unknown' });
          throw new HttpError(422, 'malware_detected', 'Il file è stato bloccato dalla scansione antivirus.');
        }
      }

      const key = generateFileKey();
      const wrappedKey = wrapKey(
        this.ctx.secrets.masterKey,
        key,
        `file:${upload.target_file_id}:${upload.target_version}`,
      );
      ensureUserDir(config, userId);
      const destination = blobPath(config, userId, upload.target_file_id, upload.target_version);
      const result = await encryptStreamToFile({
        source: fs.createReadStream(plainTemp),
        destination,
        fileKey: key,
        fileId: upload.target_file_id,
        version: upload.target_version,
        size: upload.size,
      });

      const name = sanitizeFileName(upload.name);
      if (upload.target_version > 1) {
        const file = getFile(db, upload.target_file_id);
        if (!file || file.owner_id !== userId) {
          await fsp.unlink(destination).catch(() => undefined);
          throw notFound('File non trovato');
        }
        if (file.version + 1 !== upload.target_version) {
          await fsp.unlink(destination).catch(() => undefined);
          throw conflict('Il file è stato modificato nel frattempo. Ricarica la pagina.', 'version_conflict');
        }
        withTransaction(db, () => {
          const used = db.prepare('SELECT used_bytes FROM users WHERE id = ?').get(userId) as { used_bytes: number };
          if (
            Number(used.used_bytes) + upload.size >
            Number(
              (db.prepare('SELECT quota_bytes FROM users WHERE id = ?').get(userId) as { quota_bytes: number })
                .quota_bytes,
            )
          ) {
            throw payloadTooLarge('Quota di spazio esaurita');
          }
          db.prepare(
            `INSERT INTO file_versions (id, file_id, version, size, mime, wrapped_key, storage_path, checksum, created_at, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            newId(),
            file.id,
            file.version,
            file.size,
            file.mime,
            file.wrapped_key ?? '',
            file.storage_path ?? '',
            file.checksum,
            nowMs(),
            userId,
          );
          db.prepare(
            `UPDATE files SET name = ?, size = ?, mime = ?, wrapped_key = ?, storage_path = ?, checksum = ?, version = ?,
              scan_status = 'clean', updated_at = ? WHERE id = ?`,
          ).run(
            name,
            result.size,
            sniff.mime,
            wrappedKey,
            destination,
            result.sha256,
            upload.target_version,
            nowMs(),
            file.id,
          );
          db.prepare('UPDATE users SET used_bytes = used_bytes + ?, updated_at = ? WHERE id = ?').run(
            upload.size,
            nowMs(),
            userId,
          );
          db.prepare("UPDATE uploads SET status = 'complete', updated_at = ? WHERE id = ?").run(nowMs(), uploadId);
        });
      } else {
        if (
          db
            .prepare(
              "SELECT id FROM files WHERE owner_id = ? AND IFNULL(parent_id, '') = ? AND name = ? COLLATE NOCASE AND deleted_at IS NULL",
            )
            .get(userId, upload.parent_id ?? '', name)
        ) {
          await fsp.unlink(destination).catch(() => undefined);
          throw conflict('Esiste già un elemento con questo nome', 'name_taken');
        }
        withTransaction(db, () => {
          const user = db.prepare('SELECT used_bytes, quota_bytes FROM users WHERE id = ?').get(userId) as {
            used_bytes: number;
            quota_bytes: number;
          };
          if (Number(user.used_bytes) + result.size > Number(user.quota_bytes))
            throw payloadTooLarge('Quota di spazio esaurita');
          db.prepare(
            `INSERT INTO files (id, owner_id, parent_id, name, kind, size, mime, wrapped_key, storage_path, checksum,
              version, scan_status, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'file', ?, ?, ?, ?, ?, 1, 'clean', ?, ?)`,
          ).run(
            upload.target_file_id,
            userId,
            upload.parent_id,
            name,
            result.size,
            sniff.mime,
            wrappedKey,
            destination,
            result.sha256,
            nowMs(),
            nowMs(),
          );
          db.prepare('UPDATE users SET used_bytes = used_bytes + ?, updated_at = ? WHERE id = ?').run(
            result.size,
            nowMs(),
            userId,
          );
          db.prepare("UPDATE uploads SET status = 'complete', updated_at = ? WHERE id = ?").run(nowMs(), uploadId);
        });
      }

      audit(db, {
        actorId: userId,
        action: 'file.uploaded',
        targetType: 'file',
        targetId: upload.target_file_id,
        meta: { size: result.size, mime: sniff.mime, version: upload.target_version },
      });
      const file = getFile(db, upload.target_file_id);
      if (!file) throw new Error('Upload committed but file missing');
      return file;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      logger.error('upload finalization failed', { error: error instanceof Error ? error.message : 'unknown' });
      throw new HttpError(500, 'upload_failed', 'Caricamento non riuscito');
    } finally {
      await fsp.unlink(plainTemp).catch(() => undefined);
      await removeUpload(config, uploadId);
    }
  }

  async cancel(uploadId: string, userId: string): Promise<void> {
    this.get(uploadId, userId);
    this.ctx.db.prepare('DELETE FROM uploads WHERE id = ? AND owner_id = ?').run(uploadId, userId);
    await removeUpload(this.ctx.config, uploadId);
  }

  canUploadTo(parentId: string | null, user: UserRow): boolean {
    if (!parentId) return true;
    const folder = getFile(this.ctx.db, parentId);
    return Boolean(folder && folder.kind === 'folder' && canWrite(this.ctx.db, folder, user.id));
  }
}
