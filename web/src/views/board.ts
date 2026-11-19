import { api, downloadUrl } from '../api.js';
import { events, on } from '../bus.js';
import { t } from '../i18n.js';
import { navigate } from '../router.js';
import { state } from '../store.js';
import {
  avatarEl,
  confirmDialog,
  emptyState,
  formatBytes,
  formatDate,
  h,
  icon,
  type MenuItem,
  openModal,
  promptDialog,
  relativeTime,
  showMenu,
  toast,
} from '../ui.js';
import { uploadAndWait } from '../uploads.js';
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

interface BoardLabel {
  id: string;
  name: string;
  color: string;
}

interface BoardMember {
  id: string;
  username: string;
  displayName: string;
  role: 'owner' | 'member';
  status?: string;
}

interface BoardAttachment {
  id: string;
  fileId: string;
  name: string;
  mime: string;
  size: number;
  createdAt: number;
  createdBy: string;
  isImage: boolean;
}

interface BoardComment {
  id: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  author: { id: string; username: string; displayName: string };
}

interface BoardCard {
  id: string;
  columnId: string;
  title: string;
  description: string;
  status: BoardStatus;
  dueAt: number | null;
  dueComplete: boolean;
  coverFileId: string | null;
  position: number;
  createdAt: number;
  updatedAt: number;
  tasks: BoardTask[];
  labels: BoardLabel[];
  assignees: BoardMember[];
  commentCount: number;
  attachmentCount: number;
  comments?: BoardComment[];
  attachments?: BoardAttachment[];
}

interface BoardColumn {
  id: string;
  title: string;
  position: number;
  createdAt: number;
  updatedAt: number;
  cards: BoardCard[];
}

interface BoardProject {
  id: string;
  ownerId: string;
  name: string;
  description: string;
  role: 'owner' | 'member';
  chatRoomId: string | null;
  memberCount: number;
  createdAt: number;
  updatedAt: number;
}

interface BoardResponse {
  project: BoardProject;
  projects: BoardProject[];
  members: BoardMember[];
  labels: BoardLabel[];
  columns: BoardColumn[];
}

const LABEL_COLORS = ['#8f6cf5', '#5fd3b2', '#ffcf5c', '#ff9b71', '#f48fb1', '#7cc5f5'];

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

