import { t } from './i18n.js';
import { h, icon } from './ui.js';

/**
 * The Nimbus 2000 industrial language lives in a small set of reusable
 * artifact primitives: the mahogany nameplate, the Marauder trail, the brass
 * stirrup action rail and the cloaking switch. They intentionally contain no
 * business logic; views keep owning their existing data flows.
 */

export function nimbusBrandPlate(appName: string): HTMLElement {
  return h(
    'div',
    { class: 'nimbus-plate' },
    h('span', { class: 'nimbus-plate-crest', 'aria-hidden': 'true', text: appName.slice(0, 1).toUpperCase() }),
    h(
      'div',
      { class: 'nimbus-plate-copy' },
      h('strong', { class: 'nimbus-plate-name', text: appName }),
      h('span', { class: 'nimbus-plate-sub', text: t('artifact.personal') }),
    ),
  );
}

export function marauderTrail(label: string): HTMLElement {
  const prints = h('span', { class: 'marauder-prints', 'aria-hidden': 'true' });
  for (let index = 0; index < 4; index += 1) prints.append(h('i', {}));
  return h(
    'div',
    { class: 'marauder-trail' },
    prints,
    h('span', { class: 'marauder-label', text: t('artifact.youAreHere', { place: label }) }),
  );
}

export function brassStirrups(actions: HTMLElement[], label = t('artifact.quickActions')): HTMLElement {
  const rail = h('div', {
    class: 'brass-stirrups',
    role: 'toolbar',
    'aria-label': label,
  });
  for (const action of actions) rail.append(action);
  return rail;
}

export interface PrivacySwitch {
  button: HTMLButtonElement;
  destroy: () => void;
}

/**
 * "Fatto il misfatto": an instant privacy curtain inspired by the Marauder's
 * Map. The current page stays mounted underneath, so restoring it never loses
 * unsaved state, but its pixels are blurred and dimmed immediately.
 */
export function createPrivacySwitch(): PrivacySwitch {
  let active = false;
  const veil = h(
    'button',
    {
      type: 'button',
      class: 'cloak-veil',
      hidden: true,
      'aria-label': t('artifact.cloakExit'),
    },
    h('span', { class: 'cloak-seal', 'aria-hidden': 'true', text: 'M' }),
    h('strong', { text: t('artifact.cloakActive') }),
    h('span', { class: 'cloak-hint', text: t('artifact.cloakHint') }),
  );
  const button = h(
    'button',
    {
      type: 'button',
      class: 'icon-btn privacy-switch',
      'aria-pressed': 'false',
      'aria-label': t('artifact.cloak'),
      title: t('artifact.cloak'),
      onclick: () => setActive(!active),
    },
    icon('lock', 18),
  );

  const setActive = (next: boolean): void => {
    active = next;
    document.documentElement.toggleAttribute('data-cloak', next);
    veil.hidden = !next;
    button.setAttribute('aria-pressed', String(next));
    button.setAttribute('aria-label', next ? t('artifact.cloakExit') : t('artifact.cloak'));
    button.title = next ? t('artifact.cloakExit') : t('artifact.cloak');
    if (next) veil.focus();
    else button.focus();
  };

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && active) {
      event.preventDefault();
      setActive(false);
    }
  };
  veil.addEventListener('click', () => setActive(false));
  document.addEventListener('keydown', onKey);
  document.body.append(veil);

  return {
    button,
    destroy: () => {
      document.removeEventListener('keydown', onKey);
      document.documentElement.removeAttribute('data-cloak');
      veil.remove();
    },
  };
}
