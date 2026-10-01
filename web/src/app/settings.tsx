import { createContext, useContext, useEffect } from 'react';
import type { ReactNode } from 'react';
import { useLocalStorage } from './hooks';

export type ThemeMode = 'light' | 'dark' | 'system';
export type ContentWidth = 'narrow' | 'wide';

const THEME_KEY = 'folio:theme';
const WIDTH_KEY = 'folio:width';

/** light -> dark -> system -> light. Pure, used by both the user menu and the quick-switcher "toggle theme" action. */
export function cycleThemeMode(mode: ThemeMode): ThemeMode {
  if (mode === 'light') return 'dark';
  if (mode === 'dark') return 'system';
  return 'light';
}

interface SettingsContextValue {
  theme: ThemeMode;
  setTheme: (mode: ThemeMode) => void;
  width: ContentWidth;
  setWidth: (width: ContentWidth) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

/**
 * Applies theme/width as attributes on <html> (outside React's own tree, so
 * this is the one place that reaches for the DOM directly) and shares both
 * through context so every consumer (user menu, quick switcher's theme
 * action, the markdown/editor content root) re-renders in lockstep — two
 * independent useLocalStorage calls would each keep their own copy and
 * drift out of sync with each other until an unrelated re-render happened.
 *
 * Theme: 'system' removes data-theme (prefers-color-scheme CSS takes over);
 * 'light'/'dark' sets it explicitly, and markdown.css/styles.css treat
 * [data-theme] as an override on top of the prefers-color-scheme blocks.
 * Known gap (see report): web/src/editor/editor.css and
 * web/src/diagrams/colorScheme.ts each own their *own* dark-mode detection
 * (prefers-color-scheme media queries and window.matchMedia respectively)
 * and don't read this attribute — an explicit light/dark choice re-themes
 * the shell and the markdown reading content, but not the editor's own
 * chrome or mermaid/excalidraw, which keep following the OS setting.
 *
 * Width: 'narrow' (default, ~72ch) vs 'wide' (100% - 4rem) is exposed the
 * same way as data-width, consumed by .folio-markdown. It does NOT reach
 * the editor's source/live CodeMirror surface, which hardcodes its own
 * measure (--folio-ed-measure: 72ch in editor.css) — also noted in the report.
 */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useLocalStorage<ThemeMode>(THEME_KEY, 'system');
  const [width, setWidth] = useLocalStorage<ContentWidth>(WIDTH_KEY, 'narrow');

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute('data-width', width);
  }, [width]);

  return <SettingsContext.Provider value={{ theme, setTheme, width, setWidth }}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used within <SettingsProvider>');
  return ctx;
}
