import { startAuthentication } from '@simplewebauthn/browser';
import { ApiError, api, type SessionResponse, setCsrf } from '../api.js';
import { t } from '../i18n.js';
import type { AppConfig } from '../store.js';
import { createSelectPill, h, icon } from '../ui.js';

function errorLine(): HTMLElement {
  return h('div', { class: 'error-text', role: 'alert', hidden: true });
}

function setError(element: HTMLElement, message: string): void {
  element.textContent = message;
  element.hidden = !message;
}

function brandHeader(appName: string, subtitle: string): HTMLElement {
  return h(
    'div',
    { class: 'auth-head' },
    h('div', { class: 'brand-mark', 'aria-hidden': 'true', text: appName.slice(0, 1).toUpperCase() }),
    h(
      'div',
      {},
      h('strong', { text: appName, style: { fontSize: '17px' } }),
      h('div', { class: 'muted', style: { fontSize: '12px' }, text: subtitle }),
    ),
  );
}

function authLayout(appName: string, tagline: string, content: HTMLElement): HTMLElement {
  return h(
    'div',
    { class: 'auth-page' },
    h(
      'section',
      { class: 'auth-art', 'aria-hidden': 'true' },
      h(
        'div',
        { class: 'row' },
        h('div', { class: 'brand-mark', text: appName.slice(0, 1).toUpperCase() }),
        h('strong', { text: appName }),
      ),
      h(
        'div',
        { style: { position: 'relative', zIndex: '1' } },
        h('h1', { text: tagline }),
        h('p', {
          text: 'File cifrati, chat, chiamate e condivisione rapida. Tutto sul tuo server, senza cloud esterni.',
        }),
      ),
      h(
        'div',
        { class: 'art-features' },
        h('span', { text: '🔒 AES-256-GCM' }),
        h('span', { text: '⚡ WebRTC P2P' }),
        h('span', { text: '🏠 Self-hosted' }),
      ),
    ),
    h('section', { class: 'auth-panel' }, content),
  );
}

function field(label: string, input: HTMLInputElement, hint?: string): HTMLElement {
  return h(
    'div',
    { class: 'field' },
    h('label', { for: input.id, text: label }),
    input,
    hint ? h('span', { class: 'hint', text: hint }) : null,
  );
}

function input(id: string, type: string, autocomplete: string, extra: Record<string, unknown> = {}): HTMLInputElement {
  return h('input', { class: 'input', id, type, autocomplete, required: true, ...extra });
}

function loadingButton(label: string): HTMLButtonElement {
  return h('button', { type: 'submit', class: 'btn primary block' }, icon('lock', 16), h('span', { text: label }));
}

function setBusy(button: HTMLButtonElement, busy: boolean, label: string): void {
  button.disabled = busy;
  const span = button.querySelector('span');
  if (span) span.textContent = busy ? t('common.loading') : label;
}

async function passkeyLogin(onError: (message: string) => void, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    const options = await api<{ challengeId: string; options: Record<string, unknown> }>(
      '/api/auth/webauthn/login/options',
      {
        method: 'POST',
        body: {},
        csrf: false,
      },
    );
    const response = await startAuthentication({ optionsJSON: options.options as never });
    const session = await api<SessionResponse>('/api/auth/webauthn/login/verify', {
      method: 'POST',
      body: { challengeId: options.challengeId, response },
      csrf: false,
    });
    setCsrf(session.csrfToken);
    location.assign('/');
  } catch (error) {
    onError(
      error instanceof Error && error.name === 'NotAllowedError'
        ? t('auth.passkeyFailed')
        : error instanceof Error
          ? error.message
          : t('auth.passkeyFailed'),
    );
  } finally {
    button.disabled = false;
  }
}

