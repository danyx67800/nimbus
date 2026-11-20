import { getLanguage, t } from './i18n.js';
import { state } from './store.js';

type Child = Node | string | number | null | undefined | false;

export interface ElementAttrs {
  class?: string;
  text?: string;
  html?: string;
  dataset?: Record<string, string>;
  style?: Record<string, string | number>;
  children?: Child[];
  [key: string]: unknown;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: ElementAttrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'children' || value === undefined || value === null) continue;
    if (key === 'class') element.className = String(value);
    else if (key === 'text') element.textContent = String(value);
    else if (key === 'html')
      element.innerHTML = String(value); // only static, trusted icon markup
    else if (key === 'dataset') {
      for (const [dataKey, dataValue] of Object.entries(value as Record<string, string>))
        element.dataset[dataKey] = dataValue;
    } else if (key === 'style' && typeof value === 'object') {
      for (const [styleKey, styleValue] of Object.entries(value as Record<string, string | number>)) {
        element.style.setProperty(styleKey, String(styleValue));
      }
    } else if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'value' && element instanceof HTMLInputElement) {
      element.value = String(value);
    } else if (key === 'checked' && element instanceof HTMLInputElement) {
      element.checked = Boolean(value);
    } else if (typeof value === 'boolean') {
      if (value) element.setAttribute(key, '');
      else element.removeAttribute(key);
    } else {
      element.setAttribute(key, String(value));
    }
  }
  for (const child of [...(attrs.children ?? []), ...children]) {
    if (child === null || child === undefined || child === false) continue;
    element.append(
      typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child,
    );
  }
  return element;
}

