import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { bundlesFrom } from '../../i18n/bundles';
import { STANDALONE_LANGUAGE } from '../../i18n/standalone';

/**
 * Round FORMS — mirrors web/src/tables/i18n/register.ts / web/src/markdown/
 * i18n/register.ts: this zone owns and registers its own 'forms' bundle at
 * import time, idempotently. Kept separate from 'app'/'markdown' namespaces
 * on purpose — FormRenderer is mounted from BOTH (the page route and the
 * `::form{id}` embed widget), and it must not need either.
 */
if (!i18next.isInitialized) {
  void i18next.use(initReactI18next).init({
    lng: STANDALONE_LANGUAGE,
    fallbackLng: STANDALONE_LANGUAGE,
    ns: ['forms'],
    defaultNS: 'forms',
    resources: {},
    interpolation: { escapeValue: false },
  });
}

const NS = 'forms';
// Every language that has a bundle next to this file.
const bundles = bundlesFrom(import.meta.glob('./*.json', { eager: true, import: 'default' }));

for (const [lang, bundle] of Object.entries(bundles)) {
  if (!i18next.hasResourceBundle(lang, NS)) {
    i18next.addResourceBundle(lang, NS, bundle);
  }
}
