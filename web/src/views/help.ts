import { t } from '../i18n.js';
import { navigate } from '../router.js';
import { h, icon } from '../ui.js';
import type { View } from './types.js';

function section(title: string, paragraphs: string[]): HTMLElement {
  return h('section', {}, h('h2', { text: title }), ...paragraphs.map((text) => h('p', { text })));
}

export function renderHelp(): View {
  const secure = window.isSecureContext;
  const node = h(
    'div',
    { class: 'stack', style: { maxWidth: '820px' } },
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', { text: t('help.title') }), h('p', { class: 'sub', text: t('help.intro') })),
      h(
        'div',
        { class: 'actions' },
        h(
          'button',
          { type: 'button', class: 'btn', onclick: () => navigate('/') },
          icon('arrowLeft', 16),
          t('help.back'),
        ),
      ),
    ),
    h(
      'div',
      { class: `notice ${secure ? '' : 'warn'}` },
      icon(secure ? 'shield' : 'lock', 18),
      h('span', { text: secure ? t('help.secureBanner') : t('help.insecureBanner') }),
    ),
    h(
      'div',
      { class: 'card pad prose' },
      section(t('help.tailscaleTitle'), [t('help.tailscaleText')]),
      section(t('help.cloudflareTitle'), [t('help.cloudflareText')]),
      section(t('help.proxyTitle'), [t('help.proxyText')]),
      section(t('help.turnTitle'), [t('help.turnText')]),
      h('h2', { text: t('help.details') }),
      h(
        'div',
        { class: 'secret-box' },
        [
          '# Tailscale (sul server)',
          'tailscale up --https',
          'tailscale serve https / http://127.0.0.1:3456',
          '',
          '# Cloudflare Tunnel / reverse proxy',
          'TRUST_PROXY=true',
          'REQUIRE_HTTPS=true',
          'TURN_HOST=turn.example.com',
          'TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp',
        ].join('\n'),
      ),
      h('p', {
        class: 'hint',
        text: 'La connessione HTTP sulla rete locale resta utilizzabile per file e chat, ma senza contesto sicuro il browser non espone camera, microfono, Web Crypto, notifiche push e Service Worker.',
      }),
    ),
  );
  return { node };
}
