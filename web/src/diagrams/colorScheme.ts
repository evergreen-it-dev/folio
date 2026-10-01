import { useEffect, useState } from 'react';

/**
 * Shared light/dark detection used by both MermaidBlock (mermaid theme) and
 * BoardCanvas (excalidraw theme) so the two diagram types stay visually in
 * sync with the rest of the page.
 *
 * The rule is the one the stylesheets already use (markdown.css, styles.css,
 * editor.css): an explicit `data-theme` on <html> — written by
 * SettingsProvider (web/src/app/settings.tsx) for the "light"/"dark" choices
 * — WINS, and `prefers-color-scheme` only decides for "system", which removes
 * the attribute. Reading only the media query (as this module did until now)
 * meant a reader on a light OS who explicitly picked the dark theme got white
 * mermaid diagrams and a white excalidraw canvas on a near-black page; the
 * editor's own mermaid modal, which owns a correct copy of this rule
 * (editor/mermaid-visual.tsx's isDarkTheme), rendered the SAME diagram dark,
 * so one page could show both.
 */
export type ColorScheme = 'light' | 'dark';

const QUERY = '(prefers-color-scheme: dark)';
const THEME_ATTRIBUTE = 'data-theme';

export function getColorScheme(): ColorScheme {
  const chosen = typeof document === 'undefined' ? null : document.documentElement.getAttribute(THEME_ATTRIBUTE);
  if (chosen === 'dark') return 'dark';
  if (chosen === 'light') return 'light';
  if (typeof window === 'undefined' || !window.matchMedia) return 'light';
  return window.matchMedia(QUERY).matches ? 'dark' : 'light';
}

/**
 * Subscribe to color-scheme changes. Returns an unsubscribe function.
 *
 * Two sources, because there are two ways the answer can change: the OS/
 * browser preference (matchMedia) and the user picking a theme in the app
 * (SettingsProvider setting/removing `data-theme`, which fires no event of
 * its own — hence the MutationObserver). Both funnel through getColorScheme
 * so the precedence rule lives in exactly one place, and both are deduped by
 * the caller (mermaidSetup) against the last value it applied, so an
 * attribute change that doesn't actually flip the scheme (light -> system on
 * a light OS) re-renders nothing.
 */
export function subscribeColorScheme(onChange: (scheme: ColorScheme) => void): () => void {
  const notify = () => onChange(getColorScheme());
  const cleanups: Array<() => void> = [];

  if (typeof window !== 'undefined' && window.matchMedia) {
    const mql = window.matchMedia(QUERY);
    mql.addEventListener('change', notify);
    cleanups.push(() => mql.removeEventListener('change', notify));
  }

  if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
    const observer = new MutationObserver(notify);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: [THEME_ATTRIBUTE] });
    cleanups.push(() => observer.disconnect());
  }

  return () => cleanups.forEach((off) => off());
}

/** React hook mirroring the current color scheme, updated live on change. */
export function useColorScheme(): ColorScheme {
  const [scheme, setScheme] = useState<ColorScheme>(getColorScheme);
  useEffect(() => subscribeColorScheme(setScheme), []);
  return scheme;
}
