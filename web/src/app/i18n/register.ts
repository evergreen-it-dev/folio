import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { bundlesFrom } from '../../i18n/bundles';
import { STANDALONE_LANGUAGE } from '../../i18n/standalone';

/**
 * Round 10 (i18n) — DEV-PLAN's per-zone scheme, mirroring diagrams/i18n and
 * editor/i18n exactly: this zone (app/, the biggest one — SHELL's own UI)
 * owns and registers its own bundle under its own namespace, at import
 * time, idempotently. The central web/src/i18n/ module (also SHELL-owned,
 * see its own doc comment) is what actually drives language resolution and
 * switching; this file only makes the `app` namespace's strings available
 * to it, and works standalone (English, no detection) if this module is
 * somehow reached before the central one has run.
 */
if (!i18next.isInitialized) {
  void i18next.use(initReactI18next).init({
    lng: STANDALONE_LANGUAGE,
    fallbackLng: STANDALONE_LANGUAGE,
    ns: ['app'],
    defaultNS: 'app',
    resources: {},
    interpolation: { escapeValue: false },
  });
}

const NS = 'app';
// Every language that has a bundle next to this file.
const bundles = bundlesFrom(import.meta.glob('./*.json', { eager: true, import: 'default' }));

for (const [lang, bundle] of Object.entries(bundles)) {
  if (!i18next.hasResourceBundle(lang, NS)) {
    i18next.addResourceBundle(lang, NS, bundle);
  }
}

/** Namespaced lookup for the rare non-React caller in this zone (e.g. a toast fired from a non-component helper). */
export function t(key: string, options?: Record<string, unknown>): string {
  return i18next.t(`${NS}:${key}`, options ?? {}) as string;
}
