import { api } from './api.js';
import { t } from './i18n.js';
import { navigate } from './router.js';
import { state } from './store.js';
import { formatBytes, h, icon, relativeTime } from './ui.js';

interface SpotlightFile {
  id: string;
  parentId: string | null;
  name: string;
  kind: 'file' | 'folder';
  mime: string;
  size: number;
  updatedAt: number;
}

interface SpotlightEntry {
  key: string;
  label: string;
  hint?: string;
  iconName: string;
  run: () => void;
}

let activeSpotlight: { input: HTMLInputElement; close: () => void } | null = null;

export function spotlightShortcutLabel(): string {
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent) ? '⌘K' : 'Ctrl K';
}

function navigationEntries(): SpotlightEntry[] {
  const entries: SpotlightEntry[] = [
    { key: 'files', label: t('nav.files'), iconName: 'files', run: () => navigate('/files') },
    { key: 'favorites', label: t('nav.favorites'), iconName: 'star', run: () => navigate('/favorites') },
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

function fileIconName(file: SpotlightFile): string {
  if (file.kind === 'folder') return 'folder';
  if (file.mime.startsWith('image/')) return 'image';
  if (file.mime.startsWith('video/')) return 'video';
  if (file.mime.startsWith('audio/')) return 'audio';
  if (file.mime === 'application/pdf') return 'pdf';
  return 'file';
}

function fileEntry(file: SpotlightFile): SpotlightEntry {
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
  let fileResults: SpotlightFile[] = [];
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
    const fileEntries = query && !failed ? fileResults.map(fileEntry) : [];
    entries = [...actionEntries, ...fileEntries];
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
          h('span', { class: 'spotlight-item-icon' }, icon(entry.iconName, 17)),
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

  const searchFiles = async (term: string, token: number): Promise<void> => {
    try {
      const response = await api<{ items: SpotlightFile[] }>(`/api/files?search=${encodeURIComponent(term)}`);
      if (destroyed || token !== searchSeq) return;
      fileResults = response.items.filter((item) => item.kind === 'file' || item.kind === 'folder').slice(0, 7);
    } catch {
      if (destroyed || token !== searchSeq) return;
      fileResults = [];
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
    fileResults = [];
    failed = false;
    activeIndex = 0;
    loading = Boolean(query);
    render();
    if (!query) return;
    const term = query;
    searchTimer = window.setTimeout(() => {
      void searchFiles(term, token);
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
