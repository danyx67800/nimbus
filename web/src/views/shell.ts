import { api } from '../api.js';
import { events, on } from '../bus.js';
import { t } from '../i18n.js';
import { openQuickSharePicker } from '../quick-share.js';
import { navigate } from '../router.js';
import { state, storageUsed } from '../store.js';
import { avatarEl, currentPresenceStatus, formatBytes, h, icon, showMenu, toast } from '../ui.js';
import { renderAdmin } from './admin.js';
import { renderCalls } from './calls.js';
import { renderChat } from './chat.js';
import { renderFiles } from './files.js';
import { renderHelp } from './help.js';
import { renderSettings } from './settings.js';
import type { View } from './types.js';

const NAV = [
  { key: 'files', path: '/files', icon: 'files', label: 'nav.files' },
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
  if (path.startsWith('/chat')) return 'chat';
  if (path.startsWith('/calls')) return 'calls';
  if (path.startsWith('/shared')) return 'shared';
  if (path.startsWith('/trash')) return 'trash';
  if (path.startsWith('/favorites')) return 'files';
  if (path.startsWith('/settings')) return 'settings';
  if (path.startsWith('/admin')) return 'admin';
  if (path.startsWith('/help')) return 'help';
  return 'files';
}

function titleFor(section: string): string {
  switch (section) {
    case 'chat':
      return t('nav.chat');
    case 'calls':
      return t('nav.calls');
    case 'shared':
      return t('nav.shared');
    case 'trash':
      return t('nav.trash');
    case 'settings':
      return t('nav.settings');
    case 'admin':
      return t('nav.admin');
    case 'help':
      return t('nav.help');
    default:
      return t('nav.files');
  }
}

function renderView(path: string): View {
  const params = new URLSearchParams(location.search);
  const section = sectionFor(path);
  if (section === 'chat') {
    const roomId = path.startsWith('/chat/') ? path.slice('/chat/'.length) : undefined;
    return { ...renderChat(roomId), flush: true };
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

  nav.append(h('div', { class: 'nav-label', text: 'Spazio personale' }));
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

  const progress = h('span', { style: { width: `${storage.percent}%` } });
  const storageText = h('span', { text: `${formatBytes(storage.used)} / ${formatBytes(storage.quota)}` });
  const storageRow = h('div', { class: 'row' }, storageText, h('span', { text: `${Math.round(storage.percent)}%` }));
  const meter = h(
    'div',
    { class: 'storage-meter' },
    storageRow,
    h(
      'div',
      {
        class: 'meter',
        role: 'progressbar',
        'aria-valuenow': String(Math.round(storage.percent)),
        'aria-valuemin': '0',
        'aria-valuemax': '100',
      },
      progress,
    ),
  );

  const avatar = avatarEl(
    { id: user.id, displayName: user.displayName, status: currentPresenceStatus() },
    { size: 'sm' },
  );
  const userMenuButton = h(
    'button',
    {
      type: 'button',
      class: 'icon-btn',
      'aria-label': 'Menu utente',
      onclick: (event: MouseEvent) => {
        const anchor = event.currentTarget as HTMLElement;
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
      },
    },
    icon('more', 18),
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
      h('div', {}, h('strong', { text: state.config?.appName ?? 'Nimbus' }), h('span', { text: 'Self-hosted' })),
    ),
    nav,
    h(
      'div',
      { class: 'sidebar-footer' },
      meter,
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
  const topbarTitle = h('div', { class: 'topbar-title', text: titleFor(section) });
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
    topbarTitle,
    h('div', { class: 'spacer' }),
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
  );
  const main = h('div', { class: 'shell-main' }, topbar, secureBanner, content);
  const shell = h('div', { class: 'app-shell' }, sidebar, main);

  const closeSidebar = (): void => shell.classList.remove('sidebar-open');
  sidebar.addEventListener('click', (event) => {
    if ((event.target as Element).closest('a')) closeSidebar();
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
    progress.style.width = `${current.percent}%`;
    storageText.textContent = `${formatBytes(current.used)} / ${formatBytes(current.quota)}`;
    meter.setAttribute('aria-valuenow', String(Math.round(current.percent)));
  });
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') closeSidebar();
  };
  window.addEventListener('keydown', onKey);

  return {
    node: shell,
    destroy: () => {
      unsubscribeRooms();
      unsubscribeUser();
      window.removeEventListener('keydown', onKey);
      view.destroy?.();
    },
  };
}
