import { events, on } from '../bus.js';
import { startCall, startGroupCall } from '../calls-manager.js';
import { t } from '../i18n.js';
import { navigate } from '../router.js';
import { state } from '../store.js';
import { avatarEl, emptyState, h, icon, openModal, toast } from '../ui.js';
import type { View } from './types.js';

export function renderCalls(): View {
  const grid = h('div', { class: 'calls-grid' });
  const notice = h('div', { class: 'notice' });
  const page = h('div', { class: 'stack' });

  function renderNotice(): void {
    if (!window.isSecureContext) {
      notice.className = 'notice warn';
      notice.replaceChildren(
        icon('lock', 18),
        h(
          'div',
          { class: 'grow' },
          h('strong', { text: t('calls.insecure') }),
          h('div', {
            class: 'hint',
            text: 'Apri la guida per configurare HTTPS con Tailscale, Cloudflare Tunnel o un reverse proxy.',
          }),
        ),
        h('button', { type: 'button', class: 'btn small', onclick: () => navigate('/help') }, t('settings.httpsGuide')),
      );
    } else if (!state.config?.turnConfigured) {
      notice.className = 'notice';
      notice.replaceChildren(
        icon('cloud', 18),
        h(
          'div',
          { class: 'grow' },
          h('strong', { text: 'TURN non configurato' }),
          h('div', {
            class: 'hint',
            text: 'Le chiamate funzionano solo sulla stessa rete locale o con NAT favorevole. Configura coturn e TURN_HOST/TURN_URLS per l’uso da remoto.',
          }),
        ),
      );
    } else {
      notice.remove();
    }
  }

  function renderCards(): void {
    grid.replaceChildren();
    const contacts = state.contacts;
    if (contacts.length === 0) {
      grid.append(
        emptyState(
          'phone',
          t('calls.noContacts'),
          'Gli altri utenti dell’istanza appariranno qui.',
          h('button', { type: 'button', class: 'btn primary', onclick: () => navigate('/chat') }, t('chat.newChat')),
        ),
      );
      return;
    }
    for (const contact of contacts) {
      const online = contact.status !== 'offline' && !contact.blocked;
      const card = h(
        'div',
        { class: 'call-contact' },
        avatarEl(contact, { size: 'lg' }),
        h(
          'div',
          { class: 'grow' },
          h('strong', { text: contact.displayName }),
          h('div', { class: 'sub', text: `@${contact.username} · ${t('common.' + contact.status)}` }),
          contact.blocked ? h('span', { class: 'badge danger', text: 'Bloccato' }) : null,
        ),
        h(
          'div',
          { class: 'call-buttons' },
          h(
            'button',
            {
              type: 'button',
              class: 'icon-btn',
              'aria-label': t('calls.audio'),
              title: t('calls.audio'),
              disabled: !online,
              onclick: () => startCall(contact.id, 'audio'),
            },
            icon('phone', 18),
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'icon-btn',
              'aria-label': t('calls.video'),
              title: t('calls.video'),
              disabled: !online,
              onclick: () => startCall(contact.id, 'video'),
            },
            icon('video', 18),
          ),
        ),
      );
      grid.append(card);
    }
  }

  function openGroupDialog(): void {
    const selected = new Set<string>();
    const list = h('div', { class: 'stack' });
    const online = state.contacts.filter((contact) => contact.status !== 'offline' && !contact.blocked);
    if (online.length === 0) {
      list.append(h('p', { class: 'soft', text: t('qs.noContacts') }));
    }
    for (const contact of online) {
      const checkbox = h('input', {
        type: 'checkbox',
        onchange: () => {
          if (checkbox.checked) {
            if (selected.size >= 3) {
              checkbox.checked = false;
              toast('Massimo 3 partecipanti oltre a te.', 'error');
              return;
            }
            selected.add(contact.id);
          } else selected.delete(contact.id);
        },
      });
      list.append(
        h(
          'label',
          { class: 'row', style: { padding: '7px 0', cursor: 'pointer' } },
          checkbox,
          avatarEl(contact, { size: 'sm' }),
          h('span', { text: contact.displayName }),
        ),
      );
    }
    const kind = h(
      'select',
      { class: 'select' },
      h('option', { value: 'video', text: t('calls.video') }),
      h('option', { value: 'audio', text: t('calls.audio') }),
    );
    const modal = openModal({
      title: t('calls.newGroup'),
      body: h(
        'div',
        { class: 'stack' },
        h('p', { class: 'soft', text: 'Fino a 4 partecipanti in mesh P2P. Ogni chiamata è cifrata con DTLS-SRTP.' }),
        h('div', { class: 'field' }, h('label', { text: 'Tipo' }), kind),
        list,
      ),
      wide: true,
      actions: [
        { label: t('common.cancel') },
        {
          label: t('calls.start'),
          kind: 'primary',
          close: false,
          onClick: async () => {
            if (selected.size === 0) {
              toast('Seleziona almeno una persona.', 'error');
              return;
            }
            modal.close();
            await startGroupCall([...selected], kind.value === 'audio' ? 'audio' : 'video');
          },
        },
      ],
    });
  }

  const head = h(
    'div',
    { class: 'page-head' },
    h(
      'div',
      { class: 'grow' },
      h('h1', { text: t('calls.title') }),
      h('p', { class: 'sub', text: t('calls.subtitle') }),
    ),
    h(
      'div',
      { class: 'actions' },
      h(
        'button',
        { type: 'button', class: 'btn', onclick: () => openGroupDialog() },
        icon('users', 16),
        t('calls.newGroup'),
      ),
      h(
        'button',
        { type: 'button', class: 'btn', onclick: () => navigate('/chat') },
        icon('chat', 16),
        t('chat.title'),
      ),
    ),
  );

  page.append(head, notice, grid);
  renderNotice();
  renderCards();
  const unsubscribe = on(events.contactsUpdated, () => {
    renderNotice();
    renderCards();
  });
  return {
    node: page,
    destroy: unsubscribe,
  };
}
