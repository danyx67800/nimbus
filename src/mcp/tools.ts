import type { AppContext } from '../context.js';
import { withTransaction } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { newId, nowMs, sanitizePlainText } from '../util.js';
import type { McpUser } from './oauth.js';

const CARD_STATUSES = ['todo', 'doing', 'done'] as const;
type CardStatus = (typeof CARD_STATUSES)[number];

const STATUS_TITLES: Record<CardStatus, string[]> = {
  todo: ['da fare', 'to do', 'todo', 'backlog'],
  doing: ['in corso', 'doing', 'in progress', 'in lavorazione'],
  done: ['completate', 'completata', 'completato', 'fatto', 'fatta', 'fatte', 'done'],
};

const DEFAULT_COLUMNS = ['Da fare', 'In corso', 'Completate'];
const MAX_PROJECTS = 50;
const MAX_COLUMNS = 24;
const MAX_CARDS_PER_COLUMN = 1000;
const MAX_TASKS_PER_CARD = 100;
const MAX_COMMENTS_PER_CARD = 500;
const MAX_LABELS = 30;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ProjectRow = {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  chat_room_id: string | null;
  created_at: number;
  updated_at: number;
  role: 'owner' | 'member';
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

type LabelRow = { id: string; project_id: string; name: string; color: string; created_at: number };
type MemberRow = { user_id: string; role: 'owner' | 'member'; username: string; display_name: string };
type CommentRow = {
  id: string;
  body: string;
  author_id: string;
  created_at: number;
  username: string;
  display_name: string;
};
type AttachmentRow = { id: string; file_id: string; name: string; mime: string; size: number; created_at: number };

export interface BoardTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  run: (ctx: AppContext, user: McpUser, args: Record<string, unknown>) => Record<string, unknown>;
}

const iso = (value: number | null | undefined): string | null =>
  value === null || value === undefined ? null : new Date(Number(value)).toISOString();

function str(args: Record<string, unknown>, key: string, max = 200): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Parametro "${key}" obbligatorio`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Error(`Parametro "${key}" troppo lungo`);
  return trimmed;
}

function optionalStr(args: Record<string, unknown>, key: string, max = 4000): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`Parametro "${key}" non valido`);
  if (value.length > max) throw new Error(`Parametro "${key}" troppo lungo`);
  return value;
}

function idArg(args: Record<string, unknown>, key: string): string {
  const value = str(args, key, 80);
  if (!UUID_RE.test(value)) throw new Error(`Identificatore non valido: ${key}`);
  return value;
}

function optionalId(args: Record<string, unknown>, key: string): string | undefined {
  const value = optionalStr(args, key, 80);
  if (value === undefined || value === '') return undefined;
  if (!UUID_RE.test(value)) throw new Error(`Identificatore non valido: ${key}`);
  return value;
}

function optionalBool(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new Error(`Parametro "${key}" deve essere booleano`);
  return value;
}

function optionalNum(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Parametro "${key}" deve essere un intero`);
  }
  return value;
}

function statusArg(args: Record<string, unknown>, key: string): CardStatus | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !CARD_STATUSES.includes(value as CardStatus)) {
    throw new Error(`Parametro "${key}" deve essere todo, doing o done`);
  }
  return value as CardStatus;
}

function parseDue(value: unknown, key = 'dueAt'): number | null {
  if (value === null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value);
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed) && parsed >= 0) return parsed;
  }
  throw new Error(`Parametro "${key}" deve essere una data ISO 8601 o un timestamp in millisecondi`);
}

function has(args: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(args, key);
}

function statusForColumnTitle(title: string): CardStatus | null {
  const normalized = title.trim().toLowerCase();
  for (const status of CARD_STATUSES) {
    if (STATUS_TITLES[status].includes(normalized)) return status;
  }
  return null;
}

function projectAccess(db: AppContext['db'], projectId: string, userId: string): ProjectRow {
  const row = db
    .prepare(
      `SELECT p.*, pm.role FROM projects p
       JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
       WHERE p.id = ?`,
    )
    .get(userId, projectId) as ProjectRow | undefined;
  if (!row) throw notFound('Progetto non trovato o non accessibile');
  return row;
}

function projectsForUser(db: AppContext['db'], userId: string): ProjectRow[] {
  return db
    .prepare(
      `SELECT p.*, pm.role FROM projects p
       JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
       ORDER BY p.updated_at DESC, p.created_at DESC`,
    )
    .all(userId) as unknown as ProjectRow[];
}

function projectByRef(db: AppContext['db'], userId: string, args: Record<string, unknown>): ProjectRow {
  const projectId = optionalId(args, 'projectId');
  if (projectId) return projectAccess(db, projectId, userId);
  const name = optionalStr(args, 'projectName', 80)?.trim();
  if (name) {
    const row = db
      .prepare(
        `SELECT p.*, pm.role FROM projects p
         JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
         WHERE lower(p.name) = lower(?) ORDER BY p.updated_at DESC LIMIT 1`,
      )
      .get(userId, name) as ProjectRow | undefined;
    if (!row) throw notFound(`Nessun progetto chiamato "${name}"`);
    return row;
  }
  const first = projectsForUser(db, userId)[0];
  if (!first) throw notFound('Nessuna bacheca accessibile. Crea un progetto con board_create_project.');
  return first;
}

function columnAccess(db: AppContext['db'], columnId: string, userId: string): ColumnRow & { project_id: string } {
  const row = db
    .prepare(
      `SELECT c.* FROM board_columns c
       JOIN project_members pm ON pm.project_id = c.project_id AND pm.user_id = ?
       WHERE c.id = ? AND c.project_id IS NOT NULL`,
    )
    .get(userId, columnId) as (ColumnRow & { project_id: string }) | undefined;
  if (!row) throw notFound('Colonna non trovata');
  return row;
}

