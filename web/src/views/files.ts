import { ApiError, api, downloadUrl, uploadFileVersion } from '../api.js';
import { on } from '../bus.js';
import { openFileViewer } from '../file-viewer.js';
import { t } from '../i18n.js';
import { openQuickSharePicker } from '../quick-share.js';
import { hashFile } from '../sha256.js';
import { state } from '../store.js';
import {
  avatarEl,
  confirmDialog,
  copyToClipboard,
  createSelectPill,
  debounce,
  emptyState,
  fileIcon,
  formatBytes,
  formatDate,
  formatQuota,
  h,
  icon,
  openModal,
  promptDialog,
  relativeTime,
  showMenu,
  toast,
} from '../ui.js';
import { enqueueUploads } from '../uploads.js';
import type { View } from './types.js';

export interface FileItem {
  id: string;
  parentId: string | null;
  name: string;
  kind: 'file' | 'folder';
  size: number;
  mime: string;
  version: number;
  favorite: boolean;
  isOwner: boolean;
  permission: 'owner' | 'write' | 'read';
  shared: string | null;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
  scanStatus: string;
  ownerName?: string;
}

interface ListResponse {
  items: FileItem[];
  breadcrumb: Array<{ id: string; name: string }>;
  parentId?: string | null;
}

interface SharesResponse {
  outgoing: Array<{
    fileId: string;
    userId: string;
    permission: string;
    userName: string;
    username: string;
    createdAt: number;
  }>;
  links: Array<{
    id: string;
    fileId: string;
    expiresAt: number | null;
    maxDownloads: number | null;
    downloads: number;
    createdAt: number;
    revoked: boolean;
  }>;
}

type Mode = 'files' | 'favorites' | 'shared' | 'trash';

type SortKey =
  | 'name-asc'
  | 'name-desc'
  | 'modified-desc'
  | 'modified-asc'
  | 'created-desc'
  | 'created-asc'
  | 'size-desc'
  | 'size-asc';

const LAYOUT_KEY = 'nimbus-files-layout';
const SORT_KEY = 'nimbus-files-sort';

