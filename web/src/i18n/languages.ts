import type { UiLanguage } from '@shared/contracts';
import { bundlesFrom } from './bundles';

/**
 * The interface languages this build actually has, and each one's own name
 * for itself. Both come from the `app` bundles: a language is available when
 * its bundle file exists, and its endonym is that bundle's `_language` key —
 * so a build without a bundle has neither the option nor its label.
 */
const APP_BUNDLES = bundlesFrom(import.meta.glob('../app/i18n/*.json', { eager: true, import: 'default' }));

/** Ukrainian first (the default), English second, anything else after them. */
const PREFERRED_ORDER = ['uk', 'en'];

export const UI_LANGUAGES: readonly UiLanguage[] = Object.keys(APP_BUNDLES).sort((a, b) => {
  const ia = PREFERRED_ORDER.indexOf(a);
  const ib = PREFERRED_ORDER.indexOf(b);
  return (ia === -1 ? PREFERRED_ORDER.length : ia) - (ib === -1 ? PREFERRED_ORDER.length : ib) || a.localeCompare(b);
}) as UiLanguage[];

/** A language's own name for itself — never translated. */
export function languageName(lang: string): string {
  const name = (APP_BUNDLES[lang] as { _language?: unknown } | undefined)?._language;
  return typeof name === 'string' && name ? name : lang;
}

export function isUiLanguage(value: string | null | undefined): value is UiLanguage {
  return !!value && (UI_LANGUAGES as readonly string[]).includes(value);
}