export function renderLogin(config: AppConfig, notice?: string): HTMLElement {
  const error = errorLine();
  const username = input('login-username', 'text', 'username', { autocapitalize: 'none', spellcheck: 'false' });
  const password = input('login-password', 'password', 'current-password');
  const submit = loadingButton(t('auth.login'));
  const form = h('form', {}, field(t('auth.username'), username), field(t('auth.password'), password), error, submit);
  form.onsubmit = async (event: SubmitEvent) => {
    event.preventDefault();
    setError(error, '');
    setBusy(submit, true, t('auth.login'));
    try {
      const result = await api<SessionResponse | { twoFactorRequired: true; challengeId: string; methods: string[] }>(
        '/api/auth/login',
        { method: 'POST', body: { username: username.value, password: password.value }, csrf: false },
      );
      if ('twoFactorRequired' in result) {
        showTwoFactor(result.challengeId, form, error);
        return;
      }
      setCsrf(result.csrfToken);
      location.assign('/');
    } catch (err) {
      setError(error, err instanceof ApiError ? err.message : t('common.error'));
      setBusy(submit, false, t('auth.login'));
    }
  };
  const passkeyButton = h(
    'button',
    {
      type: 'button',
      class: 'btn block',
      onclick: () => void passkeyLogin((message) => setError(error, message), passkeyButton),
    },
    icon('key', 16),
    t('auth.usePasskey'),
  );
  const card = h(
    'div',
    { class: 'stack' },
    brandHeader(config.appName, config.tagline),
    h(
      'div',
      {},
      h('h1', { style: { fontSize: '26px' }, text: t('auth.title') }),
      h('p', { class: 'soft', text: t('auth.subtitle') }),
    ),
    notice ? h('div', { class: 'notice warn', text: notice }) : null,
    form,
    h(
      'div',
      { class: 'row', style: { justifyContent: 'space-between' } },
      h('span', { class: 'auth-switch', text: 'Accesso riservato' }),
    ),
    passkeyButton,
    h(
      'div',
      { class: 'auth-footer' },
      h('span', { text: `${config.appName} v${config.version}` }),
      h('span', { text: 'Nessuna registrazione pubblica' }),
    ),
  );
  return authLayout(config.appName, config.tagline, card);
}

function showTwoFactor(challengeId: string, form: HTMLFormElement, error: HTMLElement): void {
  const code = input('twofactor-code', 'text', 'one-time-code', { inputmode: 'numeric', maxlength: '20' });
  const method = createSelectPill({
    id: 'twofactor-method',
    value: 'totp',
    ariaLabel: 'Metodo',
    options: [
      { value: 'totp', label: 'Codice app di autenticazione', dotColor: 'var(--accent)' },
      { value: 'recovery', label: 'Codice di recupero', dotColor: 'var(--warning)' },
    ],
  });
  const submit = loadingButton(t('auth.verify'));
  form.replaceChildren(
    h('h2', { style: { fontSize: '18px' }, text: t('auth.twoFactor') }),
    h('p', { class: 'soft', text: t('auth.twoFactorHint') }),
    field(t('auth.code'), code),
    h('div', { class: 'field' }, h('label', { for: 'twofactor-method', text: 'Metodo' }), method),
    error,
    submit,
  );
  form.onsubmit = async (event) => {
    event.preventDefault();
    setError(error, '');
    setBusy(submit, true, t('auth.verify'));
    try {
      const result = await api<SessionResponse>('/api/auth/2fa', {
        method: 'POST',
        body: { challengeId, code: code.value, method: method.value },
        csrf: false,
      });
      setCsrf(result.csrfToken);
      location.assign('/');
    } catch (err) {
      setError(error, err instanceof ApiError ? err.message : t('common.error'));
      setBusy(submit, false, t('auth.verify'));
    }
  };
  code.focus();
}

export function renderSetup(config: AppConfig): HTMLElement {
  const error = errorLine();
  const username = input('setup-username', 'text', 'username', {
    pattern: '[a-z0-9][a-z0-9._\\-]{2,31}',
    autocapitalize: 'none',
    spellcheck: 'false',
  });
  const displayName = input('setup-display', 'text', 'name');
  const password = input('setup-password', 'password', 'new-password', { minlength: '12' });
  const confirm = input('setup-confirm', 'password', 'new-password', { minlength: '12' });
  const submit = loadingButton(t('auth.createAdmin'));
  const form = h(
    'form',
    {
      onsubmit: async (event: SubmitEvent) => {
        event.preventDefault();
        setError(error, '');
        if (password.value !== confirm.value) {
          setError(error, t('auth.passwordMismatch'));
          return;
        }
        setBusy(submit, true, t('auth.createAdmin'));
        try {
          const result = await api<SessionResponse>('/api/setup', {
            method: 'POST',
            body: { username: username.value, displayName: displayName.value, password: password.value },
            csrf: false,
          });
          setCsrf(result.csrfToken);
          location.assign('/');
        } catch (err) {
          setError(error, err instanceof ApiError ? err.message : t('common.error'));
          setBusy(submit, false, t('auth.createAdmin'));
        }
      },
    },
    field(t('auth.username'), username, 'minuscole, numeri, punto, trattino e underscore'),
    field(t('auth.displayName'), displayName),
    field(t('auth.password'), password, t('auth.passwordHint')),
    field(t('auth.confirmPassword'), confirm),
    error,
    submit,
  );
  if (!config.setupWindowOpen) {
    return authLayout(
      config.appName,
      config.tagline,
      h(
        'div',
        { class: 'stack' },
        brandHeader(config.appName, config.tagline),
        h('h1', { text: t('auth.setupTitle') }),
        h('div', { class: 'notice warn', text: t('auth.setupClosed') }),
        h('a', { class: 'btn', href: '/' }, t('common.back')),
      ),
    );
  }
  return authLayout(
    config.appName,
    config.tagline,
    h(
      'div',
      { class: 'stack' },
      brandHeader(config.appName, t('auth.setupTitle')),
      h(
        'div',
        {},
        h('h1', { style: { fontSize: '25px' }, text: t('auth.setupTitle') }),
        h('p', { class: 'soft', text: t('auth.setupSubtitle') }),
      ),
      h(
        'div',
        { class: 'notice' },
        icon('shield', 18),
        h('span', {
          text: 'I segreti di cifratura e sessione vengono creati automaticamente nel volume dati con permessi 600.',
        }),
      ),
      form,
    ),
  );
}

