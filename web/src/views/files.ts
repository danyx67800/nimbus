import { ApiError, api, downloadUrl, fetchTextPreview, uploadFileVersion } from '../api.js';
import { on } from '../bus.js';
import { t } from '../i18n.js';
import { hashFile } from '../sha256.js';
import { state } from '../store.js';
import {
  avatarEl,
  confirmDialog,
  copyToClipboard,
  debounce,
  emptyState,
  fileIcon,
  formatBytes,
  formatDate,
  h,
  icon,
  openModal,
  promptDialog,
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

const LAYOUT_KEY = 'nimbus-files-layout';

export function renderFiles(options: { mode: Mode; folderId?: string; search?: string }): View {
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
  const layoutButton = h(
    'button',
    {
      type: 'button',
      class: 'icon-btn',
      'aria-label': layout === 'grid' ? t('files.listView') : t('files.gridView'),
      title: layout === 'grid' ? t('files.listView') : t('files.gridView'),
      onclick: () => {
        layout = layout === 'grid' ? 'list' : 'grid';
        try {
          localStorage.setItem(LAYOUT_KEY, layout);
        } catch {
          // ignore
        }
        updateLayoutButton();
        renderList();
      },
    },
    icon(layout === 'grid' ? 'list' : 'grid', 18),
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
    layoutButton,
  );

  const node = h('div', { class: 'files-shell' }, pageHead, toolbar, listRoot);

  function updateLayoutButton(): void {
    layoutButton.replaceChildren(icon(layout === 'grid' ? 'list' : 'grid', 18));
    layoutButton.setAttribute('aria-label', layout === 'grid' ? t('files.listView') : t('files.gridView'));
    layoutButton.setAttribute('title', layout === 'grid' ? t('files.listView') : t('files.gridView'));
  }

  function updateSubtitle(): void {
    if (mode === 'files') {
      const used = state.user?.usedBytes ?? 0;
      const quota = state.user?.quotaBytes ?? 0;
      subtitle.textContent = t('files.storage', { used: formatBytes(used), quota: formatBytes(quota) });
    } else if (mode === 'favorites') subtitle.textContent = 'I tuoi file e cartelle preferiti.';
    else if (mode === 'shared') subtitle.textContent = 'Elementi che altri utenti hanno condiviso con te.';
    else subtitle.textContent = 'Gli elementi eliminati restano qui fino all’eliminazione definitiva.';
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
    if (loading && items.length === 0) {
      listRoot.append(
        h(
          'div',
          { class: 'empty' },
          h('div', { class: 'empty-icon' }, icon('cloud', 28)),
          h('p', { text: t('common.loading') }),
        ),
      );
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

    if (layout === 'grid' && mode !== 'trash') {
      const grid = h('div', { class: 'file-grid' });
      for (const item of items) grid.append(fileCard(item));
      listRoot.append(grid);
      return;
    }
    const list = h('div', { class: 'file-list', role: 'list' });
    for (const item of items) list.append(fileRow(item));
    listRoot.append(list);
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

  function fileCard(item: FileItem): HTMLElement {
    const thumb = h('div', { class: 'thumb' });
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
    const card = h(
      'div',
      {
        class: 'file-card',
        role: 'button',
        tabindex: '0',
        onclick: () => openItem(item),
        onkeydown: (event: KeyboardEvent) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openItem(item);
          }
        },
      },
      thumb,
      h('div', { class: 'file-name', text: item.name }),
      h(
        'div',
        { class: 'file-meta' },
        h('span', { text: item.kind === 'folder' ? t('files.folder') : formatBytes(item.size) }),
        item.favorite ? icon('star', 13) : null,
      ),
      cardMenu(item),
    );
    return card;
  }

  function fileRow(item: FileItem): HTMLElement {
    const meta = item.ownerName
      ? t('files.sharedBy', { name: item.ownerName })
      : item.kind === 'folder'
        ? t('files.folder')
        : formatBytes(item.size);
    const row = h(
      'div',
      {
        class: 'file-row',
        role: 'listitem',
        tabindex: '0',
        onclick: () => openItem(item),
        onkeydown: (event: KeyboardEvent) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openItem(item);
          }
        },
      },
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
    const content = h('div', { class: 'preview-modal-content' }, h('p', { class: 'soft', text: t('common.loading') }));
    const modal = openModal({
      title: item.name,
      body: content,
      wide: true,
      actions: [
        {
          label: t('common.download'),
          kind: 'primary',
          close: false,
          onClick: () => download(item),
        },
        { label: t('common.close') },
      ],
    });
    const url = downloadUrl(item.id);
    const mime = item.mime;
    if (mime.startsWith('image/')) {
      content.replaceChildren(h('img', { src: url, alt: item.name }));
      return;
    }
    if (mime.startsWith('video/')) {
      content.replaceChildren(h('video', { src: url, controls: true, playsinline: true }));
      return;
    }
    if (mime.startsWith('audio/')) {
      content.replaceChildren(h('audio', { src: url, controls: true }));
      return;
    }
    if (mime === 'application/pdf') {
      content.replaceChildren(h('iframe', { src: url, title: item.name, sandbox: '' }));
      return;
    }
    if (
      mime.startsWith('text/') ||
      mime.includes('json') ||
      mime.includes('xml') ||
      mime === 'application/javascript'
    ) {
      try {
        const preview = await fetchTextPreview(item.id);
        content.replaceChildren(
          h(
            'div',
            { class: 'stack', style: { width: '100%', maxHeight: '62dvh', overflow: 'auto' } },
            h('pre', { text: preview.text }),
            preview.truncated ? h('div', { class: 'hint', text: t('files.textTruncated') }) : null,
          ),
        );
      } catch (error) {
        content.replaceChildren(
          h('p', { class: 'soft', text: error instanceof ApiError ? error.message : t('files.previewUnavailable') }),
        );
      }
      return;
    }
    content.replaceChildren(
      h(
        'div',
        { class: 'empty', style: { padding: '40px 20px' } },
        h('div', { class: 'empty-icon' }, fileIcon(item.kind, mime)),
        h('p', { text: t('files.previewUnavailable') }),
        h(
          'button',
          { type: 'button', class: 'btn', onclick: () => download(item) },
          icon('download', 16),
          t('common.download'),
        ),
      ),
    );
    void modal;
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
          const select = h(
            'select',
            { class: 'select', 'aria-label': t('files.shareWith') },
            h('option', { value: '', text: '—' }),
            ...available.map((contact) => h('option', { value: contact.id, text: contact.displayName })),
          );
          const permission = h(
            'select',
            { class: 'select', 'aria-label': t('files.permissionRead') },
            h('option', { value: 'read', text: t('files.permissionRead') }),
            h('option', { value: 'write', text: t('files.permissionWrite') }),
          );
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

  updateLayoutButton();
  updateSubtitle();
  renderBreadcrumb();
  renderList();
  void load();

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
      return 'Preferiti';
    case 'shared':
      return t('nav.shared');
    case 'trash':
      return t('nav.trash');
    default:
      return t('files.title');
  }
}

function readLayout(): 'list' | 'grid' {
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'grid' ? 'grid' : 'list';
  } catch {
    return 'list';
  }
}