function dateTimeLocal(value: number): string {
  const date = new Date(value);
  const pad = (part: number): string => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function readableLabelColor(color: string): string {
  const value = color.replace('#', '');
  if (value.length !== 6) return '#fff';
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#241c35' : '#fff';
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

export function renderBoard(options: { projectId?: string; cardId?: string } = {}): View {
  let columns: BoardColumn[] = [];
  let project: BoardProject | null = null;
  let projects: BoardProject[] = [];
  let members: BoardMember[] = [];
  let labels: BoardLabel[] = [];
  let currentProjectId = options.projectId ?? null;
  let pendingCardId = options.cardId ?? null;
  let loading = true;
  let failed = false;
  let disposed = false;
  let dragCardId: string | null = null;
  let placeholder: HTMLElement | null = null;
  let refreshMemberRows: (() => void) | null = null;

  const projectNameEl = h('h1', { text: t('board.title') });
  const projectDescriptionEl = h('p', { class: 'sub', text: t('board.subtitle') });
  const projectPickerName = h('span', { text: t('board.title') });
  const chatBadge = h('span', { class: 'board-unread', hidden: true });
  const projectPicker = h(
    'button',
    {
      type: 'button',
      class: 'board-project-picker',
      'aria-label': t('board.projects'),
      'aria-haspopup': 'menu',
      onclick: (event: MouseEvent) => {
        event.stopPropagation();
        openProjectPicker(projectPicker);
      },
    },
    icon('kanban', 14),
    projectPickerName,
    icon('chevronDown', 12),
  );
  const chatButton = h(
    'button',
    {
      type: 'button',
      class: 'btn small board-chat-button',
      'aria-label': t('board.projectChat'),
      disabled: true,
      onclick: () => {
        if (project?.chatRoomId) navigate(`/chat/${encodeURIComponent(project.chatRoomId)}`);
      },
    },
    icon('chat', 15),
    h('span', { text: t('board.projectChat') }),
    chatBadge,
  );
  const membersButton = h(
    'button',
    {
      type: 'button',
      class: 'btn small board-members-button',
      'aria-label': t('board.members'),
      disabled: true,
      onclick: () => openMembers(),
    },
    icon('users', 15),
    h('span', { class: 'board-members-label' }),
  );
  const projectMenuButton = h(
    'button',
    {
      type: 'button',
      class: 'icon-btn board-project-menu',
      'aria-label': t('board.projectMenu'),
      title: t('board.projectMenu'),
      hidden: true,
      onclick: () => openProjectMenu(projectMenuButton),
    },
    icon('more', 18),
  );

  const boardEl = h('div', { class: 'board', 'aria-busy': 'true' });
  const page = h('div', { class: 'stack board-page' });

  function openProjectPicker(anchor: HTMLElement): void {
    const items: MenuItem[] = projects.map((entry) => ({
      label: entry.name,
      iconName: 'kanban',
      selected: entry.id === project?.id,
      onClick: () => {
        if (entry.id !== project?.id) navigate(`/board?project=${encodeURIComponent(entry.id)}`);
      },
    }));
    items.push({
      label: t('board.newProject'),
      iconName: 'plus',
      onClick: () => void createProject(),
    });
    showMenu(anchor, items);
  }

  function openProjectMenu(anchor: HTMLElement): void {
    if (!project) return;
    const items: MenuItem[] = [];
    if (project.role === 'owner') {
      items.push({ label: t('board.projectSettings'), iconName: 'settings', onClick: () => openProjectSettings() });
    }
    items.push({ label: t('board.manageLabels'), iconName: 'tag', onClick: () => openLabelsManager() });
    items.push({
      label: t('board.newProject'),
      iconName: 'plus',
      onClick: () => void createProject(),
    });
    if (project.role === 'owner') {
      items.push({
        label: t('board.deleteProject'),
        iconName: 'trash',
        danger: true,
        onClick: () => void deleteProject(),
      });
    }
    showMenu(anchor, items);
  }

  function syncUrl(): void {
    if (!currentProjectId) return;
    const url = new URL(location.href);
    if (url.searchParams.get('project') !== currentProjectId) {
      url.searchParams.set('project', currentProjectId);
      history.replaceState(null, '', `${url.pathname}${url.search}`);
    }
  }

  function clearCardParam(): void {
    const url = new URL(location.href);
    if (!url.searchParams.has('card')) return;
    url.searchParams.delete('card');
    history.replaceState(null, '', `${url.pathname}${url.search}`);
  }

  function renderHeader(): void {
    projectNameEl.textContent = project?.name ?? t('board.title');
    projectDescriptionEl.textContent = project?.description || t('board.subtitle');
    projectPickerName.textContent = project?.name ?? t('board.title');
    const chatRoomId = project?.chatRoomId ?? null;
    const unread = chatRoomId ? (state.rooms.find((room) => room.id === chatRoomId)?.unread ?? 0) : 0;
    chatBadge.textContent = String(unread);
    chatBadge.hidden = unread === 0;
    chatButton.disabled = !project?.chatRoomId;
    membersButton.disabled = !project;
    const memberLabel = project
      ? members.length === 1
        ? t('board.oneMember')
        : t('board.memberCount', { n: members.length })
      : t('board.members');
    const label = membersButton.querySelector('.board-members-label');
    if (label) label.textContent = memberLabel;
    membersButton.setAttribute('aria-label', memberLabel);
    projectMenuButton.hidden = !project;
    projectPicker.hidden = !project;
    projectPicker.disabled = !project;
  }

  async function load(): Promise<void> {
    try {
      const suffix = currentProjectId ? `?project=${encodeURIComponent(currentProjectId)}` : '';
      const response = await api<BoardResponse>(`/api/board${suffix}`);
      if (disposed) return;
      project = response.project;
      projects = response.projects;
      members = response.members;
      labels = response.labels;
      columns = response.columns;
      currentProjectId = response.project.id;
      syncUrl();
      failed = false;
    } catch (error) {
      if (disposed) return;
      failed = true;
      toast(errorMessage(error), 'error');
    } finally {
      loading = false;
      if (!disposed) {
        renderHeader();
        boardEl.setAttribute('aria-busy', 'false');
        render();
        if (pendingCardId && !failed) {
          const target = columns.flatMap((column) => column.cards).find((card) => card.id === pendingCardId);
          pendingCardId = null;
          if (target) {
            clearCardParam();
            void openCardEditor(target);
          } else {
            toast(t('board.cardNotFound'), 'error');
          }
        }
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

  async function createProject(): Promise<void> {
    const name = await promptDialog({
      title: t('board.newProject'),
      label: t('board.projectName'),
      placeholder: t('board.projectNamePlaceholder'),
      confirmLabel: t('common.create'),
    });
    if (!name) return;
    try {
      const response = await api<{ project: BoardProject }>('/api/projects', {
        method: 'POST',
        body: { name },
      });
      toast(t('board.projectCreated'), 'success');
      navigate(`/board?project=${encodeURIComponent(response.project.id)}`);
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  function openProjectSettings(): void {
    if (!project) return;
    const name = h('input', { class: 'input', maxlength: '80', value: project.name });
    const description = h('textarea', {
      class: 'input board-description-input',
      maxlength: '4000',
      rows: '4',
      placeholder: t('board.projectDescriptionPlaceholder'),
    });
    description.value = project.description;
    const modal = openModal({
      title: t('board.projectSettings'),
      body: h(
        'div',
        { class: 'stack' },
        h('div', { class: 'field' }, h('label', { text: t('board.projectName') }), name),
        h('div', { class: 'field' }, h('label', { text: t('board.projectDescription') }), description),
        h(
          'button',
          {
            type: 'button',
            class: 'btn small',
            onclick: () => {
              modal.close();
              openMembers();
            },
          },
          icon('users', 14),
          t('board.manageMembers'),
        ),
      ),
      actions: [
        { label: t('common.cancel') },
        {
          label: t('common.save'),
          kind: 'primary',
          close: false,
          onClick: async () => {
            const nextName = name.value.trim();
            if (!nextName) {
              name.focus();
              return;
            }
            await api(`/api/projects/${encodeURIComponent(project?.id ?? '')}`, {
              method: 'PATCH',
              body: { name: nextName, description: description.value },
            });
            toast(t('common.saved'), 'success');
            modal.close();
            await load();
          },
        },
      ],
    });
  }

  async function deleteProject(): Promise<void> {
    if (!project) return;
    const confirmed = await confirmDialog({
      title: t('board.deleteProject'),
      message: t('board.deleteProjectText', { name: project.name }),
      confirmLabel: t('common.delete'),
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' });
      toast(t('board.projectDeleted'), 'success');
      navigate('/board', { replace: true });
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  function openMembers(): void {
    if (!project) return;
    const currentProject = project;
    const list = h('div', { class: 'board-member-list' });
    const renderMemberRows = (): void => {
      list.replaceChildren();
      for (const member of members) {
        const remove =
          currentProject.role === 'owner' && member.id !== currentProject.ownerId
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'icon-btn danger-ghost',
                  'aria-label': t('board.removeMember'),
                  title: t('board.removeMember'),
                  onclick: async () => {
                    const confirmed = await confirmDialog({
                      title: t('board.removeMember'),
                      message: t('board.removeMemberText', { name: member.displayName }),
                      confirmLabel: t('common.remove'),
                      danger: true,
                    });
                    if (!confirmed) return;
                    try {
                      await api(
                        `/api/projects/${encodeURIComponent(project?.id ?? '')}/members/${encodeURIComponent(member.id)}`,
                        { method: 'DELETE' },
                      );
                      toast(t('board.memberRemoved'), 'success');
                      modal.close();
                      await load();
                    } catch (error) {
                      toast(errorMessage(error), 'error');
                    }
                  },
                },
                icon('close', 14),
              )
            : null;
        list.append(
          h(
            'div',
            { class: 'board-member-row' },
            avatarEl(member, { size: 'sm' }),
            h(
              'div',
              { class: 'board-member-copy' },
              h('strong', { text: member.displayName }),
              h('span', { text: `@${member.username} · ${t(`board.role.${member.role}`)}` }),
            ),
            remove,
          ),
        );
      }
    };
    renderMemberRows();

    const body = h('div', { class: 'stack' }, list);
    if (project.role === 'owner') {
      const candidates = state.contacts.filter(
        (contact) => !contact.blocked && !members.some((member) => member.id === contact.id),
      );
      const addList = h('div', { class: 'board-member-list' });
      for (const contact of candidates) {
        addList.append(
          h(
            'div',
            { class: 'board-member-row' },
            avatarEl(contact, { size: 'sm' }),
            h(
              'div',
              { class: 'board-member-copy' },
              h('strong', { text: contact.displayName }),
              h('span', { text: `@${contact.username}` }),
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'btn small primary',
                onclick: async () => {
                  try {
                    await api(`/api/projects/${encodeURIComponent(project?.id ?? '')}/members`, {
                      method: 'POST',
                      body: { userId: contact.id },
                    });
                    toast(t('board.memberAdded'), 'success');
                    modal.close();
                    await load();
                  } catch (error) {
                    toast(errorMessage(error), 'error');
                  }
                },
              },
              icon('plus', 13),
              t('board.addMember'),
            ),
          ),
        );
      }
      body.append(
        h('div', { class: 'board-member-section-title', text: t('board.addMember') }),
        candidates.length > 0 ? addList : h('p', { class: 'soft', text: t('board.noMoreMembers') }),
      );
    }
    const modal = openModal({
      title: t('board.members'),
      body,
      actions: [{ label: t('common.close') }],
      onClose: () => {
        if (refreshMemberRows === renderMemberRows) refreshMemberRows = null;
      },
    });
    refreshMemberRows = renderMemberRows;
  }

  function openLabelsManager(): void {
    if (!project) return;
    const list = h('div', { class: 'board-label-manager' });
    const nameInput = h('input', {
      class: 'input',
      maxlength: '40',
      placeholder: t('board.labelName'),
    });
    const colorInput = h('input', {
      type: 'color',
      class: 'board-color-input',
      value: LABEL_COLORS[labels.length % LABEL_COLORS.length] ?? '#8f6cf5',
      'aria-label': t('board.labelColor'),
    });
    const createButton = h(
      'button',
      { type: 'button', class: 'btn small primary' },
      icon('plus', 14),
      t('board.addLabel'),
    );
    const renderList = (): void => {
      list.replaceChildren();
      if (labels.length === 0) {
        list.append(h('p', { class: 'soft', text: t('board.noLabels') }));
        return;
      }
      for (const label of labels) {
        list.append(
          h(
            'div',
            { class: 'board-label-row' },
            h('span', { class: 'board-label-dot', style: { background: label.color } }),
            h('span', { class: 'board-label-name', text: label.name || t('board.untitledLabel') }),
            h(
              'button',
              {
                type: 'button',
                class: 'icon-btn danger-ghost',
                'aria-label': t('board.deleteLabel'),
                title: t('board.deleteLabel'),
                onclick: async () => {
                  try {
                    await api(
                      `/api/projects/${encodeURIComponent(project?.id ?? '')}/labels/${encodeURIComponent(label.id)}`,
                      { method: 'DELETE' },
                    );
                    labels = labels.filter((entry) => entry.id !== label.id);
                    renderList();
                    toast(t('board.labelDeleted'), 'success');
                    await load();
                  } catch (error) {
                    toast(errorMessage(error), 'error');
                  }
                },
              },
              icon('trash', 14),
            ),
          ),
        );
      }
    };
    const createLabel = async (): Promise<void> => {
      try {
        const response = await api<{ label: BoardLabel }>(
          `/api/projects/${encodeURIComponent(project?.id ?? '')}/labels`,
          {
            method: 'POST',
            body: { name: nameInput.value, color: colorInput.value },
          },
        );
        labels = [...labels, response.label];
        nameInput.value = '';
        colorInput.value = LABEL_COLORS[labels.length % LABEL_COLORS.length] ?? '#8f6cf5';
        renderList();
        toast(t('board.labelCreated'), 'success');
        await load();
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    };
    createButton.addEventListener('click', () => void createLabel());
    nameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void createLabel();
      }
    });
    renderList();
    openModal({
      title: t('board.manageLabels'),
      body: h(
        'div',
        { class: 'stack' },
        list,
        h('div', { class: 'board-label-create' }, nameInput, colorInput, createButton),
        h('p', { class: 'soft board-member-hint', text: t('board.labelsHint') }),
      ),
      actions: [{ label: t('common.close') }],
    });
  }

  async function createColumn(): Promise<void> {
    if (!project) return;
    const title = await promptDialog({
      title: t('board.newColumn'),
      label: t('board.columnName'),
      placeholder: t('board.columnPlaceholder'),
      confirmLabel: t('common.create'),
    });
    if (!title) return;
    await mutate(
      () => api('/api/board/columns', { method: 'POST', body: { projectId: project?.id, title } }),
      t('board.columnCreated'),
    );
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

  async function openCardEditor(summary: BoardCard): Promise<void> {
    let card: BoardCard;
    try {
      const response = await api<{ card: BoardCard }>(`/api/board/cards/${encodeURIComponent(summary.id)}`);
      card = response.card;
    } catch (error) {
      toast(errorMessage(error), 'error');
      return;
    }
    const refreshBoard = (): void => {
      void load();
    };
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
    const labelsRow = h('div', { class: 'board-editor-chips' });
    const assigneesRow = h('div', { class: 'board-editor-people' });
    const dueInput = h('input', {
      type: 'datetime-local',
      class: 'input board-due-input',
      value: card.dueAt ? dateTimeLocal(card.dueAt) : '',
      'aria-label': t('board.dueDate'),
    });
    const dueComplete = h('input', {
      type: 'checkbox',
      checked: card.dueComplete,
      disabled: !card.dueAt,
      onchange: async () => {
        try {
          await api(`/api/board/cards/${encodeURIComponent(card.id)}`, {
            method: 'PATCH',
            body: { dueComplete: dueComplete.checked },
          });
          card.dueComplete = dueComplete.checked;
          refreshBoard();
        } catch (error) {
          dueComplete.checked = card.dueComplete;
          toast(errorMessage(error), 'error');
        }
      },
    });
    const dueClear = h(
      'button',
      {
        type: 'button',
        class: 'btn small',
        disabled: !card.dueAt,
        onclick: async () => {
          try {
            await api(`/api/board/cards/${encodeURIComponent(card.id)}`, {
              method: 'PATCH',
              body: { dueAt: null },
            });
            card.dueAt = null;
            card.dueComplete = false;
            dueInput.value = '';
            dueComplete.checked = false;
            dueComplete.disabled = true;
            dueClear.disabled = true;
            refreshBoard();
          } catch (error) {
            toast(errorMessage(error), 'error');
          }
        },
      },
      t('board.clearDue'),
    );
    dueInput.addEventListener('change', async () => {
      const value = dueInput.value ? new Date(dueInput.value).getTime() : null;
      if (value !== null && !Number.isFinite(value)) return;
      try {
        await api(`/api/board/cards/${encodeURIComponent(card.id)}`, {
          method: 'PATCH',
          body: { dueAt: value },
        });
        card.dueAt = value;
        card.dueComplete = value === null ? false : card.dueComplete;
        dueComplete.disabled = value === null;
        dueClear.disabled = value === null;
        refreshBoard();
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    });

    const renderLabels = (): void => {
      labelsRow.replaceChildren();
      for (const label of card.labels) {
        labelsRow.append(
          h('span', {
            class: 'board-label-chip',
            style: { background: label.color, color: readableLabelColor(label.color) },
            title: label.name || t('board.untitledLabel'),
            text: label.name || t('board.untitledLabel'),
          }),
        );
      }
      labelsRow.append(
        h(
          'button',
          {
            type: 'button',
            class: 'btn small board-chip-button',
            onclick: (event: MouseEvent) => openLabelMenu(event.currentTarget as HTMLElement),
          },
          icon('tag', 13),
          t('board.labels'),
        ),
      );
    };

    const toggleLabel = async (label: BoardLabel): Promise<void> => {
      const hasLabel = card.labels.some((entry) => entry.id === label.id);
      try {
        const response = hasLabel
          ? await api<{ labels: BoardLabel[] }>(
              `/api/board/cards/${encodeURIComponent(card.id)}/labels/${encodeURIComponent(label.id)}`,
              { method: 'DELETE' },
            )
          : await api<{ labels: BoardLabel[] }>(`/api/board/cards/${encodeURIComponent(card.id)}/labels`, {
              method: 'POST',
              body: { labelId: label.id },
            });
        card.labels = response.labels;
        renderLabels();
        refreshBoard();
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    };

    const openLabelMenu = (anchor: HTMLElement): void => {
      const items: MenuItem[] = labels.map((label) => ({
        label: label.name || t('board.untitledLabel'),
        dotColor: label.color,
        selected: card.labels.some((entry) => entry.id === label.id),
        onClick: () => toggleLabel(label),
      }));
      items.push({
        label: t('board.newLabel'),
        iconName: 'plus',
        onClick: () => openLabelCreator(),
      });
      showMenu(anchor, items);
    };

    const openLabelCreator = (): void => {
      if (!project) return;
      const name = h('input', { class: 'input', maxlength: '40', placeholder: t('board.labelName') });
      const color = h('input', {
        type: 'color',
        class: 'board-color-input',
        value: LABEL_COLORS[labels.length % LABEL_COLORS.length] ?? '#8f6cf5',
        'aria-label': t('board.labelColor'),
      });
      const modal = openModal({
        title: t('board.newLabel'),
        body: h(
          'div',
          { class: 'stack' },
          h('div', { class: 'field' }, h('label', { text: t('board.labelName') }), name),
          h('div', { class: 'field' }, h('label', { text: t('board.labelColor') }), color),
        ),
        actions: [
          { label: t('common.cancel') },
          {
            label: t('common.create'),
            kind: 'primary',
            close: false,
            onClick: async () => {
              const response = await api<{ label: BoardLabel }>(
                `/api/projects/${encodeURIComponent(project?.id ?? '')}/labels`,
                { method: 'POST', body: { name: name.value, color: color.value } },
              );
              labels = [...labels, response.label];
              const attached = await api<{ labels: BoardLabel[] }>(
                `/api/board/cards/${encodeURIComponent(card.id)}/labels`,
                { method: 'POST', body: { labelId: response.label.id } },
              );
              card.labels = attached.labels;
              renderLabels();
              refreshBoard();
              modal.close();
              toast(t('board.labelCreated'), 'success');
            },
          },
        ],
      });
    };

    const renderAssignees = (): void => {
      assigneesRow.replaceChildren();
      if (card.assignees.length === 0) {
        assigneesRow.append(h('span', { class: 'soft', text: t('board.noAssignees') }));
      }
      for (const member of card.assignees) {
        assigneesRow.append(
          h(
            'span',
            { class: 'board-assignee', title: member.displayName },
            avatarEl(member, { size: 'sm', showStatus: false }),
            h('span', { text: member.displayName }),
          ),
        );
      }
      assigneesRow.append(
        h(
          'button',
          {
            type: 'button',
            class: 'btn small board-chip-button',
            onclick: (event: MouseEvent) => openAssigneeMenu(event.currentTarget as HTMLElement),
          },
          icon('users', 13),
          t('board.assignees'),
        ),
      );
    };

    const openAssigneeMenu = (anchor: HTMLElement): void => {
      showMenu(
        anchor,
        members.map((member) => ({
          label: member.displayName,
          selected: card.assignees.some((entry) => entry.id === member.id),
          onClick: async () => {
            const assigned = card.assignees.some((entry) => entry.id === member.id);
            try {
              const response = assigned
                ? await api<{ assignees: BoardMember[] }>(
                    `/api/board/cards/${encodeURIComponent(card.id)}/members/${encodeURIComponent(member.id)}`,
                    { method: 'DELETE' },
                  )
                : await api<{ assignees: BoardMember[] }>(`/api/board/cards/${encodeURIComponent(card.id)}/members`, {
                    method: 'POST',
                    body: { userId: member.id },
                  });
              card.assignees = response.assignees;
              renderAssignees();
              refreshBoard();
            } catch (error) {
              toast(errorMessage(error), 'error');
            }
          },
        })),
      );
    };

    const attachmentsList = h('div', { class: 'board-attachments' });
    const uploadInput = h('input', { type: 'file', hidden: true, 'aria-label': t('board.uploadAttachment') });
    const uploadButton = h(
      'button',
      { type: 'button', class: 'btn small', onclick: () => uploadInput.click() },
      icon('paperclip', 14),
      t('board.uploadAttachment'),
    );
    const renderAttachments = (): void => {
      attachmentsList.replaceChildren();
      if (!card.attachments?.length) {
        attachmentsList.append(h('p', { class: 'soft', text: t('board.noAttachments') }));
        return;
      }
      for (const attachment of card.attachments) {
        const isCover = card.coverFileId === attachment.fileId;
        const preview = attachment.isImage
          ? h('img', {
              class: 'board-attachment-thumb',
              src: downloadUrl(attachment.fileId),
              alt: attachment.name,
              loading: 'lazy',
            })
          : h(
              'span',
              { class: 'board-attachment-file-icon' },
              icon(attachment.mime === 'application/pdf' ? 'pdf' : 'file', 18),
            );
        const coverButton = attachment.isImage
          ? h(
              'button',
              {
                type: 'button',
                class: `icon-btn${isCover ? ' active' : ''}`,
                'aria-label': isCover ? t('board.removeCover') : t('board.setCover'),
                title: isCover ? t('board.removeCover') : t('board.setCover'),
                onclick: async () => {
                  try {
                    await api(`/api/board/cards/${encodeURIComponent(card.id)}`, {
                      method: 'PATCH',
                      body: { coverFileId: isCover ? null : attachment.fileId },
                    });
                    card.coverFileId = isCover ? null : attachment.fileId;
                    renderAttachments();
                    refreshBoard();
                  } catch (error) {
                    toast(errorMessage(error), 'error');
                  }
                },
              },
              icon(isCover ? 'check' : 'image', 14),
            )
          : null;
        const removeButton = h(
          'button',
          {
            type: 'button',
            class: 'icon-btn danger-ghost',
            'aria-label': t('board.deleteAttachment'),
            title: t('board.deleteAttachment'),
            onclick: async () => {
              const confirmed = await confirmDialog({
                title: t('board.deleteAttachment'),
                message: t('board.deleteAttachmentText', { name: attachment.name }),
                confirmLabel: t('common.delete'),
                danger: true,
              });
              if (!confirmed) return;
              try {
                const response = await api<{ attachmentCount: number }>(
                  `/api/board/cards/${encodeURIComponent(card.id)}/attachments/${encodeURIComponent(attachment.id)}`,
                  { method: 'DELETE' },
                );
                card.attachments = card.attachments?.filter((entry) => entry.id !== attachment.id);
                card.attachmentCount = response.attachmentCount;
                if (card.coverFileId === attachment.fileId) card.coverFileId = null;
                renderAttachments();
                refreshBoard();
              } catch (error) {
                toast(errorMessage(error), 'error');
              }
            },
          },
          icon('trash', 14),
        );
        attachmentsList.append(
          h(
            'div',
            { class: `board-attachment${isCover ? ' is-cover' : ''}` },
            preview,
            h(
              'div',
              { class: 'board-attachment-copy' },
              h('strong', { text: attachment.name }),
              h('span', {
                text: `${formatBytes(attachment.size)}${isCover ? ` · ${t('board.cover')}` : ''}`,
              }),
            ),
            h(
              'div',
              { class: 'board-attachment-actions' },
              coverButton,
              h(
                'a',
                {
                  class: 'icon-btn',
                  href: downloadUrl(attachment.fileId, { inline: false }),
                  download: attachment.name,
                  'aria-label': t('common.download'),
                  title: t('common.download'),
                },
                icon('download', 14),
              ),
              removeButton,
            ),
          ),
        );
      }
    };
    uploadInput.addEventListener('change', async () => {
      const file = uploadInput.files?.[0];
      uploadInput.value = '';
      if (!file) return;
      uploadButton.disabled = true;
      try {
        const uploaded = await uploadAndWait(file, null);
        const response = await api<{ attachment: BoardAttachment; attachmentCount: number }>(
          `/api/board/cards/${encodeURIComponent(card.id)}/attachments`,
          { method: 'POST', body: { fileId: uploaded.id } },
        );
        card.attachments = [...(card.attachments ?? []), response.attachment];
        card.attachmentCount = response.attachmentCount;
        renderAttachments();
        refreshBoard();
        toast(t('board.attachmentUploaded'), 'success');
      } catch (error) {
        toast(errorMessage(error), 'error');
      } finally {
        uploadButton.disabled = false;
      }
    });

    const commentsList = h('div', { class: 'board-comments' });
    const commentInput = h('textarea', {
      class: 'input board-comment-input',
      rows: '2',
      maxlength: '4000',
      placeholder: t('board.commentPlaceholder'),
      'aria-label': t('board.commentPlaceholder'),
    });
    const commentButton = h(
      'button',
      { type: 'button', class: 'btn small primary' },
      icon('send', 13),
      t('board.commentSend'),
    );
    const renderComments = (): void => {
      commentsList.replaceChildren();
      const comments = card.comments ?? [];
      if (comments.length === 0) {
        commentsList.append(h('p', { class: 'soft', text: t('board.noComments') }));
        return;
      }
      for (const comment of comments) {
        const canDelete = comment.author.id === state.user?.id || project?.role === 'owner';
        commentsList.append(
          h(
            'div',
            { class: 'board-comment' },
            avatarEl(
              { id: comment.author.id, displayName: comment.author.displayName },
              { size: 'sm', showStatus: false },
            ),
            h(
              'div',
              { class: 'board-comment-body' },
              h(
                'div',
                { class: 'board-comment-meta' },
                h('strong', { text: comment.author.displayName }),
                h('span', { text: relativeTime(comment.createdAt) }),
                canDelete
                  ? h(
                      'button',
                      {
                        type: 'button',
                        class: 'icon-btn danger-ghost board-comment-delete',
                        'aria-label': t('board.deleteComment'),
                        title: t('board.deleteComment'),
                        onclick: async () => {
                          try {
                            await api(
                              `/api/board/cards/${encodeURIComponent(card.id)}/comments/${encodeURIComponent(comment.id)}`,
                              { method: 'DELETE' },
                            );
                            card.comments = card.comments?.filter((entry) => entry.id !== comment.id);
                            card.commentCount = Math.max(0, card.commentCount - 1);
                            renderComments();
                            refreshBoard();
                          } catch (error) {
                            toast(errorMessage(error), 'error');
                          }
                        },
                      },
                      icon('trash', 13),
                    )
                  : null,
              ),
              h('p', { text: comment.body }),
            ),
          ),
        );
      }
    };
    const addComment = async (): Promise<void> => {
      const body = commentInput.value.trim();
      if (!body) return;
      commentButton.disabled = true;
      try {
        const response = await api<{ comment: BoardComment; commentCount: number }>(
          `/api/board/cards/${encodeURIComponent(card.id)}/comments`,
          { method: 'POST', body: { body } },
        );
        card.comments = [...(card.comments ?? []), response.comment];
        card.commentCount = response.commentCount;
        commentInput.value = '';
        renderComments();
        refreshBoard();
      } catch (error) {
        toast(errorMessage(error), 'error');
      } finally {
        commentButton.disabled = false;
      }
    };
    commentButton.addEventListener('click', () => void addComment());
    commentInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void addComment();
      }
    });

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

    const statusPill = createStatusPill(
      card.status,
      (next) =>
        mutate(() =>
          api(`/api/board/cards/${encodeURIComponent(card.id)}`, { method: 'PATCH', body: { status: next } }),
        ),
      { label: t('board.cardStatus') },
    );

    renderLabels();
    renderAssignees();
    renderAttachments();
    renderComments();
    renderChecklist();

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
          h(
            'div',
            { class: 'board-editor-facts' },
            h(
              'div',
              { class: 'board-editor-block' },
              h('span', { class: 'board-editor-kicker', text: t('board.labels') }),
              labelsRow,
            ),
            h(
              'div',
              { class: 'board-editor-block' },
              h('span', { class: 'board-editor-kicker', text: t('board.assignees') }),
              assigneesRow,
            ),
            h(
              'div',
              { class: 'board-editor-block board-editor-due' },
              h('span', { class: 'board-editor-kicker', text: t('board.dueDate') }),
              h('div', { class: 'board-due-editor' }, dueInput, dueClear),
              h('label', { class: 'board-check-row' }, dueComplete, h('span', { text: t('board.dueComplete') })),
            ),
          ),
          h(
            'section',
            { class: 'board-editor-section' },
            h(
              'div',
              { class: 'board-editor-section-head' },
              h('span', { class: 'board-editor-kicker', text: t('board.attachments') }),
              uploadButton,
            ),
            h('div', { class: 'board-attachment-help', text: t('board.attachmentHelp') }),
            uploadInput,
            attachmentsList,
          ),
          h(
            'section',
            { class: 'board-editor-section' },
            h(
              'div',
              { class: 'board-editor-section-head' },
              h('span', { class: 'board-editor-kicker', text: t('board.comments') }),
              h('span', { class: 'board-editor-count', text: String(card.commentCount) }),
            ),
            commentsList,
            h('div', { class: 'board-comment-composer' }, commentInput, commentButton),
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
    const items: MenuItem[] = [{ label: t('board.editCard'), onClick: () => void openCardEditor(card) }];
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
      onClick: () => void deleteCard(card),
    });
    showMenu(anchor, items);
  }

  function openColumnMenu(anchor: HTMLElement, column: BoardColumn): void {
    const index = columns.findIndex((entry) => entry.id === column.id);
    const items: MenuItem[] = [{ label: t('board.renameColumn'), onClick: () => void renameColumn(column) }];
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
      onClick: () => void deleteColumn(column),
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

  function dueBadge(card: BoardCard): HTMLElement | null {
    if (!card.dueAt) return null;
    const overdue = !card.dueComplete && card.dueAt < Date.now();
    return h(
      'span',
      {
        class: `board-due${card.dueComplete ? ' done' : overdue ? ' overdue' : ''}`,
        title: t('board.dueDate'),
      },
      icon('clock', 12),
      h('span', { text: formatDate(card.dueAt) }),
    );
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
    const labelRow =
      card.labels.length > 0
        ? h(
            'div',
            { class: 'board-card-labels' },
            ...card.labels.map((label) =>
              h('span', {
                class: 'board-label-chip',
                style: { background: label.color, color: readableLabelColor(label.color) },
                title: label.name || t('board.untitledLabel'),
                text: label.name || t('board.untitledLabel'),
              }),
            ),
          )
        : null;
    const assignees =
      card.assignees.length > 0
        ? h(
            'div',
            { class: 'avatar-stack board-card-assignees' },
            ...card.assignees
              .slice(0, 3)
              .map((member) =>
                avatarEl({ id: member.id, displayName: member.displayName }, { size: 'sm', showStatus: false }),
              ),
          )
        : null;
    const counts =
      card.commentCount > 0 || card.attachmentCount > 0
        ? h(
            'div',
            { class: 'board-card-counts' },
            card.commentCount > 0
              ? h(
                  'span',
                  { title: t('board.comments') },
                  icon('chat', 12),
                  h('span', { text: String(card.commentCount) }),
                )
              : null,
            card.attachmentCount > 0
              ? h(
                  'span',
                  { title: t('board.attachments') },
                  icon('paperclip', 12),
                  h('span', { text: String(card.attachmentCount) }),
                )
              : null,
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
          void openCardEditor(card);
        },
        onkeydown: (event: KeyboardEvent) => {
          if (event.target !== element) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            void openCardEditor(card);
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
      card.coverFileId
        ? h('img', {
            class: 'board-card-cover',
            src: downloadUrl(card.coverFileId),
            alt: '',
            loading: 'lazy',
          })
        : null,
      labelRow,
      h('div', { class: 'board-card-top' }, statusPill, menuButton),
      h('strong', { class: 'board-card-title', text: card.title }),
      card.description ? h('p', { class: 'board-card-desc', text: card.description }) : null,
      h(
        'div',
        { class: 'board-card-footer' },
        h('div', { class: 'board-card-meta' }, icon('clock', 12), h('span', { text: relativeTime(card.updatedAt) })),
        dueBadge(card),
        taskProgress,
        counts,
        assignees,
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
    { class: 'page-head board-head' },
    h(
      'div',
      { class: 'grow' },
      h('div', { class: 'board-title-row' }, projectNameEl, projectPicker),
      projectDescriptionEl,
    ),
    h(
      'div',
      { class: 'actions board-head-actions' },
      chatButton,
      membersButton,
      projectMenuButton,
      h(
        'button',
        { type: 'button', class: 'btn primary', onclick: () => void createColumn() },
        icon('plus', 16),
        t('board.newColumn'),
      ),
    ),
  );
  page.append(head, boardEl);
  renderHeader();
  render();
  void load();

  const unsubscribePresence = on(events.contactsUpdated, () => {
    for (const member of members) {
      const contact = state.contacts.find((entry) => entry.id === member.id);
      if (!contact) continue;
      member.status = contact.status;
      member.displayName = contact.displayName;
    }
    refreshMemberRows?.();
  });

  return {
    node: page,
    destroy: () => {
      disposed = true;
      clearDropIndicators();
      refreshMemberRows = null;
      unsubscribePresence();
    },
  };
}
