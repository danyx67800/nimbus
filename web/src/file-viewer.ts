import { ApiError, api, downloadUrl, fetchTextPreview } from './api.js';
import { t } from './i18n.js';
import { formatBytes, formatDate, h, icon, relativeTime } from './ui.js';

export interface ViewerFile {
  id: string;
  name: string;
  kind: 'file' | 'folder';
  size: number;
  mime: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  scanStatus?: string;
  ownerName?: string;
  isOwner?: boolean;
}

interface ViewerDetail {
  item: {
    ownerName?: string | null;
    isOwner?: boolean;
    shareCount?: number;
    publicLinkCount?: number;
  };
  breadcrumb?: Array<{ id: string; name: string }>;
}

export interface FileViewer {
  close: () => void;
  element: HTMLElement;
}

export function openFileViewer(file: ViewerFile, options: { showDetails?: boolean } = {}): FileViewer {
  const root = document.getElementById('overlays') ?? document.body;
  const previousFocus = document.activeElement as HTMLElement | null;
  let closed = false;
  let detailsOpen = options.showDetails === true;

  const tone = toneFor(file.mime);
  const url = downloadUrl(file.id);

  const metaGrid = h('dl', { class: 'fv-meta' });

  function addMeta(_key: string, label: string, value: string | HTMLElement): void {
    const dd = h('dd');
    dd.append(typeof value === 'string' ? document.createTextNode(value) : value);
    metaGrid.append(h('div', { class: 'fv-meta-row' }, h('dt', { text: label }), dd));
  }

  addMeta('name', t('common.name'), file.name);
  addMeta('type', t('viewer.type'), file.mime || t('files.file'));
  addMeta('size', t('viewer.size'), file.kind === 'folder' ? '—' : formatBytes(file.size));
  addMeta('modified', t('viewer.modifiedAt'), `${formatDate(file.updatedAt, true)} · ${relativeTime(file.updatedAt)}`);
  addMeta('version', t('viewer.version'), `v${file.version}`);
  addMeta('security', t('viewer.security'), scanBadge(file.scanStatus));

  const infoDate = h('strong', { text: formatDate(file.createdAt, true) });
  const infoAgo = h('span', { class: 'fv-ago', text: relativeTime(file.createdAt) });

  const infoPanel = h(
    'aside',
    { class: 'fv-info', 'aria-label': t('viewer.details'), hidden: !detailsOpen },
    h(
      'div',
      { class: 'fv-info-head' },
      h('span', { class: 'fv-kicker', text: t('viewer.uploadedAt') }),
      infoDate,
      infoAgo,
    ),
    metaGrid,
  );

  const stage = h(
    'div',
    { class: 'fv-stage' },
    h('span', { class: 'fv-spinner', role: 'status', 'aria-label': t('common.loading') }),
  );

  const detailsButton = h(
    'button',
    {
      type: 'button',
      class: 'fv-btn',
      'aria-pressed': String(detailsOpen),
      'aria-controls': 'file-viewer-info',
      title: t('viewer.details'),
      onclick: () => toggleDetails(),
    },
    icon('info', 16),
    h('span', { class: 'fv-btn-label', text: t('viewer.details') }),
  );

  const closeButton = h(
    'button',
    {
      type: 'button',
      class: 'fv-btn icon-only',
      'aria-label': t('common.close'),
      title: t('common.close'),
      onclick: () => close(),
    },
    icon('close', 18),
  );

  const downloadLink = h(
    'a',
    {
      class: 'fv-btn',
      href: downloadUrl(file.id, { inline: false }),
      download: file.name,
      title: t('common.download'),
    },
    icon('download', 16),
    h('span', { class: 'fv-btn-label', text: t('common.download') }),
  );

  const subtitle = h(
    'p',
    { class: 'fv-sub' },
    h('span', { text: fileExtension(file.name) }),
    h('span', { class: 'dot', 'aria-hidden': 'true' }),
    h('span', { text: file.kind === 'folder' ? t('files.folder') : formatBytes(file.size) }),
    h('span', { class: 'dot', 'aria-hidden': 'true' }),
    h('span', { text: `${t('viewer.uploadedAt')} ${relativeTime(file.createdAt)}` }),
  );

  const bar = h(
    'header',
    { class: 'fv-bar' },
    h('span', { class: `fv-type ${tone}` }, icon(iconFor(file.mime, file.kind), 20)),
    h('div', { class: 'fv-heading' }, h('h2', { text: file.name }), subtitle),
    h('div', { class: 'fv-actions' }, detailsButton, downloadLink, closeButton),
  );

  const shell = h('div', { class: 'fv-shell' }, bar, h('div', { class: 'fv-body' }, stage, infoPanel));
  infoPanel.id = 'file-viewer-info';
  const backdrop = h(
    'div',
    {
      class: 'fv-backdrop',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': file.name,
      onclick: (event: MouseEvent) => {
        if (event.target === backdrop) close();
      },
    },
    shell,
  );

  function toggleDetails(): void {
    detailsOpen = !detailsOpen;
    infoPanel.hidden = !detailsOpen;
    detailsButton.setAttribute('aria-pressed', String(detailsOpen));
    detailsButton.classList.toggle('is-on', detailsOpen);
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = shell.querySelectorAll<HTMLElement>('button, [href], audio[controls], video[controls], iframe');
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function close(): void {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    backdrop.classList.add('is-closing');
    window.setTimeout(() => backdrop.remove(), 150);
    previousFocus?.focus();
  }

  document.addEventListener('keydown', onKey);
  root.append(backdrop);
  closeButton.focus();
  renderStage();
  void loadDetails();

  return {
    close,
    element: backdrop,
  };

  function renderStage(): void {
    const mime = file.mime;
    if (mime.startsWith('image/')) {
      const image = h('img', {
        class: 'fv-image',
        src: url,
        alt: file.name,
        decoding: 'async',
        title: t('viewer.zoomIn'),
      });
      image.addEventListener('load', () => {
        stage.replaceChildren(image);
        stage.classList.remove('is-loading');
        if (image.naturalWidth && image.naturalHeight) {
          addMeta('dimensions', t('viewer.dimensions'), `${image.naturalWidth} × ${image.naturalHeight} px`);
        }
      });
      image.addEventListener('error', () => showFallback(t('files.previewUnavailable')));
      image.addEventListener('click', () => {
        const zoomed = stage.classList.toggle('is-zoomed');
        image.title = zoomed ? t('viewer.zoomOut') : t('viewer.zoomIn');
      });
      stage.addEventListener('dblclick', (event) => event.preventDefault());
      return;
    }
    if (mime.startsWith('video/')) {
      stage.replaceChildren(h('video', { class: 'fv-video', src: url, controls: true, playsinline: true }));
      stage.classList.remove('is-loading');
      return;
    }
    if (mime.startsWith('audio/')) {
      stage.replaceChildren(
        h(
          'div',
          { class: 'fv-audio' },
          h('span', { class: 'fv-art' }, icon('audio', 34)),
          h('p', { class: 'fv-audio-name', text: file.name }),
          h('audio', { src: url, controls: true }),
        ),
      );
      stage.classList.remove('is-loading');
      return;
    }
    if (mime === 'application/pdf') {
      stage.replaceChildren(h('iframe', { class: 'fv-frame', src: url, title: file.name }));
      stage.classList.remove('is-loading');
      return;
    }
    if (isTextLike(mime)) {
      void fetchTextPreview(file.id)
        .then((preview) => {
          if (closed) return;
          stage.replaceChildren(
            h(
              'div',
              { class: 'fv-text' },
              h('pre', { text: preview.text }),
              preview.truncated ? h('p', { class: 'hint', text: t('files.textTruncated') }) : null,
            ),
          );
          stage.classList.remove('is-loading');
        })
        .catch((error: unknown) => {
          showFallback(error instanceof ApiError ? error.message : t('files.previewUnavailable'));
        });
      return;
    }
    showFallback(t('files.previewUnavailable'));
  }

  function showFallback(message: string): void {
    stage.replaceChildren(
      h(
        'div',
        { class: 'fv-fallback' },
        h('span', { class: `fv-type ${tone}` }, icon(iconFor(file.mime, file.kind), 26)),
        h('p', { text: message }),
        h(
          'a',
          { class: 'btn primary', href: downloadUrl(file.id, { inline: false }), download: file.name },
          icon('download', 16),
          t('common.download'),
        ),
      ),
    );
    stage.classList.remove('is-loading');
  }

  async function loadDetails(): Promise<void> {
    try {
      const detail = await api<ViewerDetail>(`/api/files/${encodeURIComponent(file.id)}`);
      if (closed) return;
      const item = detail.item;
      const mine = item.isOwner ?? file.isOwner ?? false;
      addMeta('owner', t('viewer.uploadedBy'), item.ownerName ?? (mine ? t('viewer.you') : '—'));
      addMeta(
        'shares',
        t('viewer.shares'),
        item.shareCount ? t('viewer.shareCount', { n: item.shareCount }) : t('viewer.none'),
      );
      addMeta(
        'links',
        t('viewer.links'),
        item.publicLinkCount ? t('viewer.linkCount', { n: item.publicLinkCount }) : t('viewer.none'),
      );
      const crumbs = detail.breadcrumb ?? [];
      addMeta('location', t('viewer.location'), [t('viewer.root'), ...crumbs.map((crumb) => crumb.name)].join(' / '));
    } catch {
      // Metadata is best effort: the viewer keeps working without it.
    }
  }
}

function isTextLike(mime: string): boolean {
  return (
    mime.startsWith('text/') ||
    mime.includes('json') ||
    mime.includes('xml') ||
    mime === 'application/javascript' ||
    mime === 'application/x-yaml'
  );
}

function iconFor(mime: string, kind: 'file' | 'folder'): string {
  if (kind === 'folder') return 'folder';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  return 'file';
}

function toneFor(mime: string): 'accent' | 'mint' | 'peach' | 'lilac' | 'sky' {
  if (mime.startsWith('image/')) return 'mint';
  if (mime === 'application/pdf') return 'peach';
  if (mime.startsWith('video/')) return 'lilac';
  if (mime.startsWith('audio/')) return 'sky';
  return 'accent';
}

function scanBadge(status?: string): HTMLElement {
  const value = status ?? 'clean';
  if (value === 'infected') return h('span', { class: 'fv-badge danger', text: t('viewer.scanInfected') });
  if (value === 'pending') return h('span', { class: 'fv-badge warn', text: t('viewer.scanPending') });
  if (value === 'error') return h('span', { class: 'fv-badge warn', text: t('viewer.scanError') });
  return h('span', { class: 'fv-badge', text: t('viewer.scanClean') });
}

function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return 'FILE';
  return name
    .slice(dot + 1)
    .slice(0, 5)
    .toUpperCase();
}
