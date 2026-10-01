/**
 * Translation bundles for the `editor` namespace.
 *
 * Every zone owns and registers its own bundles (DEV-PLAN round 10) so the
 * central `web/src/i18n/` init never has to know about all of them. Importing
 * this module is enough: registration is idempotent and re-runs if i18next is
 * initialised (or re-initialised) after us, which is what happens when the
 * central module boots later than the first editor import.
 */
import i18next from 'i18next';
import { bundlesFrom } from '../../i18n/bundles';
import { STANDALONE_LANGUAGE } from '../../i18n/standalone';

export const NS = 'editor';

// Every language that has a bundle next to this file.
const BUNDLES: Record<string, unknown> = bundlesFrom(import.meta.glob('./*.json', { eager: true, import: 'default' }));

function registerBundles(): void {
  for (const [lang, bundle] of Object.entries(BUNDLES)) {
    i18next.addResourceBundle(lang, NS, bundle, true, false);
  }
}

/**
 * Standalone fallback: when the editor is loaded before (or without) the central
 * module — unit tests, Storybook-style isolation — a minimal init keeps `t()`
 * working instead of returning bare keys.
 */
if (!i18next.isInitialized) {
  void i18next.init({
    lng: STANDALONE_LANGUAGE,
    fallbackLng: STANDALONE_LANGUAGE,
    resources: {},
    interpolation: { escapeValue: false },
  });
}

registerBundles();
// A later central `init()` replaces the resource store, so re-add ours.
i18next.on('initialized', registerBundles);

/** Namespaced lookup for non-React code (widgets, CM extensions, toasts). */
export function t(key: string, options?: Record<string, unknown>): string {
  return i18next.t(`${NS}:${key}`, options ?? {}) as string;
}

/**
 * Subscribe to language switches. Anything that *caches* rendered labels
 * (the slash menu, the placeholder, the empty-page hint) has to rebuild here,
 * otherwise switching would need a remount.
 */
export function onLanguageChanged(listener: () => void): () => void {
  i18next.on('languageChanged', listener);
  return () => i18next.off('languageChanged', listener);
}