function cardAccess(db: AppContext['db'], cardId: string, userId: string): CardRow & { project_id: string } {
  const row = db
    .prepare(
      `SELECT c.*, col.project_id AS project_id FROM board_cards c
       JOIN board_columns col ON col.id = c.column_id
       JOIN project_members pm ON pm.project_id = col.project_id AND pm.user_id = ?
       WHERE c.id = ? AND col.project_id IS NOT NULL`,
    )
    .get(userId, cardId) as (CardRow & { project_id: string }) | undefined;
  if (!row) throw notFound('Scheda non trovata');
  return row;
}

function projectMembers(db: AppContext['db'], projectId: string): MemberRow[] {
  return db
    .prepare(
      `SELECT pm.user_id, pm.role, u.username, u.display_name
       FROM project_members pm JOIN users u ON u.id = pm.user_id
       WHERE pm.project_id = ? ORDER BY pm.role DESC, u.display_name COLLATE NOCASE`,
    )
    .all(projectId) as unknown as MemberRow[];
}

function tasksForCard(db: AppContext['db'], cardId: string): TaskRow[] {
  return db
    .prepare('SELECT * FROM board_card_tasks WHERE card_id = ? ORDER BY position ASC, created_at ASC')
    .all(cardId) as unknown as TaskRow[];
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
      `SELECT cm.user_id, u.username, u.display_name, pm.role
       FROM board_card_members cm
       JOIN users u ON u.id = cm.user_id
       JOIN board_cards c ON c.id = cm.card_id
       JOIN board_columns col ON col.id = c.column_id
       JOIN project_members pm ON pm.project_id = col.project_id AND pm.user_id = cm.user_id
       WHERE cm.card_id = ? ORDER BY u.display_name COLLATE NOCASE`,
    )
    .all(cardId) as unknown as MemberRow[];
}

function count(db: AppContext['db'], table: string, column: string, value: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(value) as { n: number };
  return Number(row.n);
}

function projectView(row: ProjectRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    role: row.role,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function columnView(row: ColumnRow): Record<string, unknown> {
  return { id: row.id, title: row.title, position: Number(row.position) };
}

function taskView(row: TaskRow): Record<string, unknown> {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    done: row.status === 'done',
    notes: row.notes,
    position: Number(row.position),
    updatedAt: iso(row.updated_at),
  };
}

function labelView(row: LabelRow): Record<string, unknown> {
  return { id: row.id, name: row.name, color: row.color };
}

function memberView(row: MemberRow): Record<string, unknown> {
  return { id: row.user_id, username: row.username, displayName: row.display_name, role: row.role };
}

