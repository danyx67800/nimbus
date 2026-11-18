import { api } from '../api.js';
import { t } from '../i18n.js';
import {
  confirmDialog,
  emptyState,
  h,
  icon,
  type MenuItem,
  openModal,
  promptDialog,
  relativeTime,
  showMenu,
  toast,
} from '../ui.js';
import type { View } from './types.js';

const STATUS_ORDER = ['todo', 'doing', 'done'] as const;
type BoardStatus = (typeof STATUS_ORDER)[number];

interface BoardTask {
  id: string;
  cardId: string;
  title: string;
  status: BoardStatus;
  done: boolean;
  notes: string;
  position: number;
  createdAt: number;
  updatedAt: number;
}

interface BoardCard {
  id: string;
  columnId: string;
  title: string;
  description: string;
  status: BoardStatus;
  position: number;
  createdAt: number;
  updatedAt: number;
  tasks: BoardTask[];
}

interface BoardColumn {
  id: string;
  title: string;
  position: number;
  createdAt: number;
  updatedAt: number;
  cards: BoardCard[];
}

interface BoardResponse {
  columns: BoardColumn[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : t('common.error');
}

function statusLabel(status: BoardStatus): string {
  return t(`board.status.${status}`);
}

function statusColor(status: BoardStatus): string {
  if (status === 'done') return 'var(--success)';
  if (status === 'doing') return 'var(--warning)';
  return 'var(--muted)';
}

function createStatusPill(
  initial: BoardStatus,
  onChange: (next: BoardStatus) => boolean | Promise<boolean> | undefined,
  options: { label: string; compact?: boolean } = { label: t('board.cardStatus') },
): HTMLButtonElement {
  let current = initial;
  const label = h('span', { class: 'status-pill-label', text: statusLabel(current) });
  const button = h(
    'button',
    {
      type: 'button',
      class: `status-pill${options.compact ? ' compact' : ''} status-${current}`,
      'aria-label': `${options.label}: ${statusLabel(current)}`,
      'aria-haspopup': 'menu',
      onclick: (event: MouseEvent) => {
        event.stopPropagation();
        showMenu(
          button,
          STATUS_ORDER.map((status) => ({
            label: statusLabel(status),
            dotColor: statusColor(status),
            selected: status === current,
            onClick: async () => {
              if (status === current) return;
              const result = await onChange(status);
              if (result === false) return;
              current = status;
              button.className = `status-pill${options.compact ? ' compact' : ''} status-${current}`;
              label.textContent = statusLabel(current);
              button.setAttribute('aria-label', `${options.label}: ${statusLabel(current)}`);
            },
          })),
        );
      },
    },
    h('span', { class: 'status-pill-dot', 'aria-hidden': 'true' }),
    label,
    icon('chevronDown', 12),
  );
  return button;
}

export function renderBoard(): View {
  let columns: BoardColumn[] = [];
  let loading = true;
  let failed = false;
  let disposed = false;
  let dragCardId: string | null = null;
  let placeholder: HTMLElement | null = null;

  const boardEl = h('div', { class: 'board', 'aria-busy': 'true' });
  const page = h('div', { class: 'stack board-page' });

  async function load(): Promise<void> {
    try {
      const response = await api<BoardResponse>('/api/board');
      if (disposed) return;
      columns = response.columns;
      failed = false;
    } catch (error) {
      if (disposed) return;
      failed = true;
      toast(errorMessage(error), 'error');
    } finally {
      loading = false;
      if (!disposed) {
        boardEl.setAttribute('aria-busy', 'false');
        render();
      }
    }
  }

  async function mutate(task: () => Promise<unknown>, success?: string): Promise<boolean> {
    try {
      await task();
      if (success) toast(success, 'success');
      await load();
      return true;
    } catch (error) {
      toast(errorMessage(error), 'error');
      return false;
    }
  }

  async function createColumn(): Promise<void> {
    const title = await promptDialog({
      title: t('board.newColumn'),
      label: t('board.columnName'),
      placeholder: t('board.columnPlaceholder'),
      confirmLabel: t('common.create'),
    });
    if (!title) return;
    await mutate(() => api('/api/board/columns', { method: 'POST', body: { title } }), t('board.columnCreated'));
  }

  async function renameColumn(column: BoardColumn): Promise<void> {
    const title = await promptDialog({
      title: t('board.renameColumn'),
      label: t('board.columnName'),
      value: column.title,
      confirmLabel: t('common.save'),
    });
    if (!title || title === column.title) return;
    await mutate(
      () => api(`/api/board/columns/${encodeURIComponent(column.id)}`, { method: 'PATCH', body: { title } }),
      t('common.saved'),
    );
  }

  async function deleteColumn(column: BoardColumn): Promise<void> {
    const confirmed = await confirmDialog({
      title: t('board.deleteColumn'),
      message: t('board.deleteColumnText', { name: column.title }),
      confirmLabel: t('common.delete'),
      danger: true,
    });
    if (!confirmed) return;
    await mutate(
      () => api(`/api/board/columns/${encodeURIComponent(column.id)}`, { method: 'DELETE' }),
      t('board.columnDeleted'),
    );
  }

  async function moveColumn(column: BoardColumn, direction: -1 | 1): Promise<void> {
    const index = columns.findIndex((entry) => entry.id === column.id);
    const position = index + direction;
    if (position < 0 || position >= columns.length) return;
    await mutate(() =>
      api(`/api/board/columns/${encodeURIComponent(column.id)}`, { method: 'PATCH', body: { position } }),
    );
  }

  async function moveCard(cardId: string, columnId: string, position: number): Promise<void> {
    await mutate(() =>
      api(`/api/board/cards/${encodeURIComponent(cardId)}`, { method: 'PATCH', body: { columnId, position } }),
    );
  }

  async function deleteCard(card: BoardCard): Promise<void> {
    const confirmed = await confirmDialog({
      title: t('board.deleteCard'),
      message: t('board.deleteCardText', { name: card.title }),
      confirmLabel: t('common.delete'),
      danger: true,
    });
    if (!confirmed) return;
    await mutate(
      () => api(`/api/board/cards/${encodeURIComponent(card.id)}`, { method: 'DELETE' }),
      t('board.cardDeleted'),
    );
  }

  function openCardEditor(card: BoardCard): void {
    const titleInput = h('input', {
      class: 'input board-editor-title',
      value: card.title,
      maxlength: '200',
      placeholder: t('board.cardTitle'),
    });
    const description = h('textarea', {
      class: 'input board-description-input',
      rows: '5',
      maxlength: '4000',
      placeholder: t('board.descriptionPlaceholder'),
    });
    description.value = card.description;
    const tasks = card.tasks.map((task) => ({ ...task }));
    const checklist = h('div', { class: 'board-checklist' });
    const countLabel = h('strong', { class: 'board-editor-count' });
    const progressRingLabel = h('span');
    const progressRing = h('span', { class: 'board-progress-ring' }, progressRingLabel);
    const progressBar = h('i');
    const checklistTrack = h('div', { class: 'board-checklist-track' }, progressBar);
    const addTaskInput = h('input', {
      class: 'input board-task-input',
      maxlength: '200',
      placeholder: t('board.taskPlaceholder'),
      'aria-label': t('board.taskPlaceholder'),
    });
    const addTaskButton = h(
      'button',
      {
        type: 'button',
        class: 'btn small primary board-task-add',
        'aria-label': t('board.addTask'),
        title: t('board.addTask'),
      },
      icon('plus', 15),
    );
    let adding = false;

    const refreshBoard = (): void => {
      void load();
    };

    const openTaskNotes = (item: BoardTask, anchor: HTMLButtonElement): void => {
      let savedNotes = item.notes;
      let noteTimer: number | null = null;
      let noteSaving = false;
      let pendingNoteSave = false;
      const notesInput = h('textarea', {
        class: 'board-notes-area',
        maxlength: '8000',
        placeholder: t('board.taskNotesPlaceholder'),
        'aria-label': t('board.taskNotes'),
      });
      notesInput.value = item.notes;
      const notesStatus = h('span', { class: 'board-notes-status', 'aria-live': 'polite' });
      const setNotesStatus = (state: 'idle' | 'saving' | 'saved' | 'dirty'): void => {
        notesStatus.className = `board-notes-status ${state}`;
        notesStatus.textContent =
          state === 'saving'
            ? t('board.taskNoteSaving')
            : state === 'saved'
              ? t('board.taskNoteSaved')
              : state === 'dirty'
                ? t('board.taskNoteUnsaved')
                : '';
      };
      const saveNotes = async (): Promise<void> => {
        if (noteTimer !== null) {
          window.clearTimeout(noteTimer);
          noteTimer = null;
        }
        const value = notesInput.value;
        if (value === savedNotes) return;
        if (noteSaving) {
          pendingNoteSave = true;
          return;
        }
        noteSaving = true;
        setNotesStatus('saving');
        let saved = false;
        try {
          const response = await api<{ task: BoardTask }>(
            `/api/board/cards/${encodeURIComponent(card.id)}/tasks/${encodeURIComponent(item.id)}`,
            { method: 'PATCH', body: { notes: value } },
          );
          item.notes = response.task.notes;
          savedNotes = response.task.notes;
          if (notesInput.value === value) notesInput.value = response.task.notes;
          anchor.classList.toggle('has-notes', response.task.notes.length > 0);
          setNotesStatus('saved');
          saved = true;
          refreshBoard();
        } catch (error) {
          setNotesStatus('dirty');
          toast(errorMessage(error), 'error');
        } finally {
          noteSaving = false;
          if (saved && (pendingNoteSave || notesInput.value !== savedNotes)) {
            pendingNoteSave = false;
            void saveNotes();
          } else {
            pendingNoteSave = false;
          }
        }
      };
      notesInput.addEventListener('input', () => {
        setNotesStatus('dirty');
        if (noteTimer !== null) window.clearTimeout(noteTimer);
        noteTimer = window.setTimeout(() => {
          noteTimer = null;
          void saveNotes();
        }, 700);
      });
      notesInput.addEventListener('blur', () => void saveNotes());
      openModal({
        title: t('board.taskNotes'),
        className: 'board-notes-modal',
        body: h(
          'div',
          { class: 'board-notes-app' },
          h(
            'div',
            { class: 'board-notes-context' },
            h('span', { text: t('board.checklist') }),
            h('span', { class: 'board-notes-context-sep', text: '·' }),
            h('strong', { text: card.title }),
          ),
          h('h2', { class: 'board-notes-task-title', text: item.title }),
          h(
            'div',
            { class: 'board-notes-canvas' },
            notesInput,
            h(
              'div',
              { class: 'board-notes-foot' },
              h('span', { class: 'board-notes-hint', text: t('board.taskNotesHint') }),
              notesStatus,
            ),
          ),
        ),
        onClose: () => void saveNotes(),
      });
      notesInput.focus();
      notesInput.setSelectionRange(notesInput.value.length, notesInput.value.length);
    };

    const renderChecklist = (): void => {
      checklist.replaceChildren();
      const done = tasks.filter((task) => task.done).length;
      const total = tasks.length;
      const percent = total === 0 ? 0 : Math.round((done / total) * 100);
      countLabel.textContent = total === 0 ? t('board.noTasksShort') : t('board.completedShort', { done, total });
      progressRing.style.setProperty('--value', `${percent}%`);
      progressRingLabel.textContent = `${percent}%`;
      progressBar.style.width = `${percent}%`;
      if (tasks.length === 0) checklist.append(h('p', { class: 'board-checklist-empty', text: t('board.noTasks') }));
      for (const item of tasks) {
        const statusPill = createStatusPill(
          item.status,
          async (next) => {
            try {
              await api(`/api/board/cards/${encodeURIComponent(card.id)}/tasks/${encodeURIComponent(item.id)}`, {
                method: 'PATCH',
                body: { status: next },
              });
              item.status = next;
              item.done = next === 'done';
              renderChecklist();
              refreshBoard();
              return true;
            } catch (error) {
              toast(errorMessage(error), 'error');
              return false;
            }
          },
          { compact: true, label: t('board.taskStatus') },
        );
        const remove = h(
          'button',
          {
            type: 'button',
            class: 'icon-btn board-task-remove',
            'aria-label': t('board.deleteTask'),
            title: t('board.deleteTask'),
            onclick: async () => {
              try {
                await api(`/api/board/cards/${encodeURIComponent(card.id)}/tasks/${encodeURIComponent(item.id)}`, {
                  method: 'DELETE',
                });
                const index = tasks.findIndex((entry) => entry.id === item.id);
                if (index >= 0) tasks.splice(index, 1);
                renderChecklist();
                refreshBoard();
              } catch (error) {
                toast(errorMessage(error), 'error');
              }
            },
          },
          icon('trash', 14),
        );
        const notesToggle = h(
          'button',
          {
            type: 'button',
            class: `icon-btn board-task-notes-toggle${item.notes ? ' has-notes' : ''}`,
            'aria-label': `${t('board.openTaskNotes')}: ${item.title}`,
            title: t('board.openTaskNotes'),
            'aria-haspopup': 'dialog',
            onclick: () => openTaskNotes(item, notesToggle),
          },
          icon('chevron', 14),
        );
        checklist.append(
          h(
            'div',
            { class: `board-task status-${item.status}` },
            statusPill,
            h('span', { class: 'board-task-title', text: item.title }),
            notesToggle,
            remove,
          ),
        );
      }
    };

    const addTask = async (): Promise<void> => {
      const title = addTaskInput.value.trim();
      if (!title || adding) return;
      adding = true;
      addTaskButton.disabled = true;
      try {
        const response = await api<{ task: BoardTask }>(`/api/board/cards/${encodeURIComponent(card.id)}/tasks`, {
          method: 'POST',
          body: { title },
        });
        tasks.push(response.task);
        addTaskInput.value = '';
        renderChecklist();
        refreshBoard();
      } catch (error) {
        toast(errorMessage(error), 'error');
      } finally {
        adding = false;
        addTaskButton.disabled = false;
      }
    };
    addTaskButton.addEventListener('click', () => void addTask());
    addTaskInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void addTask();
      }
    });
    renderChecklist();

    const statusPill = createStatusPill(
      card.status,
      (next) =>
        mutate(() =>
          api(`/api/board/cards/${encodeURIComponent(card.id)}`, { method: 'PATCH', body: { status: next } }),
        ),
      { label: t('board.cardStatus') },
    );

    const modal = openModal({
      title: t('board.editCard'),
      wide: true,
      className: 'board-card-modal',
      body: h(
        'div',
        { class: 'board-editor' },
        h(
          'div',
          { class: 'board-editor-main' },
          h(
            'div',
            { class: 'board-editor-meta' },
            statusPill,
            h('span', { class: 'board-editor-hint', text: t('board.cardStatusHint') }),
          ),
          h(
            'div',
            { class: 'field board-editor-field' },
            h('label', { class: 'board-editor-kicker', text: t('board.cardTitle') }),
            titleInput,
          ),
          h(
            'div',
            { class: 'field board-editor-field' },
            h('label', { class: 'board-editor-kicker', text: t('board.cardDescription') }),
            description,
          ),
        ),
        h(
          'aside',
          { class: 'board-editor-side' },
          h(
            'div',
            { class: 'board-editor-checklist' },
            h(
              'div',
              { class: 'board-editor-section-head' },
              h(
                'div',
                { class: 'board-editor-section-copy' },
                h('span', { class: 'board-editor-kicker', text: t('board.checklist') }),
                countLabel,
              ),
              progressRing,
            ),
            checklistTrack,
            checklist,
            h('div', { class: 'board-task-composer' }, addTaskInput, addTaskButton),
            h('p', { class: 'board-checklist-hint', text: t('board.tasksAutosave') }),
          ),
        ),
      ),
      actions: [
        { label: t('common.cancel') },
        {
          label: t('common.save'),
          kind: 'primary',
          close: false,
          onClick: async () => {
            const title = titleInput.value.trim();
            if (!title) {
              titleInput.focus();
              return;
            }
            const saved = await mutate(
              () =>
                api(`/api/board/cards/${encodeURIComponent(card.id)}`, {
                  method: 'PATCH',
                  body: { title, description: description.value },
                }),
              t('common.saved'),
            );
            if (saved) modal.close();
          },
        },
      ],
    });
    titleInput.focus();
    titleInput.select();
  }

  function openComposer(column: BoardColumn): void {
    const list = boardEl.querySelector<HTMLElement>(`.board-cards[data-column-id="${column.id}"]`);
    if (!list) return;
    list.querySelector('.board-composer')?.remove();
    const input = h('textarea', {
      class: 'input board-composer-input',
      rows: '2',
      maxlength: '200',
      placeholder: t('board.cardPlaceholder'),
      'aria-label': t('board.cardPlaceholder'),
    });
    const submit = h('button', { type: 'button', class: 'btn small primary' }, icon('plus', 14), t('board.addCard'));
    const cancel = h('button', { type: 'button', class: 'btn small', text: t('common.cancel') });
    const composer = h(
      'div',
      { class: 'board-composer' },
      input,
      h('div', { class: 'board-composer-actions' }, cancel, submit),
    );
    list.insertBefore(composer, list.querySelector('.board-add-card'));
    input.focus();
    let saving = false;
    const create = async (): Promise<void> => {
      const title = input.value.trim();
      if (!title || saving) return;
      saving = true;
      submit.disabled = true;
      const created = await mutate(() =>
        api('/api/board/cards', { method: 'POST', body: { columnId: column.id, title } }),
      );
      saving = false;
      submit.disabled = false;
      if (created) composer.remove();
    };
    submit.addEventListener('click', () => void create());
    cancel.addEventListener('click', () => composer.remove());
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void create();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        composer.remove();
      }
    });
  }

  function openCardMenu(anchor: HTMLElement, card: BoardCard, column: BoardColumn): void {
    const columnIndex = columns.findIndex((entry) => entry.id === column.id);
    const cardIndex = column.cards.findIndex((entry) => entry.id === card.id);
    const previousColumn = columnIndex > 0 ? columns[columnIndex - 1] : undefined;
    const nextColumn = columnIndex >= 0 && columnIndex < columns.length - 1 ? columns[columnIndex + 1] : undefined;
    const items: MenuItem[] = [{ label: t('board.editCard'), onClick: () => openCardEditor(card) }];
    if (cardIndex > 0) {
      items.push({
        label: t('board.moveUp'),
        onClick: () => void moveCard(card.id, column.id, cardIndex - 1),
      });
    }
    if (cardIndex >= 0 && cardIndex < column.cards.length - 1) {
      items.push({
        label: t('board.moveDown'),
        onClick: () => void moveCard(card.id, column.id, cardIndex + 1),
      });
    }
    if (previousColumn) {
      items.push({
        label: t('board.movePrevColumn'),
        onClick: () => void moveCard(card.id, previousColumn.id, previousColumn.cards.length),
      });
    }
    if (nextColumn) {
      items.push({
        label: t('board.moveNextColumn'),
        onClick: () => void moveCard(card.id, nextColumn.id, nextColumn.cards.length),
      });
    }
    items.push({
      label: t('board.deleteCard'),
      iconName: 'trash',
      danger: true,
      onClick: () => deleteCard(card),
    });
    showMenu(anchor, items);
  }

  function openColumnMenu(anchor: HTMLElement, column: BoardColumn): void {
    const index = columns.findIndex((entry) => entry.id === column.id);
    const items: MenuItem[] = [{ label: t('board.renameColumn'), onClick: () => renameColumn(column) }];
    if (index > 0) {
      items.push({
        label: t('board.moveLeft'),
        iconName: 'arrowLeft',
        onClick: () => void moveColumn(column, -1),
      });
    }
    if (index >= 0 && index < columns.length - 1) {
      items.push({
        label: t('board.moveRight'),
        iconName: 'arrow',
        onClick: () => void moveColumn(column, 1),
      });
    }
    items.push({
      label: t('board.deleteColumn'),
      iconName: 'trash',
      danger: true,
      onClick: () => deleteColumn(column),
    });
    showMenu(anchor, items);
  }

  function insertionIndex(cards: HTMLElement[], clientY: number): number {
    for (let index = 0; index < cards.length; index += 1) {
      const rect = cards[index]!.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return index;
    }
    return cards.length;
  }

  function clearDropIndicators(): void {
    placeholder?.remove();
    placeholder = null;
    for (const element of boardEl.querySelectorAll('.board-column')) element.classList.remove('drop-target');
  }

  function attachDropTarget(container: HTMLElement, column: BoardColumn): void {
    container.addEventListener('dragover', (event) => {
      if (!dragCardId) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      container.closest('.board-column')?.classList.add('drop-target');
      if (!placeholder) placeholder = h('div', { class: 'board-card-placeholder', 'aria-hidden': 'true' });
      const cards = [...container.querySelectorAll<HTMLElement>('.board-card')].filter(
        (element) => element.dataset.cardId !== dragCardId,
      );
      container.insertBefore(
        placeholder,
        cards[insertionIndex(cards, event.clientY)] ?? container.querySelector('.board-add-card'),
      );
    });
    container.addEventListener('dragleave', (event) => {
      const next = event.relatedTarget as Node | null;
      if (next && container.contains(next)) return;
      container.closest('.board-column')?.classList.remove('drop-target');
      placeholder?.remove();
      placeholder = null;
    });
    container.addEventListener('drop', (event) => {
      if (!dragCardId) return;
      event.preventDefault();
      const cardId = dragCardId;
      const cards = [...container.querySelectorAll<HTMLElement>('.board-card')].filter(
        (element) => element.dataset.cardId !== dragCardId,
      );
      const position = insertionIndex(cards, event.clientY);
      dragCardId = null;
      clearDropIndicators();
      void moveCard(cardId, column.id, position);
    });
  }

  function renderCard(card: BoardCard, column: BoardColumn): HTMLElement {
    const menuButton = h(
      'button',
      {
        type: 'button',
        class: 'icon-btn board-card-menu',
        'aria-label': t('board.cardMenu'),
        title: t('board.cardMenu'),
        onclick: (event: MouseEvent) => {
          event.stopPropagation();
          openCardMenu(menuButton, card, column);
        },
      },
      icon('more', 16),
    );
    const statusPill = createStatusPill(
      card.status,
      (next) =>
        mutate(() =>
          api(`/api/board/cards/${encodeURIComponent(card.id)}`, { method: 'PATCH', body: { status: next } }),
        ),
      { label: t('board.cardStatus') },
    );
    const doneTasks = card.tasks.filter((task) => task.done).length;
    const totalTasks = card.tasks.length;
    const taskProgress =
      totalTasks > 0
        ? h(
            'div',
            { class: 'board-card-tasks', title: t('board.taskProgress', { done: doneTasks, total: totalTasks }) },
            icon('check', 12),
            h('span', { text: `${doneTasks}/${totalTasks}` }),
            h('i', { style: { '--task-progress': `${Math.round((doneTasks / totalTasks) * 100)}%` } }),
          )
        : null;
    const element = h(
      'article',
      {
        class: 'board-card',
        draggable: 'true',
        tabindex: '0',
        'data-card-id': card.id,
        'aria-label': card.title,
        onclick: (event: MouseEvent) => {
          if ((event.target as Element).closest('button, select, input, textarea, a')) return;
          openCardEditor(card);
        },
        onkeydown: (event: KeyboardEvent) => {
          if (event.target !== element) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openCardEditor(card);
          }
        },
        ondragstart: (event: DragEvent) => {
          dragCardId = card.id;
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', card.id);
          }
          requestAnimationFrame(() => element.classList.add('is-dragging'));
        },
        ondragend: () => {
          dragCardId = null;
          element.classList.remove('is-dragging');
          clearDropIndicators();
        },
      },
      h('div', { class: 'board-card-top' }, statusPill, menuButton),
      h('strong', { class: 'board-card-title', text: card.title }),
      card.description ? h('p', { class: 'board-card-desc', text: card.description }) : null,
      h(
        'div',
        { class: 'board-card-footer' },
        h('div', { class: 'board-card-meta' }, icon('clock', 12), h('span', { text: relativeTime(card.updatedAt) })),
        taskProgress,
      ),
    );
    return element;
  }

  function renderColumn(column: BoardColumn, index: number): HTMLElement {
    const menuButton = h(
      'button',
      {
        type: 'button',
        class: 'icon-btn',
        'aria-label': t('board.columnMenu'),
        title: t('board.columnMenu'),
        onclick: (event: MouseEvent) => {
          event.stopPropagation();
          openColumnMenu(menuButton, column);
        },
      },
      icon('more', 16),
    );
    const cards = h('div', { class: 'board-cards', dataset: { columnId: column.id } });
    for (const card of column.cards) cards.append(renderCard(card, column));
    cards.append(
      h(
        'button',
        { type: 'button', class: 'board-add-card', onclick: () => openComposer(column) },
        icon('plus', 15),
        h('span', { text: t('board.addCard') }),
      ),
    );
    attachDropTarget(cards, column);
    return h(
      'section',
      { class: `board-column tone-${index % 5}`, 'aria-label': column.title },
      h(
        'div',
        { class: 'board-column-head' },
        h('span', { class: 'board-column-dot', 'aria-hidden': 'true' }),
        h('h2', { text: column.title }),
        h('span', { class: 'board-column-count', text: String(column.cards.length) }),
        menuButton,
      ),
      cards,
    );
  }

  function render(): void {
    clearDropIndicators();
    boardEl.replaceChildren();
    boardEl.classList.toggle('is-empty', !loading && !failed && columns.length === 0);
    if (loading) {
      boardEl.append(h('div', { class: 'board-status', role: 'status' }, icon('kanban', 19), t('common.loading')));
      return;
    }
    if (failed) {
      boardEl.append(
        h(
          'div',
          { class: 'board-status', role: 'alert' },
          icon('cloud', 19),
          h('span', { text: t('board.loadError') }),
          h(
            'button',
            {
              type: 'button',
              class: 'btn small',
              onclick: () => {
                loading = true;
                failed = false;
                render();
                void load();
              },
            },
            t('common.retry'),
          ),
        ),
      );
      return;
    }
    if (columns.length === 0) {
      boardEl.append(
        emptyState(
          'kanban',
          t('board.emptyTitle'),
          t('board.emptyText'),
          h(
            'button',
            { type: 'button', class: 'btn primary', onclick: () => void createColumn() },
            icon('plus', 16),
            t('board.newColumn'),
          ),
        ),
      );
      return;
    }
    columns.forEach((column, index) => {
      boardEl.append(renderColumn(column, index));
    });
    boardEl.append(
      h(
        'button',
        { type: 'button', class: 'board-add-column', onclick: () => void createColumn() },
        icon('plus', 17),
        h('span', { text: t('board.newColumn') }),
      ),
    );
  }

  const head = h(
    'div',
    { class: 'page-head' },
    h(
      'div',
      { class: 'grow' },
      h('h1', { text: t('board.title') }),
      h('p', { class: 'sub', text: t('board.subtitle') }),
    ),
    h(
      'div',
      { class: 'actions' },
      h(
        'button',
        { type: 'button', class: 'btn primary', onclick: () => void createColumn() },
        icon('plus', 16),
        t('board.newColumn'),
      ),
    ),
  );
  page.append(head, boardEl);
  render();
  void load();

  return {
    node: page,
    destroy: () => {
      disposed = true;
      clearDropIndicators();
    },
  };
}
