import { startRegistration } from '@simplewebauthn/browser';
import { ApiError, api, savePushSubscription } from '../api.js';
import { events } from '../bus.js';
import { isRingtoneEnabled, setRingtoneEnabled } from '../calls-manager.js';
import { setLanguage, t } from '../i18n.js';
import { navigate } from '../router.js';
import { state } from '../store.js';
import { applyTheme, rememberLanguage } from '../theme.js';
import { copyToClipboard, formatBytes, formatDate, h, icon, openModal, promptDialog, toast } from '../ui.js';
import type { View } from './types.js';

interface SessionInfo {
  id: string;
  current: boolean;
  ip: string;
  userAgent: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

interface PasskeyInfo {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

function settingRow(title: string, description: string, control: HTMLElement): HTMLElement {
  return h(
    'div',
    { class: 'setting-row' },
    h('div', { class: 'setting-text' }, h('strong', { text: title }), h('span', { text: description })),
    control,
  );
}

function toggle(checked: boolean, onChange: (next: boolean) => Promise<void> | void): HTMLButtonElement {
  const button = h('button', {
    type: 'button',
    class: 'switch',
    role: 'switch',
    'aria-checked': String(checked),
    'aria-label': checked ? t('common.enabled') : t('common.disabled'),
    onclick: async () => {
      const next = button.getAttribute('aria-checked') !== 'true';
      button.setAttribute('aria-checked', String(next));
      try {
        await onChange(next);
      } catch (error) {
        button.setAttribute('aria-checked', String(!next));
        toast(error instanceof ApiError ? error.message : t('common.error'), 'error');
      }
    },
  });
  return button;
}

function card(title: string, body: HTMLElement, className = ''): HTMLElement {
  return h(
    'section',
    { class: `card ${className}` },
    h('div', { class: 'card-header' }, h('h2', { text: title })),
    h('div', { class: 'card-body' }, body),
  );
}

function base64ToUint8Array(value: string): Uint8Array {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) output[index] = raw.charCodeAt(index);
  return output;
}

export function renderSettings(): View {
  const user = state.user;
  if (!user) return { node: h('div') };
  const page = h('div', { class: 'stack' });
  const head = h(
    'div',
    { class: 'page-head' },
    h(
      'div',
      { class: 'grow' },
      h('h1', { text: t('settings.title') }),
      h('p', { class: 'sub', text: `@${user.username}` }),
    ),
    window.isSecureContext
      ? h('span', { class: 'badge success' }, icon('shield', 13), 'Contesto sicuro')
      : h('a', { class: 'btn small', href: '/help' }, icon('lock', 14), 'HTTPS'),
  );

  // Profile
  const displayName = h('input', {
    class: 'input',
    value: user.displayName,
    maxlength: '100',
    id: 'settings-display-name',
  });
  const presence = h(
    'select',
    { class: 'select' },
    h('option', { value: 'online', text: t('common.online'), selected: user.presence === 'online' }),
    h('option', { value: 'away', text: t('common.away'), selected: user.presence === 'away' }),
    h('option', { value: 'dnd', text: t('common.dnd'), selected: user.presence === 'dnd' }),
    h('option', { value: 'hidden', text: 'Nascondi presenza', selected: user.presence === 'hidden' }),
  );
  presence.addEventListener('change', async () => {
    try {
      const response = await api<{ user: typeof user }>('/api/me', {
        method: 'PATCH',
        body: { presence: presence.value },
      });
      state.user = response.user;
      toast(t('settings.saved'), 'success');
    } catch (error) {
      toast(error instanceof ApiError ? error.message : t('common.error'), 'error');
    }
  });
  const profileBody = h(
    'div',
    { class: 'stack' },
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'settings-display-name', text: t('settings.displayName') }),
      displayName,
    ),
    h('div', { class: 'field' }, h('label', { text: t('settings.presence') }), presence),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          type: 'button',
          class: 'btn primary',
          onclick: async () => {
            try {
              const response = await api<{ user: typeof user }>('/api/me', {
                method: 'PATCH',
                body: { displayName: displayName.value },
              });
              state.user = response.user;
              toast(t('settings.saved'), 'success');
              window.dispatchEvent(new CustomEvent(events.userUpdated));
            } catch (error) {
              toast(error instanceof ApiError ? error.message : t('common.error'), 'error');
            }
          },
        },
        t('common.save'),
      ),
    ),
  );

  // Preferences
  const language = h(
    'select',
    { class: 'select' },
    h('option', { value: 'it', text: 'Italiano', selected: user.locale === 'it' }),
    h('option', { value: 'en', text: 'English', selected: user.locale === 'en' }),
  );
  language.addEventListener('change', async () => {
    try {
      await api('/api/me', { method: 'PATCH', body: { locale: language.value } });
      state.user!.locale = language.value;
      setLanguage(language.value);
      rememberLanguage(language.value);
      window.dispatchEvent(new CustomEvent(events.userUpdated));
      toast(t('settings.languageSaved'), 'success');
    } catch (error) {
      toast(error instanceof ApiError ? error.message : t('common.error'), 'error');
    }
  });
  const theme = h(
    'select',
    { class: 'select' },
    h('option', { value: 'system', text: t('common.system'), selected: user.theme === 'system' }),
    h('option', { value: 'light', text: t('common.light'), selected: user.theme === 'light' }),
    h('option', { value: 'dark', text: t('common.dark'), selected: user.theme === 'dark' }),
  );
  theme.addEventListener('change', async () => {
    try {
      const value = theme.value === 'light' || theme.value === 'dark' ? theme.value : 'system';
      await api('/api/me', { method: 'PATCH', body: { theme: value } });
      state.user!.theme = value;
      applyTheme(value);
      toast(t('settings.saved'), 'success');
    } catch (error) {
      toast(error instanceof ApiError ? error.message : t('common.error'), 'error');
    }
  });
  const readReceipts = toggle(user.readReceipts, async (next) => {
    const response = await api<{ user: typeof user }>('/api/me', { method: 'PATCH', body: { readReceipts: next } });
    state.user = response.user;
  });
  const quickShare = toggle(user.quickShare, async (next) => {
    const response = await api<{ user: typeof user }>('/api/me', { method: 'PATCH', body: { quickShare: next } });
    state.user = response.user;
  });
  const notificationsSound = toggle(isRingtoneEnabled(), (next) => {
    setRingtoneEnabled(next);
  });
  const preferencesBody = h(
    'div',
    {},
    settingRow(t('common.language'), 'Interfaccia it / en', language),
    settingRow(t('common.theme'), 'Segue il sistema oppure forza chiaro/scuro', theme),
    settingRow(t('settings.readReceipts'), 'Comunica agli altri quando hai letto i messaggi', readReceipts),
    settingRow(t('settings.quickShare'), 'Consenti agli altri di inviarti file con la condivisione rapida', quickShare),
    settingRow('Suono delle notifiche', 'Suono per chiamate e file in arrivo', notificationsSound),
  );

  // Push
  const pushStatus = h('div', {
    class: 'hint',
    text: !window.isSecureContext ? t('settings.notificationHint') : t('settings.notificationHint'),
  });
  const pushButton = h(
    'button',
    {
      type: 'button',
      class: 'btn',
      disabled: !window.isSecureContext || !('serviceWorker' in navigator) || !('PushManager' in window),
      onclick: async () => {
        try {
          if (!window.isSecureContext) {
            toast(t('settings.notificationHint'), 'error');
            return;
          }
          const permission = await Notification.requestPermission();
          if (permission !== 'granted') {
            toast(t('settings.pushDenied'), 'error');
            return;
          }
          const registration = await navigator.serviceWorker.ready;
          const keyResponse = await api<{ publicKey: string }>('/api/push/public-key', { csrf: false });
          if (!keyResponse.publicKey) {
            toast('Chiavi push non configurate sul server.', 'error');
            return;
          }
          const subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: base64ToUint8Array(keyResponse.publicKey).buffer as ArrayBuffer,
          });
          await savePushSubscription(subscription);
          pushStatus.textContent = t('settings.pushEnabled');
          pushButton.textContent = t('settings.pushEnabled');
          pushButton.disabled = true;
        } catch (error) {
          toast(
            error instanceof ApiError ? error.message : error instanceof Error ? error.message : t('common.error'),
            'error',
          );
        }
      },
    },
    icon('bell', 16),
    t('settings.enablePush'),
  );
  if (window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window) {
    void navigator.serviceWorker.ready
      .then(async (registration) => {
        const subscription = await registration.pushManager.getSubscription();
        if (subscription) {
          pushStatus.textContent = t('settings.pushEnabled');
          pushButton.textContent = t('settings.pushEnabled');
          pushButton.disabled = true;
        }
      })
      .catch(() => undefined);
  }
  const pushBody = h(
    'div',
    {},
    settingRow(t('settings.notifications'), t('settings.notificationHint'), pushButton),
    pushStatus,
  );

  // Password
  const currentPassword = h('input', {
    class: 'input',
    type: 'password',
    autocomplete: 'current-password',
    id: 'settings-current-password',
  });
  const newPassword = h('input', {
    class: 'input',
    type: 'password',
    autocomplete: 'new-password',
    minlength: '12',
    id: 'settings-new-password',
  });
  const passwordBody = h(
    'div',
    { class: 'stack' },
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'settings-current-password', text: t('settings.currentPassword') }),
      currentPassword,
    ),
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'settings-new-password', text: t('settings.newPassword') }),
      newPassword,
    ),
    h('p', { class: 'hint', text: t('auth.passwordHint') }),
    h(
      'button',
      {
        type: 'button',
        class: 'btn primary',
        onclick: async () => {
          try {
            await api('/api/auth/password', {
              method: 'POST',
              body: { currentPassword: currentPassword.value, newPassword: newPassword.value },
            });
            currentPassword.value = '';
            newPassword.value = '';
            toast(t('settings.passwordChanged'), 'success');
            await loadSessions();
          } catch (error) {
            toast(error instanceof ApiError ? error.message : t('common.error'), 'error');
          }
        },
      },
      t('settings.changePassword'),
    ),
  );

  // 2FA
  const twoFactorBody = h('div', { class: 'stack' });
  const passkeyBody = h('div', { class: 'stack' }, h('p', { class: 'soft', text: t('common.loading') }));

  function renderTwoFactor(): void {
    twoFactorBody.replaceChildren();
    if (state.user?.totpEnabled) {
      twoFactorBody.append(
        h(
          'div',
          { class: 'row wrap' },
          h('span', { class: 'badge success' }, icon('shield', 13), t('common.enabled')),
          h('span', {
            class: 'hint',
            text: 'TOTP attivo. I codici di recupero possono essere rigenerati solo disattivando e riattivando il secondo fattore.',
          }),
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'btn danger',
            onclick: () => openDisableTwoFactor(),
          },
          t('settings.disable2fa'),
        ),
      );
    } else {
      twoFactorBody.append(
        h('p', { class: 'hint', text: 'Aggiungi un secondo fattore TOTP (Google Authenticator, Aegis, 1Password…).' }),
        h(
          'button',
          { type: 'button', class: 'btn primary', onclick: () => void openSetupTwoFactor() },
          icon('lock', 16),
          t('settings.enable2fa'),
        ),
      );
    }
  }

  async function openSetupTwoFactor(): Promise<void> {
    try {
      const setup = await api<{ secret: string; otpauth: string }>('/api/auth/2fa/setup', { method: 'POST', body: {} });
      const code = h('input', {
        class: 'input',
        inputmode: 'numeric',
        autocomplete: 'one-time-code',
        maxlength: '10',
        placeholder: '123456',
        id: 'settings-totp-code',
      });
      const body = h(
        'div',
        { class: 'stack' },
        h('p', {
          class: 'soft',
          text: 'Aggiungi questa chiave alla tua app di autenticazione, poi inserisci il codice generato.',
        }),
        h('div', { class: 'secret-box', text: setup.secret }),
        h('div', { class: 'qr-fallback', text: setup.otpauth }),
        h('div', { class: 'field' }, h('label', { for: 'settings-totp-code', text: t('auth.code') }), code),
        h(
          'button',
          {
            type: 'button',
            class: 'btn primary',
            onclick: async () => {
              try {
                const result = await api<{ recoveryCodes: string[] }>('/api/auth/2fa/enable', {
                  method: 'POST',
                  body: { code: code.value },
                });
                state.user!.totpEnabled = true;
                modal.close();
                renderTwoFactor();
                showRecoveryCodes(result.recoveryCodes);
                toast(t('settings.twoFactorEnabled'), 'success');
              } catch (error) {
                toast(error instanceof ApiError ? error.message : t('common.error'), 'error');
              }
            },
          },
          t('settings.enable2fa'),
        ),
      );
      const modal = openModal({
        title: t('settings.setup2fa'),
        body,
        wide: true,
        actions: [{ label: t('common.close') }],
      });
    } catch (error) {
      toast(error instanceof ApiError ? error.message : t('common.error'), 'error');
    }
  }

  function showRecoveryCodes(codes: string[]): void {
    const body = h(
      'div',
      { class: 'stack' },
      h('div', { class: 'notice warn', text: t('settings.recoveryHint') }),
      h('div', { class: 'secret-box', text: codes.join('\n') }),
      h(
        'button',
        {
          type: 'button',
          class: 'btn',
          onclick: async () => {
            if (await copyToClipboard(codes.join('\n'))) toast(t('settings.codesCopied'), 'success');
          },
        },
        icon('copy', 15),
        t('settings.copyCodes'),
      ),
    );
    openModal({ title: t('settings.recoveryCodes'), body, actions: [{ label: t('common.close') }] });
  }

  function openDisableTwoFactor(): void {
    const password = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
    const code = h('input', { class: 'input', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '20' });
    const modal = openModal({
      title: t('settings.disable2fa'),
      body: h(
        'div',
        { class: 'stack' },
        h('div', { class: 'field' }, h('label', { text: t('settings.currentPassword') }), password),
        h('div', { class: 'field' }, h('label', { text: t('auth.code') }), code),
      ),
      actions: [
        { label: t('common.cancel') },
        {
          label: t('settings.disable2fa'),
          kind: 'danger',
          close: false,
          onClick: async () => {
            try {
              await api('/api/auth/2fa/disable', {
                method: 'POST',
                body: { password: password.value, code: code.value },
              });
              state.user!.totpEnabled = false;
              modal.close();
              renderTwoFactor();
              toast(t('settings.twoFactorDisabled'), 'success');
            } catch (error) {
              toast(error instanceof ApiError ? error.message : t('common.error'), 'error');
            }
          },
        },
      ],
    });
  }

  async function loadPasskeys(): Promise<void> {
    passkeyBody.replaceChildren(h('p', { class: 'soft', text: t('common.loading') }));
    try {
      const response = await api<{ credentials: PasskeyInfo[] }>('/api/auth/webauthn/credentials');
      passkeyBody.replaceChildren();
      if (response.credentials.length === 0)
        passkeyBody.append(h('p', { class: 'hint', text: t('settings.noPasskeys') }));
      for (const passkey of response.credentials) {
        passkeyBody.append(
          h(
            'div',
            { class: 'version-row' },
            icon('key', 18),
            h(
              'div',
              { class: 'grow' },
              h('strong', { text: passkey.name }),
              h('div', {
                class: 'hint',
                text: `Creata ${formatDate(passkey.createdAt)}${passkey.lastUsedAt ? ` · ultimo uso ${formatDate(passkey.lastUsedAt)}` : ''}`,
              }),
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'btn small danger',
                onclick: async () => {
                  try {
                    await api(`/api/auth/webauthn/credentials/${encodeURIComponent(passkey.id)}`, { method: 'DELETE' });
                    await loadPasskeys();
                    toast(t('common.saved'), 'success');
                  } catch (error) {
                    toast(error instanceof ApiError ? error.message : t('common.error'), 'error');
                  }
                },
              },
              t('settings.removePasskey'),
            ),
          ),
        );
      }
      if (window.PublicKeyCredential) {
        passkeyBody.append(
          h(
            'button',
            {
              type: 'button',
              class: 'btn',
              onclick: async () => {
                const name = await promptDialog({
                  title: t('settings.addPasskey'),
                  label: t('settings.passkeyName'),
                  value: navigator.platform || 'Passkey',
                });
                if (!name) return;
                try {
                  const options = await api<{ challengeId: string; options: Record<string, unknown> }>(
                    '/api/auth/webauthn/register/options',
                    { method: 'POST', body: {} },
                  );
                  const response = await startRegistration({ optionsJSON: options.options as never });
                  await api('/api/auth/webauthn/register/verify', {
                    method: 'POST',
                    body: { challengeId: options.challengeId, response, name },
                  });
                  await loadPasskeys();
                  toast(t('settings.passkeyAdded'), 'success');
                } catch (error) {
                  toast(error instanceof Error ? error.message : t('common.error'), 'error');
                }
              },
            },
            icon('key', 16),
            t('settings.addPasskey'),
          ),
        );
      }
    } catch (error) {
      passkeyBody.replaceChildren(
        h('div', { class: 'notice danger', text: error instanceof ApiError ? error.message : t('common.error') }),
      );
    }
  }

  // Sessions
  const sessionsBody = h('div', { class: 'stack' }, h('p', { class: 'soft', text: t('common.loading') }));
  async function loadSessions(): Promise<void> {
    try {
      const response = await api<{ sessions: SessionInfo[] }>('/api/auth/sessions');
      sessionsBody.replaceChildren();
      for (const session of response.sessions) {
        sessionsBody.append(
          h(
            'div',
            { class: 'version-row' },
            icon(session.current ? 'shield' : 'key', 18),
            h(
              'div',
              { class: 'grow' },
              h('strong', {
                text: session.current ? t('settings.currentSession') : session.userAgent.split(' ')[0] || 'Dispositivo',
              }),
              h('div', {
                class: 'hint',
                text: `${session.ip} · ${formatDate(session.lastSeenAt, true)}${session.current ? '' : ` · ${t('admin.lastSeen')}`}`,
              }),
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'btn small danger',
                onclick: async () => {
                  try {
                    await api(`/api/auth/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' });
                    if (session.current) location.assign('/');
                    else await loadSessions();
                  } catch (error) {
                    toast(error instanceof ApiError ? error.message : t('common.error'), 'error');
                  }
                },
              },
              t('settings.revoke'),
            ),
          ),
        );
      }
      sessionsBody.append(
        h(
          'button',
          {
            type: 'button',
            class: 'btn danger',
            onclick: async () => {
              try {
                await api('/api/auth/logout-all', { method: 'POST' });
                location.assign('/');
              } catch (error) {
                toast(error instanceof ApiError ? error.message : t('common.error'), 'error');
              }
            },
          },
          icon('logout', 16),
          t('settings.logoutAll'),
        ),
      );
    } catch (error) {
      sessionsBody.replaceChildren(
        h('div', { class: 'notice danger', text: error instanceof ApiError ? error.message : t('common.error') }),
      );
    }
  }

  const securityBody = h(
    'div',
    { class: 'stack' },
    h('h3', { style: { fontSize: '14px' }, text: t('settings.changePassword') }),
    passwordBody,
    h('div', { class: 'divider' }),
    h('h3', { style: { fontSize: '14px' }, text: 'Autenticazione a due fattori' }),
    twoFactorBody,
    h('div', { class: 'divider' }),
    h('h3', { style: { fontSize: '14px' }, text: t('settings.passkeys') }),
    passkeyBody,
  );

  const storage = h(
    'div',
    { class: 'stack' },
    h(
      'div',
      { class: 'row' },
      h('strong', { class: 'grow', text: t('settings.storage') }),
      h('span', { class: 'muted', text: `${formatBytes(user.usedBytes)} / ${formatBytes(user.quotaBytes)}` }),
    ),
    h(
      'div',
      { class: 'progress' },
      h('span', {
        style: { width: `${Math.min(100, user.quotaBytes ? (user.usedBytes / user.quotaBytes) * 100 : 0)}%` },
      }),
    ),
    h('p', {
      class: 'hint',
      text: 'I file sono cifrati a riposo con AES-256-GCM e chiavi per file avvolte dalla chiave master dell’istanza.',
    }),
  );

  const httpsBody = h(
    'div',
    { class: 'stack' },
    h('p', { class: 'soft', text: t('settings.httpsText') }),
    h(
      'button',
      { type: 'button', class: 'btn', onclick: () => navigate('/help') },
      icon('lock', 16),
      t('settings.httpsGuide'),
    ),
  );

  const aboutBody = h(
    'div',
    { class: 'stack' },
    h(
      'div',
      { class: 'row' },
      h('span', { class: 'muted grow', text: t('settings.version') }),
      h('span', { text: state.config?.version ?? '—' }),
    ),
    h(
      'div',
      { class: 'row' },
      h('span', { class: 'muted grow', text: t('settings.instance') }),
      h('span', { text: state.config?.appName ?? 'Nimbus' }),
    ),
    h('p', {
      class: 'hint',
      text: 'Nessuna telemetria. Asset serviti localmente. Le chat e i file passano dal server e sono cifrati a riposo; chiamate P2P e trasferimenti rapidi sono cifrati end-to-end dal protocollo DTLS-SRTP/DTLS.',
    }),
  );

  page.append(
    head,
    h(
      'div',
      { class: 'settings-grid' },
      card(t('settings.profile'), profileBody),
      card('Preferenze', preferencesBody),
      card(t('settings.notifications'), pushBody),
      card(t('settings.storage'), storage),
      card(t('settings.security'), securityBody, 'span-2'),
      card(t('settings.sessions'), sessionsBody, 'span-2'),
      card(t('settings.httpsTitle'), httpsBody),
      card(t('settings.about'), aboutBody),
    ),
  );

  renderTwoFactor();
  void loadPasskeys();
  void loadSessions();

  return { node: page };
}
