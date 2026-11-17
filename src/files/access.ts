import type { UserRow } from '../auth/sessions.js';
import type { Db } from '../db.js';
import { forbidden, notFound } from '../errors.js';

export interface FileRow {
  id: string;
  owner_id: string;
  parent_id: string | null;
  name: string;
  kind: 'file' | 'folder';
  size: number;
  mime: string;
  wrapped_key: string | null;
  storage_path: string | null;
  checksum: string | null;
  version: number;
  favorite: number;
  scan_status: string;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
}

export type Permission = 'owner' | 'write' | 'read';

const RANK: Record<Permission, number> = { read: 1, write: 2, owner: 3 };

export function getFile(db: Db, id: string): FileRow | null {
  const row = db.prepare('SELECT * FROM files WHERE id = ?').get(id) as FileRow | undefined;
  return row ?? null;
}

export function getPermission(db: Db, file: FileRow, userId: string): Permission | null {
  if (file.owner_id === userId) return 'owner';
  if (file.deleted_at !== null) return null;
  let best: Permission | null = null;
  let current: FileRow | null = file;
  let depth = 0;
  while (current && depth < 64) {
    if (current.owner_id === userId) return 'owner';
    const share = db
      .prepare('SELECT permission FROM file_shares WHERE file_id = ? AND user_id = ?')
      .get(current.id, userId) as { permission: 'read' | 'write' } | undefined;
    if (share && (!best || RANK[share.permission] > RANK[best])) best = share.permission;
    if (!current.parent_id) break;
    current = getFile(db, current.parent_id);
    depth += 1;
  }
  return best;
}

export function canRead(db: Db, file: FileRow, userId: string): boolean {
  return getPermission(db, file, userId) !== null;
}

export function canWrite(db: Db, file: FileRow, userId: string): boolean {
  const permission = getPermission(db, file, userId);
  return permission === 'write' || permission === 'owner';
}

export function requireFile(
  db: Db,
  id: string,
  userId: string,
  mode: 'read' | 'write' | 'owner',
): { file: FileRow; permission: Permission } {
  const file = getFile(db, id);
  if (!file) throw notFound('File non trovato');
  const permission = getPermission(db, file, userId);
  if (!permission) throw notFound('File non trovato');
  if (mode === 'write' && permission === 'read') throw forbidden('Permesso di modifica mancante');
  if (mode === 'owner' && permission !== 'owner')
    throw forbidden('Solo il proprietario può eseguire questa operazione');
  if (file.kind === 'folder' && mode !== 'read' && mode !== 'write' && mode !== 'owner')
    throw forbidden('Operazione non consentita');
  return { file, permission };
}

export function requireFolderWrite(db: Db, folderId: string | null, userId: string): FileRow | null {
  if (!folderId) return null;
  const folder = getFile(db, folderId);
  if (!folder || folder.kind !== 'folder' || folder.deleted_at !== null) throw notFound('Cartella non trovata');
  if (!canWrite(db, folder, userId)) throw forbidden('Non hai i permessi di scrittura su questa cartella');
  return folder;
}

/** True when `candidateId` is `ancestorId` or lives underneath it. */
export function isDescendant(db: Db, ancestorId: string, candidateId: string): boolean {
  let current = getFile(db, candidateId);
  let depth = 0;
  while (current && depth < 128) {
    if (current.id === ancestorId) return true;
    if (!current.parent_id) return false;
    current = getFile(db, current.parent_id);
    depth += 1;
  }
  return false;
}

export function assertNotIntoItself(db: Db, fileId: string, targetParentId: string): void {
  if (fileId === targetParentId || isDescendant(db, fileId, targetParentId)) {
    throw forbidden('Non puoi spostare una cartella dentro se stessa');
  }
}

export function folderPath(db: Db, folderId: string | null, userId: string): Array<{ id: string; name: string }> {
  const path: Array<{ id: string; name: string }> = [];
  let currentId = folderId;
  let depth = 0;
  while (currentId && depth < 64) {
    const file = getFile(db, currentId);
    if (!file || !canRead(db, file, userId)) break;
    path.unshift({ id: file.id, name: file.name });
    currentId = file.parent_id;
    depth += 1;
  }
  return path;
}

export function descendantFiles(db: Db, rootId: string): FileRow[] {
  const rows = db
    .prepare(
      `WITH RECURSIVE tree(id) AS (
         SELECT id FROM files WHERE id = ?
         UNION ALL
         SELECT f.id FROM files f JOIN tree t ON f.parent_id = t.id
       )
       SELECT f.* FROM files f JOIN tree t ON f.id = t.id`,
    )
    .all(rootId) as unknown as FileRow[];
  return rows;
}

export interface FileVersionRow {
  id: string;
  file_id: string;
  version: number;
  size: number;
  mime: string;
  wrapped_key: string;
  storage_path: string;
  checksum: string | null;
  created_at: number;
  created_by: string;
}

export function getVersion(db: Db, fileId: string, version: number): FileVersionRow | null {
  const row = db.prepare('SELECT * FROM file_versions WHERE file_id = ? AND version = ?').get(fileId, version) as
    | FileVersionRow
    | undefined;
  return row ?? null;
}

export function fileJson(
  db: Db,
  file: FileRow,
  userId: string,
  extra: { sharePermission?: string | null } = {},
): Record<string, unknown> {
  const permission = getPermission(db, file, userId);
  return {
    id: file.id,
    parentId: file.parent_id,
    name: file.name,
    kind: file.kind,
    size: file.size,
    mime: file.mime,
    version: file.version,
    favorite: Boolean(file.favorite),
    isOwner: file.owner_id === userId,
    permission: permission ?? 'read',
    shared: permission !== null && permission !== 'owner' ? permission : (extra.sharePermission ?? null),
    deletedAt: file.deleted_at,
    createdAt: file.created_at,
    updatedAt: file.updated_at,
    scanStatus: file.kind === 'file' ? file.scan_status : 'clean',
  };
}

export function ensureUserExists(db: Db, userId: string): UserRow | null {
  const row = db.prepare('SELECT * FROM users WHERE id = ? AND disabled = 0').get(userId) as UserRow | undefined;
  return row ?? null;
}
