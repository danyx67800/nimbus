export type Theme = 'system' | 'light' | 'dark' | 'black';

const KEY = 'nimbus-theme';

function themeColor(theme: Theme): string {
  if (theme === 'black') return '#000000';
  if (theme === 'light') return '#fbf8ff';
  if (theme === 'system' && !window.matchMedia('(prefers-color-scheme: dark)').matches) return '#fbf8ff';
  return '#0a0714';
}

export function applyTheme(theme: Theme): void {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // private mode / storage disabled
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', themeColor(theme));
}

export function storedTheme(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    if (value === 'light' || value === 'dark' || value === 'black' || value === 'system') return value;
  } catch {
    // ignore
  }
  return 'dark';
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
