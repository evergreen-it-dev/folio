export type ThemeMode = 'light' | 'dark' | 'system';
export const THEME_KEY = 'folio:theme';

/** The dark theme-color precedes the light fallback in both HTML entry points. */
export function applyTheme(theme: ThemeMode) {
  const root = document.documentElement;
  const darkColor = document.querySelector<HTMLMetaElement>('#dark-theme-color');
  if (theme === 'dark' || theme === 'light') {
    root.dataset.theme = theme;
    darkColor?.setAttribute('media', theme === 'dark' ? 'all' : 'not all');
  } else {
    root.removeAttribute('data-theme');
    darkColor?.setAttribute('media', '(prefers-color-scheme: dark)');
  }
}

export function restoreTheme() {
  try {
    applyTheme(JSON.parse(localStorage.getItem(THEME_KEY) ?? 'null'));
  } catch {
    applyTheme('system');
  }
}