const ICONS: Record<string, string> = {
  files:
    '<path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H10l2 2.2h5.5A2.5 2.5 0 0 1 20 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5Z"/>',
  chat: '<path d="M21 12a8 8 0 0 1-8 8H5l1.8-3.2A8 8 0 1 1 21 12Z"/><path d="M8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01"/>',
  phone:
    '<path d="M6.6 3.8 9 6.2a1.5 1.5 0 0 1 .2 1.9L8 10.4a12 12 0 0 0 5.6 5.6l2.3-1.2a1.5 1.5 0 0 1 1.9.2l2.4 2.4a1.5 1.5 0 0 1 0 2.1l-1.4 1.4c-.9.9-2.2 1.2-3.4.8A18 18 0 0 1 3.3 7.6c-.4-1.2 0-2.5.8-3.4L5.5 2.8a1.5 1.5 0 0 1 2.1 0Z"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="2.5"/><path d="m16 10 5-3v10l-5-3"/>',
  share:
    '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4"/>',
  trash:
    '<path d="M4 7h16M9 7V4.8A.8.8 0 0 1 9.8 4h4.4a.8.8 0 0 1 .8.8V7M6.5 7l.8 12.2a1.8 1.8 0 0 0 1.8 1.7h5.8a1.8 1.8 0 0 0 1.8-1.7L17.5 7"/><path d="M10 11v5M14 11v5"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  admin: '<path d="M12 3 4.5 6v5.2c0 4.6 3.1 8.2 7.5 9.8 4.4-1.6 7.5-5.2 7.5-9.8V6Z"/><path d="M9 12l2 2 4-4"/>',
  upload:
    '<path d="M12 16V4M7.5 8.5 12 4l4.5 4.5"/><path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"/>',
  folder:
    '<path d="M3.5 7.8A2.3 2.3 0 0 1 5.8 5.5h3.5l2 2.2h5.4a2.3 2.3 0 0 1 2.3 2.3v6.2a2.3 2.3 0 0 1-2.3 2.3H5.8a2.3 2.3 0 0 1-2.3-2.3Z"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/>',
  image:
    '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="1.7"/><path d="m4 18 5-5 4 4 3-3 4 4"/>',
  audio: '<path d="M9 18V5l10-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
  pdf: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5M8.5 16.5c1.5-.5 4-4 4.5-7.5.1-.8 1.6-.6 1.3.4-.5 1.8-2.9 6-5.5 7.2-.9.4-1.4-.6-.4-1Z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  download: '<path d="M12 4v12M7.5 11.5 12 16l4.5-4.5"/><path d="M4 17v2.5h16V17"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9Z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.1-1.1"/>',
  tag: '<path d="M20 13 13 20a2.8 2.8 0 0 1-4 0l-5-5a2.8 2.8 0 0 1-.8-2V5.5A1.5 1.5 0 0 1 4.7 4H10a2.8 2.8 0 0 1 2 .8l8 8a2.8 2.8 0 0 1 0 4.2Z"/><circle cx="7.5" cy="7.5" r="0.8"/>',
  users:
    '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><path d="M16 5.2a3 3 0 0 1 0 5.6M17 14.5a5 5 0 0 1 4 5.5"/>',
  logout: '<path d="M9 4H5.5A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20H9"/><path d="M16 8l4 4-4 4M20 12H9"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  spark:
    '<path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z"/><path d="m18.5 16.5.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7Z"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  paperclip: '<path d="m21 11.5-8.8 8.8a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7l-9 9a2 2 0 0 1-2.8-2.8l8.3-8.3"/>',
  check: '<path d="m5 12 5 5L20 6"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/>',
  micOff:
    '<path d="m3 3 18 18"/><path d="M9 9v2a3 3 0 0 0 5 2.2M15 10V6a3 3 0 0 0-5.8-1M5 11a7 7 0 0 0 10.6 6M12 18v3M9 21h6"/>',
  camera: '<rect x="3" y="6" width="13" height="12" rx="2.5"/><path d="m16 10 5-3v10l-5-3"/>',
  cameraOff:
    '<path d="m3 3 18 18"/><path d="M10.5 6H8a2.5 2.5 0 0 0-2.5 2.5v7A2.5 2.5 0 0 0 8 18h7a2.5 2.5 0 0 0 2.3-1.5M16 10l5-3v8"/>',
  screen: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  bell: '<path d="M18 9a6 6 0 1 0-12 0c0 6-3 7-3 7h18s-3-1-3-7"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  shield: '<path d="M12 3 4.5 6v5.2c0 4.6 3.1 8.2 7.5 9.8 4.4-1.6 7.5-5.2 7.5-9.8V6Z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  cloud: '<path d="M7 18a4.5 4.5 0 0 1-.4-9A6 6 0 0 1 18 8.5a4.8 4.8 0 0 1 .5 9.5Z"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/>',
  arrowLeft: '<path d="m15 18-6-6 6-6"/>',
  play: '<path d="m8 5 11 7-11 7Z"/>',
  grid: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
  kanban:
    '<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="9.5" y="4" width="5" height="11" rx="1.5"/><rect x="16" y="4" width="5" height="7" rx="1.5"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l2 2M14 9l2 2"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.8h.01"/>',
  checkSquare: '<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="m8 12 2.5 2.5L16 9"/>',
};

export function icon(name: string, size = 18): HTMLElement {
  const markup = ICONS[name] ?? ICONS.file ?? '';
  const span = h('span', {
    class: 'icon',
    style: { display: 'inline-flex', width: `${size}px`, height: `${size}px`, flex: '0 0 auto' },
    html: `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${markup}</svg>`,
  });
  return span;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ''}${parts[1]![0] ?? ''}`.toUpperCase();
}

export function avatarHue(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}

export function avatarEl(
  user: { id: string; displayName: string; status?: string },
  options: { size?: 'sm' | 'lg' | 'xl'; showStatus?: boolean } = {},
): HTMLElement {
  const hue = avatarHue(user.id);
  const element = h('span', {
    class: ['avatar', options.size ?? ''].filter(Boolean).join(' '),
    style: {
      background: `linear-gradient(135deg, hsl(${hue} 72% 56%), hsl(${(hue + 45) % 360} 68% 46%))`,
    },
    title: user.displayName,
    'aria-hidden': 'true',
  });
  element.append(document.createTextNode(initials(user.displayName)));
  if (options.showStatus !== false && user.status) {
    const dot = h('span', { class: `status-dot ${user.status}` });
    element.append(dot);
  }
  return element;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[index]}`;
}

