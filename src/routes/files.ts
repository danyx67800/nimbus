import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { hashPassword } from '../auth/passwords.js';
import type { AppContext } from '../context.js';
import {
  decryptRange,
  encryptStreamToFile,
  generateFileKey,
  randomToken,
  sha256Hex,
  unwrapKey,
  wrapKey,
} from '../crypto.js';
import { withTransaction } from '../db.js';
import { badRequest, conflict, forbidden, notFound, payloadTooLarge } from '../errors.js';
import {
  assertNotIntoItself,
  descendantFiles,
  type FileRow,
  fileJson,
  folderPath,
  getFile,
  getPermission,
  getVersion,
  requireFile,
  requireFolderWrite,
} from '../files/access.js';
import { sendContent } from '../files/content.js';
import { UPLOAD_CHUNK_SIZE, UploadService } from '../files/upload.js';
import { clientIp, enforceRate, parseBody, requestUserAgent } from '../http/helpers.js';
import { requireAuth } from '../http/security.js';
import { blobPath, removeBlobIfExists } from '../storage.js';
import { assertUuid, newId, nowMs, sanitizeFileName } from '../util.js';

function nameTaken(
  db: AppContext['db'],
  ownerId: string,
  parentId: string | null,
  name: string,
  excludeId?: string,
): boolean {
  const row = db
    .prepare(
      `SELECT id FROM files WHERE owner_id = ? AND IFNULL(parent_id, '') = ? AND name = ? COLLATE NOCASE
       AND deleted_at IS NULL AND (? IS NULL OR id != ?)`,
    )
    .get(ownerId, parentId ?? '', name, excludeId ?? null, excludeId ?? null);
  return Boolean(row);
}

function uniqueName(db: AppContext['db'], ownerId: string, parentId: string | null, desired: string): string {
  const base = sanitizeFileName(desired).slice(0, 160);
  let candidate = base;
  let counter = 2;
  while (nameTaken(db, ownerId, parentId, candidate)) {
    candidate = `${base.slice(0, 150)} (${counter})`;
    counter += 1;
  }
  return candidate;
}

function strictOwner(file: FileRow, userId: string): void {
  if (file.owner_id !== userId) throw forbidden('Solo il proprietario può eseguire questa operazione');
}

function activeFile(db: AppContext['db'], id: string, userId: string): FileRow {
  const { file } = requireFile(db, id, userId, 'read');
  if (file.deleted_at !== null) throw notFound('File non trovato');
  return file;
}

function sourceOf(file: FileRow): {
  id: string;
  name: string;
  size: number;
  mime: string;
  version: number;
  wrapped_key: string | null;
  storage_path: string | null;
  scan_status: string;
} {
  return {
    id: file.id,
    name: file.name,
    size: file.size,
    mime: file.mime,
    version: file.version,
    wrapped_key: file.wrapped_key,
    storage_path: file.storage_path,
    scan_status: file.scan_status,
  };
}

function trashTopLevel(db: AppContext['db'], user: { id: string }): FileRow[] {
  return db
    .prepare(
      `SELECT f.* FROM files f LEFT JOIN files p ON p.id = f.parent_id
       WHERE f.owner_id = ? AND f.deleted_at IS NOT NULL AND (f.parent_id IS NULL OR p.deleted_at IS NULL)
       ORDER BY f.deleted_at DESC LIMIT 500`,
    )
    .all(user.id) as unknown as FileRow[];
}

