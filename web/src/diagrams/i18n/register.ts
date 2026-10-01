import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { bundlesFrom } from '../../i18n/bundles';
import { STANDALONE_LANGUAGE } from '../../i18n/standalone';

/**
 * Round 10 (i18n) — DEV-PLAN's mandatory per-zone scheme: each zone owns and
 * registers its own bundle under its own namespace, at import time,
 * idempotently, rather than a central module holding everyone's strings.
 *
 * NOTE for SHELL: as of this writing, web/src/i18n/ (the central module —
 * app-wide language detection, localStorage 'folio:lang', the language
 * switcher, initReactI18next wiring) doesn't exist yet. If it's still
 * missing when this module first runs, we do a minimal `i18next.init(...)`
 * ourselves so `useTranslation('diagrams')` works standalone (English, no
 * detection) instead of throwing/warning — then register normally either
 * way. Once web/src/i18n/'s real init exists and runs before this module is
 * ever reached (the expected case — it's app-wide setup, imported from the
 * app root ahead of any lazy feature code), `isInitialized` is already true
 * and this fallback never fires.
 */
if (!i18next.isInitialized) {
  void i18next.use(initReactI18next).init({
    lng: STANDALONE_LANGUAGE,
    fallbackLng: STANDALONE_LANGUAGE,
    ns: ['diagrams'],
    defaultNS: 'diagrams',
    resources: {},
    interpolation: { escapeValue: false }, // React already escapes; avoid double-escaping.
  });
}

const NS = 'diagrams';
// Every language that has a bundle next to this file.
const bundles = bundlesFrom(import.meta.glob('./*.json', { eager: true, import: 'default' }));

for (const [lang, bundle] of Object.entries(bundles)) {
  if (!i18next.hasResourceBundle(lang, NS)) {
    i18next.addResourceBundle(lang, NS, bundle);
  }
}
