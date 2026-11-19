import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { withTransaction } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { canRead, getFile } from '../files/access.js';
import { enforceRate, parseBody } from '../http/helpers.js';
import { requireAuth } from '../http/security.js';
import { assertUuid, newId, nowMs, sanitizePlainText } from '../util.js';

type ProjectRow = {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  chat_room_id: string | null;
  created_at: number;
  updated_at: number;
};

type ProjectAccessRow = ProjectRow & { role: 'owner' | 'member' };
type ProjectListRow = ProjectAccessRow & { member_count: number };

type MemberRow = {
  user_id: string;
  role: 'owner' | 'member';
  username: string;
  display_name: string;
  presence: string;
};

type ColumnRow = {
  id: string;
  owner_id: string;
  project_id: string | null;
  title: string;
  position: number;
  created_at: number;
  updated_at: number;
};

type ColumnAccessRow = ColumnRow & { project_id: string };

type CardRow = {
  id: string;
  column_id: string;
  owner_id: string;
  title: string;
  description: string;
  status: CardStatus;
  due_at: number | null;
  due_complete: number;
  cover_file_id: string | null;
  position: number;
  created_at: number;
  updated_at: number;
};

type CardAccessRow = CardRow & { project_id: string };

type TaskRow = {
  id: string;
  card_id: string;
  title: string;
  status: CardStatus;
  done: number;
  notes: string;
  position: number;
  created_at: number;
  updated_at: number;
};

type LabelRow = {
  id: string;
  project_id: string;
  name: string;
  color: string;
  created_at: number;
};

type CommentRow = {
  id: string;
  card_id: string;
  author_id: string;
  body: string;
  created_at: number;
  updated_at: number;
  username: string;
  display_name: string;
};

type AttachmentRow = {
  id: string;
  card_id: string;
  file_id: string;
  created_by: string;
  created_at: number;
  name: string;
  mime: string;
  size: number;
};

const CARD_STATUSES = ['todo', 'doing', 'done'] as const;
type CardStatus = (typeof CARD_STATUSES)[number];

const STATUS_TITLES: Record<CardStatus, string[]> = {
  todo: ['da fare', 'to do', 'todo', 'backlog'],
  doing: ['in corso', 'doing', 'in progress', 'in lavorazione'],
  done: ['completate', 'completata', 'completato', 'fatto', 'fatta', 'fatte', 'done'],
};

const MAX_PROJECTS = 50;
const MAX_MEMBERS = 50;
const MAX_COLUMNS = 24;
const MAX_CARDS_PER_COLUMN = 1000;
const MAX_TASKS_PER_CARD = 100;
const MAX_COMMENTS_PER_CARD = 500;
const MAX_ATTACHMENTS_PER_CARD = 20;
const MAX_LABELS = 30;
const MAX_TASK_NOTES = 8000;
const MAX_COMMENT = 4000;
const DEFAULT_COLUMNS = ['Da fare', 'In corso', 'Completate'];

function statusForColumnTitle(title: string): CardStatus | null {
  const normalized = title.trim().toLowerCase();
  for (const status of CARD_STATUSES) {
    if (STATUS_TITLES[status].includes(normalized)) return status;
  }
  return null;
}

function presenceFor(ctx: AppContext, userId: string, presence: string): string {
  return ctx.hub.isOnline(userId) && presence !== 'hidden' ? presence : 'offline';
}

function getProjectRow(db: AppContext['db'], projectId: string): ProjectRow | null {
  return (db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow | undefined) ?? null;
}

function requireProject(db: AppContext['db'], projectId: string, userId: string): ProjectAccessRow {
  const row = db
    .prepare(
      `SELECT p.*, pm.role FROM projects p
       JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
       WHERE p.id = ?`,
    )
    .get(userId, projectId) as ProjectAccessRow | undefined;
  if (!row) throw notFound('Progetto non trovato');
  return row;
}

function requireProjectOwner(db: AppContext['db'], projectId: string, userId: string): ProjectAccessRow {
  const project = requireProject(db, projectId, userId);
  if (project.owner_id !== userId) throw forbidden('Solo il proprietario del progetto può eseguire questa operazione');
  return project;
}

function projectMembers(db: AppContext['db'], projectId: string): MemberRow[] {
  return db
    .prepare(
      `SELECT pm.user_id, pm.role, u.username, u.display_name, u.presence
       FROM project_members pm JOIN users u ON u.id = pm.user_id
       WHERE pm.project_id = ? ORDER BY pm.role DESC, u.display_name COLLATE NOCASE`,
    )
    .all(projectId) as unknown as MemberRow[];
}

function memberJson(ctx: AppContext, row: MemberRow): Record<string, unknown> {
  return {
    id: row.user_id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    status: presenceFor(ctx, row.user_id, row.presence),
  };
}

function projectsForUser(db: AppContext['db'], userId: string): ProjectListRow[] {
  return db
    .prepare(
      `SELECT p.*, pm.role, (SELECT COUNT(*) FROM project_members x WHERE x.project_id = p.id) AS member_count
       FROM projects p JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
       ORDER BY p.updated_at DESC, p.created_at DESC`,
    )
    .all(userId) as unknown as ProjectListRow[];
}

