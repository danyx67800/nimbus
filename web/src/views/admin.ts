import { ApiError, api } from '../api.js';
import { t } from '../i18n.js';
import { state } from '../store.js';
import { copyToClipboard, formatBytes, formatDate, h, icon, openModal, promptDialog, toast } from '../ui.js';
import type { View } from './types.js';

interface AdminUser {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'user';
  quotaBytes: number;
  usedBytes: number;
  disabled: boolean;
  totpEnabled: boolean;
  presence: string;
  createdAt: number;
}

interface Invite {
  id: string;
  role: string;
  expiresAt: number;
  usedAt: number | null;
  createdAt: number;
  creator: string | null;
}

interface AdminSession {
  id: string;
  userId: string;
  username: string;
  displayName: string;
  ip: string;
  userAgent: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

interface AuditEntry {
  id: number;
  actorUsername: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  createdAt: number;
}

interface Report {
  id: string;
  reporter: string;
  target: string;
  reason: string;
  messageId: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

interface Stats {
  users: number;
  usedBytes: number;
  files: number;
  activeSessions: number;
  databaseBytes: number;
  uptimeSeconds: number;
}

type Tab = 'users' | 'invites' | 'sessions' | 'audit' | 'reports';

function table(headers: string[], rows: HTMLElement[]): HTMLElement {
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, ...headers.map((header) => h('th', { text: header })))),
      h('tbody', {}, ...rows),
    ),
  );
}

function cell(content: string | Node): HTMLTableCellElement {
  const element = document.createElement('td');
  if (typeof content === 'string') element.textContent = content;
  else element.append(content);
  return element;
}