export function formatDate(timestamp: number, long = false): string {
  const locale = getLanguage() === 'en' ? 'en-GB' : 'it-IT';
  return new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: long ? 'long' : 'short',
    year: 'numeric',
    ...(long ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(new Date(timestamp));
}

export function formatTime(timestamp: number): string {
  const locale = getLanguage() === 'en' ? 'en-GB' : 'it-IT';
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp));
}

export function relativeTime(timestamp: number): string {
  const diff = timestamp - Date.now();
  const abs = Math.abs(diff);
  const locale = getLanguage() === 'en' ? 'en' : 'it';
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (abs < 60_000) return formatter.format(Math.round(diff / 1000), 'second');
  if (abs < 3_600_000) return formatter.format(Math.round(diff / 60_000), 'minute');
  if (abs < 86_400_000) return formatter.format(Math.round(diff / 3_600_000), 'hour');
  if (abs < 7 * 86_400_000) return formatter.format(Math.round(diff / 86_400_000), 'day');
  return formatDate(timestamp);
}

export function statusLabel(status: string): string {
  return t(`common.${status}`, {});
}

export function fileIcon(kind: string, mime = ''): HTMLElement {
  const name =
    kind === 'folder'
      ? 'folder'
      : mime.startsWith('image/')
        ? 'image'
        : mime.startsWith('video/')
          ? 'video'
          : mime.startsWith('audio/')
            ? 'audio'
            : mime === 'application/pdf'
              ? 'pdf'
              : 'file';
  return h('span', { class: `file-icon ${kind === 'folder' ? 'folder' : ''}` }, icon(name, 18));
}

let toastStack: HTMLElement | null = null;

export function toast(message: string, type: 'info' | 'success' | 'error' = 'info', timeout = 4200): void {
  if (!toastStack) {
    toastStack = h('div', { class: 'toast-stack', role: 'region', 'aria-label': 'Notifiche' });
    document.body.append(toastStack);
  }
  const close = (): void => element.remove();
  const element = h(
    'div',
    { class: `toast ${type}`, role: 'status' },
    h('div', { class: 'toast-body', text: message }),
    h('button', { type: 'button', 'aria-label': t('common.close'), onclick: close }, icon('close', 14)),
  );
  toastStack.append(element);
  window.setTimeout(() => element.remove(), timeout);
}

export interface ModalAction {
  label: string;
  kind?: 'primary' | 'danger' | 'default';
  close?: boolean;
  onClick?: () => void | Promise<void>;
}

export interface ModalOptions {
  title: string;
  body: Node | string;
  actions?: ModalAction[];
  wide?: boolean;
  className?: string;
  onClose?: () => void;
}

export interface OpenModal {
  close: () => void;
  element: HTMLElement;
  body: HTMLElement;
}