export async function renderInvite(config: AppConfig, token: string): Promise<HTMLElement> {
  const container = h(
    'div',
    { class: 'stack' },
    brandHeader(config.appName, t('auth.inviteTitle')),
    h('p', { class: 'soft', text: t('common.loading') }),
  );
  const page = authLayout(config.appName, config.tagline, container);
  try {
    const preview = await api<{ valid: boolean; role: string | null; expiresAt: number | null }>(
      `/api/invites/${encodeURIComponent(token)}/preview`,
      { csrf: false },
    );
    if (!preview.valid) {
      container.replaceChildren(
        brandHeader(config.appName, t('auth.inviteTitle')),
        h('h1', { text: t('auth.inviteTitle') }),
        h('div', { class: 'notice danger', text: t('auth.inviteInvalid') }),
        h('a', { class: 'btn', href: '/' }, t('common.back')),
      );
      return page;
    }
    const error = errorLine();
    const username = input('invite-username', 'text', 'username', {
      pattern: '[a-z0-9][a-z0-9._\\-]{2,31}',
      autocapitalize: 'none',
      spellcheck: 'false',
    });
    const displayName = input('invite-display', 'text', 'name');
    const password = input('invite-password', 'password', 'new-password', { minlength: '12' });
    const confirm = input('invite-confirm', 'password', 'new-password', { minlength: '12' });
    const submit = loadingButton(t('auth.join'));
    const form = h(
      'form',
      {
        onsubmit: async (event: SubmitEvent) => {
          event.preventDefault();
          setError(error, '');
          if (password.value !== confirm.value) {
            setError(error, t('auth.passwordMismatch'));
            return;
          }
          setBusy(submit, true, t('auth.join'));
          try {
            const result = await api<SessionResponse>(`/api/invites/${encodeURIComponent(token)}/redeem`, {
              method: 'POST',
              body: { username: username.value, displayName: displayName.value, password: password.value },
              csrf: false,
            });
            setCsrf(result.csrfToken);
            location.assign('/');
          } catch (err) {
            setError(error, err instanceof ApiError ? err.message : t('common.error'));
            setBusy(submit, false, t('auth.join'));
          }
        },
      },
      field(t('auth.username'), username, t('auth.passwordHint')),
      field(t('auth.displayName'), displayName),
      field(t('auth.password'), password, t('auth.passwordHint')),
      field(t('auth.confirmPassword'), confirm),
      error,
      submit,
    );
    container.replaceChildren(
      brandHeader(config.appName, t('auth.inviteTitle')),
      h('h1', { style: { fontSize: '25px' }, text: t('auth.inviteTitle') }),
      h('p', { class: 'soft', text: preview.role === 'admin' ? 'Invito come amministratore.' : 'Invito come utente.' }),
      form,
    );
  } catch (err) {
    container.replaceChildren(
      brandHeader(config.appName, t('auth.inviteTitle')),
      h('div', { class: 'notice danger', text: err instanceof ApiError ? err.message : t('auth.inviteInvalid') }),
      h('a', { class: 'btn', href: '/' }, t('common.back')),
    );
  }
  return page;
}
