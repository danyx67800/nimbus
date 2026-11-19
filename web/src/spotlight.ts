import { api } from './api.js';
import { t } from './i18n.js';
import { navigate } from './router.js';
import { state } from './store.js';
import { avatarEl, formatBytes, h, icon, relativeTime } from './ui.js';

interface SearchPerson {
  id: string;
  username: string;
  displayName: string;
  status: string;
  roomId: string | null;
}

interface SearchRoom {
  id: string;
  kind: 'dm' | 'group' | 'channel';
  title: string;
  updatedAt: number;
  lastMessage: string | null;
  lastMessageAt: number | null;
}

interface SearchMessage {
  id: string;
  roomId: string;
  roomTitle: string;
  roomKind: 'dm' | 'group' | 'channel';
  senderId: string;
  senderName: string;
  body: string;
  createdAt: number;
}

interface SearchFile {
  id: string;
  parentId: string | null;
  name: string;
  kind: 'file' | 'folder';
  mime: string;
  size: number;
  updatedAt: number;
}

interface SearchBoardItem {
  kind: 'card' | 'task';
  id: string;
  cardId: string;
  title: string;
  snippet: string;
  status: string;
  columnTitle: string;
  cardTitle?: string;
  projectId: string;
  projectName: string;
  updatedAt: number;
}

interface SearchResults {
  people: SearchPerson[];
  rooms: SearchRoom[];
  messages: SearchMessage[];
  files: SearchFile[];
  board: SearchBoardItem[];
}

interface SpotlightEntry {
  key: string;
  label: string;
  hint?: string;
  iconName: string;
  avatar?: { id: string; displayName: string; status?: string };
  run: () => void;
}

function emptyResults(): SearchResults {
  return { people: [], rooms: [], messages: [], files: [], board: [] };
}

let activeSpotlight: { input: HTMLInputElement; close: () => void } | null = null;

export function spotlightShortcutLabel(): string {
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent) ? '⌘K' : 'Ctrl K';
}

function navigationEntries(): SpotlightEntry[] {
  const entries: SpotlightEntry[] = [
    { key: 'files', label: t('nav.files'), iconName: 'files', run: () => navigate('/files') },
    { key: 'favorites', label: t('nav.favorites'), iconName: 'star', run: () => navigate('/favorites') },
    { key: 'board', label: t('nav.board'), iconName: 'kanban', run: () => navigate('/board') },
    { key: 'chat', label: t('nav.chat'), iconName: 'chat', run: () => navigate('/chat') },
    { key: 'calls', label: t('nav.calls'), iconName: 'phone', run: () => navigate('/calls') },
    { key: 'shared', label: t('nav.shared'), iconName: 'share', run: () => navigate('/shared') },
    { key: 'trash', label: t('nav.trash'), iconName: 'trash', run: () => navigate('/trash') },
    { key: 'settings', label: t('nav.settings'), iconName: 'settings', run: () => navigate('/settings') },
    { key: 'help', label: t('nav.help'), iconName: 'lock', run: () => navigate('/help') },
  ];
  if (state.user?.role === 'admin') {
    entries.push({ key: 'admin', label: t('nav.admin'), iconName: 'admin', run: () => navigate('/admin') });
  }
  return entries;
}

function fileIconName(file: SearchFile): string {
  if (file.kind === 'folder') return 'folder';
  if (file.mime.startsWith('image/')) return 'image';
  if (file.mime.startsWith('video/')) return 'video';
  if (file.mime.startsWith('audio/')) return 'audio';
  if (file.mime === 'application/pdf') return 'pdf';
  return 'file';
}

function fileEntry(file: SearchFile): SpotlightEntry {
  const detail = file.kind === 'folder' ? t('files.folder') : formatBytes(file.size);
  return {
    key: `file-${file.id}`,
    label: file.name,
    hint: `${detail} · ${relativeTime(file.updatedAt)}`,
    iconName: fileIconName(file),
    run: () => {
      const params = new URLSearchParams();
      if (file.kind === 'folder') {
        params.set('folder', file.id);
      } else {
        if (file.parentId) params.set('folder', file.parentId);
        params.set('file', file.id);
      }
      navigate(`/files?${params.toString()}`);
    },
  };
}

function personEntry(person: SearchPerson): SpotlightEntry {
  return {
    key: `person-${person.id}`,
    label: person.displayName,
    hint: `@${person.username} · ${t(`common.${person.status || 'offline'}`)}`,
    iconName: 'users',
    avatar: { id: person.id, displayName: person.displayName, status: person.status },
    run: () => {
      if (person.roomId) navigate(`/chat/${encodeURIComponent(person.roomId)}`);
      else navigate(`/chat?dm=${encodeURIComponent(person.id)}`);
    },
  };
}

function roomKindLabel(kind: SearchRoom['kind']): string {
  if (kind === 'dm') return t('spotlight.directMessage');
  if (kind === 'channel') return t('spotlight.channel');
  return t('spotlight.group');
}