function cardView(ctx: AppContext, row: CardRow, withDetails = false): Record<string, unknown> {
  const tasks = tasksForCard(ctx.db, row.id);
  const labels = labelsForCard(ctx.db, row.id);
  const assignees = assigneesForCard(ctx.db, row.id);
  const view: Record<string, unknown> = {
    id: row.id,
    columnId: row.column_id,
    title: row.title,
    description: row.description,
    status: row.status,
    dueAt: iso(row.due_at),
    dueComplete: Boolean(row.due_complete),
    position: Number(row.position),
    tasks: tasks.map(taskView),
    labels: labels.map(labelView),
    assignees: assignees.map(memberView),
    commentCount: count(ctx.db, 'board_card_comments', 'card_id', row.id),
    attachmentCount: count(ctx.db, 'board_card_attachments', 'card_id', row.id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
  if (withDetails) {
    const comments = ctx.db
      .prepare(
        `SELECT bc.id, bc.body, bc.author_id, bc.created_at, u.username, u.display_name
         FROM board_card_comments bc JOIN users u ON u.id = bc.author_id
         WHERE bc.card_id = ? ORDER BY bc.created_at ASC LIMIT 100`,
      )
      .all(row.id) as unknown as CommentRow[];
    const attachments = ctx.db
      .prepare(
        `SELECT a.id, a.file_id, a.created_at, f.name, f.mime, f.size
         FROM board_card_attachments a JOIN files f ON f.id = a.file_id
         WHERE a.card_id = ? AND f.deleted_at IS NULL ORDER BY a.created_at ASC`,
      )
      .all(row.id) as unknown as AttachmentRow[];
    view.comments = comments.map((comment) => ({
      id: comment.id,
      body: comment.body,
      author: { id: comment.author_id, username: comment.username, displayName: comment.display_name },
      createdAt: iso(comment.created_at),
    }));
    view.attachments = attachments.map((attachment) => ({
      id: attachment.id,
      fileId: attachment.file_id,
      name: attachment.name,
      mime: attachment.mime,
      size: Number(attachment.size),
      createdAt: iso(attachment.created_at),
    }));
  }
  return view;
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

function createProjectRecord(ctx: AppContext, ownerId: string, name: string, description: string): ProjectRow {
  const id = newId();
  const now = nowMs();
  ctx.db
    .prepare('INSERT INTO projects (id, owner_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, ownerId, name, description, now, now);
  ctx.db
    .prepare("INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)")
    .run(id, ownerId, now);
  for (const [position, title] of DEFAULT_COLUMNS.entries()) {
    ctx.db
      .prepare(
        'INSERT INTO board_columns (id, owner_id, project_id, title, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(newId(), ownerId, id, title, position, now, now);
  }
  return projectAccess(ctx.db, id, ownerId);
}

function ensureDefaultProject(ctx: AppContext, userId: string): ProjectRow {
  const existing = projectsForUser(ctx.db, userId)[0];
  if (existing) return existing;
  return createProjectRecord(ctx, userId, 'Bacheca', '');
}

function columnForStatus(db: AppContext['db'], projectId: string, status: CardStatus): ColumnRow | null {
  const rows = db
    .prepare('SELECT * FROM board_columns WHERE project_id = ? ORDER BY position ASC, created_at ASC')
    .all(projectId) as unknown as ColumnRow[];
  return rows.find((row) => statusForColumnTitle(row.title) === status) ?? null;
}

function resolveLabel(db: AppContext['db'], projectId: string, ref: string): LabelRow {
  const row = UUID_RE.test(ref)
    ? (db.prepare('SELECT * FROM board_labels WHERE id = ? AND project_id = ?').get(ref, projectId) as
        | LabelRow
        | undefined)
    : (db
        .prepare('SELECT * FROM board_labels WHERE project_id = ? AND lower(name) = lower(?) LIMIT 1')
        .get(projectId, ref) as LabelRow | undefined);
  if (!row) throw notFound(`Etichetta "${ref}" non trovata`);
  return row;
}

function resolveMember(db: AppContext['db'], projectId: string, ref: string): MemberRow {
  const row = UUID_RE.test(ref)
    ? (db
        .prepare(
          `SELECT pm.user_id, pm.role, u.username, u.display_name FROM project_members pm
           JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ? AND pm.user_id = ?`,
        )
        .get(projectId, ref) as MemberRow | undefined)
    : (db
        .prepare(
          `SELECT pm.user_id, pm.role, u.username, u.display_name FROM project_members pm
           JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ? AND lower(u.username) = lower(?)`,
        )
        .get(projectId, ref) as MemberRow | undefined);
  if (!row) throw notFound(`Membro "${ref}" non trovato nel progetto`);
  return row;
}

function reindexColumn(db: AppContext['db'], columnId: string, cardId: string, position: number): void {
  const rows = db
    .prepare('SELECT id FROM board_cards WHERE column_id = ? AND id != ? ORDER BY position ASC, created_at ASC')
    .all(columnId, cardId) as Array<{ id: string }>;
  const ids = rows.map((row) => row.id);
  const index = Math.max(0, Math.min(position, ids.length));
  ids.splice(index, 0, cardId);
  ids.forEach((id, index2) => {
    db.prepare('UPDATE board_cards SET column_id = ?, position = ? WHERE id = ?').run(columnId, index2, id);
  });
}

function compactColumn(db: AppContext['db'], columnId: string): void {
  const rows = db
    .prepare('SELECT id FROM board_cards WHERE column_id = ? ORDER BY position ASC, created_at ASC')
    .all(columnId) as Array<{ id: string }>;
  rows.forEach((row, position) => {
    db.prepare('UPDATE board_cards SET position = ? WHERE id = ?').run(position, row.id);
  });
}

const objectSchema = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const text = (description: string, maxLength = 200): Record<string, unknown> => ({
  type: 'string',
  description,
  maxLength,
});

const readOnly = { readOnlyHint: true, openWorldHint: false };
const destructive = { destructiveHint: true, openWorldHint: false };

export const boardTools: BoardTool[] = [
  {
    name: 'board_list_projects',
    title: 'Elenca le bacheche',
    description:
      'Elenca i progetti bacheca a cui l’utente ha accesso, con nome, descrizione, ruolo e date. Usa gli ID restituiti con gli altri strumenti.',
    inputSchema: objectSchema({}),
    annotations: readOnly,
    run: (ctx, user) => ({
      projects: projectsForUser(ctx.db, user.id).map(projectView),
    }),
  },
  {
    name: 'board_get',
    title: 'Leggi una bacheca',
    description:
      'Restituisce una bacheca completa: colonne in ordine con tutte le schede, attività, etichette, assegnatari, scadenze, membri e conteggi di commenti e allegati. Senza parametri usa la bacheca più recente e la crea se non esiste.',
    inputSchema: objectSchema({
      projectId: text('ID del progetto. Ometti per usare la bacheca più recente.'),
      projectName: text('Nome del progetto, alternativa all’ID.', 80),
    }),
    annotations: readOnly,
    run: (ctx, user, args) => {
      const project =
        projectsForUser(ctx.db, user.id).length === 0 &&
        !optionalId(args, 'projectId') &&
        !optionalStr(args, 'projectName')
          ? ensureDefaultProject(ctx, user.id)
          : projectByRef(ctx.db, user.id, args);
      const columns = ctx.db
        .prepare('SELECT * FROM board_columns WHERE project_id = ? ORDER BY position ASC, created_at ASC')
        .all(project.id) as unknown as ColumnRow[];
      const cards = ctx.db
        .prepare(
          `SELECT c.* FROM board_cards c JOIN board_columns col ON col.id = c.column_id
           WHERE col.project_id = ? ORDER BY c.position ASC, c.created_at ASC`,
        )
        .all(project.id) as unknown as CardRow[];
      const byColumn = new Map<string, CardRow[]>();
      for (const column of columns) byColumn.set(column.id, []);
      for (const card of cards) byColumn.get(card.column_id)?.push(card);
      return {
        project: projectView(project),
        members: projectMembers(ctx.db, project.id).map(memberView),
        labels: (
          ctx.db
            .prepare('SELECT * FROM board_labels WHERE project_id = ? ORDER BY created_at ASC')
            .all(project.id) as unknown as LabelRow[]
        ).map(labelView),
        columns: columns.map((column) => ({
          ...columnView(column),
          cards: (byColumn.get(column.id) ?? []).map((card) => cardView(ctx, card)),
        })),
      };
    },
  },
  {
    name: 'board_get_card',
    title: 'Leggi una scheda',
    description:
      'Restituisce una scheda completa con tutte le attività, le etichette, gli assegnatari, gli allegati e gli ultimi 100 commenti.',
    inputSchema: objectSchema({ cardId: text('ID della scheda.') }, ['cardId']),
    annotations: readOnly,
    run: (ctx, user, args) => ({ card: cardView(ctx, cardAccess(ctx.db, idArg(args, 'cardId'), user.id), true) }),
  },
  {
    name: 'board_search',
    title: 'Cerca nelle schede',
    description:
      'Cerca per testo nel titolo e nella descrizione delle schede accessibili. Restituisce ID, titolo, stato, progetto e colonna, così puoi aprire la scheda con board_get_card.',
    inputSchema: objectSchema(
      {
        query: text('Testo da cercare.'),
        projectId: text('Limita la ricerca a un progetto.'),
      },
      ['query'],
    ),
    annotations: readOnly,
    run: (ctx, user, args) => {
      const query = str(args, 'query', 100);
      const projectId = optionalId(args, 'projectId');
      const escaped = query.replace(/[\\%_]/g, (char) => `\\${char}`);
      const rows = ctx.db
        .prepare(
          `SELECT c.id, c.title, c.status, c.column_id, col.title AS column_title, p.id AS project_id, p.name AS project_name
           FROM board_cards c
           JOIN board_columns col ON col.id = c.column_id
           JOIN projects p ON p.id = col.project_id
           JOIN project_members pm ON pm.project_id = col.project_id AND pm.user_id = ?
           WHERE (lower(c.title) LIKE lower(?) ESCAPE '\\' OR lower(c.description) LIKE lower(?) ESCAPE '\\')
             ${projectId ? 'AND col.project_id = ?' : ''}
           ORDER BY c.updated_at DESC LIMIT 50`,
        )
        .all(
          ...(projectId
            ? [user.id, `%${escaped}%`, `%${escaped}%`, projectId]
            : [user.id, `%${escaped}%`, `%${escaped}%`]),
        ) as Array<Record<string, unknown>>;
      return {
        query,
        results: rows.map((row) => ({
          cardId: String(row.id),
          title: String(row.title),
          status: String(row.status),
          columnId: String(row.column_id),
          columnTitle: String(row.column_title),
          projectId: String(row.project_id),
          projectName: String(row.project_name),
        })),
      };
    },
  },
  {
    name: 'board_list_members',
    title: 'Elenca i membri',
    description:
      'Elenca i membri del progetto con ID, username, nome e ruolo. Usa username o ID con board_assign_member.',
    inputSchema: objectSchema({
      projectId: text('ID del progetto. Ometti per la bacheca più recente.'),
      projectName: text('Nome del progetto.', 80),
    }),
    annotations: readOnly,
    run: (ctx, user, args) => {
      const project = projectByRef(ctx.db, user.id, args);
      return { project: projectView(project), members: projectMembers(ctx.db, project.id).map(memberView) };
    },
  },
  {
    name: 'board_create_project',
    title: 'Crea una bacheca',
    description:
      'Crea un nuovo progetto bacheca con le colonne predefinite Da fare, In corso e Completate. Il creatore diventa proprietario.',
    inputSchema: objectSchema(
      {
        name: text('Nome del progetto.', 80),
        description: text('Descrizione facoltativa.', 4000),
      },
      ['name'],
    ),
    run: (ctx, user, args) => {
      const owned = ctx.db.prepare('SELECT COUNT(*) AS n FROM projects WHERE owner_id = ?').get(user.id) as {
        n: number;
      };
      if (Number(owned.n) >= MAX_PROJECTS) throw conflict(`Puoi creare al massimo ${MAX_PROJECTS} progetti`);
      const project = withTransaction(ctx.db, () =>
        createProjectRecord(
          ctx,
          user.id,
          sanitizePlainText(str(args, 'name', 80), 80),
          sanitizePlainText(optionalStr(args, 'description') ?? '', 4000),
        ),
      );
      return { project: projectView(project) };
    },
  },
  {
    name: 'board_update_project',
    title: 'Modifica una bacheca',
    description: 'Rinomina o aggiorna la descrizione di un progetto. Solo il proprietario può modificarlo.',
    inputSchema: objectSchema(
      {
        projectId: text('ID del progetto.'),
        name: text('Nuovo nome.', 80),
        description: text('Nuova descrizione.', 4000),
      },
      ['projectId'],
    ),
    run: (ctx, user, args) => {
      const projectId = idArg(args, 'projectId');
      const project = projectAccess(ctx.db, projectId, user.id);
      if (project.owner_id !== user.id) throw forbidden('Solo il proprietario del progetto può modificarlo');
      const name = optionalStr(args, 'name', 80);
      const description = optionalStr(args, 'description');
      if (name === undefined && description === undefined) throw badRequest('Nessuna modifica richiesta');
      const now = nowMs();
      withTransaction(ctx.db, () => {
        if (name !== undefined) {
          ctx.db
            .prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?')
            .run(sanitizePlainText(name, 80), now, projectId);
          if (project.chat_room_id) {
            ctx.db
              .prepare('UPDATE chat_rooms SET name = ?, updated_at = ? WHERE id = ?')
              .run(sanitizePlainText(name, 80), now, project.chat_room_id);
          }
        }
        if (description !== undefined) {
          ctx.db
            .prepare('UPDATE projects SET description = ?, updated_at = ? WHERE id = ?')
            .run(sanitizePlainText(description, 4000), now, projectId);
        }
      });
      return { project: projectView(projectAccess(ctx.db, projectId, user.id)) };
    },
  },
  {
    name: 'board_create_column',
    title: 'Crea una colonna',
    description:
      'Aggiunge una colonna alla fine della bacheca. I titoli “Da fare”, “In corso” e “Completate” mappano gli stati.',
    inputSchema: objectSchema(
      {
        projectId: text('ID del progetto.'),
        title: text('Titolo della colonna.', 80),
      },
      ['projectId', 'title'],
    ),
    run: (ctx, user, args) => {
      const project = projectAccess(ctx.db, idArg(args, 'projectId'), user.id);
      if (count(ctx.db, 'board_columns', 'project_id', project.id) >= MAX_COLUMNS) {
        throw conflict(`Puoi creare al massimo ${MAX_COLUMNS} colonne`);
      }
      const id = newId();
      const now = nowMs();
      ctx.db
        .prepare(
          'INSERT INTO board_columns (id, owner_id, project_id, title, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          id,
          project.owner_id,
          project.id,
          sanitizePlainText(str(args, 'title', 80), 80),
          nextColumnPosition(ctx.db, project.id),
          now,
          now,
        );
      return { column: columnView(columnAccess(ctx.db, id, user.id)) };
    },
  },
  {
    name: 'board_update_column',
    title: 'Modifica una colonna',
    description: 'Rinomina una colonna o cambia la sua posizione (0 = prima colonna).',
    inputSchema: objectSchema(
      {
        columnId: text('ID della colonna.'),
        title: text('Nuovo titolo.', 80),
        position: { type: 'integer', minimum: 0, maximum: MAX_COLUMNS, description: 'Nuova posizione.' },
      },
      ['columnId'],
    ),
    run: (ctx, user, args) => {
      const column = columnAccess(ctx.db, idArg(args, 'columnId'), user.id);
      const title = optionalStr(args, 'title', 80);
      const position = optionalNum(args, 'position');
      if (title === undefined && position === undefined) throw badRequest('Nessuna modifica richiesta');
      withTransaction(ctx.db, () => {
        if (title !== undefined) {
          ctx.db
            .prepare('UPDATE board_columns SET title = ?, updated_at = ? WHERE id = ?')
            .run(sanitizePlainText(title, 80), nowMs(), column.id);
        }
        if (position !== undefined) {
          const rows = ctx.db
            .prepare('SELECT id FROM board_columns WHERE project_id = ? ORDER BY position ASC, created_at ASC')
            .all(column.project_id) as Array<{ id: string }>;
          const ids = rows.map((row) => row.id).filter((id) => id !== column.id);
          ids.splice(Math.max(0, Math.min(position, ids.length)), 0, column.id);
          ids.forEach((id, index) => {
            ctx.db.prepare('UPDATE board_columns SET position = ? WHERE id = ?').run(index, id);
          });
        }
      });
      return { column: columnView(columnAccess(ctx.db, column.id, user.id)) };
    },
  },
  {
    name: 'board_delete_column',
    title: 'Elimina una colonna',
    description:
      'Elimina una colonna e tutte le schede che contiene. Operazione irreversibile: chiedi conferma all’utente.',
    inputSchema: objectSchema({ columnId: text('ID della colonna.') }, ['columnId']),
    annotations: destructive,
    run: (ctx, user, args) => {
      const column = columnAccess(ctx.db, idArg(args, 'columnId'), user.id);
      ctx.db.prepare('DELETE FROM board_columns WHERE id = ?').run(column.id);
      return { deleted: true, columnId: column.id };
    },
  },
  {
    name: 'board_create_card',
    title: 'Crea una scheda',
    description:
      'Crea una scheda in una colonna. Puoi indicare la colonna (columnId) oppure lo stato (todo, doing, done) e il progetto; senza nulla usa la prima colonna della bacheca più recente. Le etichette si passano per ID o nome.',
    inputSchema: objectSchema(
      {
        projectId: text('ID del progetto. Serve se non indichi columnId.'),
        columnId: text('ID della colonna di destinazione.'),
        title: text('Titolo della scheda.', 200),
        description: text('Descrizione facoltativa.', 4000),
        status: { type: 'string', enum: [...CARD_STATUSES], description: 'Stato iniziale della scheda.' },
        dueAt: {
          type: ['string', 'number', 'null'],
          description: 'Scadenza ISO 8601 o timestamp in millisecondi.',
        },
        labels: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 30,
          description: 'Etichette esistenti, per ID o nome.',
        },
      },
      ['title'],
    ),
    run: (ctx, user, args) => {
      const explicitColumnId = optionalId(args, 'columnId');
      let column: ColumnRow & { project_id: string };
      if (explicitColumnId) {
        column = columnAccess(ctx.db, explicitColumnId, user.id);
      } else {
        const project = projectByRef(ctx.db, user.id, args);
        const status = statusArg(args, 'status') ?? 'todo';
        const mapped = columnForStatus(ctx.db, project.id, status);
        const first = ctx.db
          .prepare('SELECT * FROM board_columns WHERE project_id = ? ORDER BY position ASC, created_at ASC LIMIT 1')
          .get(project.id) as ColumnRow | undefined;
        const chosen = mapped ?? first;
        if (!chosen) throw conflict('Il progetto non ha colonne: creane una con board_create_column');
        column = chosen as ColumnRow & { project_id: string };
      }
      if (count(ctx.db, 'board_cards', 'column_id', column.id) >= MAX_CARDS_PER_COLUMN) {
        throw conflict(`Una colonna può contenere al massimo ${MAX_CARDS_PER_COLUMN} schede`);
      }
      const status = statusArg(args, 'status') ?? statusForColumnTitle(column.title) ?? 'todo';
      const id = newId();
      const now = nowMs();
      const dueAt = has(args, 'dueAt') ? parseDue(args.dueAt) : null;
      withTransaction(ctx.db, () => {
        ctx.db
          .prepare(
            `INSERT INTO board_cards (id, column_id, owner_id, title, description, status, due_at, due_complete, position, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
          )
          .run(
            id,
            column.id,
            user.id,
            sanitizePlainText(str(args, 'title', 200), 200),
            sanitizePlainText(optionalStr(args, 'description') ?? '', 4000),
            status,
            dueAt,
            nextCardPosition(ctx.db, column.id),
            now,
            now,
          );
        const labels = args.labels;
        if (Array.isArray(labels)) {
          for (const ref of labels) {
            if (typeof ref !== 'string' || !ref.trim()) continue;
            const label = resolveLabel(ctx.db, column.project_id, ref.trim());
            ctx.db
              .prepare('INSERT OR IGNORE INTO board_card_labels (card_id, label_id) VALUES (?, ?)')
              .run(id, label.id);
          }
        }
        ctx.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, column.project_id);
      });
      return { card: cardView(ctx, cardAccess(ctx.db, id, user.id)) };
    },
  },
  {
    name: 'board_update_card',
    title: 'Modifica una scheda',
    description:
      'Aggiorna titolo, descrizione, stato, colonna, posizione, scadenza o completamento di una scheda. Cambiare columnId sposta la scheda; cambiare status la sposta nella colonna corrispondente se esiste.',
    inputSchema: objectSchema(
      {
        cardId: text('ID della scheda.'),
        title: text('Nuovo titolo.', 200),
        description: text('Nuova descrizione.', 4000),
        status: { type: 'string', enum: [...CARD_STATUSES] },
        columnId: text('ID della colonna di destinazione.'),
        position: { type: 'integer', minimum: 0, maximum: MAX_CARDS_PER_COLUMN },
        dueAt: {
          type: ['string', 'number', 'null'],
          description: 'Nuova scadenza ISO 8601 o timestamp, null per rimuoverla.',
        },
        dueComplete: { type: 'boolean', description: 'Scadenza completata.' },
      },
      ['cardId'],
    ),
    run: (ctx, user, args) => {
      const card = cardAccess(ctx.db, idArg(args, 'cardId'), user.id);
      const title = optionalStr(args, 'title', 200);
      const description = optionalStr(args, 'description');
      const status = statusArg(args, 'status');
      const targetColumnId = optionalId(args, 'columnId');
      const position = optionalNum(args, 'position');
      const dueComplete = optionalBool(args, 'dueComplete');
      if (
        title === undefined &&
        description === undefined &&
        status === undefined &&
        targetColumnId === undefined &&
        position === undefined &&
        dueComplete === undefined &&
        !has(args, 'dueAt')
      ) {
        throw badRequest('Nessuna modifica richiesta');
      }
      let destinationColumnId = targetColumnId ?? card.column_id;
      let targetStatus: CardStatus = status ?? card.status;
      if (targetColumnId !== undefined) {
        const target = columnAccess(ctx.db, targetColumnId, user.id);
        if (target.project_id !== card.project_id) throw forbidden('La scheda appartiene a un altro progetto');
        if (status === undefined) targetStatus = statusForColumnTitle(target.title) ?? card.status;
      } else if (status !== undefined) {
        const mapped = columnForStatus(ctx.db, card.project_id, status);
        if (mapped) destinationColumnId = mapped.id;
      }
      const columnChanged = destinationColumnId !== card.column_id;
      const now = nowMs();
      withTransaction(ctx.db, () => {
        if (title !== undefined) {
          ctx.db.prepare('UPDATE board_cards SET title = ? WHERE id = ?').run(sanitizePlainText(title, 200), card.id);
        }
        if (description !== undefined) {
          ctx.db
            .prepare('UPDATE board_cards SET description = ? WHERE id = ?')
            .run(sanitizePlainText(description, 4000), card.id);
        }
        if (targetColumnId !== undefined || position !== undefined || targetStatus !== card.status) {
          reindexColumn(ctx.db, destinationColumnId, card.id, position ?? MAX_CARDS_PER_COLUMN);
          if (columnChanged) compactColumn(ctx.db, card.column_id);
        }
        if (status !== undefined || targetColumnId !== undefined) {
          ctx.db.prepare('UPDATE board_cards SET status = ? WHERE id = ?').run(targetStatus, card.id);
        }
        if (has(args, 'dueAt')) {
          ctx.db
            .prepare('UPDATE board_cards SET due_at = ?, due_complete = 0 WHERE id = ?')
            .run(parseDue(args.dueAt), card.id);
        }
        if (dueComplete !== undefined) {
          ctx.db.prepare('UPDATE board_cards SET due_complete = ? WHERE id = ?').run(dueComplete ? 1 : 0, card.id);
        }
        ctx.db.prepare('UPDATE board_cards SET updated_at = ? WHERE id = ?').run(now, card.id);
        ctx.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, card.project_id);
      });
      return { card: cardView(ctx, cardAccess(ctx.db, card.id, user.id)) };
    },
  },
  {
    name: 'board_delete_card',
    title: 'Elimina una scheda',
    description: 'Elimina definitivamente una scheda con le sue attività, commenti, etichette e allegati.',
    inputSchema: objectSchema({ cardId: text('ID della scheda.') }, ['cardId']),
    annotations: destructive,
    run: (ctx, user, args) => {
      const card = cardAccess(ctx.db, idArg(args, 'cardId'), user.id);
      ctx.db.prepare('DELETE FROM board_cards WHERE id = ?').run(card.id);
      compactColumn(ctx.db, card.column_id);
      return { deleted: true, cardId: card.id };
    },
  },
  {
    name: 'board_add_task',
    title: 'Aggiungi un’attività',
    description: 'Aggiunge una checklist alla scheda. Lo stato iniziale è “todo”.',
    inputSchema: objectSchema(
      {
        cardId: text('ID della scheda.'),
        title: text('Testo dell’attività.', 200),
      },
      ['cardId', 'title'],
    ),
    run: (ctx, user, args) => {
      const card = cardAccess(ctx.db, idArg(args, 'cardId'), user.id);
      if (count(ctx.db, 'board_card_tasks', 'card_id', card.id) >= MAX_TASKS_PER_CARD) {
        throw conflict(`Una scheda può contenere al massimo ${MAX_TASKS_PER_CARD} attività`);
      }
      const id = newId();
      const now = nowMs();
      ctx.db
        .prepare(
          `INSERT INTO board_card_tasks (id, card_id, title, status, done, position, created_at, updated_at)
           VALUES (?, ?, ?, 'todo', 0, ?, ?, ?)`,
        )
        .run(id, card.id, sanitizePlainText(str(args, 'title', 200), 200), nextTaskPosition(ctx.db, card.id), now, now);
      ctx.db.prepare('UPDATE board_cards SET updated_at = ? WHERE id = ?').run(now, card.id);
      const task = ctx.db.prepare('SELECT * FROM board_card_tasks WHERE id = ?').get(id) as TaskRow;
      return { task: taskView(task) };
    },
  },
  {
    name: 'board_update_task',
    title: 'Modifica un’attività',
    description: 'Aggiorna testo, stato, completamento o note di un’attività della checklist.',
    inputSchema: objectSchema(
      {
        cardId: text('ID della scheda.'),
        taskId: text('ID dell’attività.'),
        title: text('Nuovo testo.', 200),
        status: { type: 'string', enum: [...CARD_STATUSES] },
        done: { type: 'boolean', description: 'Scorciatoia: true = done, false = todo.' },
        notes: text('Note aggiuntive.', 8000),
      },
      ['cardId', 'taskId'],
    ),
    run: (ctx, user, args) => {
      const card = cardAccess(ctx.db, idArg(args, 'cardId'), user.id);
      const taskId = idArg(args, 'taskId');
      const task = ctx.db.prepare('SELECT * FROM board_card_tasks WHERE id = ? AND card_id = ?').get(taskId, card.id) as
        | TaskRow
        | undefined;
      if (!task) throw notFound('Attività non trovata');
      const title = optionalStr(args, 'title', 200);
      const notes = optionalStr(args, 'notes', 8000);
      const done = optionalBool(args, 'done');
      const status = statusArg(args, 'status') ?? (done === undefined ? undefined : done ? 'done' : 'todo');
      if (title === undefined && notes === undefined && status === undefined)
        throw badRequest('Nessuna modifica richiesta');
      const now = nowMs();
      withTransaction(ctx.db, () => {
        if (title !== undefined) {
          ctx.db
            .prepare('UPDATE board_card_tasks SET title = ? WHERE id = ?')
            .run(sanitizePlainText(title, 200), task.id);
        }
        if (notes !== undefined) {
          ctx.db
            .prepare('UPDATE board_card_tasks SET notes = ? WHERE id = ?')
            .run(sanitizePlainText(notes, 8000), task.id);
        }
        if (status !== undefined) {
          ctx.db
            .prepare('UPDATE board_card_tasks SET status = ?, done = ? WHERE id = ?')
            .run(status, status === 'done' ? 1 : 0, task.id);
        }
        ctx.db.prepare('UPDATE board_card_tasks SET updated_at = ? WHERE id = ?').run(now, task.id);
        ctx.db.prepare('UPDATE board_cards SET updated_at = ? WHERE id = ?').run(now, card.id);
      });
      const fresh = ctx.db.prepare('SELECT * FROM board_card_tasks WHERE id = ?').get(task.id) as TaskRow;
      return { task: taskView(fresh) };
    },
  },
  {
    name: 'board_delete_task',
    title: 'Elimina un’attività',
    description: 'Rimuove un’attività dalla checklist di una scheda.',
    inputSchema: objectSchema({ cardId: text('ID della scheda.'), taskId: text('ID dell’attività.') }, [
      'cardId',
      'taskId',
    ]),
    annotations: destructive,
    run: (ctx, user, args) => {
      const card = cardAccess(ctx.db, idArg(args, 'cardId'), user.id);
      const taskId = idArg(args, 'taskId');
      const task = ctx.db.prepare('SELECT id FROM board_card_tasks WHERE id = ? AND card_id = ?').get(taskId, card.id);
      if (!task) throw notFound('Attività non trovata');
      ctx.db.prepare('DELETE FROM board_card_tasks WHERE id = ?').run(taskId);
      ctx.db.prepare('UPDATE board_cards SET updated_at = ? WHERE id = ?').run(nowMs(), card.id);
      return { deleted: true, taskId };
    },
  },
  {
    name: 'board_add_comment',
    title: 'Commenta una scheda',
    description: 'Aggiunge un commento alla scheda a nome dell’utente autenticato.',
    inputSchema: objectSchema(
      {
        cardId: text('ID della scheda.'),
        body: text('Testo del commento.', 4000),
      },
      ['cardId', 'body'],
    ),
    run: (ctx, user, args) => {
      const card = cardAccess(ctx.db, idArg(args, 'cardId'), user.id);
      if (count(ctx.db, 'board_card_comments', 'card_id', card.id) >= MAX_COMMENTS_PER_CARD) {
        throw conflict('Troppi commenti su questa scheda');
      }
      const id = newId();
      const now = nowMs();
      ctx.db
        .prepare(
          'INSERT INTO board_card_comments (id, card_id, author_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(id, card.id, user.id, sanitizePlainText(str(args, 'body', 4000), 4000), now, now);
      ctx.db.prepare('UPDATE board_cards SET updated_at = ? WHERE id = ?').run(now, card.id);
      return {
        comment: {
          id,
          body: sanitizePlainText(str(args, 'body', 4000), 4000),
          author: { id: user.id, username: user.username, displayName: user.display_name },
          createdAt: iso(now),
        },
        commentCount: count(ctx.db, 'board_card_comments', 'card_id', card.id),
      };
    },
  },
  {
    name: 'board_create_label',
    title: 'Crea un’etichetta',
    description: 'Crea un’etichetta di progetto con nome e colore esadecimale (default #8f6cf5).',
    inputSchema: objectSchema(
      {
        projectId: text('ID del progetto.'),
        name: text('Nome dell’etichetta.', 40),
        color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$', description: 'Colore esadecimale, es. #8f6cf5.' },
      },
      ['projectId', 'name'],
    ),
    run: (ctx, user, args) => {
      const project = projectAccess(ctx.db, idArg(args, 'projectId'), user.id);
      if (count(ctx.db, 'board_labels', 'project_id', project.id) >= MAX_LABELS) {
        throw conflict(`Puoi creare al massimo ${MAX_LABELS} etichette`);
      }
      const color = optionalStr(args, 'color', 7) ?? '#8f6cf5';
      if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw badRequest('Colore non valido');
      const id = newId();
      ctx.db
        .prepare('INSERT INTO board_labels (id, project_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, project.id, sanitizePlainText(str(args, 'name', 40), 40), color, nowMs());
      const label = ctx.db.prepare('SELECT * FROM board_labels WHERE id = ?').get(id) as LabelRow;
      return { label: labelView(label) };
    },
  },
  {
    name: 'board_set_card_labels',
    title: 'Imposta le etichette',
    description:
      'Sostituisce le etichette di una scheda con l’elenco indicato (per ID o nome). Passa un array vuoto per rimuoverle tutte.',
    inputSchema: objectSchema(
      {
        cardId: text('ID della scheda.'),
        labels: { type: 'array', items: { type: 'string' }, maxItems: 30 },
      },
      ['cardId', 'labels'],
    ),
    run: (ctx, user, args) => {
      const card = cardAccess(ctx.db, idArg(args, 'cardId'), user.id);
      const labels = args.labels;
      if (!Array.isArray(labels)) throw badRequest('labels deve essere un array');
      const resolved = labels.map((ref) => {
        if (typeof ref !== 'string' || !ref.trim()) throw badRequest('Etichetta non valida');
        return resolveLabel(ctx.db, card.project_id, ref.trim());
      });
      withTransaction(ctx.db, () => {
        ctx.db.prepare('DELETE FROM board_card_labels WHERE card_id = ?').run(card.id);
        for (const label of resolved) {
          ctx.db
            .prepare('INSERT OR IGNORE INTO board_card_labels (card_id, label_id) VALUES (?, ?)')
            .run(card.id, label.id);
        }
        ctx.db.prepare('UPDATE board_cards SET updated_at = ? WHERE id = ?').run(nowMs(), card.id);
      });
      return { labels: labelsForCard(ctx.db, card.id).map(labelView) };
    },
  },
  {
    name: 'board_assign_member',
    title: 'Assegna un membro',
    description:
      'Assegna un membro del progetto a una scheda, oppure rimuovilo con remove=true. Usa username o ID utente.',
    inputSchema: objectSchema(
      {
        cardId: text('ID della scheda.'),
        user: text('Username o ID del membro del progetto.', 80),
        remove: { type: 'boolean', description: 'true per rimuovere l’assegnazione.' },
      },
      ['cardId', 'user'],
    ),
    run: (ctx, user, args) => {
      const card = cardAccess(ctx.db, idArg(args, 'cardId'), user.id);
      const member = resolveMember(ctx.db, card.project_id, str(args, 'user', 80));
      if (optionalBool(args, 'remove')) {
        ctx.db.prepare('DELETE FROM board_card_members WHERE card_id = ? AND user_id = ?').run(card.id, member.user_id);
      } else {
        ctx.db
          .prepare('INSERT OR IGNORE INTO board_card_members (card_id, user_id) VALUES (?, ?)')
          .run(card.id, member.user_id);
      }
      ctx.db.prepare('UPDATE board_cards SET updated_at = ? WHERE id = ?').run(nowMs(), card.id);
      return { assignees: assigneesForCard(ctx.db, card.id).map(memberView) };
    },
  },
];

export function executeBoardTool(
  ctx: AppContext,
  user: McpUser,
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const tool = boardTools.find((entry) => entry.name === name);
  if (!tool) throw notFound(`Strumento sconosciuto: ${name}`);
  return tool.run(ctx, user, args);
}
