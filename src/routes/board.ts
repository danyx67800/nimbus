import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { withTransaction } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { parseBody } from '../http/helpers.js';
import { requireAuth } from '../http/security.js';
import { assertUuid, newId, nowMs, sanitizePlainText } from '../util.js';

type ColumnRow = {
  id: string;
  owner_id: string;
  title: string;
  position: number;
  created_at: number;
  updated_at: number;
};

const CARD_STATUSES = ['todo', 'doing', 'done'] as const;
type CardStatus = (typeof CARD_STATUSES)[number];

const STATUS_TITLES: Record<CardStatus, string[]> = {
  todo: ['da fare', 'to do', 'todo', 'backlog'],
  doing: ['in corso', 'doing', 'in progress', 'in lavorazione'],
  done: ['completate', 'completata', 'completato', 'fatto', 'fatta', 'fatte', 'done'],
};

type CardRow = {
  id: string;
  column_id: string;
  owner_id: string;
  title: string;
  description: string;
  status: CardStatus;
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

const MAX_COLUMNS = 24;
const MAX_CARDS_PER_COLUMN = 1000;
const MAX_TASKS_PER_CARD = 100;
const MAX_TASK_NOTES = 8000;
const DEFAULT_COLUMNS = ['Da fare', 'In corso', 'Completate'];

function statusForColumnTitle(title: string): CardStatus | null {
  const normalized = title.trim().toLowerCase();
  for (const status of CARD_STATUSES) {
    if (STATUS_TITLES[status].includes(normalized)) return status;
  }
  return null;
}

function columnIdForStatus(db: AppContext['db'], ownerId: string, status: CardStatus): string | null {
  const rows = db
    .prepare('SELECT id, title FROM board_columns WHERE owner_id = ? ORDER BY position ASC, created_at ASC')
    .all(ownerId) as Array<{ id: string; title: string }>;
  return rows.find((row) => statusForColumnTitle(row.title) === status)?.id ?? null;
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

function cardJson(row: CardRow, tasks: TaskRow[] = []): Record<string, unknown> {
  return {
    id: row.id,
    columnId: row.column_id,
    title: row.title,
    description: row.description,
    status: row.status,
    position: Number(row.position),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    tasks: tasks.map(taskJson),
  };
}

function requireColumn(db: AppContext['db'], id: string, ownerId: string): ColumnRow {
  const row = db.prepare('SELECT * FROM board_columns WHERE id = ? AND owner_id = ?').get(id, ownerId) as
    | ColumnRow
    | undefined;
  if (!row) throw notFound('Colonna non trovata');
  return row;
}

function requireCard(db: AppContext['db'], id: string, ownerId: string): CardRow {
  const row = db.prepare('SELECT * FROM board_cards WHERE id = ? AND owner_id = ?').get(id, ownerId) as
    | CardRow
    | undefined;
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

function loadBoard(db: AppContext['db'], ownerId: string): Array<Record<string, unknown>> {
  const columns = db
    .prepare('SELECT * FROM board_columns WHERE owner_id = ? ORDER BY position ASC, created_at ASC')
    .all(ownerId) as unknown as ColumnRow[];
  const cards = db
    .prepare('SELECT * FROM board_cards WHERE owner_id = ? ORDER BY position ASC, created_at ASC')
    .all(ownerId) as unknown as CardRow[];
  const tasks = db
    .prepare(
      `SELECT t.* FROM board_card_tasks t JOIN board_cards c ON c.id = t.card_id
       WHERE c.owner_id = ? ORDER BY t.position ASC, t.created_at ASC`,
    )
    .all(ownerId) as unknown as TaskRow[];
  const cardsByColumn = new Map<string, CardRow[]>();
  const tasksByCard = new Map<string, TaskRow[]>();
  for (const column of columns) cardsByColumn.set(column.id, []);
  for (const card of cards) cardsByColumn.get(card.column_id)?.push(card);
  for (const task of tasks) {
    const list = tasksByCard.get(task.card_id);
    if (list) list.push(task);
    else tasksByCard.set(task.card_id, [task]);
  }
  return columns.map((column) => ({
    ...columnJson(column),
    cards: (cardsByColumn.get(column.id) ?? []).map((card) => cardJson(card, tasksByCard.get(card.id) ?? [])),
  }));
}

function ensureDefaultBoard(db: AppContext['db'], ownerId: string): void {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM board_columns WHERE owner_id = ?').get(ownerId) as {
    n: number;
  };
  if (Number(existing.n) > 0) return;
  withTransaction(db, () => {
    const check = db.prepare('SELECT COUNT(*) AS n FROM board_columns WHERE owner_id = ?').get(ownerId) as {
      n: number;
    };
    if (Number(check.n) > 0) return;
    const now = nowMs();
    for (const [position, title] of DEFAULT_COLUMNS.entries()) {
      db.prepare(
        'INSERT INTO board_columns (id, owner_id, title, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(newId(), ownerId, title, position, now, now);
    }
  });
}

function nextColumnPosition(db: AppContext['db'], ownerId: string): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM board_columns WHERE owner_id = ?')
    .get(ownerId) as { next: number };
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

export function registerBoardRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get('/api/board', async (req) => {
    const { user } = requireAuth(req);
    ensureDefaultBoard(db, user.id);
    return { columns: loadBoard(db, user.id) };
  });

  app.post('/api/board/columns', async (req) => {
    const { user } = requireAuth(req);
    const body = parseBody(z.object({ title: z.string().trim().min(1).max(80) }), req.body);
    const count = db.prepare('SELECT COUNT(*) AS n FROM board_columns WHERE owner_id = ?').get(user.id) as {
      n: number;
    };
    if (Number(count.n) >= MAX_COLUMNS) throw conflict(`Puoi creare al massimo ${MAX_COLUMNS} colonne`);
    const id = newId();
    const now = nowMs();
    db.prepare(
      'INSERT INTO board_columns (id, owner_id, title, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, user.id, sanitizePlainText(body.title, 80), nextColumnPosition(db, user.id), now, now);
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
          .prepare('SELECT id FROM board_columns WHERE owner_id = ? ORDER BY position ASC, created_at ASC')
          .all(user.id) as Array<{ id: string }>;
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
      `INSERT INTO board_cards (id, column_id, owner_id, title, description, status, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      body.columnId,
      user.id,
      sanitizePlainText(body.title, 200),
      body.description === undefined ? '' : sanitizePlainText(body.description, 4000),
      status,
      nextCardPosition(db, body.columnId),
      now,
      now,
    );
    return { card: cardJson(requireCard(db, id, user.id)) };
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
      }),
      req.body,
    );
    if (
      body.title === undefined &&
      body.description === undefined &&
      body.columnId === undefined &&
      body.position === undefined &&
      body.status === undefined
    )
      throw badRequest('Nessuna modifica richiesta');
    let targetColumnId = body.columnId ?? card.column_id;
    let targetStatus: CardStatus = body.status ?? card.status;
    if (body.columnId !== undefined) {
      const targetColumn = requireColumn(db, targetColumnId, user.id);
      if (body.status === undefined) targetStatus = statusForColumnTitle(targetColumn.title) ?? card.status;
    } else if (body.status !== undefined) {
      const mappedColumn = columnIdForStatus(db, user.id, body.status);
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
      if (targetChanged || body.position !== undefined) {
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
      db.prepare('UPDATE board_cards SET updated_at = ? WHERE id = ?').run(now, id);
    });
    return { card: cardJson(requireCard(db, card.id, user.id), tasksForCard(db, card.id)) };
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
}