export function openModal(options: ModalOptions): OpenModal {
  const root = document.getElementById('overlays') ?? document.body;
  const previousFocus = document.activeElement as HTMLElement | null;
  const titleId = `modal-title-${Math.random().toString(36).slice(2)}`;
  const body = h('div', { class: 'modal-body' });
  if (typeof options.body === 'string') body.append(h('p', { text: options.body }));
  else body.append(options.body);

  const closeButton = h(
    'button',
    { type: 'button', class: 'icon-btn modal-close', 'aria-label': t('common.close'), onclick: () => close() },
    icon('close', 18),
  );
  const footer = h('div', { class: 'modal-footer' });
  for (const action of options.actions ?? []) {
    footer.append(
      h(
        'button',
        {
          type: 'button',
          class: `btn ${action.kind === 'primary' ? 'primary' : action.kind === 'danger' ? 'danger' : ''}`,
          onclick: async () => {
            try {
              await action.onClick?.();
              if (action.close !== false) close();
            } catch (error) {
              toast(error instanceof Error ? error.message : t('common.error'), 'error');
            }
          },
          text: action.label,
        },
        action.kind === 'primary' ? icon('check', 15) : null,
      ),
    );
  }
  if ((options.actions ?? []).length === 0) footer.remove();

  const modal = h(
    'div',
    {
      class: `modal ${options.wide ? 'wide' : ''} ${options.className ?? ''}`.trim(),
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': titleId,
    },
    h('div', { class: 'modal-header' }, h('h2', { id: titleId, text: options.title }), closeButton),
    body,
    footer,
  );
  const backdrop = h(
    'div',
    {
      class: 'modal-backdrop',
      onclick: (event: MouseEvent) => {
        if (event.target === backdrop) close();
      },
    },
    modal,
  );
  root.append(backdrop);

  const onKey = (event: KeyboardEvent): void => {
    const modals = root.querySelectorAll<HTMLElement>('.modal');
    if (modals.length > 0 && modals[modals.length - 1] !== modal) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = modal.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
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
  };
  document.addEventListener('keydown', onKey);
  const focusTarget = modal.querySelector<HTMLElement>('input, textarea, select, button.primary, button');
  focusTarget?.focus();

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    options.onClose?.();
    previousFocus?.focus();
  };
  return { close, element: modal, body };
}

export function confirmDialog(options: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const modal = openModal({
      title: options.title,
      body: h('p', { class: 'soft', text: options.message }),
      actions: [
        {
          label: t('common.cancel'),
          onClick: () => {
            answered = true;
            resolve(false);
          },
        },
        {
          label: options.confirmLabel ?? t('common.confirm'),
          kind: options.danger ? 'danger' : 'primary',
          onClick: () => {
            answered = true;
            resolve(true);
          },
        },
      ],
      onClose: () => {
        if (!answered) resolve(false);
      },
    });
    void modal;
  });
}

export function promptDialog(options: {
  title: string;
  label: string;
  value?: string;
  placeholder?: string;
  confirmLabel?: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    let answered = false;
    const input = h('input', {
      class: 'input',
      value: options.value ?? '',
      placeholder: options.placeholder ?? '',
      maxlength: '300',
    });
    const modal = openModal({
      title: options.title,
      body: h('div', { class: 'field' }, h('label', { text: options.label, for: 'prompt-input' }), input),
      actions: [
        {
          label: t('common.cancel'),
          onClick: () => {
            answered = true;
            resolve(null);
          },
        },
        {
          label: options.confirmLabel ?? t('common.save'),
          kind: 'primary',
          onClick: () => {
            answered = true;
            resolve(input.value.trim());
          },
        },
      ],
      onClose: () => {
        if (!answered) resolve(null);
      },
    });
    input.id = 'prompt-input';
    void modal;
  });
}

export function emptyState(iconName: string, title: string, text: string, action?: HTMLElement): HTMLElement {
  return h(
    'div',
    { class: 'empty' },
    h('div', { class: 'empty-icon' }, icon(iconName, 30)),
    h('h2', { text: title }),
    h('p', { text }),
    action ?? null,
  );
}

export interface MenuItem {
  label: string;
  iconName?: string;
  dotColor?: string;
  selected?: boolean;
  danger?: boolean;
  onClick: () => void | Promise<void>;
}

export interface SelectPillOption {
  value: string;
  label: string;
  dotColor?: string;
}

export interface SelectPillOptions {
  options: SelectPillOption[];
  value?: string;
  id?: string;
  className?: string;
  ariaLabel?: string;
  placeholder?: string;
}