function projectJson(
  row: ProjectAccessRow,
  memberCount = 0,
  chatRoomId: string | null = row.chat_room_id,
): Record<string, unknown> {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    description: row.description,
    role: row.role,
    chatRoomId,
    memberCount,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function columnJson(row: ColumnRow): Record<string, unknown> {
  return {
    id: row.id,
    title: row.title,
    position: Number(row.position),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function taskJson(row: TaskRow): Record<string, unknown> {
  return {
    id: row.id,
    cardId: row.card_id,
    title: row.title,
    status: row.status,
    done: row.status === 'done',
    notes: row.notes,
    position: Number(row.position),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function labelJson(row: LabelRow): Record<string, unknown> {
  return { id: row.id, name: row.name, color: row.color };
}

function attachmentJson(row: AttachmentRow): Record<string, unknown> {
  return {
    id: row.id,
    fileId: row.file_id,
    name: row.name,
    mime: row.mime,
    size: Number(row.size),
    createdAt: Number(row.created_at),
    createdBy: row.created_by,
    isImage: row.mime.startsWith('image/'),
  };
}

function commentJson(row: CommentRow): Record<string, unknown> {
  return {
    id: row.id,
    body: row.body,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    author: { id: row.author_id, username: row.username, displayName: row.display_name },
  };
}

function cardJson(
  row: CardRow,
  tasks: TaskRow[],
  labels: LabelRow[],
  assignees: MemberRow[],
  commentCount: number,
  attachmentCount: number,
): Record<string, unknown> {
  return {
    id: row.id,
    columnId: row.column_id,
    title: row.title,
    description: row.description,
    status: row.status,
    dueAt: row.due_at === null ? null : Number(row.due_at),
    dueComplete: Boolean(row.due_complete),
    coverFileId: row.cover_file_id,
    position: Number(row.position),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    tasks: tasks.map(taskJson),
    labels: labels.map(labelJson),
    assignees: assignees.map((member) => ({
      id: member.user_id,
      username: member.username,
      displayName: member.display_name,
      role: member.role,
    })),
    commentCount,
    attachmentCount,
  };
}

function cardJsonWithPresence(
  ctx: AppContext,
  row: CardRow,
  tasks: TaskRow[],
  labels: LabelRow[],
  assignees: MemberRow[],
  commentCount: number,
  attachmentCount: number,
): Record<string, unknown> {
  const base = cardJson(row, tasks, labels, assignees, commentCount, attachmentCount);
  base.assignees = assignees.map((member) => memberJson(ctx, member));
  return base;
}

function requireColumn(db: AppContext['db'], id: string, userId: string): ColumnAccessRow {
  const row = db
    .prepare(
      `SELECT c.* FROM board_columns c
       JOIN project_members pm ON pm.project_id = c.project_id AND pm.user_id = ?
       WHERE c.id = ? AND c.project_id IS NOT NULL`,
    )
    .get(userId, id) as ColumnAccessRow | undefined;
  if (!row) throw notFound('Colonna non trovata');
  return row;
}

function requireCard(db: AppContext['db'], id: string, userId: string): CardAccessRow {
  const row = db
    .prepare(
      `SELECT c.*, col.project_id AS project_id FROM board_cards c
       JOIN board_columns col ON col.id = c.column_id
       JOIN project_members pm ON pm.project_id = col.project_id AND pm.user_id = ?
       WHERE c.id = ? AND col.project_id IS NOT NULL`,
    )
    .get(userId, id) as CardAccessRow | undefined;
  if (!row) throw notFound('Scheda non trovata');
  return row;
}

function requireTask(db: AppContext['db'], id: string, cardId: string): TaskRow {
  const row = db.prepare('SELECT * FROM board_card_tasks WHERE id = ? AND card_id = ?').get(id, cardId) as
    | TaskRow
    | undefined;
  if (!row) throw notFound('Attività non trovata');
  return row;
}

function tasksForCard(db: AppContext['db'], cardId: string): TaskRow[] {
  return db
    .prepare('SELECT * FROM board_card_tasks WHERE card_id = ? ORDER BY position ASC, created_at ASC')
    .all(cardId) as unknown as TaskRow[];
}

function labelsForProject(db: AppContext['db'], projectId: string): LabelRow[] {
  return db
    .prepare('SELECT * FROM board_labels WHERE project_id = ? ORDER BY created_at ASC')
    .all(projectId) as unknown as LabelRow[];
}

function labelsForCard(db: AppContext['db'], cardId: string): LabelRow[] {
  return db
    .prepare(
      `SELECT l.* FROM board_card_labels cl JOIN board_labels l ON l.id = cl.label_id
       WHERE cl.card_id = ? ORDER BY l.created_at ASC`,
    )
    .all(cardId) as unknown as LabelRow[];
}

function assigneesForCard(db: AppContext['db'], cardId: string): MemberRow[] {
  return db
    .prepare(
      `SELECT cm.user_id, u.username, u.display_name, u.presence, pm.role
       FROM board_card_members cm
       JOIN users u ON u.id = cm.user_id
       JOIN board_cards c ON c.id = cm.card_id
       JOIN board_columns col ON col.id = c.column_id
       JOIN project_members pm ON pm.project_id = col.project_id AND pm.user_id = cm.user_id
       WHERE cm.card_id = ? ORDER BY u.display_name COLLATE NOCASE`,
    )
    .all(cardId) as unknown as MemberRow[];
}

function commentCount(db: AppContext['db'], cardId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM board_card_comments WHERE card_id = ?').get(cardId) as {
    n: number;
  };
  return Number(row.n);
}

function attachmentCount(db: AppContext['db'], cardId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM board_card_attachments a JOIN files f ON f.id = a.file_id
       WHERE a.card_id = ? AND f.deleted_at IS NULL`,
    )
    .get(cardId) as { n: number };
  return Number(row.n);
}

function columnIdForStatus(db: AppContext['db'], projectId: string, status: CardStatus): string | null {
  const rows = db
    .prepare('SELECT id, title FROM board_columns WHERE project_id = ? ORDER BY position ASC, created_at ASC')
    .all(projectId) as Array<{ id: string; title: string }>;
  return rows.find((row) => statusForColumnTitle(row.title) === status)?.id ?? null;
}

function nextColumnPosition(db: AppContext['db'], projectId: string): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM board_columns WHERE project_id = ?')
    .get(projectId) as { next: number };
  return Number(row.next);
}

function nextCardPosition(db: AppContext['db'], columnId: string): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM board_cards WHERE column_id = ?')
    .get(columnId) as { next: number };
  return Number(row.next);
}

function nextTaskPosition(db: AppContext['db'], cardId: string): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM board_card_tasks WHERE card_id = ?')
    .get(cardId) as { next: number };
  return Number(row.next);
}

function cardCount(db: AppContext['db'], columnId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM board_cards WHERE column_id = ?').get(columnId) as { n: number };
  return Number(row.n);
}

function ensureProjectColumns(db: AppContext['db'], projectId: string): void {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM board_columns WHERE project_id = ?').get(projectId) as {
    n: number;
  };
  if (Number(existing.n) > 0) return;
  const now = nowMs();
  for (const [position, title] of DEFAULT_COLUMNS.entries()) {
    db.prepare(
      'INSERT INTO board_columns (id, owner_id, project_id, title, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      newId(),
      (db.prepare('SELECT owner_id FROM projects WHERE id = ?').get(projectId) as { owner_id: string }).owner_id,
      projectId,
      title,
      position,
      now,
      now,
    );
  }
}

function createProjectRecord(
  db: AppContext['db'],
  ownerId: string,
  name: string,
  description: string,
): ProjectAccessRow {
  const id = newId();
  const now = nowMs();
  db.prepare(
    'INSERT INTO projects (id, owner_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, ownerId, name, description, now, now);
  db.prepare("INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(
    id,
    ownerId,
    now,
  );
  for (const [position, title] of DEFAULT_COLUMNS.entries()) {
    db.prepare(
      'INSERT INTO board_columns (id, owner_id, project_id, title, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(newId(), ownerId, id, title, position, now, now);
  }
  return { ...getProjectRow(db, id)!, role: 'owner' };
}

function ensureDefaultProject(ctx: AppContext, userId: string): ProjectAccessRow {
  const existing = projectsForUser(ctx.db, userId)[0];
  if (existing) return existing;
  return withTransaction(ctx.db, () => createProjectRecord(ctx.db, userId, 'Bacheca', ''));
}

function syncProjectChatMembers(ctx: AppContext, project: ProjectRow, roomId: string): void {
  const members = projectMembers(ctx.db, project.id);
  const memberIds = new Set(members.map((member) => member.user_id));
  for (const member of members) {
    ctx.db
      .prepare(
        `INSERT INTO chat_members (room_id, user_id, role, joined_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(room_id, user_id) DO UPDATE SET role = excluded.role`,
      )
      .run(roomId, member.user_id, member.role, nowMs());
  }
  const existing = ctx.db.prepare('SELECT user_id FROM chat_members WHERE room_id = ?').all(roomId) as Array<{
    user_id: string;
  }>;
  for (const row of existing) {
    if (!memberIds.has(row.user_id)) {
      ctx.db.prepare('DELETE FROM chat_members WHERE room_id = ? AND user_id = ?').run(roomId, row.user_id);
    }
  }
}

function ensureProjectChat(ctx: AppContext, project: ProjectAccessRow): string {
  const existingRoomId = project.chat_room_id;
  const roomExists = existingRoomId
    ? (ctx.db.prepare('SELECT id FROM chat_rooms WHERE id = ?').get(existingRoomId) as { id: string } | undefined)
    : undefined;
  if (roomExists && existingRoomId) {
    syncProjectChatMembers(ctx, project, existingRoomId);
    const room = ctx.db.prepare('SELECT name FROM chat_rooms WHERE id = ?').get(existingRoomId) as {
      name: string | null;
    };
    if (room.name !== project.name) {
      ctx.db.prepare('UPDATE chat_rooms SET name = ? WHERE id = ?').run(project.name, existingRoomId);
    }
    return existingRoomId;
  }
  const roomId = newId();
  const now = nowMs();
  ctx.db
    .prepare(
      "INSERT INTO chat_rooms (id, kind, name, created_by, created_at, updated_at) VALUES (?, 'group', ?, ?, ?, ?)",
    )
    .run(roomId, sanitizePlainText(project.name, 80), project.owner_id, now, now);
  syncProjectChatMembers(ctx, project, roomId);
  ctx.db.prepare('UPDATE projects SET chat_room_id = ? WHERE id = ?').run(roomId, project.id);
  project.chat_room_id = roomId;
  for (const member of projectMembers(ctx.db, project.id)) {
    ctx.hub.sendToUser(member.user_id, { type: 'room:created', roomId });
  }
  return roomId;
}

function shareAttachmentWithProject(ctx: AppContext, projectId: string, file: { id: string; owner_id: string }): void {
  const members = projectMembers(ctx.db, projectId);
  const now = nowMs();
  for (const member of members) {
    if (member.user_id === file.owner_id) continue;
    ctx.db
      .prepare(
        `INSERT INTO file_shares (id, file_id, user_id, permission, origin, created_by, created_at)
         VALUES (?, ?, ?, 'read', 'board', ?, ?)
         ON CONFLICT(file_id, user_id) DO UPDATE SET permission =
           CASE WHEN file_shares.permission = 'write' THEN 'write' ELSE excluded.permission END`,
      )
      .run(newId(), file.id, member.user_id, file.owner_id, now);
  }
}

function pruneBoardFileShares(db: AppContext['db'], userId: string): void {
  db.prepare(
    `DELETE FROM file_shares
     WHERE user_id = ? AND origin = 'board' AND permission = 'read'
       AND NOT EXISTS (
         SELECT 1 FROM board_card_attachments a
         JOIN board_cards c ON c.id = a.card_id
         JOIN board_columns col ON col.id = c.column_id
         JOIN project_members pm ON pm.project_id = col.project_id AND pm.user_id = file_shares.user_id
         WHERE a.file_id = file_shares.file_id
       )`,
  ).run(userId);
}

function shareProjectAttachmentsWithMember(ctx: AppContext, projectId: string, userId: string): void {
  const rows = ctx.db
    .prepare(
      `SELECT DISTINCT a.file_id, f.owner_id FROM board_card_attachments a
       JOIN board_cards c ON c.id = a.card_id
       JOIN board_columns col ON col.id = c.column_id
       JOIN files f ON f.id = a.file_id
       WHERE col.project_id = ? AND f.deleted_at IS NULL`,
    )
    .all(projectId) as Array<{ file_id: string; owner_id: string }>;
  for (const row of rows) {
    if (row.owner_id === userId) continue;
    ctx.db
      .prepare(
        `INSERT INTO file_shares (id, file_id, user_id, permission, origin, created_by, created_at)
         VALUES (?, ?, ?, 'read', 'board', ?, ?)
         ON CONFLICT(file_id, user_id) DO UPDATE SET permission =
           CASE WHEN file_shares.permission = 'write' THEN 'write' ELSE excluded.permission END`,
      )
      .run(newId(), row.file_id, userId, row.owner_id, nowMs());
  }
}

function loadBoard(ctx: AppContext, projectId: string): Array<Record<string, unknown>> {
  const { db } = ctx;
  const columns = db
    .prepare('SELECT * FROM board_columns WHERE project_id = ? ORDER BY position ASC, created_at ASC')
    .all(projectId) as unknown as ColumnRow[];
  const cards = db
    .prepare(
      `SELECT c.* FROM board_cards c JOIN board_columns col ON col.id = c.column_id
       WHERE col.project_id = ? ORDER BY c.position ASC, c.created_at ASC`,
    )
    .all(projectId) as unknown as CardRow[];
  const tasks = db
    .prepare(
      `SELECT t.* FROM board_card_tasks t JOIN board_cards c ON c.id = t.card_id
       JOIN board_columns col ON col.id = c.column_id
       WHERE col.project_id = ? ORDER BY t.position ASC, t.created_at ASC`,
    )
    .all(projectId) as unknown as TaskRow[];
  const labelRows = db
    .prepare(
      `SELECT cl.card_id, l.* FROM board_card_labels cl
       JOIN board_labels l ON l.id = cl.label_id
       JOIN board_cards c ON c.id = cl.card_id
       JOIN board_columns col ON col.id = c.column_id
       WHERE col.project_id = ? ORDER BY l.created_at ASC`,
    )
    .all(projectId) as unknown as Array<LabelRow & { card_id: string }>;
  const assigneeRows = db
    .prepare(
      `SELECT cm.card_id, cm.user_id, u.username, u.display_name, u.presence, pm.role
       FROM board_card_members cm
       JOIN users u ON u.id = cm.user_id
       JOIN board_cards c ON c.id = cm.card_id
       JOIN board_columns col ON col.id = c.column_id
       JOIN project_members pm ON pm.project_id = col.project_id AND pm.user_id = cm.user_id
       WHERE col.project_id = ? ORDER BY u.display_name COLLATE NOCASE`,
    )
    .all(projectId) as unknown as Array<MemberRow & { card_id: string }>;
  const commentCounts = db
    .prepare(
      `SELECT bc.card_id, COUNT(*) AS n FROM board_card_comments bc
       JOIN board_cards c ON c.id = bc.card_id JOIN board_columns col ON col.id = c.column_id
       WHERE col.project_id = ? GROUP BY bc.card_id`,
    )
    .all(projectId) as Array<{ card_id: string; n: number }>;
  const attachmentCounts = db
    .prepare(
      `SELECT a.card_id, COUNT(*) AS n FROM board_card_attachments a
       JOIN files f ON f.id = a.file_id
       JOIN board_cards c ON c.id = a.card_id JOIN board_columns col ON col.id = c.column_id
       WHERE col.project_id = ? AND f.deleted_at IS NULL GROUP BY a.card_id`,
    )
    .all(projectId) as Array<{ card_id: string; n: number }>;

  const cardsByColumn = new Map<string, CardRow[]>();
  const tasksByCard = new Map<string, TaskRow[]>();
  const labelsByCard = new Map<string, LabelRow[]>();
  const assigneesByCard = new Map<string, MemberRow[]>();
  const commentsByCard = new Map<string, number>();
  const attachmentsByCard = new Map<string, number>();
  for (const column of columns) cardsByColumn.set(column.id, []);
  for (const card of cards) cardsByColumn.get(card.column_id)?.push(card);
  for (const task of tasks) {
    const list = tasksByCard.get(task.card_id);
    if (list) list.push(task);
    else tasksByCard.set(task.card_id, [task]);
  }
  for (const label of labelRows) {
    const list = labelsByCard.get(label.card_id);
    if (list) list.push(label);
    else labelsByCard.set(label.card_id, [label]);
  }
  for (const assignee of assigneeRows) {
    const list = assigneesByCard.get(assignee.card_id);
    if (list) list.push(assignee);
    else assigneesByCard.set(assignee.card_id, [assignee]);
  }
  for (const row of commentCounts) commentsByCard.set(row.card_id, Number(row.n));
  for (const row of attachmentCounts) attachmentsByCard.set(row.card_id, Number(row.n));

  return columns.map((column) => ({
    ...columnJson(column),
    cards: (cardsByColumn.get(column.id) ?? []).map((card) =>
      cardJsonWithPresence(
        ctx,
        card,
        tasksByCard.get(card.id) ?? [],
        labelsByCard.get(card.id) ?? [],
        assigneesByCard.get(card.id) ?? [],
        commentsByCard.get(card.id) ?? 0,
        attachmentsByCard.get(card.id) ?? 0,
      ),
    ),
  }));
}

function cardSummary(ctx: AppContext, card: CardRow): Record<string, unknown> {
  return cardJsonWithPresence(
    ctx,
    card,
    tasksForCard(ctx.db, card.id),
    labelsForCard(ctx.db, card.id),
    assigneesForCard(ctx.db, card.id),
    commentCount(ctx.db, card.id),
    attachmentCount(ctx.db, card.id),
  );
}

function cardDetail(ctx: AppContext, card: CardRow): Record<string, unknown> {
  const comments = ctx.db
    .prepare(
      `SELECT bc.*, u.username, u.display_name FROM board_card_comments bc
       JOIN users u ON u.id = bc.author_id WHERE bc.card_id = ? ORDER BY bc.created_at ASC`,
    )
    .all(card.id) as unknown as CommentRow[];
  const attachments = ctx.db
    .prepare(
      `SELECT a.id, a.card_id, a.file_id, a.created_by, a.created_at, f.name, f.mime, f.size
       FROM board_card_attachments a JOIN files f ON f.id = a.file_id
       WHERE a.card_id = ? AND f.deleted_at IS NULL ORDER BY a.created_at ASC`,
    )
    .all(card.id) as unknown as AttachmentRow[];
  return {
    ...cardSummary(ctx, card),
    comments: comments.map(commentJson),
    attachments: attachments.map(attachmentJson),
  };
}

export function registerBoardRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get('/api/projects', async (req) => {
    const { user } = requireAuth(req);
    return {
      projects: projectsForUser(db, user.id).map((project) => projectJson(project, Number(project.member_count))),
    };
  });

  app.post('/api/projects', async (req) => {
    const { user } = requireAuth(req);
    enforceRate(ctx.limiter, `project-create:${user.id}`, 20, 60 * 60_000);
    const body = parseBody(
      z.object({
        name: z.string().trim().min(1).max(80),
        description: z.string().max(4000).optional(),
      }),
      req.body,
    );
    const count = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE owner_id = ?').get(user.id) as { n: number };
    if (Number(count.n) >= MAX_PROJECTS) throw conflict(`Puoi creare al massimo ${MAX_PROJECTS} progetti`);
    const project = withTransaction(db, () =>
      createProjectRecord(
        db,
        user.id,
        sanitizePlainText(body.name, 80),
        body.description === undefined ? '' : sanitizePlainText(body.description, 4000),
      ),
    );
    ensureProjectChat(ctx, project);
    return {
      project: projectJson({ ...project, chat_room_id: getProjectRow(db, project.id)?.chat_room_id ?? null }, 1),
    };
  });

  app.get('/api/board', async (req) => {
    const { user } = requireAuth(req);
    const requested = (req.query as { project?: string }).project;
    const project = requested
      ? requireProject(db, assertUuid(requested, 'project'), user.id)
      : ensureDefaultProject(ctx, user.id);
    ensureProjectColumns(db, project.id);
    const chatRoomId = ensureProjectChat(ctx, {
      ...project,
      chat_room_id: getProjectRow(db, project.id)?.chat_room_id ?? null,
    });
    const fresh = getProjectRow(db, project.id);
    if (!fresh) throw notFound('Progetto non trovato');
    const members = projectMembers(db, project.id);
    return {
      project: projectJson({ ...fresh, role: project.role }, members.length, chatRoomId),
      projects: projectsForUser(db, user.id).map((row) => projectJson(row, Number(row.member_count))),
      members: members.map((member) => memberJson(ctx, member)),
      labels: labelsForProject(db, project.id).map(labelJson),
      columns: loadBoard(ctx, project.id),
    };
  });

  app.patch('/api/projects/:id', async (req) => {
    const { user } = requireAuth(req);
    const id = assertUuid((req.params as { id?: string }).id, 'project');
    const project = requireProjectOwner(db, id, user.id);
    const body = parseBody(
      z.object({
        name: z.string().trim().min(1).max(80).optional(),
        description: z.string().max(4000).optional(),
      }),
      req.body,
    );
    if (body.name === undefined && body.description === undefined) throw badRequest('Nessuna modifica richiesta');
    const now = nowMs();
    withTransaction(db, () => {
      if (body.name !== undefined) {
        db.prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?').run(
          sanitizePlainText(body.name, 80),
          now,
          id,
        );
        if (project.chat_room_id) {
          db.prepare('UPDATE chat_rooms SET name = ?, updated_at = ? WHERE id = ?').run(
            sanitizePlainText(body.name, 80),
            now,
            project.chat_room_id,
          );
        }
      }
      if (body.description !== undefined) {
        db.prepare('UPDATE projects SET description = ?, updated_at = ? WHERE id = ?').run(
          sanitizePlainText(body.description, 4000),
          now,
          id,
        );
      }
    });
    const fresh = getProjectRow(db, id);
    return { project: projectJson({ ...fresh!, role: 'owner' }, projectMembers(db, id).length) };
  });

  app.delete('/api/projects/:id', async (req) => {
    const { user } = requireAuth(req);
    const id = assertUuid((req.params as { id?: string }).id, 'project');
    const project = requireProjectOwner(db, id, user.id);
    const memberIds = projectMembers(db, id).map((member) => member.user_id);
    withTransaction(db, () => {
      db.prepare('DELETE FROM board_columns WHERE project_id = ?').run(id);
      db.prepare('DELETE FROM board_labels WHERE project_id = ?').run(id);
      db.prepare('DELETE FROM project_members WHERE project_id = ?').run(id);
      db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    });
    if (project.chat_room_id) db.prepare('DELETE FROM chat_rooms WHERE id = ?').run(project.chat_room_id);
    for (const memberId of memberIds) pruneBoardFileShares(db, memberId);
    return { ok: true };
  });

  app.post('/api/projects/:id/members', async (req) => {
    const { user } = requireAuth(req);
    const id = assertUuid((req.params as { id?: string }).id, 'project');
    requireProjectOwner(db, id, user.id);
    const body = parseBody(z.object({ userId: z.string().uuid() }), req.body);
    const target = db.prepare('SELECT id, disabled FROM users WHERE id = ?').get(body.userId) as
      | { id: string; disabled: number }
      | undefined;
    if (!target || Number(target.disabled) !== 0) throw notFound('Utente non trovato');
    const count = db.prepare('SELECT COUNT(*) AS n FROM project_members WHERE project_id = ?').get(id) as {
      n: number;
    };
    if (Number(count.n) >= MAX_MEMBERS) throw conflict(`Un progetto può avere al massimo ${MAX_MEMBERS} membri`);
    db.prepare(
      "INSERT OR IGNORE INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)",
    ).run(id, body.userId, nowMs());
    ensureProjectChat(ctx, requireProject(db, id, user.id));
    shareProjectAttachmentsWithMember(ctx, id, body.userId);
    ctx.hub.sendToUser(body.userId, { type: 'room:created', roomId: getProjectRow(db, id)?.chat_room_id ?? '' });
    return { members: projectMembers(db, id).map((member) => memberJson(ctx, member)) };
  });

  app.delete('/api/projects/:id/members/:userId', async (req) => {
    const { user } = requireAuth(req);
    const params = req.params as { id?: string; userId?: string };
    const id = assertUuid(params.id, 'project');
    const userId = assertUuid(params.userId, 'user');
    const project = requireProjectOwner(db, id, user.id);
    if (userId === project.owner_id) throw forbidden('Il proprietario non può essere rimosso');
    db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(id, userId);
    db.prepare(
      'DELETE FROM board_card_members WHERE user_id = ? AND card_id IN (SELECT c.id FROM board_cards c JOIN board_columns col ON col.id = c.column_id WHERE col.project_id = ?)',
    ).run(userId, id);
    if (project.chat_room_id) {
      db.prepare('DELETE FROM chat_members WHERE room_id = ? AND user_id = ?').run(project.chat_room_id, userId);
    }
    pruneBoardFileShares(db, userId);
    return { members: projectMembers(db, id).map((member) => memberJson(ctx, member)) };
  });

  app.post('/api/projects/:id/labels', async (req) => {
    const { user } = requireAuth(req);
    const id = assertUuid((req.params as { id?: string }).id, 'project');
    requireProject(db, id, user.id);
    const body = parseBody(
      z.object({
        name: z.string().trim().max(40).default(''),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      }),
      req.body,
    );
    const count = db.prepare('SELECT COUNT(*) AS n FROM board_labels WHERE project_id = ?').get(id) as { n: number };
    if (Number(count.n) >= MAX_LABELS) throw conflict(`Puoi creare al massimo ${MAX_LABELS} etichette`);
    const labelId = newId();
    db.prepare('INSERT INTO board_labels (id, project_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)').run(
      labelId,
      id,
      sanitizePlainText(body.name, 40),
      body.color,
      nowMs(),
    );
    return { label: labelJson(db.prepare('SELECT * FROM board_labels WHERE id = ?').get(labelId) as LabelRow) };
  });

  app.patch('/api/projects/:id/labels/:labelId', async (req) => {
    const { user } = requireAuth(req);
    const params = req.params as { id?: string; labelId?: string };
    const id = assertUuid(params.id, 'project');
    const labelId = assertUuid(params.labelId, 'label');
    requireProject(db, id, user.id);
    const body = parseBody(
      z.object({
        name: z.string().trim().max(40).optional(),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional(),
      }),
      req.body,
    );
    const label = db.prepare('SELECT * FROM board_labels WHERE id = ? AND project_id = ?').get(labelId, id) as
      | LabelRow
      | undefined;
    if (!label) throw notFound('Etichetta non trovata');
    if (body.name !== undefined) {
      db.prepare('UPDATE board_labels SET name = ? WHERE id = ?').run(sanitizePlainText(body.name, 40), labelId);
    }
    if (body.color !== undefined) db.prepare('UPDATE board_labels SET color = ? WHERE id = ?').run(body.color, labelId);
    return { label: labelJson(db.prepare('SELECT * FROM board_labels WHERE id = ?').get(labelId) as LabelRow) };
  });

  app.delete('/api/projects/:id/labels/:labelId', async (req) => {
    const { user } = requireAuth(req);
    const params = req.params as { id?: string; labelId?: string };
    const id = assertUuid(params.id, 'project');
    const labelId = assertUuid(params.labelId, 'label');
    requireProject(db, id, user.id);
    db.prepare('DELETE FROM board_labels WHERE id = ? AND project_id = ?').run(labelId, id);
    return { ok: true };
  });

  app.post('/api/board/columns', async (req) => {
    const { user } = requireAuth(req);
    const body = parseBody(
      z.object({ projectId: z.string().uuid(), title: z.string().trim().min(1).max(80) }),
      req.body,
    );
    const project = requireProject(db, body.projectId, user.id);
    const count = db.prepare('SELECT COUNT(*) AS n FROM board_columns WHERE project_id = ?').get(project.id) as {
      n: number;
    };
    if (Number(count.n) >= MAX_COLUMNS) throw conflict(`Puoi creare al massimo ${MAX_COLUMNS} colonne`);
    const id = newId();
    const now = nowMs();
    db.prepare(
      'INSERT INTO board_columns (id, owner_id, project_id, title, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      id,
      project.owner_id,
      project.id,
      sanitizePlainText(body.title, 80),
      nextColumnPosition(db, project.id),
      now,
      now,
    );
    return { column: { ...columnJson(requireColumn(db, id, user.id)), cards: [] } };
  });

  app.patch('/api/board/columns/:id', async (req) => {
    const { user } = requireAuth(req);
    const id = assertUuid((req.params as { id?: string }).id, 'column');
    const column = requireColumn(db, id, user.id);
    const body = parseBody(
      z.object({
        title: z.string().trim().min(1).max(80).optional(),
        position: z.number().int().min(0).max(MAX_COLUMNS).optional(),
      }),
      req.body,
    );
    const now = nowMs();
    withTransaction(db, () => {
      if (body.title !== undefined) {
        db.prepare('UPDATE board_columns SET title = ?, updated_at = ? WHERE id = ?').run(
          sanitizePlainText(body.title, 80),
          now,
          id,
        );
      }
      if (body.position !== undefined) {
        const rows = db
          .prepare('SELECT id FROM board_columns WHERE project_id = ? ORDER BY position ASC, created_at ASC')
          .all(column.project_id) as Array<{ id: string }>;
        const ids = rows.map((row) => row.id).filter((columnId) => columnId !== id);
        const index = Math.max(0, Math.min(body.position, ids.length));
        ids.splice(index, 0, id);
        ids.forEach((columnId, position) => {
          db.prepare('UPDATE board_columns SET position = ? WHERE id = ?').run(position, columnId);
        });
      }
    });
    return { column: columnJson(requireColumn(db, column.id, user.id)) };
  });

  app.delete('/api/board/columns/:id', async (req) => {
    const { user } = requireAuth(req);
    const id = assertUuid((req.params as { id?: string }).id, 'column');
    requireColumn(db, id, user.id);
    db.prepare('DELETE FROM board_columns WHERE id = ?').run(id);
    return { ok: true };
  });

  app.post('/api/board/cards', async (req) => {
    const { user } = requireAuth(req);
    const body = parseBody(
      z.object({
        columnId: z.string().uuid(),
        title: z.string().trim().min(1).max(200),
        description: z.string().max(4000).optional(),
        status: z.enum(CARD_STATUSES).optional(),
        dueAt: z.number().int().min(0).nullable().optional(),
      }),
      req.body,
    );
    const column = requireColumn(db, body.columnId, user.id);
    if (cardCount(db, body.columnId) >= MAX_CARDS_PER_COLUMN)
      throw conflict(`Una colonna può contenere al massimo ${MAX_CARDS_PER_COLUMN} schede`);
    const id = newId();
    const now = nowMs();
    const status = body.status ?? statusForColumnTitle(column.title) ?? 'todo';
    db.prepare(
      `INSERT INTO board_cards (id, column_id, owner_id, title, description, status, due_at, due_complete, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    ).run(
      id,
      body.columnId,
      user.id,
      sanitizePlainText(body.title, 200),
      body.description === undefined ? '' : sanitizePlainText(body.description, 4000),
      status,
      body.dueAt ?? null,
      nextCardPosition(db, body.columnId),
      now,
      now,
    );
    return { card: cardSummary(ctx, requireCard(db, id, user.id)) };
  });

  app.get('/api/board/cards/:id', async (req) => {
    const { user } = requireAuth(req);
    const id = assertUuid((req.params as { id?: string }).id, 'card');
    const card = requireCard(db, id, user.id);
    return { card: cardDetail(ctx, card) };
  });

  app.patch('/api/board/cards/:id', async (req) => {
    const { user } = requireAuth(req);
    const id = assertUuid((req.params as { id?: string }).id, 'card');
    const card = requireCard(db, id, user.id);
    const body = parseBody(
      z.object({
        title: z.string().trim().min(1).max(200).optional(),
        description: z.string().max(4000).optional(),
        columnId: z.string().uuid().optional(),
        position: z.number().int().min(0).max(MAX_CARDS_PER_COLUMN).optional(),
        status: z.enum(CARD_STATUSES).optional(),
        dueAt: z.number().int().min(0).nullable().optional(),
        dueComplete: z.boolean().optional(),
        coverFileId: z.string().uuid().nullable().optional(),
      }),
      req.body,
    );
    if (
      body.title === undefined &&
      body.description === undefined &&
      body.columnId === undefined &&
      body.position === undefined &&
      body.status === undefined &&
      body.dueAt === undefined &&
      body.dueComplete === undefined &&
      body.coverFileId === undefined
    )
      throw badRequest('Nessuna modifica richiesta');
    if (body.coverFileId) {
      const attachment = db
        .prepare(
          `SELECT a.id FROM board_card_attachments a JOIN files f ON f.id = a.file_id
           WHERE a.card_id = ? AND a.file_id = ? AND f.deleted_at IS NULL`,
        )
        .get(id, body.coverFileId);
      if (!attachment) throw notFound('Allegato non trovato');
    }
    let targetColumnId = body.columnId ?? card.column_id;
    let targetStatus: CardStatus = body.status ?? card.status;
    if (body.columnId !== undefined) {
      const targetColumn = requireColumn(db, targetColumnId, user.id);
      if (targetColumn.project_id !== card.project_id) throw forbidden('La scheda appartiene a un altro progetto');
      if (body.status === undefined) targetStatus = statusForColumnTitle(targetColumn.title) ?? card.status;
    } else if (body.status !== undefined) {
      const mappedColumn = columnIdForStatus(db, card.project_id, body.status);
      if (mappedColumn) targetColumnId = mappedColumn;
    }
    const targetChanged = targetColumnId !== card.column_id;
    const now = nowMs();
    withTransaction(db, () => {
      if (body.title !== undefined) {
        db.prepare('UPDATE board_cards SET title = ? WHERE id = ?').run(sanitizePlainText(body.title, 200), id);
      }
      if (body.description !== undefined) {
        db.prepare('UPDATE board_cards SET description = ? WHERE id = ?').run(
          sanitizePlainText(body.description, 4000),
          id,
        );
      }
      if (body.columnId !== undefined || body.position !== undefined || targetStatus !== card.status) {
        const rows = db
          .prepare('SELECT id FROM board_cards WHERE column_id = ? AND id != ? ORDER BY position ASC, created_at ASC')
          .all(targetColumnId, id) as Array<{ id: string }>;
        const ids = rows.map((row) => row.id);
        const index = Math.max(0, Math.min(body.position ?? ids.length, ids.length));
        ids.splice(index, 0, id);
        ids.forEach((cardId, position) => {
          db.prepare('UPDATE board_cards SET column_id = ?, position = ? WHERE id = ?').run(
            targetColumnId,
            position,
            cardId,
          );
        });
        if (targetChanged) {
          const sourceRows = db
            .prepare('SELECT id FROM board_cards WHERE column_id = ? ORDER BY position ASC, created_at ASC')
            .all(card.column_id) as Array<{ id: string }>;
          sourceRows.forEach((row, position) => {
            db.prepare('UPDATE board_cards SET position = ? WHERE id = ?').run(position, row.id);
          });
        }
      }
      if (body.status !== undefined || body.columnId !== undefined) {
        db.prepare('UPDATE board_cards SET status = ? WHERE id = ?').run(targetStatus, id);
      }
      if (body.dueAt !== undefined) {
        db.prepare('UPDATE board_cards SET due_at = ?, due_complete = 0 WHERE id = ?').run(body.dueAt, id);
      }
      if (body.dueComplete !== undefined) {
        db.prepare('UPDATE board_cards SET due_complete = ? WHERE id = ?').run(body.dueComplete ? 1 : 0, id);
      }
      if (body.coverFileId !== undefined) {
        db.prepare('UPDATE board_cards SET cover_file_id = ? WHERE id = ?').run(body.coverFileId, id);
      }
      db.prepare('UPDATE board_cards SET updated_at = ? WHERE id = ?').run(now, id);
    });
    return { card: cardSummary(ctx, requireCard(db, card.id, user.id)) };
  });

  app.delete('/api/board/cards/:id', async (req) => {
    const { user } = requireAuth(req);
    const id = assertUuid((req.params as { id?: string }).id, 'card');
    requireCard(db, id, user.id);
    db.prepare('DELETE FROM board_cards WHERE id = ?').run(id);
    return { ok: true };
  });

  app.post('/api/board/cards/:id/tasks', async (req) => {
    const { user } = requireAuth(req);
    const cardId = assertUuid((req.params as { id?: string }).id, 'card');
    const card = requireCard(db, cardId, user.id);
    const body = parseBody(z.object({ title: z.string().trim().min(1).max(200) }), req.body);
    const count = db.prepare('SELECT COUNT(*) AS n FROM board_card_tasks WHERE card_id = ?').get(card.id) as {
      n: number;
    };
    if (Number(count.n) >= MAX_TASKS_PER_CARD)
      throw conflict(`Una scheda può contenere al massimo ${MAX_TASKS_PER_CARD} attività`);
    const id = newId();
    const now = nowMs();
    db.prepare(
      `INSERT INTO board_card_tasks (id, card_id, title, status, done, position, created_at, updated_at)
       VALUES (?, ?, ?, 'todo', 0, ?, ?, ?)`,
    ).run(id, card.id, sanitizePlainText(body.title, 200), nextTaskPosition(db, card.id), now, now);
    db.prepare('UPDATE board_cards SET updated_at = ? WHERE id = ?').run(now, card.id);
    return { task: taskJson(requireTask(db, id, card.id)) };
  });

  app.patch('/api/board/cards/:id/tasks/:taskId', async (req) => {
    const { user } = requireAuth(req);
    const params = req.params as { id?: string; taskId?: string };
    const cardId = assertUuid(params.id, 'card');
    const taskId = assertUuid(params.taskId, 'task');
    const card = requireCard(db, cardId, user.id);
    const task = requireTask(db, taskId, card.id);
    const body = parseBody(
      z.object({
        title: z.string().trim().min(1).max(200).optional(),
        status: z.enum(CARD_STATUSES).optional(),
        done: z.boolean().optional(),
        notes: z.string().max(MAX_TASK_NOTES).optional(),
      }),
      req.body,
    );
    if (body.title === undefined && body.status === undefined && body.done === undefined && body.notes === undefined)
      throw badRequest('Nessuna modifica richiesta');
    const nextStatus: CardStatus | undefined =
      body.status ?? (body.done === undefined ? undefined : body.done ? 'done' : 'todo');
    const now = nowMs();
    withTransaction(db, () => {
      if (body.title !== undefined) {
        db.prepare('UPDATE board_card_tasks SET title = ? WHERE id = ?').run(
          sanitizePlainText(body.title, 200),
          task.id,
        );
      }
      if (body.notes !== undefined) {
        db.prepare('UPDATE board_card_tasks SET notes = ? WHERE id = ?').run(
          sanitizePlainText(body.notes, MAX_TASK_NOTES),
          task.id,
        );
      }
      if (nextStatus !== undefined) {
        db.prepare('UPDATE board_card_tasks SET status = ?, done = ? WHERE id = ?').run(
          nextStatus,
          nextStatus === 'done' ? 1 : 0,
          task.id,
        );
      }
      db.prepare('UPDATE board_card_tasks SET updated_at = ? WHERE id = ?').run(now, task.id);
      db.prepare('UPDATE board_cards SET updated_at = ? WHERE id = ?').run(now, card.id);
    });
    return { task: taskJson(requireTask(db, taskId, card.id)) };
  });

  app.delete('/api/board/cards/:id/tasks/:taskId', async (req) => {
    const { user } = requireAuth(req);
    const params = req.params as { id?: string; taskId?: string };
    const cardId = assertUuid(params.id, 'card');
    const taskId = assertUuid(params.taskId, 'task');
    const card = requireCard(db, cardId, user.id);
    requireTask(db, taskId, card.id);
    db.prepare('DELETE FROM board_card_tasks WHERE id = ?').run(taskId);
    db.prepare('UPDATE board_cards SET updated_at = ? WHERE id = ?').run(nowMs(), card.id);
    return { ok: true };
  });

  app.post('/api/board/cards/:id/labels', async (req) => {
    const { user } = requireAuth(req);
    const id = assertUuid((req.params as { id?: string }).id, 'card');
    const card = requireCard(db, id, user.id);
    const body = parseBody(z.object({ labelId: z.string().uuid() }), req.body);
    const label = db
      .prepare('SELECT id FROM board_labels WHERE id = ? AND project_id = ?')
      .get(body.labelId, card.project_id);
    if (!label) throw notFound('Etichetta non trovata');
    db.prepare('INSERT OR IGNORE INTO board_card_labels (card_id, label_id) VALUES (?, ?)').run(id, body.labelId);
    return { labels: labelsForCard(db, id).map(labelJson) };
  });

  app.delete('/api/board/cards/:id/labels/:labelId', async (req) => {
    const { user } = requireAuth(req);
    const params = req.params as { id?: string; labelId?: string };
    const id = assertUuid(params.id, 'card');
    const labelId = assertUuid(params.labelId, 'label');
    requireCard(db, id, user.id);
    db.prepare('DELETE FROM board_card_labels WHERE card_id = ? AND label_id = ?').run(id, labelId);
    return { labels: labelsForCard(db, id).map(labelJson) };
  });

  app.post('/api/board/cards/:id/members', async (req) => {
    const { user } = requireAuth(req);
    const id = assertUuid((req.params as { id?: string }).id, 'card');
    const card = requireCard(db, id, user.id);
    const body = parseBody(z.object({ userId: z.string().uuid() }), req.body);
    const member = db
      .prepare('SELECT user_id FROM project_members WHERE project_id = ? AND user_id = ?')
      .get(card.project_id, body.userId);
    if (!member) throw notFound('Membro del progetto non trovato');
    db.prepare('INSERT OR IGNORE INTO board_card_members (card_id, user_id) VALUES (?, ?)').run(id, body.userId);
    return { assignees: assigneesForCard(db, id).map((entry) => memberJson(ctx, entry)) };
  });

  app.delete('/api/board/cards/:id/members/:userId', async (req) => {
    const { user } = requireAuth(req);
    const params = req.params as { id?: string; userId?: string };
    const id = assertUuid(params.id, 'card');
    const userId = assertUuid(params.userId, 'user');
    requireCard(db, id, user.id);
    db.prepare('DELETE FROM board_card_members WHERE card_id = ? AND user_id = ?').run(id, userId);
    return { assignees: assigneesForCard(db, id).map((entry) => memberJson(ctx, entry)) };
  });

  app.post('/api/board/cards/:id/comments', async (req) => {
    const { user } = requireAuth(req);
    const id = assertUuid((req.params as { id?: string }).id, 'card');
    requireCard(db, id, user.id);
    const body = parseBody(z.object({ body: z.string().trim().min(1).max(MAX_COMMENT) }), req.body);
    const count = db.prepare('SELECT COUNT(*) AS n FROM board_card_comments WHERE card_id = ?').get(id) as {
      n: number;
    };
    if (Number(count.n) >= MAX_COMMENTS_PER_CARD) throw conflict('Troppi commenti su questa scheda');
    const commentId = newId();
    const now = nowMs();
    db.prepare(
      'INSERT INTO board_card_comments (id, card_id, author_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(commentId, id, user.id, sanitizePlainText(body.body, MAX_COMMENT), now, now);
    db.prepare('UPDATE board_cards SET updated_at = ? WHERE id = ?').run(now, id);
    const row = db
      .prepare(
        `SELECT bc.*, u.username, u.display_name FROM board_card_comments bc
         JOIN users u ON u.id = bc.author_id WHERE bc.id = ?`,
      )
      .get(commentId) as CommentRow;
    return { comment: commentJson(row), commentCount: Number(count.n) + 1 };
  });

  app.delete('/api/board/cards/:id/comments/:commentId', async (req) => {
    const { user } = requireAuth(req);
    const params = req.params as { id?: string; commentId?: string };
    const id = assertUuid(params.id, 'card');
    const commentId = assertUuid(params.commentId, 'comment');
    const card = requireCard(db, id, user.id);
    const comment = db
      .prepare('SELECT id, author_id FROM board_card_comments WHERE id = ? AND card_id = ?')
      .get(commentId, id) as { id: string; author_id: string } | undefined;
    if (!comment) throw notFound('Commento non trovato');
    const project = requireProject(db, card.project_id, user.id);
    if (comment.author_id !== user.id && project.owner_id !== user.id)
      throw forbidden('Non puoi eliminare questo commento');
    db.prepare('DELETE FROM board_card_comments WHERE id = ?').run(commentId);
    return { ok: true };
  });

  app.post('/api/board/cards/:id/attachments', async (req) => {
    const { user } = requireAuth(req);
    const id = assertUuid((req.params as { id?: string }).id, 'card');
    const card = requireCard(db, id, user.id);
    const body = parseBody(z.object({ fileId: z.string().uuid() }), req.body);
    const file = getFile(db, body.fileId);
    if (file?.kind !== 'file' || file.deleted_at !== null || file.scan_status !== 'clean')
      throw notFound('File non trovato');
    if (!canRead(db, file, user.id)) throw notFound('File non trovato');
    if (attachmentCount(db, id) >= MAX_ATTACHMENTS_PER_CARD)
      throw conflict(`Puoi allegare al massimo ${MAX_ATTACHMENTS_PER_CARD} file`);
    const existing = db
      .prepare('SELECT id FROM board_card_attachments WHERE card_id = ? AND file_id = ?')
      .get(id, file.id);
    if (existing) throw conflict('File già allegato');
    const attachmentId = newId();
    db.prepare(
      'INSERT INTO board_card_attachments (id, card_id, file_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(attachmentId, id, file.id, user.id, nowMs());
    shareAttachmentWithProject(ctx, card.project_id, file);
    const row = db
      .prepare(
        `SELECT a.id, a.card_id, a.file_id, a.created_by, a.created_at, f.name, f.mime, f.size
         FROM board_card_attachments a JOIN files f ON f.id = a.file_id WHERE a.id = ?`,
      )
      .get(attachmentId) as AttachmentRow;
    return { attachment: attachmentJson(row), attachmentCount: attachmentCount(db, id) };
  });

  app.delete('/api/board/cards/:id/attachments/:attachmentId', async (req) => {
    const { user } = requireAuth(req);
    const params = req.params as { id?: string; attachmentId?: string };
    const id = assertUuid(params.id, 'card');
    const attachmentId = assertUuid(params.attachmentId, 'attachment');
    requireCard(db, id, user.id);
    const attachment = db
      .prepare('SELECT id, file_id FROM board_card_attachments WHERE id = ? AND card_id = ?')
      .get(attachmentId, id) as { id: string; file_id: string } | undefined;
    if (!attachment) throw notFound('Allegato non trovato');
    db.prepare('DELETE FROM board_card_attachments WHERE id = ?').run(attachmentId);
    db.prepare('UPDATE board_cards SET cover_file_id = NULL WHERE id = ? AND cover_file_id = ?').run(
      id,
      attachment.file_id,
    );
    return { ok: true, attachmentCount: attachmentCount(db, id) };
  });
}
