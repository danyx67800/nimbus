import { api } from '../api.js';
import { events, on } from '../bus.js';
import { t } from '../i18n.js';
import { createNotificationCenter } from '../notifications.js';
import { openQuickSharePicker } from '../quick-share.js';
import { navigate } from '../router.js';
import { openSpotlight, spotlightShortcutLabel } from '../spotlight.js';
import { state, storageUsed } from '../store.js';
import { avatarEl, currentPresenceStatus, formatBytes, h, icon, showMenu, toast } from '../ui.js';
import { renderAdmin } from './admin.js';
import { renderBoard } from './board.js';
import { renderCalls } from './calls.js';
import { renderChat } from './chat.js';
import { renderFiles } from './files.js';
import { renderHelp } from './help.js';
import { renderSettings } from './settings.js';
import type { View } from './types.js';

const NAV = [
  { key: 'files', path: '/files', icon: 'files', label: 'nav.files' },
  { key: 'favorites', path: '/favorites', icon: 'star', label: 'nav.favorites' },
  { key: 'board', path: '/board', icon: 'kanban', label: 'nav.board' },
  { key: 'chat', path: '/chat', icon: 'chat', label: 'nav.chat' },
  { key: 'calls', path: '/calls', icon: 'phone', label: 'nav.calls' },
  { key: 'shared', path: '/shared', icon: 'share', label: 'nav.shared' },
  { key: 'trash', path: '/trash', icon: 'trash', label: 'nav.trash' },
];

const BOTTOM_NAV = [
  { key: 'settings', path: '/settings', icon: 'settings', label: 'nav.settings' },
  { key: 'help', path: '/help', icon: 'lock', label: 'nav.help' },
];

function sectionFor(path: string): string {
  if (path.startsWith('/board')) return 'board';
  if (path.startsWith('/chat')) return 'chat';
  if (path.startsWith('/calls')) return 'calls';
  if (path.startsWith('/shared')) return 'shared';
  if (path.startsWith('/trash')) return 'trash';
  if (path.startsWith('/favorites')) return 'favorites';
  if (path.startsWith('/settings')) return 'settings';
  if (path.startsWith('/admin')) return 'admin';
  if (path.startsWith('/help')) return 'help';
  return 'files';
}

function renderView(path: string): View {
  const params = new URLSearchParams(location.search);
  const section = sectionFor(path);
  if (section === 'board') {
    return renderBoard({
      projectId: params.get('project') ?? undefined,
      cardId: params.get('card') ?? undefined,
    });
  }
  if (section === 'chat') {
    const roomId = path.startsWith('/chat/') ? path.slice('/chat/'.length) : undefined;
    return {
      ...renderChat(roomId, {
        directUserId: params.get('dm') ?? undefined,
        search: params.get('q') ?? undefined,
      }),
      flush: true,
    };
  }
  if (section === 'calls') return renderCalls();
  if (section === 'shared') return renderFiles({ mode: 'shared' });
  if (section === 'trash') return renderFiles({ mode: 'trash' });
  if (section === 'settings') return renderSettings();
  if (section === 'admin') return renderAdmin();
  if (section === 'help') return renderHelp();
  return renderFiles({
    mode: path.startsWith('/favorites') ? 'favorites' : 'files',
    folderId: params.get('folder') ?? undefined,
    search: params.get('q') ?? undefined,
    openFileId: params.get('file') ?? undefined,
  });
}