export function createSelectPill(options: SelectPillOptions): HTMLButtonElement {
  const requested = options.value;
  let current =
    requested !== undefined && options.options.some((option) => option.value === requested)
      ? requested
      : (options.options[0]?.value ?? '');
  const dot = h('span', { class: 'select-pill-dot', 'aria-hidden': 'true' });
  const valueLabel = h('span', { class: 'select-pill-value' });
  const button = h(
    'button',
    {
      type: 'button',
      id: options.id,
      class: `select-pill ${options.className ?? ''}`.trim(),
      'aria-haspopup': 'menu',
      disabled: options.options.length === 0,
      onclick: (event: MouseEvent) => {
        event.stopPropagation();
        openMenu();
      },
    },
    dot,
    valueLabel,
    icon('chevronDown', 14),
  );

  function sync(): void {
    const selected = options.options.find((option) => option.value === current);
    const text = selected?.label ?? options.placeholder ?? '—';
    valueLabel.textContent = text;
    button.classList.toggle('is-placeholder', !selected || selected.value === '');
    dot.hidden = !selected?.dotColor;
    if (selected?.dotColor) dot.style.background = selected.dotColor;
    button.setAttribute('aria-label', options.ariaLabel ? `${options.ariaLabel}: ${text}` : text);
  }

  function openMenu(): void {
    showMenu(
      button,
      options.options.map((option) => ({
        label: option.label,
        dotColor: option.dotColor,
        selected: option.value === current,
        onClick: () => {
          if (option.value === current) return;
          current = option.value;
          button.value = current;
          sync();
          button.dispatchEvent(new Event('change', { bubbles: true }));
          button.focus();
        },
      })),
    );
  }

  button.value = current;
  sync();
  return button;
}

export function showMenu(anchor: HTMLElement, items: MenuItem[]): void {
  for (const menu of document.querySelectorAll('.menu')) menu.remove();
  const menu = h('div', { class: 'menu', role: 'menu' });
  for (const item of items) {
    menu.append(
      h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          class: item.danger ? 'danger' : '',
          onclick: async () => {
            menu.remove();
            try {
              await item.onClick();
            } catch (error) {
              toast(error instanceof Error ? error.message : t('common.error'), 'error');
            }
          },
        },
        item.dotColor
          ? h('span', { class: 'menu-dot', style: { background: item.dotColor }, 'aria-hidden': 'true' })
          : item.iconName
            ? icon(item.iconName, 16)
            : null,
        h('span', { class: 'menu-label', text: item.label }),
        item.selected ? h('span', { class: 'menu-check' }, icon('check', 15)) : null,
      ),
    );
  }
  const root = document.getElementById('overlays') ?? document.body;
  root.append(menu);
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const left = Math.min(window.innerWidth - width - 8, Math.max(8, rect.right - width));
  const top = rect.bottom + height + 8 > window.innerHeight ? Math.max(8, rect.top - height - 6) : rect.bottom + 6;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const close = (): void => {
    menu.remove();
    document.removeEventListener('pointerdown', onPointer, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close);
    window.removeEventListener('scroll', close, true);
  };
  const onPointer = (event: PointerEvent): void => {
    if (!menu.contains(event.target as Node)) close();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') close();
  };
  document.addEventListener('pointerdown', onPointer, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', close);
  window.addEventListener('scroll', close, true);
  menu.querySelector<HTMLButtonElement>('button')?.focus();
}

export async function copyToClipboard(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // fall through
  }
  try {
    const textarea = h('textarea', { value, style: { position: 'fixed', opacity: '0', top: '0' } });
    document.body.append(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}

export function debounce<T extends (...args: never[]) => void>(fn: T, delay: number): (...args: Parameters<T>) => void {
  let timer = 0;
  return (...args: Parameters<T>) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), delay);
  };
}

export function badge(text: string, kind: 'success' | 'warn' | 'danger' | '' = ''): HTMLElement {
  return h('span', { class: `badge ${kind}`, text });
}

export function currentPresenceStatus(): 'online' | 'away' | 'dnd' | 'offline' {
  const preference = state.user?.presence ?? 'online';
  if (preference === 'hidden') return 'offline';
  return preference === 'online' || preference === 'away' || preference === 'dnd' ? preference : 'offline';
}