function reactivateDescendants(db: AppContext['db'], file: FileRow): void {
  const now = nowMs();
  const rows = descendantFiles(db, file.id);
  for (const row of rows) {
    if (row.id === file.id) continue;
    if (nameTaken(db, row.owner_id, row.parent_id, row.name, row.id)) {
      const restoredName = uniqueName(db, row.owner_id, row.parent_id, row.name);
      db.prepare('UPDATE files SET deleted_at = NULL, name = ?, updated_at = ? WHERE id = ?').run(
        restoredName,
        now,
        row.id,
      );
    } else {
      db.prepare('UPDATE files SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now, row.id);
    }
  }
}

async function copyTree(
  ctx: AppContext,
  user: { id: string; quota_bytes: number; used_bytes: number },
  source: FileRow,
  targetParentId: string | null,
  options: { nameSuffix: string; depth: number },
): Promise<FileRow> {
  if (options.depth > 32) throw badRequest('Struttura troppo profonda');
  if (source.kind === 'folder') {
    const folderId = newId();
    const name = uniqueName(ctx.db, user.id, targetParentId, `${source.name}${options.nameSuffix}`);
    ctx.db
      .prepare(
        `INSERT INTO files (id, owner_id, parent_id, name, kind, size, mime, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'folder', 0, 'inode/directory', 1, ?, ?)`,
      )
      .run(folderId, user.id, targetParentId, name, nowMs(), nowMs());
    const children = ctx.db
      .prepare('SELECT * FROM files WHERE parent_id = ? AND deleted_at IS NULL ORDER BY kind DESC, name COLLATE NOCASE')
      .all(source.id) as unknown as FileRow[];
    for (const child of children) {
      await copyTree(ctx, user, child, folderId, { nameSuffix: '', depth: options.depth + 1 });
    }
    const folder = getFile(ctx.db, folderId);
    if (!folder) throw new Error('Copy failed');
    return folder;
  }

  if (!source.wrapped_key || !source.storage_path) throw notFound('File non trovato');
  const total = (ctx.db.prepare('SELECT used_bytes FROM users WHERE id = ?').get(user.id) as { used_bytes: number })
    .used_bytes;
  if (total + source.size > user.quota_bytes) throw payloadTooLarge('Quota di spazio esaurita');
  const newFileId = newId();
  const key = generateFileKey();
  const wrapped = wrapKey(ctx.secrets.masterKey, key, `file:${newFileId}:1`);
  const destination = blobPath(ctx.config, user.id, newFileId, 1);
  const oldKey = unwrapKey(ctx.secrets.masterKey, source.wrapped_key, `file:${source.id}:${source.version}`);
  const generator = decryptRange({
    path: source.storage_path,
    fileKey: oldKey,
    fileId: source.id,
    version: source.version,
    start: 0,
    end: Math.max(0, source.size - 1),
  });
  try {
    await encryptStreamToFile({
      source: Readable.from(generator),
      destination,
      fileKey: key,
      fileId: newFileId,
      version: 1,
      size: source.size,
    });
  } catch (error) {
    await removeBlobIfExists(destination);
    throw error;
  }
  const name = uniqueName(ctx.db, user.id, targetParentId, `${source.name}${options.nameSuffix}`);
  try {
    withTransaction(ctx.db, () => {
      const current = ctx.db.prepare('SELECT used_bytes, quota_bytes FROM users WHERE id = ?').get(user.id) as {
        used_bytes: number;
        quota_bytes: number;
      };
      if (Number(current.used_bytes) + source.size > Number(current.quota_bytes))
        throw payloadTooLarge('Quota di spazio esaurita');
      ctx.db
        .prepare(
          `INSERT INTO files (id, owner_id, parent_id, name, kind, size, mime, wrapped_key, storage_path, checksum,
          version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'file', ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          newFileId,
          user.id,
          targetParentId,
          name,
          source.size,
          source.mime,
          wrapped,
          destination,
          source.checksum,
          nowMs(),
          nowMs(),
        );
      ctx.db
        .prepare('UPDATE users SET used_bytes = used_bytes + ?, updated_at = ? WHERE id = ?')
        .run(source.size, nowMs(), user.id);
    });
  } catch (error) {
    await removeBlobIfExists(destination);
    throw error;
  }
  const copied = getFile(ctx.db, newFileId);
  if (!copied) throw new Error('Copy failed');
  return copied;
}

export function registerFileRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config, secrets } = ctx;
  const uploads = new UploadService(ctx);

  app.get('/api/files', async (req) => {
    const { user } = requireAuth(req);
    const query = req.query as { parent?: string; view?: string; search?: string };
    const view = query.view ?? 'files';
    if (view === 'trash') {
      return { items: trashTopLevel(db, user).map((file) => fileJson(db, file, user.id)), breadcrumb: [] };
    }
    if (view === 'favorites') {
      const rows = db
        .prepare(
          'SELECT * FROM files WHERE owner_id = ? AND favorite = 1 AND deleted_at IS NULL ORDER BY kind DESC, name COLLATE NOCASE',
        )
        .all(user.id) as unknown as FileRow[];
      return { items: rows.map((file) => fileJson(db, file, user.id)), breadcrumb: [] };
    }
    if (view === 'shared') {
      const rows = db
        .prepare(
          `SELECT f.*, s.permission AS share_permission, u.display_name AS owner_name
           FROM file_shares s JOIN files f ON f.id = s.file_id JOIN users u ON u.id = f.owner_id
           WHERE s.user_id = ? AND f.deleted_at IS NULL
           ORDER BY f.kind DESC, f.name COLLATE NOCASE LIMIT 500`,
        )
        .all(user.id) as unknown as Array<FileRow & { share_permission: string; owner_name: string }>;
      return {
        items: rows.map((file) => ({
          ...fileJson(db, file, user.id, { sharePermission: file.share_permission }),
          ownerName: file.owner_name,
        })),
        breadcrumb: [],
      };
    }
    if (query.search !== undefined && query.search.trim() !== '') {
      const term = query.search
        .trim()
        .slice(0, 200)
        .replace(/[\\%_]/g, (char) => `\\${char}`);
      const rows = db
        .prepare(
          `SELECT * FROM files WHERE owner_id = ? AND deleted_at IS NULL AND name LIKE ? ESCAPE '\\'
           ORDER BY kind DESC, name COLLATE NOCASE LIMIT 300`,
        )
        .all(user.id, `%${term}%`) as unknown as FileRow[];
      return { items: rows.map((file) => fileJson(db, file, user.id)), breadcrumb: [] };
    }

    let parentId: string | null = null;
    if (query.parent) {
      parentId = assertUuid(query.parent, 'parent');
      const parent = getFile(db, parentId);
      if (!parent || parent.kind !== 'folder' || parent.deleted_at !== null) throw notFound('Cartella non trovata');
      if (!getPermission(db, parent, user.id)) throw notFound('Cartella non trovata');
    }
    const rows = parentId
      ? (db
          .prepare(
            'SELECT * FROM files WHERE parent_id = ? AND deleted_at IS NULL ORDER BY kind DESC, name COLLATE NOCASE LIMIT 1000',
          )
          .all(parentId) as unknown as FileRow[])
      : (db
          .prepare(
            'SELECT * FROM files WHERE owner_id = ? AND parent_id IS NULL AND deleted_at IS NULL ORDER BY kind DESC, name COLLATE NOCASE LIMIT 1000',
          )
          .all(user.id) as unknown as FileRow[]);
    return {
      items: rows.map((file) => fileJson(db, file, user.id)),
      breadcrumb: folderPath(db, parentId, user.id),
      parentId,
    };
  });

  app.post('/api/files/folders', async (req) => {
    const { user } = requireAuth(req);
    enforceRate(ctx.limiter, `folder-create:${user.id}`, 60, 10 * 60_000);
    const body = parseBody(
      z.object({ name: z.string().min(1).max(200), parentId: z.string().uuid().nullable().optional() }),
      req.body,
    );
    const parentId = body.parentId ?? null;
    if (parentId) requireFolderWrite(db, parentId, user.id);
    const name = sanitizeFileName(body.name);
    if (nameTaken(db, user.id, parentId, name)) throw conflict('Esiste già un elemento con questo nome', 'name_taken');
    const id = newId();
    db.prepare(
      `INSERT INTO files (id, owner_id, parent_id, name, kind, size, mime, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'folder', 0, 'inode/directory', 1, ?, ?)`,
    ).run(id, user.id, parentId, name, nowMs(), nowMs());
    const file = getFile(db, id);
    if (!file) throw new Error('Folder creation failed');
    return { item: fileJson(db, file, user.id) };
  });

  app.get('/api/files/:id', async (req) => {
    const { user } = requireAuth(req);
    const id = assertUuid((req.params as { id?: string }).id, 'file');
    const { file, permission } = requireFile(db, id, user.id, 'read');
    const owner = db.prepare('SELECT display_name FROM users WHERE id = ?').get(file.owner_id) as
      | { display_name: string }
      | undefined;
    const linkCount = db
      .prepare('SELECT COUNT(*) AS n FROM public_links WHERE file_id = ? AND revoked_at IS NULL')
      .get(file.id) as { n: number };
    return {
      item: {
        ...fileJson(db, file, user.id),
        permission,
        ownerName: owner?.display_name ?? null,
        shareCount: (
          db.prepare('SELECT COUNT(*) AS n FROM file_shares WHERE file_id = ?').get(file.id) as { n: number }
        ).n,
        publicLinkCount: Number(linkCount.n),
      },
      breadcrumb: folderPath(db, file.parent_id, user.id),
    };
  });

  app.patch('/api/files/:id', async (req) => {
    const { user } = requireAuth(req);
    const id = assertUuid((req.params as { id?: string }).id, 'file');
    const { file } = requireFile(db, id, user.id, 'owner');
    strictOwner(file, user.id);
    if (file.deleted_at !== null) throw badRequest('Ripristina l’elemento prima di modificarlo');
    const body = parseBody(
      z.object({
        name: z.string().min(1).max(200).optional(),
        parentId: z.string().uuid().nullable().optional(),
        favorite: z.boolean().optional(),
      }),
      req.body,
    );
    const now = nowMs();
    if (body.name !== undefined) {
      const name = sanitizeFileName(body.name);
      if (nameTaken(db, user.id, file.parent_id, name, file.id))
        throw conflict('Esiste già un elemento con questo nome', 'name_taken');
      db.prepare('UPDATE files SET name = ?, updated_at = ? WHERE id = ?').run(name, now, id);
    }
    if (body.parentId !== undefined) {
      if (file.kind === 'folder') assertNotIntoItself(db, file.id, body.parentId ?? '');
      if (body.parentId) {
        const parent = requireFolderWrite(db, body.parentId, user.id);
        if (!parent) throw notFound('Cartella non trovata');
      }
      if (nameTaken(db, user.id, body.parentId, file.name, file.id))
        throw conflict('Esiste già un elemento con questo nome', 'name_taken');
      db.prepare('UPDATE files SET parent_id = ?, updated_at = ? WHERE id = ?').run(body.parentId, now, id);
    }
    if (body.favorite !== undefined) {
      db.prepare('UPDATE files SET favorite = ?, updated_at = ? WHERE id = ?').run(body.favorite ? 1 : 0, now, id);
    }
    const updated = getFile(db, id);
    if (!updated) throw new Error('Update failed');
    return { item: fileJson(db, updated, user.id) };
  });

  app.post('/api/files/:id/copy', async (req) => {
    const { user } = requireAuth(req);
    const id = assertUuid((req.params as { id?: string }).id, 'file');
    const file = activeFile(db, id, user.id);
    const body = parseBody(z.object({ parentId: z.string().uuid().nullable().optional() }), req.body);
    const parentId = body.parentId ?? null;
    if (parentId) requireFolderWrite(db, parentId, user.id);
    const copy = await copyTree(ctx, user, file, parentId, { nameSuffix: ' (copia)', depth: 0 });
    return { item: fileJson(db, copy, user.id) };
  });

  app.delete('/api/files/:id', async (req) => {
    const { user } = requireAuth(req);
    const id = assertUuid((req.params as { id?: string }).id, 'file');
    const { file } = requireFile(db, id, user.id, 'owner');
    strictOwner(file, user.id);
    if (file.deleted_at !== null) throw badRequest('Elemento già nel cestino');
    const now = nowMs();
    const rows = descendantFiles(db, file.id);
    withTransaction(db, () => {
      db.prepare('UPDATE files SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, file.id);
      for (const row of rows) {
        if (row.id !== file.id)
          db.prepare('UPDATE files SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, row.id);
      }
    });
    audit(db, {
      actorId: user.id,
      action: 'file.deleted',
      targetType: 'file',
      targetId: file.id,
      ip: clientIp(req),
      userAgent: requestUserAgent(req),
      meta: { name: file.name, kind: file.kind },
    });
    return { ok: true };
  });

  app.post('/api/files/:id/restore', async (req) => {
    const { user } = requireAuth(req);
    const id = assertUuid((req.params as { id?: string }).id, 'file');
    const { file } = requireFile(db, id, user.id, 'owner');
    strictOwner(file, user.id);
    if (file.deleted_at === null) throw badRequest('Elemento non nel cestino');
    withTransaction(db, () => {
      const parent = file.parent_id ? getFile(db, file.parent_id) : null;
      const parentPermission = parent && parent.deleted_at === null ? getPermission(db, parent, user.id) : null;
      const destinationParent =
        parentPermission === 'owner' || parentPermission === 'write' ? (parent?.id ?? null) : null;
      const rootName = nameTaken(db, user.id, destinationParent, file.name, file.id)
        ? uniqueName(db, user.id, destinationParent, file.name)
        : file.name;
      db.prepare('UPDATE files SET parent_id = ?, name = ?, deleted_at = NULL, updated_at = ? WHERE id = ?').run(
        destinationParent,
        rootName,
        nowMs(),
        file.id,
      );
      reactivateDescendants(db, file);
    });
    audit(db, {
      actorId: user.id,
      action: 'file.restored',
      targetType: 'file',
      targetId: file.id,
      ip: clientIp(req),
      userAgent: requestUserAgent(req),
    });
    return { item: fileJson(db, getFile(db, file.id) as FileRow, user.id) };
  });

  app.delete('/api/files/:id/purge', async (req) => {
    const { user } = requireAuth(req);
    const id = assertUuid((req.params as { id?: string }).id, 'file');
    const { file } = requireFile(db, id, user.id, 'owner');
    strictOwner(file, user.id);
    if (file.deleted_at === null) throw badRequest('Sposta prima l’elemento nel cestino');
    const rows = descendantFiles(db, file.id);
    const perOwner = new Map<string, number>();
    for (const row of rows) {
      const versions = db
        .prepare('SELECT storage_path, size FROM file_versions WHERE file_id = ?')
        .all(row.id) as Array<{
        storage_path: string;
        size: number;
      }>;
      for (const version of versions) {
        await removeBlobIfExists(version.storage_path);
        perOwner.set(row.owner_id, (perOwner.get(row.owner_id) ?? 0) + Number(version.size));
      }
      if (row.kind === 'file') {
        if (row.storage_path) await removeBlobIfExists(row.storage_path);
        perOwner.set(row.owner_id, (perOwner.get(row.owner_id) ?? 0) + row.size);
      }
    }
    withTransaction(db, () => {
      db.prepare('DELETE FROM files WHERE id = ?').run(file.id);
      for (const [ownerId, size] of perOwner) {
        db.prepare('UPDATE users SET used_bytes = MAX(0, used_bytes - ?), updated_at = ? WHERE id = ?').run(
          size,
          nowMs(),
          ownerId,
        );
      }
    });
    audit(db, {
      actorId: user.id,
      action: 'file.purged',
      targetType: 'file',
      targetId: file.id,
      ip: clientIp(req),
      userAgent: requestUserAgent(req),
      meta: { name: file.name, kind: file.kind },
    });
    return { ok: true };
  });

  app.get('/api/files/:id/content', async (req, reply) => {
    const { user } = requireAuth(req);
    const id = assertUuid((req.params as { id?: string }).id, 'file');
    const file = activeFile(db, id, user.id);
    if (file.kind !== 'file') throw badRequest('Non è un file');
    const query = req.query as { download?: string };
    return sendContent(reply, { config, secrets }, sourceOf(file), {
      inline: query.download !== '1' && query.download !== 'true',
      rangeHeader: req.headers.range,
    });
  });

  app.get('/api/files/:id/versions', async (req) => {
    const { user } = requireAuth(req);
    const id = assertUuid((req.params as { id?: string }).id, 'file');
    const { file } = requireFile(db, id, user.id, 'read');
    if (file.kind !== 'file') throw badRequest('Non è un file');
    const rows = db
      .prepare('SELECT * FROM file_versions WHERE file_id = ? ORDER BY version DESC')
      .all(file.id) as Array<Record<string, unknown>>;
    return {
      versions: [
        {
          version: file.version,
          size: file.size,
          mime: file.mime,
          checksum: file.checksum,
          createdAt: file.updated_at,
          current: true,
        },
        ...rows.map((row) => ({
          version: Number(row.version),
          size: Number(row.size),
          mime: String(row.mime),
          checksum: row.checksum ? String(row.checksum) : null,
          createdAt: Number(row.created_at),
          current: false,
        })),
      ],
    };
  });

  app.post('/api/files/:id/versions/:version/restore', async (req) => {
    const { user } = requireAuth(req);
    const id = assertUuid((req.params as { id?: string }).id, 'file');
    const versionParam = Number.parseInt((req.params as { version?: string }).version ?? '', 10);
    const { file } = requireFile(db, id, user.id, 'owner');
    strictOwner(file, user.id);
    if (file.kind !== 'file') throw badRequest('Non è un file');
    const version = getVersion(db, file.id, versionParam);
    if (!version) throw notFound('Versione non trovata');
    if (version.version === file.version) throw badRequest('La versione è già quella corrente');
    const nextVersion = file.version + 1;
    const oldKey = unwrapKey(secrets.masterKey, version.wrapped_key, `file:${file.id}:${version.version}`);
    const newKey = generateFileKey();
    const newWrapped = wrapKey(secrets.masterKey, newKey, `file:${file.id}:${nextVersion}`);
    const destination = blobPath(config, user.id, file.id, nextVersion);
    const generator = decryptRange({
      path: version.storage_path,
      fileKey: oldKey,
      fileId: file.id,
      version: version.version,
      start: 0,
      end: Math.max(0, version.size - 1),
    });
    await encryptStreamToFile({
      source: Readable.from(generator),
      destination,
      fileKey: newKey,
      fileId: file.id,
      version: nextVersion,
      size: version.size,
    });
    try {
      withTransaction(db, () => {
        const current = db.prepare('SELECT used_bytes, quota_bytes FROM users WHERE id = ?').get(user.id) as {
          used_bytes: number;
          quota_bytes: number;
        };
        if (Number(current.used_bytes) + version.size > Number(current.quota_bytes))
          throw payloadTooLarge('Quota di spazio esaurita');
        const exists = db
          .prepare('SELECT id FROM file_versions WHERE file_id = ? AND version = ?')
          .get(file.id, file.version);
        if (!exists) {
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
            user.id,
          );
        }
        db.prepare(
          `UPDATE files SET size = ?, mime = ?, wrapped_key = ?, storage_path = ?, checksum = ?, version = ?, updated_at = ? WHERE id = ?`,
        ).run(version.size, version.mime, newWrapped, destination, version.checksum, nextVersion, nowMs(), file.id);
        db.prepare('UPDATE users SET used_bytes = used_bytes + ?, updated_at = ? WHERE id = ?').run(
          version.size,
          nowMs(),
          user.id,
        );
      });
    } catch (error) {
      await removeBlobIfExists(destination);
      throw error;
    }
    audit(db, {
      actorId: user.id,
      action: 'file.version_restored',
      targetType: 'file',
      targetId: file.id,
      ip: clientIp(req),
      userAgent: requestUserAgent(req),
      meta: { version: version.version },
    });
    return { ok: true, version: nextVersion };
  });

  // ---- Uploads ----
  app.post('/api/uploads', async (req) => {
    const { user } = requireAuth(req);
    enforceRate(ctx.limiter, `upload-create:${user.id}`, 120, 10 * 60_000);
    const body = parseBody(
      z.object({
        name: z.string().min(1).max(200),
        parentId: z.string().uuid().nullable().optional(),
        size: z.number().int().min(0).max(config.maxUploadBytes),
        sha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/i)
          .optional(),
      }),
      req.body,
    );
    return uploads.create(user, { name: body.name, parentId: body.parentId ?? null, size: body.size });
  });

  app.post('/api/files/:id/versions/upload', async (req) => {
    const { user } = requireAuth(req);
    enforceRate(ctx.limiter, `upload-version:${user.id}`, 60, 10 * 60_000);
    const id = assertUuid((req.params as { id?: string }).id, 'file');
    const file = activeFile(db, id, user.id);
    strictOwner(file, user.id);
    if (file.kind !== 'file') throw badRequest('Non è un file');
    const body = parseBody(z.object({ size: z.number().int().min(0).max(config.maxUploadBytes) }), req.body);
    return uploads.create(user, { name: file.name, parentId: file.parent_id, size: body.size, versionOf: file.id });
  });

  app.get('/api/uploads/:id', async (req) => {
    const { user } = requireAuth(req);
    const id = assertUuid((req.params as { id?: string }).id, 'upload');
    return uploads.status(id, user.id);
  });

  app.put('/api/uploads/:id/chunks/:index', { bodyLimit: UPLOAD_CHUNK_SIZE + 1024 }, async (req) => {
    const { user } = requireAuth(req);
    const id = assertUuid((req.params as { id?: string }).id, 'upload');
    const index = Number.parseInt((req.params as { index?: string }).index ?? '', 10);
    const stream = req.body as AsyncIterable<Buffer>;
    if (!stream || typeof (stream as unknown as AsyncIterable<Buffer>)[Symbol.asyncIterator] !== 'function') {
      throw badRequest('Corpo del chunk mancante');
    }
    return uploads.addChunk(id, user.id, index, stream);
  });

  app.post('/api/uploads/:id/complete', async (req) => {
    const { user } = requireAuth(req);
    const id = assertUuid((req.params as { id?: string }).id, 'upload');
    const body = parseBody(
      z.object({
        sha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/i)
          .optional(),
      }),
      req.body,
    );
    const file = await uploads.complete(id, user.id, body.sha256);
    return { item: fileJson(db, file, user.id) };
  });

  app.delete('/api/uploads/:id', async (req) => {
    const { user } = requireAuth(req);
    const id = assertUuid((req.params as { id?: string }).id, 'upload');
    await uploads.cancel(id, user.id);
    return { ok: true };
  });

  // ---- User shares ----
  app.get('/api/shares', async (req) => {
    const { user } = requireAuth(req);
    const incoming = db
      .prepare(
        `SELECT s.file_id, s.permission, s.created_at, f.name, f.kind, f.size, f.deleted_at,
                o.display_name AS owner_name, o.username AS owner_username
         FROM file_shares s JOIN files f ON f.id = s.file_id JOIN users o ON o.id = f.owner_id
         WHERE s.user_id = ? AND f.deleted_at IS NULL ORDER BY s.created_at DESC LIMIT 300`,
      )
      .all(user.id) as Array<Record<string, unknown>>;
    const outgoing = db
      .prepare(
        `SELECT s.file_id, s.user_id, s.permission, s.created_at, f.name, f.kind,
                u.display_name AS user_name, u.username
         FROM file_shares s JOIN files f ON f.id = s.file_id JOIN users u ON u.id = s.user_id
         WHERE f.owner_id = ? AND f.deleted_at IS NULL ORDER BY s.created_at DESC LIMIT 300`,
      )
      .all(user.id) as Array<Record<string, unknown>>;
    const links = db
      .prepare(
        `SELECT l.id, l.file_id, l.expires_at, l.max_downloads, l.downloads, l.created_at, l.revoked_at, f.name, f.kind
         FROM public_links l JOIN files f ON f.id = l.file_id WHERE l.created_by = ? ORDER BY l.created_at DESC LIMIT 300`,
      )
      .all(user.id) as Array<Record<string, unknown>>;
    return {
      incoming: incoming.map((row) => ({
        fileId: String(row.file_id),
        name: String(row.name),
        kind: String(row.kind),
        size: Number(row.size),
        permission: String(row.permission),
        ownerName: String(row.owner_name),
        ownerUsername: String(row.owner_username),
        createdAt: Number(row.created_at),
      })),
      outgoing: outgoing.map((row) => ({
        fileId: String(row.file_id),
        userId: String(row.user_id),
        name: String(row.name),
        kind: String(row.kind),
        permission: String(row.permission),
        userName: String(row.user_name),
        username: String(row.username),
        createdAt: Number(row.created_at),
      })),
      links: links.map((row) => ({
        id: String(row.id),
        fileId: String(row.file_id),
        name: String(row.name),
        kind: String(row.kind),
        expiresAt: row.expires_at ? Number(row.expires_at) : null,
        maxDownloads: row.max_downloads ? Number(row.max_downloads) : null,
        downloads: Number(row.downloads),
        createdAt: Number(row.created_at),
        revoked: Boolean(row.revoked_at),
      })),
    };
  });

  app.post('/api/files/:id/shares', async (req) => {
    const { user } = requireAuth(req);
    const id = assertUuid((req.params as { id?: string }).id, 'file');
    const { file } = requireFile(db, id, user.id, 'owner');
    strictOwner(file, user.id);
    if (file.deleted_at !== null) throw badRequest('File nel cestino');
    const body = parseBody(z.object({ userId: z.string().uuid(), permission: z.enum(['read', 'write']) }), req.body);
    if (body.userId === user.id) throw badRequest('Non puoi condividere con te stesso');
    const target = db.prepare('SELECT id, display_name FROM users WHERE id = ? AND disabled = 0').get(body.userId) as
      | { id: string; display_name: string }
      | undefined;
    if (!target) throw notFound('Utente non trovato');
    db.prepare(
      `INSERT INTO file_shares (id, file_id, user_id, permission, origin, created_by, created_at)
       VALUES (?, ?, ?, ?, 'manual', ?, ?)
       ON CONFLICT(file_id, user_id) DO UPDATE SET permission = excluded.permission`,
    ).run(newId(), file.id, body.userId, body.permission, user.id, nowMs());
    audit(db, {
      actorId: user.id,
      action: 'share.created',
      targetType: 'file',
      targetId: file.id,
      ip: clientIp(req),
      userAgent: requestUserAgent(req),
      meta: { sharedWith: body.userId, permission: body.permission },
    });
    ctx.hub.sendToUser(body.userId, {
      type: 'share:created',
      file: { id: file.id, name: file.name, kind: file.kind, permission: body.permission },
      from: { id: user.id, displayName: user.display_name },
    });
    return { ok: true };
  });

  app.delete('/api/files/:id/shares/:userId', async (req) => {
    const { user } = requireAuth(req);
    const id = assertUuid((req.params as { id?: string }).id, 'file');
    const targetUserId = assertUuid((req.params as { userId?: string }).userId, 'user');
    const { file } = requireFile(db, id, user.id, 'owner');
    strictOwner(file, user.id);
    const result = db.prepare('DELETE FROM file_shares WHERE file_id = ? AND user_id = ?').run(file.id, targetUserId);
    if (Number(result.changes) === 0) throw notFound('Condivisione non trovata');
    audit(db, {
      actorId: user.id,
      action: 'share.revoked',
      targetType: 'file',
      targetId: file.id,
      ip: clientIp(req),
      userAgent: requestUserAgent(req),
      meta: { sharedWith: targetUserId },
    });
    return { ok: true };
  });

  // ---- Public links ----
  app.post('/api/public-links', async (req) => {
    const { user } = requireAuth(req);
    enforceRate(ctx.limiter, `public-link:${user.id}`, 60, 60 * 60_000);
    const body = parseBody(
      z.object({
        fileId: z.string().uuid(),
        password: z.string().min(6).max(128).optional(),
        expiresInHours: z
          .number()
          .int()
          .min(1)
          .max(24 * 365)
          .optional(),
        maxDownloads: z.number().int().min(1).max(10_000).optional(),
      }),
      req.body,
    );
    const { file } = requireFile(db, body.fileId, user.id, 'owner');
    strictOwner(file, user.id);
    if (file.kind !== 'file' || file.deleted_at !== null) throw badRequest('Puoi condividere solo file attivi');
    const token = randomToken(32);
    const id = newId();
    const now = nowMs();
    const passwordHash = body.password ? await hashPassword(body.password) : null;
    db.prepare(
      `INSERT INTO public_links (id, file_id, token_hash, password_hash, expires_at, max_downloads, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      file.id,
      sha256Hex(token),
      passwordHash,
      body.expiresInHours ? now + body.expiresInHours * 60 * 60_000 : null,
      body.maxDownloads ?? null,
      user.id,
      now,
    );
    audit(db, {
      actorId: user.id,
      action: 'public_link.created',
      targetType: 'file',
      targetId: file.id,
      ip: clientIp(req),
      userAgent: requestUserAgent(req),
      meta: { linkId: id, protected: Boolean(passwordHash), maxDownloads: body.maxDownloads ?? null },
    });
    return {
      link: {
        id,
        token,
        url: `/p/${token}`,
        expiresAt: body.expiresInHours ? now + body.expiresInHours * 60 * 60_000 : null,
      },
    };
  });

  app.delete('/api/public-links/:id', async (req) => {
    const { user } = requireAuth(req);
    const id = assertUuid((req.params as { id?: string }).id, 'link');
    const link = db.prepare('SELECT id, created_by, file_id FROM public_links WHERE id = ?').get(id) as
      | { id: string; created_by: string; file_id: string }
      | undefined;
    if (!link || link.created_by !== user.id) throw notFound('Link non trovato');
    db.prepare('UPDATE public_links SET revoked_at = ? WHERE id = ?').run(nowMs(), id);
    audit(db, {
      actorId: user.id,
      action: 'public_link.revoked',
      targetType: 'file',
      targetId: link.file_id,
      ip: clientIp(req),
      userAgent: requestUserAgent(req),
      meta: { linkId: id },
    });
    return { ok: true };
  });

  void UPLOAD_CHUNK_SIZE;
}
