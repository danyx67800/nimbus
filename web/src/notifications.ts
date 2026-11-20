import { api, listRooms, savePushSubscription } from './api.js';
import { emit, events } from './bus.js';
import { t } from './i18n.js';
import { realtime } from './realtime.js';
import { navigate } from './router.js';
import { type ChatMessage, sortRoomsByRecent, state } from './store.js';
import { h, icon, openModal, relativeTime, toast } from './ui.js';

interface SiteNotification {
  id: string;
  title: string;
  body: string;
  url: string;
  createdAt: number;
  read: boolean;
}

const MAX_NOTIFICATIONS = 30;
const TOAST_INTERVAL = 2500;
const PROMPT_KEY = 'nimbus-notifications-prompted';

let notifications: SiteNotification[] = [];
let initialized = false;
let panelOpen = false;
let roomsRefreshTimer = 0;
const listeners = new Set<() => void>();
const lastToastAt = new Map<string, number>();

function notifyListeners(): void {
  for (const listener of [...listeners]) listener();
}

function subscribeNotifications(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function unreadNotificationCount(): number {
  return notifications.reduce((total, item) => total + (item.read ? 0 : 1), 0);
}

function addNotification(input: { title: string; body: string; url: string }): void {
  const id =
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  notifications = [{ id, ...input, createdAt: Date.now(), read: panelOpen }, ...notifications].slice(
    0,
    MAX_NOTIFICATIONS,
  );
  notifyListeners();
}

function markAllRead(): void {
  let changed = false;
  for (const item of notifications) {
    if (item.read) continue;
    item.read = true;
    changed = true;
  }
  if (changed) notifyListeners();
}

function clearNotifications(): void {
  notifications = [];
  notifyListeners();
}

export function resetNotifications(): void {
  window.clearTimeout(roomsRefreshTimer);
  notifications = [];
  lastToastAt.clear();
  notifyListeners();
}

function roomById(roomId: string): (typeof state.rooms)[number] | undefined {
  return state.rooms.find((room) => room.id === roomId);
}

function scheduleRoomsRefresh(): void {
  window.clearTimeout(roomsRefreshTimer);
  roomsRefreshTimer = window.setTimeout(() => {
    void listRooms()
      .then((rooms) => {
        state.rooms = rooms;
        emit(events.roomsUpdated);
      })
      .catch(() => undefined);
  }, 350);
}

function updateRoomList(message: ChatMessage): void {
  if (location.pathname.startsWith('/chat')) return;
  const room = roomById(message.roomId);
  if (!room) {
    scheduleRoomsRefresh();
    return;
  }
  room.unread += 1;
  room.updatedAt = message.createdAt;
  room.lastMessage = {
    id: message.id,
    senderId: message.sender.id,
    preview: message.body.slice(0, 120) || t('chat.attachment'),
    createdAt: message.createdAt,
  };
  state.rooms = sortRoomsByRecent(state.rooms);
  emit(events.roomsUpdated);
}

function showBrowserNotification(title: string, body: string, url: string, tag: string): void {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  void (async () => {
    try {
      if ('serviceWorker' in navigator) {
        const registration = await navigator.serviceWorker.getRegistration();
        if (registration) {
          await registration.showNotification(title, {
            body,
            icon: '/icon.svg',
            badge: '/icon.svg',
            tag,
            data: { url },
          });
          return;
        }
      }
    } catch {
      // Fall back to a page notification below.
    }
    try {
      const notification = new Notification(title, { body, icon: '/icon.svg', tag });
      notification.onclick = () => {
        window.focus();
        navigate(url);
        notification.close();
      };
    } catch {
      // Some platforms require a service worker registration.
    }
  })();
}

function handleMessage(message: ChatMessage): void {
  if (!message?.id || message.sender.id === state.user?.id) return;
  updateRoomList(message);
  const room = roomById(message.roomId);
  if (room?.muted) return;
  if (state.activeRoomId === message.roomId && document.visibilityState === 'visible') return;

  const title = room?.title ?? message.sender.displayName;
  const preview = message.body.slice(0, 160) || t('chat.attachment');
  const body = room && room.kind !== 'dm' ? `${message.sender.displayName}: ${preview}` : preview;
  const url = `/chat/${encodeURIComponent(message.roomId)}`;
  addNotification({ title, body, url });

  if (document.visibilityState === 'visible') {
    const now = Date.now();
    if (now - (lastToastAt.get(message.roomId) ?? 0) > TOAST_INTERVAL) {
      toast(`${title}: ${body}`, 'info');
      lastToastAt.set(message.roomId, now);
    }
    return;
  }
  showBrowserNotification(title, body, url, `room-${message.roomId}`);
}

export function initNotifications(): void {
  if (initialized) return;
  initialized = true;
  realtime.on('message:new', (payload) => {
    const message = payload.message as ChatMessage | undefined;
    if (message) handleMessage(message);
  });
}

/** Ask for notification permission on the first visit, once per browser. */
export function promptNotificationPermission(): void {
  if (!window.isSecureContext || !('Notification' in window)) return;
  if (Notification.permission !== 'default') return;
  try {
    if (localStorage.getItem(PROMPT_KEY)) return;
    localStorage.setItem(PROMPT_KEY, '1');
  } catch {
    return;
  }
  window.setTimeout(() => {
    openModal({
      title: t('notifications.promptTitle'),
      body: h('div', { class: 'stack' }, h('p', { class: 'soft', text: t('notifications.promptText') })),
      actions: [
        { label: t('notifications.promptLater') },
        {
          label: t('notifications.promptEnable'),
          kind: 'primary',
          onClick: () => {
            void enableBrowserNotifications();
          },
        },
      ],
    });
  }, 1000);
}

function base64ToUint8Array(value: string): Uint8Array {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) output[index] = raw.charCodeAt(index);
  return output;
}

