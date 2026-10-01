import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { bundlesFrom } from '../../i18n/bundles';
import { STANDALONE_LANGUAGE } from '../../i18n/standalone';

/**
 * Round 10 (i18n) — DEV-PLAN's per-zone scheme, mirroring diagrams/i18n and
 * editor/i18n exactly: this zone owns and registers its own bundle under its
 * own namespace, at import time, idempotently.
 *
 * As of this writing web/src/i18n/ (the central module — language detection,
 * localStorage 'folio:lang', the switcher, initReactI18next wiring) doesn't
 * exist yet; SHELL owns that and it's tracked as separate follow-up work, not
 * folded into this round. If it's still missing when this module first runs,
 * a minimal i18next.init(...) keeps useTranslation('markdown') working
 * standalone (English, no detection) instead of throwing/warning. Once the
 * real central init exists and runs first (the expected case), isInitialized
 * is already true and this fallback never fires.
 */
if (!i18next.isInitialized) {
  void i18next.use(initReactI18next).init({
    lng: STANDALONE_LANGUAGE,
    fallbackLng: STANDALONE_LANGUAGE,
    ns: ['markdown'],
    defaultNS: 'markdown',
    resources: {},
    interpolation: { escapeValue: false }, // React already escapes; avoid double-escaping.
  });
}

const NS = 'markdown';
// Every language that has a bundle next to this file.
const bundles = bundlesFrom(import.meta.glob('./*.json', { eager: true, import: 'default' }));

for (const [lang, bundle] of Object.entries(bundles)) {
  if (!i18next.hasResourceBundle(lang, NS)) {
    i18next.addResourceBundle(lang, NS, bundle);
  }
}

/**
 * Namespaced lookup for the one non-React caller in this zone: pipeline.ts's
 * directive-fallback rehype plugin runs inside a plain unified transform,
 * not a component, so it can't call useTranslation(). Mirrors editor/i18n's
 * own t() helper for the same reason.
 */
export function t(key: string, options?: Record<string, unknown>): string {
  return i18next.t(`${NS}:${key}`, options ?? {}) as string;
}
