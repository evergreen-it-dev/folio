import mermaid from 'mermaid';
import { getColorScheme, subscribeColorScheme, type ColorScheme } from './colorScheme';

/**
 * mermaid.initialize() configures module-level global state inside the
 * mermaid package itself — there must be exactly one owner of it. Every
 * MermaidBlock instance shares this singleton instead of calling
 * mermaid.initialize() itself, and subscribes to onMermaidThemeChange to
 * know when a re-render is needed after the OS/browser theme flips.
 */

let scheme: ColorScheme = 'light';
let initialized = false;
const listeners = new Set<() => void>();

function apply(next: ColorScheme): void {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: next === 'dark' ? 'dark' : 'neutral',
  });
}

/** Idempotent: configures mermaid once and starts listening for theme changes. */
export function ensureMermaidInitialized(): void {
  if (initialized) return;
  initialized = true;
  // Read the scheme HERE, not at module-evaluation time: `data-theme` is set
  // by SettingsProvider's effect (web/src/app/settings.tsx), which runs after
  // this module is imported. A module-load snapshot would therefore miss an
  // explicit light/dark choice on the very first render, and — since the
  // attribute is already in place by then — no MutationObserver change would
  // ever arrive to correct it.
  scheme = getColorScheme();
  apply(scheme);
  subscribeColorScheme((next) => {
    if (next === scheme) return;
    scheme = next;
    apply(scheme);
    listeners.forEach((listener) => listener());
  });
}

/**
 * Subscribe to color-scheme changes that require mounted diagrams to
 * re-render (mermaid must be re-run per-diagram; there's no way to re-theme
 * already-rendered SVG output in place). Returns an unsubscribe function.
 */
export function onMermaidThemeChange(listener: () => void): () => void {
  ensureMermaidInitialized();
  listeners.add(listener);
  return () => listeners.delete(listener);
}
