type Renderer = () => void;

let renderer: Renderer | null = null;

export function setRenderer(fn: Renderer): void {
  renderer = fn;
}

export function rerender(): void {
  renderer?.();
}

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  const target = path.startsWith('/') ? path : `/${path}`;
  if (target === `${location.pathname}${location.search}`) {
    window.scrollTo({ top: 0 });
    return;
  }
  if (options.replace) history.replaceState(null, '', target);
  else history.pushState(null, '', target);
  renderer?.();
  window.scrollTo({ top: 0 });
}

export function initRouter(): void {
  window.addEventListener('popstate', () => renderer?.());
  document.addEventListener('click', (event) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href || !href.startsWith('/') || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
    if (anchor.origin !== location.origin) return;
    event.preventDefault();
    navigate(href);
  });
}