function roomEntry(room: SearchRoom): SpotlightEntry {
  const meta = roomKindLabel(room.kind);
  return {
    key: `room-${room.id}`,
    label: room.title,
    hint: room.lastMessage ? `${meta} · ${room.lastMessage}` : meta,
    iconName: room.kind === 'dm' ? 'chat' : 'users',
    run: () => navigate(`/chat/${encodeURIComponent(room.id)}`),
  };
}

function messageEntry(message: SearchMessage, searchQuery: string): SpotlightEntry {
  return {
    key: `message-${message.id}`,
    label: `${message.senderName} · ${message.roomTitle}`,
    hint: message.body,
    iconName: 'chat',
    run: () => navigate(`/chat/${encodeURIComponent(message.roomId)}?q=${encodeURIComponent(searchQuery)}`),
  };
}

function boardEntry(item: SearchBoardItem): SpotlightEntry {
  const meta =
    item.kind === 'task'
      ? `${t('spotlight.boardTask')} · ${item.projectName}`
      : `${t('spotlight.boardCard')} · ${item.projectName}`;
  return {
    key: `board-${item.kind}-${item.id}`,
    label: item.title,
    hint: item.snippet ? `${meta} · ${item.snippet}` : `${meta} · ${item.columnTitle}`,
    iconName: 'kanban',
    run: () => navigate(`/board?project=${encodeURIComponent(item.projectId)}&card=${encodeURIComponent(item.cardId)}`),
  };
}