export function renderFiles(options: { mode: Mode; folderId?: string; search?: string; openFileId?: string }): View {
  let mode = options.mode;
  let parentId: string | null = options.folderId ?? null;
  let search = options.search ?? '';
  let items: FileItem[] = [];
  let breadcrumb: Array<{ id: string; name: string }> = [];
  let loading = false;
  let errorMessage = '';
  let requestId = 0;
  let destroyed = false;
  let layout: 'list' | 'grid' = readLayout();
  let sort: SortKey = readSort();
  let selecting = false;
  const selectedItems = new Map<string, FileItem>();

  const listRoot = h('div', { class: 'files-dropzone' });
  const breadcrumbRow = h('div', { class: 'breadcrumb' });
  const title = h('h1', { text: titleFor(mode) });
  const subtitle = h('p', { class: 'sub' });
  const searchInput = h('input', {
    type: 'search',
    placeholder: t('files.searchPlaceholder'),
    'aria-label': t('files.searchPlaceholder'),
    value: search,
    oninput: debounce(() => {
      search = searchInput.value.trim();
      void load();
    }, 320),
  });
  const searchBox = h('label', { class: 'search-box' }, icon('search', 16), searchInput);
  const gridTab = h('button', { type: 'button', onclick: () => setLayout('grid') }, t('home.grid'));
  const listTab = h('button', { type: 'button', onclick: () => setLayout('list') }, t('home.list'));
  const layoutTabs = h(
    'div',
    { class: 'tabs', role: 'group', 'aria-label': `${t('home.grid')} / ${t('home.list')}` },
    gridTab,
    listTab,
  );
  const sortPill = createSelectPill({
    ariaLabel: t('files.sort'),
    value: sort,
    options: sortOptions(),
  });
  sortPill.classList.add('sort-pill');
  sortPill.addEventListener('change', () => {
    sort = sortPill.value as SortKey;
    try {
      localStorage.setItem(SORT_KEY, sort);
    } catch {
      // ignore
    }
    renderList();
  });
  const refreshButton = h(
    'button',
    {
      type: 'button',
      class: 'icon-btn refresh-btn',
      'aria-label': t('files.refresh'),
      title: t('files.refresh'),
      onclick: () => void load(),
    },
    icon('refresh', 16),
  );
  const selectButton = h(
    'button',
    {
      type: 'button',
      class: 'icon-btn select-btn',
      'aria-label': t('files.select'),
      'aria-pressed': 'false',
      title: t('files.select'),
      onclick: () => setSelecting(!selecting),
    },
    icon('checkSquare', 16),
  );
  const selectionCount = h('span', { class: 'selection-count' });
  const downloadSelectedButton = h(
    'button',
    { type: 'button', class: 'btn small primary', disabled: true, onclick: () => downloadSelected() },
    icon('download', 14),
    t('files.downloadSelected'),
  );
  const selectionBar = h(
    'div',
    { class: 'selection-bar', role: 'toolbar', 'aria-label': t('files.select'), hidden: true },
    icon('checkSquare', 16),
    selectionCount,
    h('div', { class: 'grow' }),
    h('button', { type: 'button', class: 'btn small', onclick: () => selectAll() }, t('files.selectAll')),
    downloadSelectedButton,
    h('button', { type: 'button', class: 'btn small', onclick: () => setSelecting(false) }, t('common.cancel')),
  );
  const uploadInput = h('input', {
    type: 'file',
    multiple: true,
    hidden: true,
    onchange: () => {
      const files = Array.from(uploadInput.files ?? []);
      uploadInput.value = '';
      if (files.length === 0) return;
      void enqueueUploads(files, parentId).then((uploaded) => {
        if (uploaded.some(Boolean)) {
          toast(files.length === 1 ? t('files.uploadComplete') : `${files.length} file caricati`, 'success');
          void load();
        }
      });
    },
  });
  const uploadButton = h(
    'button',
    { type: 'button', class: 'btn primary', onclick: () => uploadInput.click() },
    icon('upload', 16),
    t('files.upload'),
  );
  const newFolderButton = h(
    'button',
    { type: 'button', class: 'btn', onclick: () => void createFolder() },
    icon('plus', 16),
    t('files.newFolder'),
  );
  const quickActions = h(
    'div',
    { class: 'quick-actions' },
    quickCard('peach', 'upload', t('files.upload'), t('home.quickUpload'), () => uploadInput.click()),
    quickCard('lilac', 'folder', t('files.newFolder'), t('home.quickFolder'), () => void createFolder()),
    quickCard('mint', 'share', t('qs.title'), t('home.quickShare'), () => {
      if (!window.isSecureContext) {
        toast(t('qs.insecure'), 'error');
        return;
      }
      openQuickSharePicker();
    }),
  );
  const helloUsed = h('b');
  const helloQuota = h('b');
  const hello = h(
    'section',
    { class: 'hello' },
    h('span', { class: 'tag' }, icon('spark', 12), greetingDate()),
    h(
      'h1',
      {},
      t('home.greeting', { name: (state.user?.displayName ?? '').split(/\s+/)[0] ?? '' }),
      h('span', { class: 'wave', text: '✦' }),
    ),
    h('p', {}, `${t('home.have')} `, helloUsed, ` ${t('home.safeOn')} `, helloQuota, `. ${t('home.encrypted')}`),
  );
  const fab = h(
    'button',
    {
      type: 'button',
      class: 'fab',
      'aria-label': t('home.add'),
      onclick: (event: MouseEvent) => {
        showMenu(event.currentTarget as HTMLElement, [
          { label: t('files.upload'), iconName: 'upload', onClick: () => uploadInput.click() },
          { label: t('files.newFolder'), iconName: 'folder', onClick: () => void createFolder() },
        ]);
      },
    },
    icon('plus', 18),
    h('span', { text: t('home.add') }),
  );

  const pageHead = h(
    'div',
    { class: 'page-head' },
    h('div', { class: 'grow' }, title, subtitle),
    h(
      'div',
      { class: 'actions' },
      mode === 'files' ? newFolderButton : null,
      mode === 'files' || mode === 'favorites' ? uploadButton : null,
      uploadInput,
    ),
  );

  const toolbar = h(
    'div',
    { class: 'toolbar' },
    breadcrumbRow,
    h('div', { class: 'grow' }),
    mode === 'files' ? searchBox : null,
  );
  const sectionTitle = h('h2');
  const sectionHead = h(
    'div',
    { class: 'sec-head' },
    sectionTitle,
    h('div', { class: 'grow' }),
    sortPill,
    selectButton,
    refreshButton,
    layoutTabs,
  );
  const recentList = h('div', { class: 'recent-list' });
  const homeSide = h(
    'aside',
    { class: 'home-side', 'aria-label': t('home.recent') },
    h('section', { class: 'panel' }, h('h3', { text: t('home.recent') }), recentList),
    h(
      'section',
      { class: 'panel security-panel' },
      h('h3', { text: t('home.security') }),
      h('div', { class: 'security-state' }, icon('shield', 16), h('b', { text: t('home.encryptedTitle') })),
      h('p', { text: t('home.encryptedText') }),
      h(
        'div',
        { class: 'security-row' },
        icon(window.isSecureContext ? 'lock' : 'cloud', 14),
        h('span', { text: window.isSecureContext ? t('home.secure') : t('home.insecure') }),
      ),
    ),
  );
  const homeMain = h('div', { class: 'home-main' }, sectionHead, selectionBar, listRoot);
  const columns = h('div', { class: 'home-cols' }, homeMain, homeSide);
  const node = h('div', { class: 'files-shell' }, hello, quickActions, pageHead, toolbar, columns, fab);

  function setLayout(next: 'grid' | 'list'): void {
    layout = next;
    try {
      localStorage.setItem(LAYOUT_KEY, layout);
    } catch {
      // ignore
    }
    syncLayoutTabs();
    renderList();
  }

  function syncLayoutTabs(): void {
    gridTab.classList.toggle('on', layout === 'grid');
    listTab.classList.toggle('on', layout === 'list');
    gridTab.setAttribute('aria-pressed', String(layout === 'grid'));
    listTab.setAttribute('aria-pressed', String(layout === 'list'));
  }

  function sectionLabel(): string {
    if (search) return t('chat.searchResults');
    if (mode === 'favorites') return t('home.favorites');
    if (mode === 'shared') return t('home.shared');
    if (mode === 'trash') return t('home.trash');
    return t('home.files');
  }

  function updateSubtitle(): void {
    const used = state.user?.usedBytes ?? 0;
    const quota = state.user?.quotaBytes ?? 0;
    helloUsed.textContent = formatBytes(used);
    helloQuota.textContent = formatQuota(quota);
    if (mode === 'files')
      subtitle.textContent = t('files.storage', { used: formatBytes(used), quota: formatQuota(quota) });
    else if (mode === 'favorites') subtitle.textContent = 'I tuoi file e cartelle preferiti.';
    else if (mode === 'shared') subtitle.textContent = 'Elementi che altri utenti hanno condiviso con te.';
    else subtitle.textContent = 'Gli elementi eliminati restano qui fino all’eliminazione definitiva.';
    sectionTitle.textContent = sectionLabel();
    updateChrome();
  }

  function updateChrome(): void {
    const home = mode === 'files' && !parentId && !search;
    hello.hidden = !home;
    quickActions.hidden = !home;
    pageHead.hidden = home;
    breadcrumbRow.hidden = home;
    fab.hidden = mode !== 'files' || Boolean(search);
    layoutTabs.hidden = mode === 'trash';
    homeSide.hidden = !home;
    columns.classList.toggle('single', !home);
    selectButton.hidden = mode === 'trash';
    if (mode === 'trash' && selecting) {
      selecting = false;
      selectedItems.clear();
      renderList();
    }
    syncSelection();
  }

  function renderRecent(): void {
    const recent = [...items].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3);
    recentList.replaceChildren();
    if (recent.length === 0) {
      recentList.append(h('p', { class: 'hint', text: t('home.noRecent') }));
      return;
    }
    for (const item of recent) {
      recentList.append(
        h(
          'button',
          { type: 'button', class: 'recent-row', onclick: () => openItem(item) },
          h(
            'span',
            { class: `recent-icon ${toneFor(item, 0)}` },
            item.kind === 'folder' ? icon('folder', 16) : fileIcon(item.kind, item.mime),
          ),
          h(
            'span',
            { class: 'recent-text' },
            h('b', { text: item.name }),
            h('small', { text: relativeTime(item.updatedAt) }),
          ),
        ),
      );
    }
  }

  function renderBreadcrumb(): void {
    breadcrumbRow.replaceChildren();
    if (search) {
      breadcrumbRow.append(h('span', { class: 'muted', text: t('files.searchResults', { q: search }) }));
      return;
    }
    if (mode === 'shared') {
      breadcrumbRow.append(h('span', { class: 'muted', text: t('nav.shared') }));
      return;
    }
    if (mode === 'trash') {
      breadcrumbRow.append(h('span', { class: 'muted', text: t('nav.trash') }));
      return;
    }
    if (mode === 'favorites') {
      breadcrumbRow.append(h('span', { class: 'muted', text: 'Preferiti' }));
      return;
    }
    breadcrumbRow.append(h('button', { type: 'button', onclick: () => goTo(null), text: t('files.root') }));
    for (const crumb of breadcrumb) {
      breadcrumbRow.append(h('span', { class: 'sep', text: '/' }));
      breadcrumbRow.append(h('button', { type: 'button', onclick: () => goTo(crumb.id), text: crumb.name }));
    }
  }

  function goTo(id: string | null): void {
    mode = 'files';
    parentId = id;
    search = '';
    searchInput.value = '';
    title.textContent = titleFor(mode);
    updateSubtitle();
    const url = id ? `/files?folder=${encodeURIComponent(id)}` : '/files';
    history.pushState(null, '', url);
    void load();
  }

  async function load(): Promise<void> {
    const current = ++requestId;
    loading = true;
    errorMessage = '';
    if (items.length === 0) renderList();
    refreshButton.classList.add('is-loading');
    refreshButton.disabled = true;
    const params = new URLSearchParams();
    if (search && mode === 'files') params.set('search', search);
    else if (mode !== 'files') params.set('view', mode);
    else if (parentId) params.set('parent', parentId);
    try {
      const response = await api<ListResponse>(`/api/files?${params.toString()}`);
      if (destroyed || current !== requestId) return;
      items = response.items;
      breadcrumb = response.breadcrumb ?? [];
      loading = false;
      renderBreadcrumb();
      renderList();
      updateSubtitle();
    } catch (error) {
      if (destroyed || current !== requestId) return;
      loading = false;
      errorMessage = error instanceof ApiError ? error.message : t('common.error');
      renderList();
    } finally {
      if (current === requestId) {
        refreshButton.classList.remove('is-loading');
        refreshButton.disabled = false;
      }
    }
  }

  function openItem(item: FileItem): void {
    if (item.kind === 'folder') {
      if (mode === 'trash') return;
      goTo(item.id);
      return;
    }
    void openPreview(item);
  }

  function setSelecting(value: boolean): void {
    selecting = value;
    if (!value) selectedItems.clear();
    syncSelection();
    renderList();
  }

  function toggleSelected(item: FileItem): void {
    if (selectedItems.has(item.id)) selectedItems.delete(item.id);
    else selectedItems.set(item.id, item);
    syncSelection();
    renderList();
  }

  function selectAll(): void {
    for (const item of items) if (item.kind === 'file') selectedItems.set(item.id, item);
    syncSelection();
    renderList();
  }

  function downloadSelected(): void {
    const files = [...selectedItems.values()];
    if (files.length === 0) return;
    files.forEach((item, index) => {
      window.setTimeout(() => download(item), index * 250);
    });
    toast(t('files.downloadStarted', { n: files.length }), 'success');
  }

  function syncSelection(): void {
    selectionBar.hidden = !selecting;
    selectionCount.textContent = t('files.selectedCount', { n: selectedItems.size });
    downloadSelectedButton.disabled = selectedItems.size === 0;
    selectButton.setAttribute('aria-pressed', String(selecting));
    selectButton.classList.toggle('on', selecting);
    node.classList.toggle('selecting', selecting);
  }

  function checkEl(item: FileItem): HTMLElement {
    const on = selectedItems.has(item.id);
    return h(
      'span',
      {
        class: `file-check${on ? ' on' : ''}`,
        role: 'checkbox',
        'aria-checked': String(on),
        'aria-label': `${t('files.select')} ${item.name}`,
        onclick: (event: MouseEvent) => {
          event.stopPropagation();
          toggleSelected(item);
        },
      },
      on ? icon('check', 13) : null,
    );
  }

  function menuFor(item: FileItem, anchor: HTMLElement): void {
    const actions = [];
    if (mode === 'trash') {
      actions.push({ label: t('common.restore'), iconName: 'arrowLeft', onClick: () => restore(item) });
      actions.push({
        label: t('files.deleteForever'),
        iconName: 'trash',
        danger: true,
        onClick: () => purge(item),
      });
    } else {
      if (item.kind === 'file') {
        actions.push({ label: t('files.preview'), iconName: 'file', onClick: () => void openPreview(item) });
        actions.push({
          label: t('viewer.details'),
          iconName: 'info',
          onClick: () => openFileViewer(item, { showDetails: true }),
        });
        actions.push({ label: t('common.download'), iconName: 'download', onClick: () => download(item) });
      }
      if (item.isOwner) {
        actions.push({ label: t('files.shareTitle'), iconName: 'share', onClick: () => void openShare(item) });
        actions.push({ label: t('common.rename'), iconName: 'file', onClick: () => void rename(item) });
        actions.push({ label: t('common.move'), iconName: 'folder', onClick: () => void move(item) });
        actions.push({ label: t('common.copy'), iconName: 'copy', onClick: () => void copy(item) });
        if (item.kind === 'file') {
          actions.push({ label: t('files.versions'), iconName: 'clock', onClick: () => void openVersions(item) });
        }
      }
      if (item.isOwner) {
        actions.push({
          label: item.favorite ? t('files.unfavorite') : t('files.favorite'),
          iconName: 'star',
          onClick: async () => {
            await api(`/api/files/${encodeURIComponent(item.id)}`, {
              method: 'PATCH',
              body: { favorite: !item.favorite },
            });
            item.favorite = !item.favorite;
            renderList();
          },
        });
        actions.push({ label: t('common.delete'), iconName: 'trash', danger: true, onClick: () => void remove(item) });
      }
    }
    showMenu(anchor, actions);
  }

  function renderList(): void {
    listRoot.replaceChildren();
    renderRecent();
    if (loading && items.length === 0) {
      listRoot.append(skeletonList());
      return;
    }
    if (errorMessage) {
      listRoot.append(
        emptyState(
          'cloud',
          t('common.error'),
          errorMessage,
          h('button', { type: 'button', class: 'btn', onclick: () => void load() }, t('common.retry')),
        ),
      );
      return;
    }
    if (items.length === 0) {
      const titleText =
        mode === 'trash'
          ? t('files.trashEmpty')
          : mode === 'favorites'
            ? t('files.favoritesEmpty')
            : search
              ? t('chat.noMessagesFound')
              : t('files.emptyTitle');
      const text = search
        ? `Nessun risultato per “${search}”.`
        : mode === 'trash' || mode === 'favorites'
          ? ''
          : t('files.emptyText');
      const action =
        mode === 'files' && !search
          ? h(
              'button',
              { type: 'button', class: 'btn primary', onclick: () => uploadInput.click() },
              icon('upload', 16),
              t('files.upload'),
            )
          : undefined;
      listRoot.append(emptyState(search ? 'search' : 'folder', titleText, text, action));
      return;
    }

    const visible = sortItems(items, sort);
    if (layout === 'grid' && mode !== 'trash') {
      const grid = h('div', { class: 'file-grid' });
      visible.forEach((item, index) => {
        grid.append(fileCard(item, index));
      });
      listRoot.append(grid);
      return;
    }
    const list = h('div', { class: 'file-list', role: 'list' });
    visible.forEach((item, index) => {
      list.append(fileRow(item, index));
    });
    listRoot.append(list);
  }

  function skeletonList(): HTMLElement {
    const wrap = h('div', { class: 'skeleton-list', role: 'status', 'aria-label': t('common.loading') });
    for (let index = 0; index < 6; index += 1) {
      wrap.append(
        h(
          'div',
          { class: 'skeleton-row' },
          h('div', { class: 'skeleton skeleton-icon' }),
          h(
            'div',
            { class: 'grow' },
            h('div', { class: 'skeleton skeleton-line sk-w-60' }),
            h('div', { class: 'skeleton skeleton-line sk-w-30' }),
          ),
        ),
      );
    }
    return wrap;
  }

  function cardMenu(item: FileItem): HTMLButtonElement {
    return h(
      'button',
      {
        type: 'button',
        class: 'icon-btn item-menu',
        'aria-label': `Azioni per ${item.name}`,
        onclick: (event: MouseEvent) => {
          event.stopPropagation();
          menuFor(item, event.currentTarget as HTMLElement);
        },
      },
      icon('more', 16),
    );
  }

  function fileCard(item: FileItem, index: number): HTMLElement {
    const thumb = h('div', { class: `thumb ${toneFor(item, index)}` });
    if (item.kind === 'folder') thumb.append(icon('folder', 30));
    else if (item.mime.startsWith('image/') && item.size < 8 * 1024 * 1024) {
      thumb.append(
        h('img', {
          src: downloadUrl(item.id),
          alt: '',
          loading: 'lazy',
          onerror: (event: Event) => ((event.currentTarget as HTMLImageElement).style.display = 'none'),
        }),
      );
    } else thumb.append(fileIcon(item.kind, item.mime));
    if (item.kind !== 'folder') thumb.append(h('span', { class: 'tag', text: fileExtension(item.name) }));
    const selectable = selecting && item.kind === 'file';
    const card = h(
      'div',
      {
        class: [
          'file-card',
          selectable ? 'is-selectable' : '',
          selectable && selectedItems.has(item.id) ? 'is-selected' : '',
        ]
          .filter(Boolean)
          .join(' '),
        style: { '--i': String(index) },
        role: 'button',
        tabindex: '0',
        onclick: () => (selectable ? toggleSelected(item) : openItem(item)),
        onkeydown: (event: KeyboardEvent) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (selectable) toggleSelected(item);
            else openItem(item);
          }
        },
        oncontextmenu: (event: MouseEvent) => {
          event.preventDefault();
          menuFor(item, event.currentTarget as HTMLElement);
        },
      },
      selectable ? checkEl(item) : null,
      thumb,
      h('div', { class: 'file-name', text: item.name }),
      h(
        'div',
        { class: 'file-meta' },
        h('span', { text: formatDate(item.updatedAt) }),
        h('span', { class: 'dot', 'aria-hidden': 'true' }),
        h('span', { text: item.kind === 'folder' ? t('files.folder') : formatBytes(item.size) }),
        item.favorite ? icon('star', 13) : null,
      ),
      cardMenu(item),
    );
    return card;
  }

  function fileRow(item: FileItem, index: number): HTMLElement {
    const meta = item.ownerName
      ? t('files.sharedBy', { name: item.ownerName })
      : item.kind === 'folder'
        ? t('files.folder')
        : formatBytes(item.size);
    const selectable = selecting && item.kind === 'file';
    const row = h(
      'div',
      {
        class: [
          'file-row',
          selectable ? 'is-selectable' : '',
          selectable && selectedItems.has(item.id) ? 'is-selected' : '',
        ]
          .filter(Boolean)
          .join(' '),
        style: { '--i': String(index) },
        role: 'listitem',
        tabindex: '0',
        onclick: () => (selectable ? toggleSelected(item) : openItem(item)),
        onkeydown: (event: KeyboardEvent) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (selectable) toggleSelected(item);
            else openItem(item);
          }
        },
        oncontextmenu: (event: MouseEvent) => {
          event.preventDefault();
          menuFor(item, event.currentTarget as HTMLElement);
        },
      },
      selectable ? checkEl(item) : null,
      h(
        'div',
        { class: 'name-cell' },
        item.kind === 'folder' ? fileIcon('folder', item.mime) : fileIcon('file', item.mime),
        h(
          'div',
          { class: 'grow' },
          h('div', { class: 'file-name', text: item.name }),
          h('div', { class: 'meta', style: { fontSize: '11px' }, text: meta }),
        ),
      ),
      h('span', { class: 'meta meta-type meta-size', text: item.kind === 'folder' ? '—' : formatBytes(item.size) }),
      h('span', { class: 'meta meta-date', text: formatDate(item.updatedAt) }),
      h('div', { class: 'table-actions row-actions' }, cardMenu(item)),
    );
    return row;
  }

  async function createFolder(): Promise<void> {
    const name = await promptDialog({
      title: t('files.newFolder'),
      label: t('files.folderName'),
      confirmLabel: t('common.create'),
    });
    if (!name) return;
    try {
      await api('/api/files/folders', { method: 'POST', body: { name, parentId } });
      toast(t('files.folderCreated'), 'success');
      await load();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : t('common.error'), 'error');
    }
  }

  async function rename(item: FileItem): Promise<void> {
    const name = await promptDialog({ title: t('files.renameTitle'), label: t('common.name'), value: item.name });
    if (!name || name === item.name) return;
    try {
      await api(`/api/files/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: { name } });
      await load();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : t('common.error'), 'error');
    }
  }

  async function move(item: FileItem): Promise<void> {
    const target = await pickFolder(t('files.moveTitle'), item.id);
    if (target === undefined) return;
    try {
      await api(`/api/files/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: { parentId: target } });
      toast(t('files.moved'), 'success');
      await load();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : t('common.error'), 'error');
    }
  }

  async function copy(item: FileItem): Promise<void> {
    const target = await pickFolder(t('files.copyTo', {}), undefined);
    if (target === undefined) return;
    try {
      await api(`/api/files/${encodeURIComponent(item.id)}/copy`, { method: 'POST', body: { parentId: target } });
      toast(t('common.copied'), 'success');
      await load();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : t('common.error'), 'error');
    }
  }

  async function remove(item: FileItem): Promise<void> {
    const confirmed = await confirmDialog({
      title: t('files.deleteTitle'),
      message: t('files.deleteText', { name: item.name }),
      confirmLabel: t('common.delete'),
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api(`/api/files/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      toast(t('files.deleted'), 'success');
      await load();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : t('common.error'), 'error');
    }
  }

  async function restore(item: FileItem): Promise<void> {
    try {
      await api(`/api/files/${encodeURIComponent(item.id)}/restore`, { method: 'POST', body: {} });
      toast(t('files.restored'), 'success');
      await load();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : t('common.error'), 'error');
    }
  }

  async function purge(item: FileItem): Promise<void> {
    const confirmed = await confirmDialog({
      title: t('files.purgeTitle'),
      message: t('files.purgeText', { name: item.name }),
      confirmLabel: t('files.deleteForever'),
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api(`/api/files/${encodeURIComponent(item.id)}/purge`, { method: 'DELETE' });
      toast(t('files.purged'), 'success');
      await load();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : t('common.error'), 'error');
    }
  }

  function download(item: FileItem): void {
    const anchor = h('a', { href: downloadUrl(item.id, { inline: false }), download: item.name, hidden: true });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  }

  async function openPreview(item: FileItem): Promise<void> {
    openFileViewer(item);
  }

  async function openFromSpotlight(id: string): Promise<void> {
    try {
      const response = await api<{ item: FileItem }>(`/api/files/${encodeURIComponent(id)}`);
      if (destroyed) return;
      const item = response.item;
      if (item.kind === 'folder') {
        goTo(item.id);
        return;
      }
      history.replaceState(null, '', item.parentId ? `/files?folder=${encodeURIComponent(item.parentId)}` : '/files');
      await openPreview(item);
    } catch (error) {
      history.replaceState(null, '', '/files');
      toast(error instanceof ApiError ? error.message : t('common.error'), 'error');
    }
  }

  async function openVersions(item: FileItem): Promise<void> {
    const body = h('div', { class: 'version-list' }, h('p', { class: 'soft', text: t('common.loading') }));
    const uploadVersionInput = h('input', {
      type: 'file',
      hidden: true,
      onchange: async () => {
        const file = uploadVersionInput.files?.[0];
        uploadVersionInput.value = '';
        if (!file) return;
        const status = h('div', { class: 'notice', text: 'Preparazione…' });
        body.prepend(status);
        try {
          const hash = await hashFile(file, (fraction) => {
            status.textContent = `Calcolo checksum… ${Math.round(fraction * 100)}%`;
          });
          await uploadFileVersion(item.id, file, hash, (fraction) => {
            status.textContent = `${t('files.uploading')} ${Math.round(fraction * 100)}%`;
          });
          toast(t('files.uploadComplete'), 'success');
          modal.close();
          await load();
        } catch (error) {
          status.className = 'notice danger';
          status.textContent = error instanceof ApiError ? error.message : t('files.uploadFailed');
        }
      },
    });
    const uploadButton = h(
      'button',
      { type: 'button', class: 'btn', onclick: () => uploadVersionInput.click() },
      icon('upload', 16),
      t('files.saveVersion'),
    );
    const modal = openModal({ title: t('files.versions'), body, wide: true, actions: [{ label: t('common.close') }] });
    modal.body.prepend(h('div', { class: 'row' }, uploadButton, uploadVersionInput));
    try {
      const response = await api<{
        versions: Array<{ version: number; size: number; mime: string; createdAt: number; current: boolean }>;
      }>(`/api/files/${encodeURIComponent(item.id)}/versions`);
      body.replaceChildren();
      for (const version of response.versions) {
        const row = h(
          'div',
          { class: 'version-row' },
          h(
            'div',
            { class: 'grow' },
            h('strong', {
              text: version.current
                ? `${t('files.currentVersion')} (v${version.version})`
                : t('files.version', { n: version.version }),
            }),
            h('div', { class: 'hint', text: `${formatDate(version.createdAt, true)} · ${formatBytes(version.size)}` }),
          ),
          version.current
            ? h('span', { class: 'badge success', text: t('files.currentVersion') })
            : item.isOwner
              ? h(
                  'button',
                  {
                    type: 'button',
                    class: 'btn small',
                    onclick: async () => {
                      try {
                        await api(`/api/files/${encodeURIComponent(item.id)}/versions/${version.version}/restore`, {
                          method: 'POST',
                          body: {},
                        });
                        toast(t('files.restored'), 'success');
                        modal.close();
                        await load();
                      } catch (error) {
                        toast(error instanceof ApiError ? error.message : t('common.error'), 'error');
                      }
                    },
                  },
                  t('files.restoreVersion'),
                )
              : null,
        );
        body.append(row);
      }
      if (response.versions.length === 0) body.append(h('p', { class: 'soft', text: t('files.noVersions') }));
    } catch (error) {
      body.replaceChildren(
        h('div', { class: 'notice danger', text: error instanceof ApiError ? error.message : t('common.error') }),
      );
    }
  }

  async function openShare(item: FileItem): Promise<void> {
    const body = h('div', { class: 'stack' });
    const modal = openModal({
      title: `${t('files.shareTitle')} · ${item.name}`,
      body,
      wide: true,
      actions: [{ label: t('common.close') }],
    });
    void modal;
    let createdUrl: string | null = null;

    const refresh = async (): Promise<void> => {
      body.replaceChildren(h('p', { class: 'soft', text: t('common.loading') }));
      try {
        const data = await api<SharesResponse>('/api/shares');
        const shares = data.outgoing.filter((share) => share.fileId === item.id);
        const links = data.links.filter((link) => link.fileId === item.id && !link.revoked);
        body.replaceChildren();

        const personSection = h(
          'div',
          { class: 'stack' },
          h('h3', { style: { fontSize: '14px' }, text: t('files.shareWith') }),
          shares.length === 0
            ? h('p', { class: 'hint', text: t('files.noShares') })
            : h(
                'ul',
                { class: 'list-plain' },
                ...shares.map((share) =>
                  h(
                    'li',
                    {},
                    avatarEl({ id: share.userId, displayName: share.userName }, { size: 'sm', showStatus: false }),
                    h(
                      'div',
                      { class: 'grow' },
                      h('strong', { text: share.userName }),
                      h('div', {
                        class: 'hint',
                        text: share.permission === 'write' ? t('files.permissionWrite') : t('files.permissionRead'),
                      }),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        class: 'btn small danger',
                        onclick: async () => {
                          await api(
                            `/api/files/${encodeURIComponent(item.id)}/shares/${encodeURIComponent(share.userId)}`,
                            { method: 'DELETE' },
                          );
                          toast(t('files.revoke'), 'success');
                          await refresh();
                        },
                      },
                      icon('x', 14),
                      t('files.revoke'),
                    ),
                  ),
                ),
              ),
        );
        const available = state.contacts.filter((contact) => !contact.blocked && contact.id !== state.user?.id);
        if (available.length > 0) {
          const select = createSelectPill({
            ariaLabel: t('files.shareWith'),
            value: '',
            placeholder: '—',
            options: [
              { value: '', label: '—' },
              ...available.map((contact) => ({ value: contact.id, label: contact.displayName })),
            ],
          });
          const permission = createSelectPill({
            ariaLabel: t('files.permissionRead'),
            value: 'read',
            options: [
              { value: 'read', label: t('files.permissionRead'), dotColor: 'var(--muted)' },
              { value: 'write', label: t('files.permissionWrite'), dotColor: 'var(--accent)' },
            ],
          });
          const add = h(
            'button',
            {
              type: 'button',
              class: 'btn primary',
              onclick: async () => {
                if (!select.value) return;
                try {
                  await api(`/api/files/${encodeURIComponent(item.id)}/shares`, {
                    method: 'POST',
                    body: { userId: select.value, permission: permission.value },
                  });
                  await refresh();
                } catch (error) {
                  toast(error instanceof ApiError ? error.message : t('common.error'), 'error');
                }
              },
            },
            t('files.addShare'),
          );
          personSection.append(h('div', { class: 'row' }, select, permission, add));
        }
        body.append(personSection);

        if (item.kind === 'file') {
          const password = h('input', {
            class: 'input',
            type: 'text',
            placeholder: t('files.passwordOptional'),
            autocomplete: 'new-password',
          });
          const expires = h('input', {
            class: 'input',
            type: 'number',
            min: '1',
            max: '8760',
            placeholder: t('files.expiresHours'),
          });
          const maxDownloads = h('input', {
            class: 'input',
            type: 'number',
            min: '1',
            max: '10000',
            placeholder: t('files.maxDownloads'),
          });
          const create = h(
            'button',
            {
              type: 'button',
              class: 'btn',
              onclick: async () => {
                try {
                  const result = await api<{ link: { token: string; url: string; expiresAt: number | null } }>(
                    '/api/public-links',
                    {
                      method: 'POST',
                      body: {
                        fileId: item.id,
                        ...(password.value ? { password: password.value } : {}),
                        ...(expires.value ? { expiresInHours: Number(expires.value) } : {}),
                        ...(maxDownloads.value ? { maxDownloads: Number(maxDownloads.value) } : {}),
                      },
                    },
                  );
                  createdUrl = `${location.origin}/p/${result.link.token}`;
                  password.value = '';
                  expires.value = '';
                  maxDownloads.value = '';
                  await refresh();
                } catch (error) {
                  toast(error instanceof ApiError ? error.message : t('common.error'), 'error');
                }
              },
            },
            icon('link', 15),
            t('files.createLink'),
          );
          const publicSection = h(
            'div',
            { class: 'stack' },
            h('h3', { style: { fontSize: '14px' }, text: t('files.publicLink') }),
            h('div', { class: 'row wrap' }, password, expires, maxDownloads, create),
            links.length === 0
              ? h('p', { class: 'hint', text: t('files.noLinks') })
              : h(
                  'ul',
                  { class: 'list-plain' },
                  ...links.map((link) =>
                    h(
                      'li',
                      {},
                      icon('link', 16),
                      h(
                        'div',
                        { class: 'grow' },
                        h('span', {
                          text: link.expiresAt
                            ? t('public.expires', { date: formatDate(link.expiresAt) })
                            : t('public.unlimited'),
                        }),
                        h('div', {
                          class: 'hint',
                          text: `${link.downloads}${link.maxDownloads ? ` / ${link.maxDownloads}` : ''} download`,
                        }),
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          class: 'btn small danger',
                          onclick: async () => {
                            await api(`/api/public-links/${encodeURIComponent(link.id)}`, { method: 'DELETE' });
                            await refresh();
                          },
                        },
                        t('files.revoke'),
                      ),
                    ),
                  ),
                ),
          );
          if (createdUrl) {
            const url = createdUrl;
            publicSection.prepend(
              h(
                'div',
                { class: 'stack' },
                h('div', { class: 'notice success', text: t('files.linkCreated') }),
                h('div', { class: 'secret-box', text: url }),
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'btn small',
                    onclick: async () => {
                      if (await copyToClipboard(url)) toast(t('common.copied'), 'success');
                    },
                  },
                  icon('link', 14),
                  t('common.copyLink'),
                ),
              ),
            );
          }
          body.append(publicSection);
        }
      } catch (error) {
        body.replaceChildren(
          h('div', { class: 'notice danger', text: error instanceof ApiError ? error.message : t('common.error') }),
        );
      }
    };
    await refresh();
  }

  async function pickFolder(titleText: string, excludeId?: string): Promise<string | null | undefined> {
    return new Promise((resolve) => {
      let current: string | null = null;
      let settled = false;
      let crumbs: Array<{ id: string; name: string }> = [];
      const folderList = h('div', { class: 'stack' }, h('p', { class: 'soft', text: t('common.loading') }));
      const crumbRow = h('div', { class: 'breadcrumb' });
      const body = h('div', { class: 'stack' }, crumbRow, folderList);
      const modal = openModal({
        title: titleText,
        body,
        actions: [
          {
            label: t('common.cancel'),
            onClick: () => {
              settled = true;
              resolve(undefined);
            },
          },
          {
            label: t('files.chooseFolder'),
            kind: 'primary',
            onClick: () => {
              settled = true;
              resolve(current);
            },
          },
        ],
        onClose: () => {
          if (!settled) resolve(undefined);
        },
      });
      void modal;

      const renderCrumbs = (): void => {
        crumbRow.replaceChildren(
          h('button', { type: 'button', text: t('files.root'), onclick: () => void navigateTo(null) }),
        );
        for (const crumb of crumbs) {
          crumbRow.append(
            h('span', { class: 'sep', text: '/' }),
            h('button', { type: 'button', text: crumb.name, onclick: () => void navigateTo(crumb.id) }),
          );
        }
      };

      const navigateTo = async (id: string | null): Promise<void> => {
        current = id;
        try {
          const data = await api<ListResponse>(`/api/files?${id ? `parent=${encodeURIComponent(id)}` : ''}`);
          crumbs = data.breadcrumb ?? [];
          renderCrumbs();
          const folders = data.items.filter((item) => item.kind === 'folder' && item.id !== excludeId);
          folderList.replaceChildren();
          if (folders.length === 0) folderList.append(h('p', { class: 'hint', text: 'Nessuna sottocartella' }));
          for (const folder of folders) {
            folderList.append(
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn block',
                  style: { justifyContent: 'flex-start' },
                  onclick: () => void navigateTo(folder.id),
                },
                icon('folder', 16),
                h('span', { class: 'grow', text: folder.name }),
                icon('chevron', 14),
              ),
            );
          }
        } catch (error) {
          folderList.replaceChildren(
            h('div', { class: 'notice danger', text: error instanceof ApiError ? error.message : t('common.error') }),
          );
        }
      };
      void navigateTo(null);
    });
  }

  syncLayoutTabs();
  syncSelection();
  updateSubtitle();
  renderBreadcrumb();
  renderList();
  void load();
  if (options.openFileId) void openFromSpotlight(options.openFileId);

  const unsubscribeUser = on('nimbus:user-refreshed', updateSubtitle);
  return {
    node,
    destroy: () => {
      destroyed = true;
      unsubscribeUser();
    },
  };
}

function titleFor(mode: Mode): string {
  switch (mode) {
    case 'favorites':
      return t('nav.favorites');
    case 'shared':
      return t('nav.shared');
    case 'trash':
      return t('nav.trash');
    default:
      return t('files.title');
  }
}

function sortOptions(): Array<{ value: SortKey; label: string }> {
  return [
    { value: 'name-asc', label: t('files.sortNameAsc') },
    { value: 'name-desc', label: t('files.sortNameDesc') },
    { value: 'modified-desc', label: t('files.sortModifiedDesc') },
    { value: 'modified-asc', label: t('files.sortModifiedAsc') },
    { value: 'created-desc', label: t('files.sortCreatedDesc') },
    { value: 'created-asc', label: t('files.sortCreatedAsc') },
    { value: 'size-desc', label: t('files.sortSizeDesc') },
    { value: 'size-asc', label: t('files.sortSizeAsc') },
  ];
}

function readSort(): SortKey {
  const fallback: SortKey = 'name-asc';
  try {
    const stored = localStorage.getItem(SORT_KEY);
    return sortOptions().some((option) => option.value === stored) ? (stored as SortKey) : fallback;
  } catch {
    return fallback;
  }
}

function sortItems(list: FileItem[], key: SortKey): FileItem[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return [...list].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    switch (key) {
      case 'name-desc':
        return collator.compare(b.name, a.name);
      case 'modified-desc':
        return b.updatedAt - a.updatedAt || collator.compare(a.name, b.name);
      case 'modified-asc':
        return a.updatedAt - b.updatedAt || collator.compare(a.name, b.name);
      case 'created-desc':
        return b.createdAt - a.createdAt || collator.compare(a.name, b.name);
      case 'created-asc':
        return a.createdAt - b.createdAt || collator.compare(a.name, b.name);
      case 'size-desc':
        return b.size - a.size || collator.compare(a.name, b.name);
      case 'size-asc':
        return a.size - b.size || collator.compare(a.name, b.name);
      default:
        return collator.compare(a.name, b.name);
    }
  });
}

function readLayout(): 'list' | 'grid' {
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

function toneFor(item: FileItem, index: number): string {
  if (item.kind === 'folder') return 'lilac';
  if (item.mime.startsWith('image/')) return 'mint';
  if (item.mime === 'application/pdf') return 'peach';
  if (item.mime.startsWith('video/')) return 'lilac';
  if (item.mime.startsWith('audio/')) return 'sky';
  return ['peach', 'lilac', 'mint', 'sky'][index % 4] ?? 'lilac';
}

function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return 'FILE';
  return name
    .slice(dot + 1)
    .slice(0, 5)
    .toUpperCase();
}

function greetingDate(): string {
  const locale = document.documentElement.lang === 'en' ? 'en-GB' : 'it-IT';
  const formatted = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' }).format(
    new Date(),
  );
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}

function quickCard(tone: string, iconName: string, title: string, hint: string, action: () => void): HTMLElement {
  return h(
    'button',
    { type: 'button', class: `quick-card ${tone}`, onclick: action },
    h('div', { class: 'q-icon' }, icon(iconName, 21)),
    h('div', { class: 'q-text' }, h('b', { text: title }), h('span', { text: hint })),
    h('span', { class: 'q-arrow' }, icon('arrow', 16)),
  );
}
