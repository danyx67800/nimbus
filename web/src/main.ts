import { ApiError, api, getMe, listContacts, listRooms, setCsrf } from './api.js';
import { events, on } from './bus.js';
import { initCalls } from './calls-manager.js';
import { setLanguage } from './i18n.js';
import { initNotifications, promptNotificationPermission, resetNotifications } from './notifications.js';
import { initQuickShare } from './quick-share.js';
import { realtime } from './realtime.js';
import { initRouter, rerender, setRenderer } from './router.js';
import { type AppConfig, applyPresence, setConfig, setContacts, setUser, state } from './store.js';
import { applyTheme, rememberLanguage, storedLanguage, storedTheme } from './theme.js';
import { toast } from './ui.js';
import { renderInvite, renderLogin, renderSetup } from './views/auth.js';
import { renderPublicShare } from './views/public-share.js';
import { renderShell } from './views/shell.js';
import type { View } from './views/types.js';

const appRoot = document.getElementById('app') as HTMLElement;
let currentCleanup: (() => void) | undefined;
let managersReady = false;
let session: Awaited<ReturnType<typeof getMe>> | null = null;
let lastMountedPath = '';

function mount(node: HTMLElement, cleanup?: () => void): void {
  currentCleanup?.();
  currentCleanup = undefined;
  const path = `${location.pathname}${location.search}`;
  if (path !== lastMountedPath) {
    node.classList.add('route-enter');
    lastMountedPath = path;
  }
  appRoot.replaceChildren(node);
  currentCleanup = cleanup;
  window.scrollTo({ top: 0 });
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Errore imprevisto';
}

function applyUserPreferences(): void {
  if (!state.user) return;
  const lang =
    state.user.locale === 'en' || state.user.locale === 'it'
      ? state.user.locale
      : (state.config?.defaultLocale ?? 'it');
  setLanguage(lang);
  rememberLanguage(lang);
  const theme =
    state.user.theme === 'light' ||
    state.user.theme === 'dark' ||
    state.user.theme === 'black' ||
    state.user.theme === 'system'
      ? state.user.theme
      : storedTheme();
  applyTheme(theme);
}

async function hydrate(result: Awaited<ReturnType<typeof getMe>>): Promise<void> {
  session = result;
  setCsrf(result.csrfToken);
  setUser(result.user);
  applyUserPreferences();
  const [contacts, rooms] = await Promise.all([listContacts(), listRooms()]);
  setContacts(contacts);
  state.rooms = rooms;
  if (!managersReady) {
    managersReady = true;
    initCalls();
    initQuickShare();
    initNotifications();
    on(events.userUpdated, () => {
      applyUserPreferences();
      rerender();
    });
    on('nimbus:files-changed', () => {
      void refreshUser();
    });
    on('nimbus:ws-state', (detail) => {
      const connected = Boolean((detail as { connected?: boolean } | null)?.connected);
      if (connected) {
        void refreshContacts();
        void refreshRooms();
      }
    });
    realtime.on('ready', () => {
      void refreshContacts();
      void refreshRooms();
    });
    realtime.on('presence:update', (payload) => {
      const user = payload.user as
        | { id?: string; displayName?: string; status?: string; presence?: string }
        | undefined;
      if (!user?.id) return;
      // Hub events use `status`; profile updates broadcast `presence`.
      const raw = user.status ?? user.presence;
      if (!raw) return;
      const status = raw === 'online' || raw === 'away' || raw === 'dnd' ? raw : 'offline';
      applyPresence(user.id, status, user.displayName);
      window.dispatchEvent(new CustomEvent(events.contactsUpdated));
    });
  }
  realtime.connect();
  // Do not wait for the first WebSocket frame: the contact list is also the
  // source of truth for the quick-share overlay and must reflect newly
  // created users immediately.
  void refreshContacts();
  renderRoute();
  promptNotificationPermission();
}

export async function refreshUser(): Promise<void> {
  if (!state.user) return;
  try {
    const result = await getMe();
    session = result;
    setUser(result.user);
    setCsrf(result.csrfToken);
    window.dispatchEvent(new CustomEvent('nimbus:user-refreshed'));
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return;
    toast(errorMessage(error), 'error');
  }
}

export async function refreshContacts(): Promise<void> {
  try {
    setContacts(await listContacts());
    window.dispatchEvent(new CustomEvent(events.contactsUpdated));
  } catch {
    // contact refresh is best-effort
  }
}

export async function refreshRooms(): Promise<void> {
  try {
    state.rooms = await listRooms();
    window.dispatchEvent(new CustomEvent(events.roomsUpdated));
  } catch {
    // best effort
  }
}

async function showLogin(notice?: string): Promise<void> {
  if (!state.config) return;
  realtime.close();
  setUser(null);
  session = null;
  state.contacts = [];
  state.rooms = [];
  state.activeRoomId = null;
  resetNotifications();
  mount(renderLogin(state.config, notice));
}

function setupNeeded(): boolean {
  return Boolean(state.config?.needsSetup);
}

async function route(): Promise<void> {
  const path = location.pathname;
  const config = state.config;
  if (!config) return;

  if (path.startsWith('/p/')) {
    mount(await renderPublicShare(path.slice(3)));
    return;
  }
  if (path.startsWith('/invite/')) {
    mount(await renderInvite(config, path.slice(8)));
    return;
  }

  if (setupNeeded()) {
    if (path !== '/setup') history.replaceState(null, '', '/setup');
    mount(renderSetup(config));
    return;
  }

  if (!state.user || !session) {
    try {
      const me = await getMe();
      await hydrate(me);
      return;
    } catch (error) {
      if (path === '/setup') history.replaceState(null, '', '/');
      mount(renderLogin(config, error instanceof ApiError && error.status === 401 ? undefined : errorMessage(error)));
      return;
    }
  }

  if (path === '/setup') {
    history.replaceState(null, '', '/');
    renderRoute();
    return;
  }

  const view: View = renderShell(path);
  const node = view.node;
  const cleanup = view.destroy;
  // The view can be replaced asynchronously (files/chat load); the shell keeps its own cleanup.
  mount(node, cleanup);
  if (view.flush) node.classList.add('flush');
}

function renderRoute(): void {
  void route().catch((error) => {
    if (error instanceof ApiError && error.status === 401) {
      void showLogin();
      return;
    }
    toast(errorMessage(error), 'error');
  });
}

async function boot(): Promise<void> {
  try {
    const config = await api<AppConfig>('/api/config', { csrf: false });
    setConfig(config);
    setLanguage(storedLanguage() ?? config.defaultLocale);
    applyTheme(storedTheme());
    initRouter();
    setRenderer(renderRoute);
    window.addEventListener('nimbus:unauthorized', () => {
      void showLogin('Sessione scaduta. Accedi di nuovo.');
    });
    const path = location.pathname;
    if (path.startsWith('/p/') || path.startsWith('/invite/')) {
      await route();
      return;
    }
    if (config.needsSetup) {
      if (path !== '/setup') history.replaceState(null, '', '/setup');
      mount(renderSetup(config));
      return;
    }
    try {
      const me = await getMe();
      await hydrate(me);
    } catch (error) {
      if (error instanceof ApiError && error.status !== 401) toast(errorMessage(error), 'error');
      mount(renderLogin(config));
    }
  } catch (error) {
    appRoot.replaceChildren(
      Object.assign(document.createElement('div'), {
        className: 'offline-page',
        textContent: `Impossibile contattare il server: ${errorMessage(error)}`,
      }),
    );
  }
}

window.addEventListener('online', () => {
  if (state.user) realtime.connect();
});

if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}

void boot();