export function openSpotlight(): void {
  if (activeSpotlight) {
    activeSpotlight.input.focus();
    activeSpotlight.input.select();
    return;
  }
  if (document.querySelector('.modal-backdrop')) return;

  const root = document.getElementById('overlays') ?? document.body;
  const previousFocus = document.activeElement as HTMLElement | null;
  const titleId = `spotlight-title-${Math.random().toString(36).slice(2)}`;
  const listId = `spotlight-list-${Math.random().toString(36).slice(2)}`;
  let query = '';
  let searchResults = emptyResults();
  let entries: SpotlightEntry[] = [];
  let itemEls: HTMLButtonElement[] = [];
  let activeIndex = 0;
  let loading = false;
  let failed = false;
  let searchSeq = 0;
  let searchTimer: number | undefined;
  let closed = false;
  let destroyed = false;

  const input = h('input', {
    type: 'search',
    class: 'spotlight-input',
    placeholder: t('spotlight.placeholder'),
    'aria-label': t('spotlight.placeholder'),
    autocomplete: 'off',
    spellcheck: 'false',
    role: 'combobox',
    'aria-expanded': 'true',
    'aria-controls': listId,
    'aria-autocomplete': 'list',
  });
  const closeButton = h('button', {
    type: 'button',
    class: 'spotlight-esc',
    'aria-label': t('common.close'),
    text: 'esc',
  });
  const results = h('div', { class: 'spotlight-results', id: listId, role: 'listbox' });
  const panel = h(
    'div',
    {
      class: 'spotlight',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': titleId,
    },
    h('h2', { id: titleId, class: 'sr-only', text: t('spotlight.dialogLabel') }),
    h('div', { class: 'spotlight-top' }, icon('search', 19), input, closeButton),
    results,
    h('div', { class: 'spotlight-footer', text: t('spotlight.keyboardHint') }),
  );
  const backdrop = h(
    'div',
    {
      class: 'spotlight-backdrop',
    },
    panel,
  );

  const close = (): void => {
    if (closed) return;
    closed = true;
    destroyed = true;
    searchSeq += 1;
    if (searchTimer !== undefined) window.clearTimeout(searchTimer);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('popstate', close);
    backdrop.remove();
    if (activeSpotlight?.input === input) activeSpotlight = null;
    previousFocus?.focus();
  };

  const syncActive = (scroll = false): void => {
    const active = activeIndex >= 0 ? entries[activeIndex] : undefined;
    if (active) input.setAttribute('aria-activedescendant', `spotlight-option-${activeIndex}`);
    else input.removeAttribute('aria-activedescendant');
    itemEls.forEach((element, index) => {
      const selected = index === activeIndex;
      element.setAttribute('aria-selected', String(selected));
      element.classList.toggle('is-active', selected);
    });
    if (scroll) itemEls[activeIndex]?.scrollIntoView({ block: 'nearest' });
  };

  const setActive = (next: number, scroll = false): void => {
    if (entries.length === 0) return;
    activeIndex = (next + entries.length) % entries.length;
    syncActive(scroll);
  };

  const select = (): void => {
    const entry = entries[activeIndex];
    if (!entry) return;
    close();
    entry.run();
  };

  const render = (): void => {
    const normalizedQuery = query.toLocaleLowerCase();
    const actionEntries = query
      ? navigationEntries().filter((entry) => entry.label.toLocaleLowerCase().includes(normalizedQuery))
      : navigationEntries();
    const peopleEntries = query && !failed ? searchResults.people.map(personEntry) : [];
    const roomEntries = query && !failed ? searchResults.rooms.map(roomEntry) : [];
    const messageEntries =
      query && !failed ? searchResults.messages.map((message) => messageEntry(message, query)) : [];
    const fileEntries = query && !failed ? searchResults.files.map(fileEntry) : [];
    const boardEntries = query && !failed ? searchResults.board.map(boardEntry) : [];
    entries = [...actionEntries, ...peopleEntries, ...roomEntries, ...messageEntries, ...boardEntries, ...fileEntries];
    if (entries.length === 0) activeIndex = -1;
    else if (activeIndex < 0 || activeIndex >= entries.length) activeIndex = 0;

    results.replaceChildren();
    itemEls = [];
    let index = 0;
    const appendGroup = (title: string, group: SpotlightEntry[]): void => {
      if (group.length === 0) return;
      results.append(h('div', { class: 'spotlight-group-title', text: title }));
      for (const entry of group) {
        const itemIndex = index++;
        const item = h(
          'button',
          {
            type: 'button',
            class: 'spotlight-item',
            id: `spotlight-option-${itemIndex}`,
            role: 'option',
            tabindex: '-1',
            'aria-selected': 'false',
            onclick: () => selectEntry(entry),
            onmouseenter: () => setActive(itemIndex),
          },
          h(
            'span',
            { class: 'spotlight-item-icon' },
            entry.avatar ? avatarEl(entry.avatar, { size: 'sm', showStatus: false }) : icon(entry.iconName, 17),
          ),
          h(
            'span',
            { class: 'spotlight-item-text' },
            h('span', { class: 'spotlight-item-label', text: entry.label }),
            entry.hint ? h('span', { class: 'spotlight-item-hint', text: entry.hint }) : null,
          ),
          h('span', { class: 'spotlight-item-arrow' }, icon('arrow', 14)),
        );
        itemEls.push(item);
        results.append(item);
      }
    };

    appendGroup(t('spotlight.goTo'), actionEntries);
    appendGroup(t('spotlight.people'), peopleEntries);
    appendGroup(t('spotlight.rooms'), roomEntries);
    appendGroup(t('spotlight.messages'), messageEntries);
    appendGroup(t('spotlight.board'), boardEntries);
    appendGroup(t('spotlight.files'), fileEntries);

    if (query && loading) {
      results.append(
        h(
          'div',
          { class: 'spotlight-status', role: 'status' },
          h('span', { class: 'spotlight-pulse', 'aria-hidden': 'true' }),
          t('spotlight.loading'),
        ),
      );
    } else if (query && failed) {
      results.append(h('div', { class: 'spotlight-status danger', role: 'status', text: t('spotlight.searchError') }));
    } else if (query && entries.length === 0) {
      results.append(
        h(
          'div',
          { class: 'spotlight-empty' },
          h('div', { class: 'spotlight-empty-icon' }, icon('search', 22)),
          h('strong', { text: t('spotlight.noResults', { q: query }) }),
          h('span', { text: t('spotlight.noResultsHint') }),
        ),
      );
    }

    syncActive();
  };

  const selectEntry = (entry: SpotlightEntry): void => {
    close();
    entry.run();
  };

  const searchGlobal = async (term: string, token: number): Promise<void> => {
    try {
      const response = await api<SearchResults>(`/api/search?q=${encodeURIComponent(term)}`);
      if (destroyed || token !== searchSeq) return;
      searchResults = {
        people: response.people ?? [],
        rooms: response.rooms ?? [],
        messages: response.messages ?? [],
        files: (response.files ?? []).filter((item) => item.kind === 'file' || item.kind === 'folder'),
        board: response.board ?? [],
      };
      failed = false;
    } catch {
      if (destroyed || token !== searchSeq) return;
      searchResults = emptyResults();
      failed = true;
    } finally {
      if (!destroyed && token === searchSeq) {
        loading = false;
        render();
      }
    }
  };

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'Tab') {
      const active = document.activeElement;
      if (event.shiftKey && active === input) {
        event.preventDefault();
        closeButton.focus();
      } else if (!event.shiftKey && active === closeButton) {
        event.preventDefault();
        input.focus();
      }
      return;
    }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && entries.length > 0) {
      event.preventDefault();
      setActive(activeIndex + (event.key === 'ArrowDown' ? 1 : -1), true);
      return;
    }
    if (event.key === 'Enter' && event.target === input) {
      event.preventDefault();
      select();
    }
  };

  input.addEventListener('input', () => {
    query = input.value.trim();
    const token = ++searchSeq;
    if (searchTimer !== undefined) window.clearTimeout(searchTimer);
    searchResults = emptyResults();
    failed = false;
    activeIndex = 0;
    loading = Boolean(query);
    render();
    if (!query) return;
    const term = query;
    searchTimer = window.setTimeout(() => {
      void searchGlobal(term, token);
    }, 180);
  });
  closeButton.addEventListener('click', close);
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey);
  window.addEventListener('popstate', close);

  root.append(backdrop);
  activeSpotlight = { input, close };
  render();
  input.focus();
}