export async function enableBrowserNotifications(): Promise<boolean> {
  if (!window.isSecureContext) {
    toast(t('settings.notificationHint'), 'error');
    return false;
  }
  if (!('Notification' in window)) {
    toast(t('notifications.unsupported'), 'error');
    return false;
  }
  let permission: NotificationPermission;
  try {
    permission = await Notification.requestPermission();
  } catch {
    toast(t('settings.pushDenied'), 'error');
    return false;
  }
  if (permission !== 'granted') {
    toast(t('settings.pushDenied'), 'error');
    return false;
  }
  // Also register Web Push so notifications keep arriving when the site is closed.
  try {
    if ('serviceWorker' in navigator && 'PushManager' in window) {
      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        const keyResponse = await api<{ publicKey: string }>('/api/push/public-key', { csrf: false });
        if (keyResponse.publicKey) {
          subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: base64ToUint8Array(keyResponse.publicKey).buffer as ArrayBuffer,
          });
        }
      }
      if (subscription) await savePushSubscription(subscription);
    }
  } catch {
    // Page notifications still work without a push subscription.
  }
  toast(t('notifications.enabled'), 'success');
  return true;
}

export interface NotificationCenter {
  button: HTMLButtonElement;
  destroy: () => void;
}

export function createNotificationCenter(): NotificationCenter {
  const badge = h('span', { class: 'notification-badge', hidden: true });
  const button = h(
    'button',
    {
      type: 'button',
      class: 'icon-btn notification-button',
      'aria-label': t('notifications.title'),
      title: t('notifications.title'),
      'aria-haspopup': 'dialog',
    },
    icon('bell', 18),
    badge,
  );
  let panel: HTMLElement | null = null;
  let listEl: HTMLElement | null = null;
  let footer: HTMLElement | null = null;

  const updateBadge = (): void => {
    const count = unreadNotificationCount();
    badge.hidden = count === 0;
    badge.textContent = count > 9 ? '9+' : String(count);
  };

  const renderList = (): void => {
    if (!listEl) return;
    listEl.replaceChildren();
    if (notifications.length === 0) {
      listEl.append(
        h('div', { class: 'notification-empty' }, icon('bell', 22), h('p', { text: t('notifications.empty') })),
      );
      return;
    }
    for (const item of notifications) {
      listEl.append(
        h(
          'button',
          {
            type: 'button',
            class: `notification-item${item.read ? '' : ' unread'}`,
            onclick: () => {
              item.read = true;
              notifyListeners();
              closePanel();
              navigate(item.url);
            },
          },
          h('span', { class: 'notification-item-icon' }, icon('chat', 16)),
          h(
            'span',
            { class: 'notification-item-copy' },
            h('strong', { text: item.title }),
            h('span', { class: 'notification-item-body', text: item.body }),
            h('span', { class: 'notification-item-time', text: relativeTime(item.createdAt) }),
          ),
        ),
      );
    }
  };

  const renderFooter = (): void => {
    if (!footer) return;
    footer.replaceChildren();
    if (!('Notification' in window)) {
      footer.append(h('span', { class: 'hint grow', text: t('notifications.unsupported') }));
    } else if (Notification.permission === 'granted') {
      footer.append(h('span', { class: 'hint grow', text: t('notifications.enabled') }));
    } else if (Notification.permission === 'denied') {
      footer.append(h('span', { class: 'hint grow', text: t('settings.pushDenied') }));
    } else {
      footer.append(
        h(
          'button',
          {
            type: 'button',
            class: 'btn small',
            onclick: () =>
              void enableBrowserNotifications().then((enabled) => {
                if (enabled) renderFooter();
              }),
          },
          icon('bell', 14),
          t('notifications.enable'),
        ),
      );
    }
    footer.append(
      h(
        'button',
        {
          type: 'button',
          class: 'btn small',
          onclick: () => {
            clearNotifications();
            closePanel();
          },
        },
        icon('trash', 14),
        t('notifications.clear'),
      ),
    );
  };

  const closePanel = (): void => {
    panelOpen = false;
    panel?.remove();
    panel = null;
    listEl = null;
    footer = null;
    document.removeEventListener('pointerdown', onPointer, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', closePanel);
    window.removeEventListener('scroll', onScroll, true);
  };

  const onPointer = (event: PointerEvent): void => {
    const target = event.target as Node;
    if (panel?.contains(target) || button.contains(target)) return;
    closePanel();
  };

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') closePanel();
  };

  const onScroll = (event: Event): void => {
    if (event.target instanceof Node && panel?.contains(event.target)) return;
    closePanel();
  };

  const openPanel = (): void => {
    if (panel) return;
    listEl = h('div', { class: 'notification-list' });
    footer = h('div', { class: 'notification-footer' });
    panel = h(
      'div',
      { class: 'notification-panel', role: 'dialog', 'aria-label': t('notifications.title') },
      h(
        'div',
        { class: 'notification-head' },
        h('strong', { text: t('notifications.title') }),
        h(
          'button',
          { type: 'button', class: 'icon-btn', 'aria-label': t('common.close'), onclick: closePanel },
          icon('close', 16),
        ),
      ),
      listEl,
      footer,
    );
    const root = document.getElementById('overlays') ?? document.body;
    root.append(panel);
    panelOpen = true;
    const rect = button.getBoundingClientRect();
    const width = Math.min(360, window.innerWidth - 24);
    panel.style.width = `${width}px`;
    panel.style.left = `${Math.min(window.innerWidth - width - 12, Math.max(12, rect.right - width))}px`;
    panel.style.top = `${rect.bottom + 8}px`;
    markAllRead();
    renderList();
    renderFooter();
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', closePanel);
    window.addEventListener('scroll', onScroll, true);
  };

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (panel) closePanel();
    else openPanel();
  });

  const unsubscribe = subscribeNotifications(() => {
    updateBadge();
    if (panelOpen) {
      renderList();
      renderFooter();
    }
  });
  updateBadge();

  return {
    button,
    destroy: () => {
      unsubscribe();
      closePanel();
    },
  };
}
