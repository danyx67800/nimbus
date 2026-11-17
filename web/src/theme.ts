export type Theme = 'system' | 'light' | 'dark';

const KEY = 'nimbus-theme';

export function applyTheme(theme: Theme): void {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // private mode / storage disabled
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    meta.setAttribute('content', dark ? '#080c17' : '#f2f5fb');
  }
}

export function storedTheme(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    if (value === 'light' || value === 'dark' || value === 'system') return value;
  } catch {
    // ignore
  }
  return 'system';
}

export function storedLanguage(): string | null {
  try {
    return localStorage.getItem('nimbus-lang');
  } catch {
    return null;
  }
}

export function rememberLanguage(lang: string): void {
  try {
    localStorage.setItem('nimbus-lang', lang);
  } catch {
    // ignore
  }
}