export function renderShell(path: string): View {
  const user = state.user;
  if (!user) return { node: h('div') };
  const section = sectionFor(path);
  const unread = state.rooms.reduce((total, room) => total + room.unread, 0);
  const storage = storageUsed();
  const nav = h('nav', { class: 'nav', 'aria-label': 'Navigazione principale' });

  const appendLink = (entry: { key: string; path: string; icon: string; label: string }): void => {
    const badge =
      entry.key === 'chat' && unread > 0
        ? h('span', { class: 'nav-badge', id: 'nav-chat-badge', text: String(unread) })
        : null;
    nav.append(
      h(
        'a',
        {
          class: `nav-link ${section === entry.key ? 'active' : ''}`,
          href: entry.path,
          'aria-current': section === entry.key ? 'page' : undefined,
        },
        icon(entry.icon, 18),
        h('span', { text: t(entry.label) }),
        badge,
      ),
    );
  };

  for (const entry of NAV) {
    if (entry.key === 'shared' || entry.key === 'trash') {
      if (entry.key === 'shared') nav.append(h('div', { class: 'nav-label', text: 'Organizza' }));
    }
    appendLink(entry);
  }
  nav.append(h('div', { class: 'nav-label', text: 'Sistema' }));
  for (const entry of BOTTOM_NAV) appendLink(entry);
  if (user.role === 'admin') {
    appendLink({ key: 'admin', path: '/admin', icon: 'admin', label: 'nav.admin' });
  }

  const spacePercent = h('span', { text: `${Math.round(storage.percent)}%` });
  const spaceUsed = h('b', { text: formatBytes(storage.used) });
  const spaceQuota = h('small', { text: t('home.ofQuota', { quota: formatBytes(storage.quota) }) });
  const spaceBar = h('i', { style: { width: `${Math.min(100, storage.percent)}%` } });
  const spaceTrack = h(
    'div',
    {
      class: 'track',
      role: 'progressbar',
      'aria-valuenow': String(Math.round(storage.percent)),
      'aria-valuemin': '0',
      'aria-valuemax': '100',
    },
    spaceBar,
  );
  const spaceCard = h(
    'div',
    { class: 'space-card' },
    h('div', { class: 'lab' }, h('span', { text: t('settings.storage') }), spacePercent),
    h('div', { class: 'amount' }, spaceUsed, spaceQuota),
    spaceTrack,
  );

  const avatar = avatarEl({ id: user.id, displayName: user.displayName, status: currentPresenceStatus() });
  const notificationCenter = createNotificationCenter();
  const openUserMenu = (anchor: HTMLElement): void => {
    showMenu(anchor, [
      { label: t('nav.settings'), iconName: 'settings', onClick: () => navigate('/settings') },
      { label: t('nav.help'), iconName: 'lock', onClick: () => navigate('/help') },
      {
        label: t('common.logout'),
        iconName: 'logout',
        danger: true,
        onClick: async () => {
          try {
            await api('/api/auth/logout', { method: 'POST' });
          } catch {
            // ignore, cookie may already be invalid
          }
          location.assign('/');
        },
      },
    ]);
  };
  const userMenuButton = h(
    'button',
    {
      type: 'button',
      class: 'icon-btn',
      'aria-label': 'Menu utente',
      onclick: (event: MouseEvent) => openUserMenu(event.currentTarget as HTMLElement),
    },
    icon('more', 18),
  );
  const topbarAvatar = h(
    'button',
    {
      type: 'button',
      class: 'topbar-avatar',
      'aria-label': 'Menu utente',
      title: user.displayName,
      onclick: (event: MouseEvent) => openUserMenu(event.currentTarget as HTMLElement),
    },
    avatarEl(
      { id: user.id, displayName: user.displayName, status: currentPresenceStatus() },
      { size: 'lg', showStatus: false },
    ),
  );

  const sidebar = h(
    'aside',
    { class: 'sidebar', id: 'sidebar' },
    h(
      'a',
      { class: 'sidebar-brand', href: '/files', style: { textDecoration: 'none', color: 'inherit' } },
      h('div', {
        class: 'brand-mark',
        'aria-hidden': 'true',
        text: state.config?.appName.slice(0, 1).toUpperCase() ?? 'N',
      }),
      h(
        'div',
        {},
        h('strong', { text: state.config?.appName ?? 'Nimbus' }),
        h('span', { text: t('home.personalSpace') }),
      ),
    ),
    nav,
    h(
      'div',
      { class: 'sidebar-footer' },
      spaceCard,
      h(
        'div',
        { class: 'user-card' },
        avatar,
        h(
          'div',
          { class: 'grow' },
          h('div', { class: 'name', text: user.displayName }),
          h('div', { class: 'sub', text: user.role === 'admin' ? t('admin.admin') : `@${user.username}` }),
        ),
        userMenuButton,
      ),
    ),
  );

  const view = renderView(path);
  const topbarSearch = h(
    'button',
    {
      type: 'button',
      class: 'topbar-search',
      'aria-label': t('spotlight.open'),
      title: `${t('spotlight.open')} (${spotlightShortcutLabel()})`,
      'aria-keyshortcuts': 'Meta+K Control+K',
      onclick: () => openSpotlight(),
    },
    icon('search', 18),
    h('span', { class: 'topbar-search-label', text: t('spotlight.searchPlaceholder') }),
    h('kbd', { class: 'topbar-search-kbd', text: spotlightShortcutLabel() }),
  );
  const quickShareButton = h(
    'button',
    {
      type: 'button',
      class: 'icon-btn',
      'aria-label': t('qs.title'),
      title: t('qs.title'),
      onclick: () => {
        if (!window.isSecureContext) toast(t('qs.insecure'), 'error');
        else openQuickSharePicker();
      },
    },
    icon('share', 18),
  );
  const menuButton = h(
    'button',
    {
      type: 'button',
      class: 'icon-btn mobile-menu',
      'aria-label': 'Apri menu',
      onclick: () => shell.classList.toggle('sidebar-open'),
    },
    icon('menu', 20),
  );
  const secureBanner = !window.isSecureContext
    ? h(
        'div',
        { class: 'secure-banner', role: 'status' },
        icon('lock', 16),
        h(
          'div',
          { class: 'grow' },
          h('span', { text: `${t('help.insecureBanner')} ` }),
          h('a', { href: '/help', text: t('settings.httpsGuide') }),
        ),
      )
    : null;

  const content = h('div', { class: `view ${view.flush ? 'flush' : ''}` }, view.node);
  const topbar = h(
    'header',
    { class: 'topbar' },
    menuButton,
    topbarSearch,
    h('div', { class: 'spacer' }),
    notificationCenter.button,
    quickShareButton,
    h(
      'button',
      {
        type: 'button',
        class: 'icon-btn',
        'aria-label': t('nav.help'),
        title: t('nav.help'),
        onclick: () => navigate('/help'),
      },
      icon('shield', 18),
    ),
    topbarAvatar,
  );
  const main = h('div', { class: 'shell-main' }, topbar, secureBanner, content);
  const shell = h('div', { class: 'app-shell' }, sidebar, main);

  const closeSidebar = (): void => shell.classList.remove('sidebar-open');
  sidebar.addEventListener('click', (event) => {
    if ((event.target as Element).closest('a')) closeSidebar();
  });
  shell.addEventListener('click', (event) => {
    if (event.target === shell) closeSidebar();
  });

  const updateBadge = (): void => {
    const count = state.rooms.reduce((total, room) => total + room.unread, 0);
    const badge = document.getElementById('nav-chat-badge');
    if (!badge && count > 0) {
      const chatLink = nav.querySelector('a[href="/chat"]');
      chatLink?.append(h('span', { class: 'nav-badge', id: 'nav-chat-badge', text: String(count) }));
    } else if (badge) {
      if (count === 0) badge.remove();
      else badge.textContent = String(count);
    }
  };

  const unsubscribeRooms = on(events.roomsUpdated, updateBadge);
  const unsubscribeUser = on('nimbus:user-refreshed', () => {
    const current = storageUsed();
    spacePercent.textContent = `${Math.round(current.percent)}%`;
    spaceUsed.textContent = formatBytes(current.used);
    spaceQuota.textContent = t('home.ofQuota', { quota: formatBytes(current.quota) });
    spaceBar.style.width = `${Math.min(100, current.percent)}%`;
    spaceTrack.setAttribute('aria-valuenow', String(Math.round(current.percent)));
  });
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') closeSidebar();
    if (
      !event.defaultPrevented &&
      !event.altKey &&
      !event.shiftKey &&
      (event.metaKey || event.ctrlKey) &&
      event.key.toLowerCase() === 'k'
    ) {
      event.preventDefault();
      openSpotlight();
    }
  };
  window.addEventListener('keydown', onKey);

  return {
    node: shell,
    destroy: () => {
      unsubscribeRooms();
      unsubscribeUser();
      window.removeEventListener('keydown', onKey);
      notificationCenter.destroy();
      view.destroy?.();
    },
  };
}