export function renderAdmin(): View {
  if (state.user?.role !== 'admin') {
    return {
      node: h(
        'div',
        { class: 'empty' },
        h('div', { class: 'empty-icon' }, icon('admin', 30)),
        h('h2', { text: t('admin.title') }),
        h('p', { text: 'Solo gli amministratori possono accedere a questa sezione.' }),
      ),
    };
  }

  let tab: Tab = 'users';
  const content = h('div', { class: 'stack' });
  const statsRow = h('div', { class: 'calls-grid' });
  const tabs = h('div', { class: 'toolbar' });

  const tabLabels: Array<{ key: Tab; label: string }> = [
    { key: 'users', label: t('admin.users') },
    { key: 'invites', label: t('admin.invites') },
    { key: 'sessions', label: t('admin.sessions') },
    { key: 'audit', label: t('admin.audit') },
    { key: 'reports', label: t('admin.reports') },
  ];

  function renderTabs(): void {
    tabs.replaceChildren();
    for (const entry of tabLabels) {
      tabs.append(
        h(
          'button',
          {
            type: 'button',
            class: `btn small ${tab === entry.key ? 'primary' : ''}`,
            onclick: () => {
              tab = entry.key;
              renderTabs();
              void loadTab();
            },
          },
          entry.label,
        ),
      );
    }
  }

  async function loadStats(): Promise<void> {
    try {
      const response = await api<{ stats: Stats }>('/api/admin/stats');
      const stats = response.stats;
      statsRow.replaceChildren(
        ...[
          [t('admin.totalUsers'), String(stats.users)],
          [t('admin.totalFiles'), String(stats.files)],
          [t('admin.sessions'), String(stats.activeSessions)],
          [t('settings.storage'), formatBytes(stats.usedBytes)],
          [t('admin.database'), formatBytes(stats.databaseBytes)],
          [
            t('admin.uptime'),
            `${Math.floor(stats.uptimeSeconds / 3600)}h ${Math.floor((stats.uptimeSeconds % 3600) / 60)}m`,
          ],
        ].map(([label, value]) =>
          h(
            'div',
            { class: 'card pad' },
            h('div', { class: 'sub', text: label ?? '' }),
            h('div', { style: { fontSize: '24px', fontWeight: '700', marginTop: '4px' }, text: value ?? '' }),
          ),
        ),
      );
    } catch (error) {
      toast(error instanceof ApiError ? error.message : t('common.error'), 'error');
    }
  }

  async function loadUsers(): Promise<void> {
    content.replaceChildren(h('p', { class: 'soft', text: t('common.loading') }));
    try {
      const response = await api<{ users: AdminUser[] }>('/api/admin/users');
      const rows = response.users.map((user) => {
        const actions = h(
          'div',
          { class: 'table-actions' },
          h(
            'button',
            {
              type: 'button',
              class: 'btn small',
              title: t('admin.resetPassword'),
              onclick: async () => {
                const password = await promptDialog({
                  title: t('admin.resetPassword'),
                  label: t('settings.newPassword'),
                });
                if (!password) return;
                try {
                  await api(`/api/admin/users/${encodeURIComponent(user.id)}/password`, {
                    method: 'POST',
                    body: { password },
                  });
                  toast(t('admin.passwordReset'), 'success');
                } catch (error) {
                  toast(error instanceof ApiError ? error.message : t('common.error'), 'error');
                }
              },
            },
            icon('key', 14),
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn small',
              title: t('admin.quota'),
              onclick: async () => {
                const value = await promptDialog({
                  title: t('admin.quota'),
                  label: t('admin.quotaBytes'),
                  value: String(user.quotaBytes),
                });
                if (!value) return;
                try {
                  await api(`/api/admin/users/${encodeURIComponent(user.id)}`, {
                    method: 'PATCH',
                    body: { quotaBytes: Number(value) },
                  });
                  await loadUsers();
                } catch (error) {
                  toast(error instanceof ApiError ? error.message : t('common.error'), 'error');
                }
              },
            },
            icon('cloud', 14),
          ),
          h(
            'button',
            {
              type: 'button',
              class: `btn small ${user.disabled ? '' : 'danger'}`,
              title: user.disabled ? t('admin.enableUser') : t('admin.disableUser'),
              onclick: async () => {
                if (!user.disabled && !(await confirmDisable(user))) return;
                try {
                  await api(`/api/admin/users/${encodeURIComponent(user.id)}`, {
                    method: 'PATCH',
                    body: { disabled: !user.disabled },
                  });
                  await loadUsers();
                } catch (error) {
                  toast(error instanceof ApiError ? error.message : t('common.error'), 'error');
                }
              },
            },
            icon(user.disabled ? 'check' : 'x', 14),
          ),
        );
        return h(
          'tr',
          {},
          cell(
            h(
              'div',
              {},
              h('strong', { text: user.displayName }),
              h('div', { class: 'hint', text: `@${user.username}` }),
            ),
          ),
          cell(
            h('span', {
              class: `badge ${user.role === 'admin' ? 'warn' : ''}`,
              text: user.role === 'admin' ? t('admin.admin') : t('admin.user'),
            }),
          ),
          cell(`${formatBytes(user.usedBytes)} / ${formatBytes(user.quotaBytes)}`),
          cell(
            h('span', {
              class: `badge ${user.disabled ? 'danger' : 'success'}`,
              text: user.disabled ? t('common.disabled') : t('admin.active'),
            }),
          ),
          cell(
            user.totpEnabled
              ? h('span', { class: 'badge success', text: '2FA' })
              : h('span', { class: 'hint', text: '—' }),
          ),
          cell(actions),
        );
      });
      content.replaceChildren(
        h(
          'div',
          { class: 'row' },
          h('div', { class: 'grow' }),
          h(
            'button',
            {
              type: 'button',
              class: 'btn primary',
              onclick: () => openCreateUser(),
            },
            icon('plus', 16),
            t('admin.createUser'),
          ),
        ),
        table(
          [t('common.name'), t('admin.role'), t('admin.quota'), t('admin.active'), '2FA', t('admin.actions')],
          rows,
        ),
      );
    } catch (error) {
      content.replaceChildren(
        h('div', { class: 'notice danger', text: error instanceof ApiError ? error.message : t('common.error') }),
      );
    }
  }

  async function confirmDisable(user: AdminUser): Promise<boolean> {
    return new Promise((resolve) => {
      let answered = false;
      openModal({
        title: t('admin.disableUser'),
        body: h('p', { class: 'soft', text: `${t('admin.confirmDisable')} (${user.displayName})` }),
        actions: [
          {
            label: t('common.cancel'),
            onClick: () => {
              answered = true;
              resolve(false);
            },
          },
          {
            label: t('admin.disableUser'),
            kind: 'danger',
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
    });
  }

  function openCreateUser(): void {
    const username = h('input', {
      class: 'input',
      pattern: '[a-z0-9][a-z0-9._\\-]{2,31}',
      autocomplete: 'off',
      placeholder: 'mario.rossi',
    });
    const displayName = h('input', { class: 'input', maxlength: '100', placeholder: 'Mario Rossi' });
    const password = h('input', { class: 'input', type: 'password', minlength: '12', autocomplete: 'new-password' });
    const role = h(
      'select',
      { class: 'select' },
      h('option', { value: 'user', text: t('admin.user') }),
      h('option', { value: 'admin', text: t('admin.admin') }),
    );
    const quota = h('input', { class: 'input', type: 'number', min: '0', value: '10737418240' });
    const modal = openModal({
      title: t('admin.createUser'),
      body: h(
        'div',
        { class: 'stack' },
        h('div', { class: 'field' }, h('label', { text: t('auth.username') }), username),
        h('div', { class: 'field' }, h('label', { text: t('auth.displayName') }), displayName),
        h(
          'div',
          { class: 'field' },
          h('label', { text: t('auth.password') }),
          password,
          h('span', { class: 'hint', text: t('auth.passwordHint') }),
        ),
        h('div', { class: 'field' }, h('label', { text: t('admin.role') }), role),
        h('div', { class: 'field' }, h('label', { text: t('admin.quotaBytes') }), quota),
      ),
      actions: [
        { label: t('common.cancel') },
        {
          label: t('admin.createUser'),
          kind: 'primary',
          close: false,
          onClick: async () => {
            try {
              await api('/api/admin/users', {
                method: 'POST',
                body: {
                  username: username.value.trim().toLowerCase(),
                  displayName: displayName.value.trim(),
                  password: password.value,
                  role: role.value,
                  quotaBytes: Number(quota.value),
                },
              });
              modal.close();
              toast(t('admin.userCreated'), 'success');
              await loadStats();
              await loadUsers();
            } catch (error) {
              toast(error instanceof ApiError ? error.message : t('common.error'), 'error');
            }
          },
        },
      ],
    });
  }

  async function loadInvites(): Promise<void> {
    content.replaceChildren(h('p', { class: 'soft', text: t('common.loading') }));
    try {
      const response = await api<{ invites: Invite[] }>('/api/admin/invites');
      const rows = response.invites.map((invite) =>
        h(
          'tr',
          {},
          cell(invite.creator ?? '—'),
          cell(h('span', { class: 'badge', text: invite.role === 'admin' ? t('admin.admin') : t('admin.user') })),
          cell(formatDate(invite.expiresAt, true)),
          cell(
            invite.usedAt
              ? h('span', { class: 'badge success', text: t('admin.used') })
              : h('span', { class: 'badge', text: t('admin.open') }),
          ),
          cell(
            h(
              'div',
              { class: 'table-actions' },
              invite.usedAt
                ? '—'
                : h(
                    'button',
                    {
                      type: 'button',
                      class: 'btn small danger',
                      onclick: async () => {
                        try {
                          await api(`/api/admin/invites/${encodeURIComponent(invite.id)}`, { method: 'DELETE' });
                          await loadInvites();
                        } catch (error) {
                          toast(error instanceof ApiError ? error.message : t('common.error'), 'error');
                        }
                      },
                    },
                    t('admin.revoke'),
                  ),
            ),
          ),
        ),
      );
      content.replaceChildren(
        h(
          'div',
          { class: 'row wrap' },
          h(
            'div',
            { class: 'grow' },
            h('p', { class: 'hint', text: 'Gli inviti sono monouso e scadono automaticamente.' }),
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn primary',
              onclick: () => openCreateInvite(),
            },
            icon('plus', 16),
            t('admin.createInvite'),
          ),
        ),
        table(
          [t('admin.createUser'), t('admin.role'), t('admin.expiresIn'), t('admin.status'), t('admin.actions')],
          rows,
        ),
      );
    } catch (error) {
      content.replaceChildren(
        h('div', { class: 'notice danger', text: error instanceof ApiError ? error.message : t('common.error') }),
      );
    }
  }

  function openCreateInvite(): void {
    const role = h(
      'select',
      { class: 'select' },
      h('option', { value: 'user', text: t('admin.user') }),
      h('option', { value: 'admin', text: t('admin.admin') }),
    );
    const hours = h('input', { class: 'input', type: 'number', min: '1', max: '168', value: '24' });
    const modal = openModal({
      title: t('admin.createInvite'),
      body: h(
        'div',
        { class: 'stack' },
        h('div', { class: 'field' }, h('label', { text: t('admin.role') }), role),
        h('div', { class: 'field' }, h('label', { text: t('admin.expiresIn') }), hours),
      ),
      actions: [
        { label: t('common.cancel') },
        {
          label: t('admin.createInvite'),
          kind: 'primary',
          close: false,
          onClick: async () => {
            try {
              const response = await api<{ invite: { token: string; url: string; expiresAt: number } }>(
                '/api/admin/invites',
                {
                  method: 'POST',
                  body: { role: role.value, expiresInHours: Number(hours.value) },
                },
              );
              modal.close();
              const link = `${location.origin}${response.invite.url}`;
              const linkModal = openModal({
                title: t('admin.inviteLink'),
                body: h(
                  'div',
                  { class: 'stack' },
                  h('div', { class: 'notice success', text: t('admin.inviteCreated') }),
                  h('div', { class: 'secret-box', text: link }),
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'btn',
                      onclick: async () => {
                        if (await copyToClipboard(link)) toast(t('common.copied'), 'success');
                      },
                    },
                    icon('copy', 15),
                    t('common.copyLink'),
                  ),
                ),
                actions: [{ label: t('common.close') }],
              });
              void linkModal;
              await loadInvites();
            } catch (error) {
              toast(error instanceof ApiError ? error.message : t('common.error'), 'error');
            }
          },
        },
      ],
    });
  }

  async function loadSessions(): Promise<void> {
    content.replaceChildren(h('p', { class: 'soft', text: t('common.loading') }));
    try {
      const response = await api<{ sessions: AdminSession[] }>('/api/admin/sessions');
      const rows = response.sessions.map((session) =>
        h(
          'tr',
          {},
          cell(
            h(
              'div',
              {},
              h('strong', { text: session.displayName }),
              h('div', { class: 'hint', text: `@${session.username}` }),
            ),
          ),
          cell(session.ip),
          cell(session.userAgent.split(' ').slice(0, 3).join(' ')),
          cell(formatDate(session.lastSeenAt, true)),
          cell(
            h(
              'div',
              { class: 'table-actions' },
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn small danger',
                  onclick: async () => {
                    try {
                      await api(`/api/admin/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' });
                      await loadSessions();
                    } catch (error) {
                      toast(error instanceof ApiError ? error.message : t('common.error'), 'error');
                    }
                  },
                },
                t('settings.revoke'),
              ),
            ),
          ),
        ),
      );
      content.replaceChildren(
        rows.length === 0
          ? h('p', { class: 'soft', text: t('admin.noSessions') })
          : table([t('common.name'), 'IP', 'Client', t('admin.lastSeen'), t('admin.actions')], rows),
      );
    } catch (error) {
      content.replaceChildren(
        h('div', { class: 'notice danger', text: error instanceof ApiError ? error.message : t('common.error') }),
      );
    }
  }

  async function loadAudit(action = ''): Promise<void> {
    content.replaceChildren(h('p', { class: 'soft', text: t('common.loading') }));
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (action) params.set('action', action);
      const response = await api<{ entries: AuditEntry[] }>(`/api/admin/audit?${params.toString()}`);
      const filter = h('input', {
        class: 'input',
        placeholder: t('admin.filterAction'),
        value: action,
        onkeydown: (event: KeyboardEvent) => {
          if (event.key === 'Enter') void loadAudit(filter.value.trim());
        },
      });
      const rows = response.entries.map((entry) =>
        h(
          'tr',
          {},
          cell(formatDate(entry.createdAt, true)),
          cell(entry.actorUsername ?? '—'),
          cell(h('span', { class: 'mono', style: { fontSize: '11px' }, text: entry.action })),
          cell(
            entry.targetType ? `${entry.targetType}${entry.targetId ? ` · ${entry.targetId.slice(0, 8)}` : ''}` : '—',
          ),
          cell(entry.ip ?? '—'),
        ),
      );
      content.replaceChildren(
        h(
          'div',
          { class: 'row' },
          filter,
          h(
            'button',
            { type: 'button', class: 'btn', onclick: () => void loadAudit(filter.value.trim()) },
            icon('search', 15),
            t('common.search'),
          ),
          h('div', { class: 'grow' }),
          h(
            'button',
            { type: 'button', class: 'btn', onclick: () => void loadStats() },
            icon('refresh', 15),
            t('admin.reload'),
          ),
        ),
        rows.length === 0
          ? h('p', { class: 'soft', text: 'Nessuna voce.' })
          : table([t('common.date'), 'Attore', 'Azione', 'Target', 'IP'], rows),
        h('p', {
          class: 'hint',
          text: 'Il registro non contiene password, token né contenuti dei file o dei messaggi.',
        }),
      );
    } catch (error) {
      content.replaceChildren(
        h('div', { class: 'notice danger', text: error instanceof ApiError ? error.message : t('common.error') }),
      );
    }
  }

  async function loadReports(): Promise<void> {
    content.replaceChildren(h('p', { class: 'soft', text: t('common.loading') }));
    try {
      const response = await api<{ reports: Report[] }>('/api/admin/reports');
      const rows = response.reports.map((report) =>
        h(
          'tr',
          {},
          cell(report.reporter),
          cell(report.target),
          cell(report.reason),
          cell(formatDate(report.createdAt, true)),
          cell(
            report.resolvedAt
              ? h('span', { class: 'badge success', text: t('admin.resolved') })
              : h('span', { class: 'badge warn', text: t('admin.open') }),
          ),
          cell(
            report.resolvedAt
              ? '—'
              : h(
                  'button',
                  {
                    type: 'button',
                    class: 'btn small',
                    onclick: async () => {
                      try {
                        await api(`/api/admin/reports/${encodeURIComponent(report.id)}/resolve`, { method: 'POST' });
                        await loadReports();
                      } catch (error) {
                        toast(error instanceof ApiError ? error.message : t('common.error'), 'error');
                      }
                    },
                  },
                  t('admin.resolve'),
                ),
          ),
        ),
      );
      content.replaceChildren(
        rows.length === 0
          ? h('p', { class: 'soft', text: t('admin.noReports') })
          : table(
              [
                t('admin.reporter'),
                t('admin.target'),
                t('admin.reportReason'),
                t('common.date'),
                t('admin.status'),
                t('admin.actions'),
              ],
              rows,
            ),
      );
    } catch (error) {
      content.replaceChildren(
        h('div', { class: 'notice danger', text: error instanceof ApiError ? error.message : t('common.error') }),
      );
    }
  }

  async function loadTab(): Promise<void> {
    switch (tab) {
      case 'users':
        await loadUsers();
        break;
      case 'invites':
        await loadInvites();
        break;
      case 'sessions':
        await loadSessions();
        break;
      case 'audit':
        await loadAudit();
        break;
      case 'reports':
        await loadReports();
        break;
    }
  }

  const node = h(
    'div',
    { class: 'stack' },
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        { class: 'grow' },
        h('h1', { text: t('admin.title') }),
        h('p', { class: 'sub', text: 'Gestione utenti, inviti, sessioni e audit dell’istanza.' }),
      ),
    ),
    statsRow,
    tabs,
    content,
  );
  renderTabs();
  void loadStats();
  void loadTab();

  return { node };
}
