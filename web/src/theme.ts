export type Theme = 'system' | 'light' | 'dark' | 'black';
export type Atmosphere = 'auto' | 'day' | 'dusk' | 'night';
export type ResolvedAtmosphere = Exclude<Atmosphere, 'auto'>;
export type House = 'none' | 'gryffindor' | 'slytherin' | 'ravenclaw' | 'hufflepuff';

const THEME_KEY = 'nimbus-theme';
const ATMOSPHERE_KEY = 'nimbus-atmosphere';
const HOUSE_KEY = 'nimbus-house';

function resolvedAtmosphere(theme: Theme, atmosphere: Atmosphere): ResolvedAtmosphere {
  if (atmosphere !== 'auto') return atmosphere;
  if (theme === 'light') return 'day';
  if (theme === 'black') return 'night';
  if (theme === 'system') return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dusk' : 'day';
  return 'dusk';
}

function themeColor(atmosphere: ResolvedAtmosphere): string {
  if (atmosphere === 'day') return '#f4ebd9';
  if (atmosphere === 'night') return '#0f1412';
  return '#2b2620';
}

function syncAtmosphere(theme: Theme, atmosphere: Atmosphere): void {
  const resolved = resolvedAtmosphere(theme, atmosphere);
  document.documentElement.dataset.atmosphere = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', themeColor(resolved));
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode / storage disabled
  }
}

export function applyTheme(theme: Theme): void {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  store(THEME_KEY, theme);
  syncAtmosphere(theme, storedAtmosphere());
}

export function storedTheme(): Theme {
  try {
    const value = localStorage.getItem(THEME_KEY);
    if (value === 'light' || value === 'dark' || value === 'black' || value === 'system') return value;
  } catch {
    // ignore
  }
  return 'dark';
}

export function applyAtmosphere(atmosphere: Atmosphere): void {
  store(ATMOSPHERE_KEY, atmosphere);
  syncAtmosphere(storedTheme(), atmosphere);
}

export function storedAtmosphere(): Atmosphere {
  try {
    const value = localStorage.getItem(ATMOSPHERE_KEY);
    if (value === 'auto' || value === 'day' || value === 'dusk' || value === 'night') return value;
  } catch {
    // ignore
  }
  return 'auto';
}

export function applyHouse(house: House): void {
  if (house === 'none') delete document.documentElement.dataset.house;
  else document.documentElement.dataset.house = house;
  store(HOUSE_KEY, house);
}

export function storedHouse(): House {
  try {
    const value = localStorage.getItem(HOUSE_KEY);
    if (
      value === 'none' ||
      value === 'gryffindor' ||
      value === 'slytherin' ||
      value === 'ravenclaw' ||
      value === 'hufflepuff'
    ) {
      return value;
    }
  } catch {
    // ignore
  }
  return 'none';
}

export function storedLanguage(): string | null {
  try {
    return localStorage.getItem('nimbus-lang');
  } catch {
    return null;
  }
}

export function rememberLanguage(lang: string): void {
  store('nimbus-lang', lang);
}
