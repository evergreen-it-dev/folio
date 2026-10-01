import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { bundlesFrom } from '../../i18n/bundles';
import { STANDALONE_LANGUAGE } from '../../i18n/standalone';

/**
 * Round 26 (DATA TABLES) — mirrors web/src/markdown/i18n/register.ts exactly:
 * this zone owns and registers its own 'tables' bundle at import time,
 * idempotently. TABLES-UI fills in uk/en/ru.json; this file itself shouldn't
 * need touching.
 */
if (!i18next.isInitialized) {
  void i18next.use(initReactI18next).init({
    lng: STANDALONE_LANGUAGE,
    fallbackLng: STANDALONE_LANGUAGE,
    ns: ['tables'],
    defaultNS: 'tables',
    resources: {},
    interpolation: { escapeValue: false },
  });
}

const NS = 'tables';
// Every language that has a bundle next to this file.
const bundles = bundlesFrom(import.meta.glob('./*.json', { eager: true, import: 'default' }));

for (const [lang, bundle] of Object.entries(bundles)) {
  if (!i18next.hasResourceBundle(lang, NS)) {
    i18next.addResourceBundle(lang, NS, bundle);
  }
}
