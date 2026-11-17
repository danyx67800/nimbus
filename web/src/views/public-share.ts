import { ApiError, api } from '../api.js';
import { t } from '../i18n.js';
import { state } from '../store.js';
import { formatBytes, formatDate, h, icon } from '../ui.js';

interface PublicMeta {
  requiresPassword: boolean;
  appName: string;
  expiresAt: number | null;
  downloadsLeft: number | null;
  file: { name: string; size: number; mime: string } | null;
  contentOrigin: string;
}

interface PublicAccess {
  access: string;
  expiresIn: number;
  file: { name: string; size: number; mime: string };
  contentOrigin: string;
  downloadsLeft: number | null;
}

function publicShell(content: HTMLElement): HTMLElement {
  const appName = state.config?.appName ?? 'Nimbus';
  return h(
    'div',
    { class: 'public-page' },
    h(
      'div',
      { class: 'public-card' },
      h(
        'div',
        { class: 'row' },
        h('div', { class: 'brand-mark', 'aria-hidden': 'true', text: appName.slice(0, 1).toUpperCase() }),
        h(
          'div',
          { class: 'grow' },
          h('strong', { text: appName }),
          h('div', { class: 'muted', style: { fontSize: '12px' }, text: t('public.title') }),
        ),
        h('a', { class: 'btn small', href: '/' }, t('public.backHome')),
      ),
      content,
    ),
  );
}

function errorCard(message: string): HTMLElement {
  return publicShell(
    h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'empty', style: { padding: '30px 10px' } },
        h('div', { class: 'empty-icon' }, icon('link', 28)),
        h('h2', { text: t('public.notFound') }),
        h('p', { text: message }),
      ),
    ),
  );
}

export async function renderPublicShare(token: string): Promise<HTMLElement> {
  const page = publicShell(h('p', { class: 'soft', text: t('common.loading') }));
  let meta: PublicMeta;
  try {
    meta = await api<PublicMeta>(`/api/public/shares/${encodeURIComponent(token)}`, { csrf: false });
  } catch (error) {
    return errorCard(error instanceof ApiError ? error.message : t('public.notFound'));
  }
  const content = h('div', { class: 'stack' });
  page
    .querySelector('.public-card')
    ?.replaceChildren(
      h(
        'div',
        { class: 'row' },
        h('div', { class: 'brand-mark', 'aria-hidden': 'true', text: meta.appName.slice(0, 1).toUpperCase() }),
        h(
          'div',
          { class: 'grow' },
          h('strong', { text: meta.appName }),
          h('div', { class: 'muted', style: { fontSize: '12px' }, text: t('public.title') }),
        ),
        h('a', { class: 'btn small', href: '/' }, t('public.backHome')),
      ),
      content,
    );

  const unlock = async (password?: string): Promise<PublicAccess | null> => {
    try {
      return await api<PublicAccess>(`/api/public/shares/${encodeURIComponent(token)}/unlock`, {
        method: 'POST',
        body: password === undefined ? {} : { password },
        csrf: false,
      });
    } catch (error) {
      content.prepend(
        h('div', {
          class: 'notice danger',
          role: 'alert',
          text: error instanceof ApiError ? error.message : t('public.notFound'),
        }),
      );
      return null;
    }
  };

  const showFile = (access: PublicAccess): void => {
    const origin = (access.contentOrigin || location.origin).replace(/\/$/, '');
    const base = `${origin}/api/public/shares/${encodeURIComponent(token)}/content?access=${encodeURIComponent(access.access)}`;
    const isImage = access.file.mime.startsWith('image/') && !access.file.mime.includes('svg');
    const isPdf = access.file.mime === 'application/pdf';
    content.replaceChildren(
      h(
        'div',
        { class: 'public-file' },
        h('span', { class: 'file-icon' }, icon(isImage ? 'image' : isPdf ? 'pdf' : 'file', 20)),
        h(
          'div',
          { class: 'grow' },
          h('div', { class: 'name', text: access.file.name }),
          h('div', {
            class: 'muted',
            style: { fontSize: '12px' },
            text: `${formatBytes(access.file.size)} · ${access.file.mime || t('common.file')}`,
          }),
        ),
      ),
      access.downloadsLeft !== null
        ? h('div', { class: 'hint', text: t('public.downloadsLeft', { n: access.downloadsLeft }) })
        : h('div', { class: 'hint', text: t('public.unlimited') }),
      ...(meta.expiresAt
        ? [h('div', { class: 'hint', text: t('public.expires', { date: formatDate(meta.expiresAt, true) }) })]
        : []),
      ...(isImage
        ? [
            h(
              'div',
              { class: 'preview-modal-content', style: { maxHeight: '50dvh' } },
              h('img', { src: `${base}&download=0`, alt: access.file.name, loading: 'lazy' }),
            ),
          ]
        : []),
      ...(isPdf
        ? [
            h(
              'div',
              { class: 'preview-modal-content', style: { width: '100%', height: '50dvh' } },
              h('iframe', { src: `${base}&download=0`, title: t('public.preview'), sandbox: '' }),
            ),
          ]
        : []),
      h(
        'a',
        { class: 'btn primary block', href: `${base}&download=1`, rel: 'noopener' },
        icon('download', 17),
        t('public.download'),
      ),
      h('div', { class: 'auth-footer' }, h('span', { text: t('public.poweredBy', { app: meta.appName }) })),
    );
  };

  if (meta.requiresPassword) {
    const password = h('input', {
      class: 'input',
      type: 'password',
      autocomplete: 'current-password',
      required: true,
      id: 'public-password',
    });
    const submit = h('button', { type: 'submit', class: 'btn primary block' }, icon('lock', 16), t('public.unlock'));
    const form = h(
      'form',
      {
        onsubmit: async (event: SubmitEvent) => {
          event.preventDefault();
          submit.disabled = true;
          const access = await unlock(password.value);
          if (access) showFile(access);
          else submit.disabled = false;
        },
      },
      h('div', { class: 'field' }, h('label', { for: 'public-password', text: t('public.passwordPrompt') }), password),
      submit,
    );
    content.replaceChildren(
      h('div', { class: 'notice' }, icon('lock', 18), h('span', { text: t('public.passwordPrompt') })),
      form,
    );
    password.focus();
    return page;
  }

  const access = await unlock();
  if (!access) return page;
  showFile(access);
  return page;
}
