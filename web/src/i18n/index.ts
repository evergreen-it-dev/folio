import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import type { UiLanguage } from '@shared/contracts';
import { api } from '../app/api';
import { UI_LANGUAGES, isUiLanguage } from './languages';

/**
 * Central i18n bootstrap (Round 10, owned by SHELL). Must run and resolve
 * BEFORE the app renders — see main.tsx, which awaits initI18n() before its
 * first createRoot().render() call.
 *
 * Deliberately never passes `resources` into init(): each zone
 * (editor/diagrams/markdown/app/emoji) registers its own bundle via
 * i18next.addResourceBundle at import time (idempotent), and doing so here
 * would wipe out whichever zone happened to register first if it ran before
 * this module. editor/diagrams already defend against the reverse ordering
 * too (their own standalone-init guard fires if THEY load before this file
 * has run), so either import order works correctly.
 */
export const LANG_STORAGE_KEY = 'folio:lang';
/** The languages this build has bundles for — see ./languages.ts. */
const SUPPORTED_LANGS: readonly UiLanguage[] = UI_LANGUAGES;
const DEFAULT_LANG: UiLanguage = 'en';

const isSupported = isUiLanguage;

/**
 * localStorage -> browser language (first available match) -> English. The user's
 * own PROFILE preference isn't known yet at this point — it needs an
 * authenticated fetch, which only happens once AuthProvider mounts and
 * resolves GET /api/auth/state. See reconcileLanguageFromProfile below for
 * how that gets folded in afterwards.
 */
function resolveInitialLanguage(): UiLanguage {
  try {
    const stored = localStorage.getItem(LANG_STORAGE_KEY);
    if (isSupported(stored)) return stored;
  } catch {
    // storage unavailable (private mode, etc.) — fall through to browser detection
  }
  const candidates = typeof navigator !== 'undefined' ? (navigator.languages ?? [navigator.language]) : [];
  for (const candidate of candidates) {
    const base = candidate?.slice(0, 2).toLowerCase();
    if (isSupported(base)) return base;
  }
  return DEFAULT_LANG;
}

let initPromise: Promise<unknown> | null = null;

/** Screen readers, spellcheck and hyphenation all read <html lang>. */
function syncDocumentLang(lang: string): void {
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
}

/** Idempotent — safe to call more than once (App.tsx's dev-server remounts, tests). */
export function initI18n(): Promise<unknown> {
  if (!initPromise) {
    i18next.on('languageChanged', syncDocumentLang);
    initPromise = i18next
      .use(initReactI18next)
      .init({
        lng: resolveInitialLanguage(),
        fallbackLng: DEFAULT_LANG,
        supportedLngs: SUPPORTED_LANGS as unknown as string[],
        ns: ['app', 'editor', 'diagrams', 'markdown', 'emoji', 'tables'],
        defaultNS: 'app',
        interpolation: { escapeValue: false }, // React already escapes; avoid double-escaping.
      })
      .then(() => syncDocumentLang(i18next.language));
  }
  return initPromise;
}

/**
 * Explicit choice from the language switcher (user menu): writes
 * localStorage, switches i18next immediately (so the whole app re-renders
 * live, no reload), then best-effort persists to the user's profile so it
 * follows them to a new device. A failed PATCH doesn't undo the switch the
 * user already sees and asked for — it just won't be remembered server-side
 * until a later successful call.
 */
export async function setUiLanguage(lang: UiLanguage): Promise<void> {
  try {
    localStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    // private mode etc. — the in-memory switch below still works this session
  }
  await i18next.changeLanguage(lang);
  try {
    await api.updateMyPreferences({ lang });
  } catch {
    // offline/network hiccup — language already switched locally
  }
}

/**
 * Called once by AuthProvider right after GET /api/auth/state resolves —
 * brings a device that's never set localStorage (or was on a stale value)
 * in line with the user's saved profile preference. A device that already
 * matches, or a user with no profile preference set yet, is a no-op.
 */
export function reconcileLanguageFromProfile(profileLang: UiLanguage | undefined): void {
  if (!isSupported(profileLang)) return;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(LANG_STORAGE_KEY);
  } catch {
    // ignore — see resolveInitialLanguage
  }
  if (stored === profileLang) return;
  try {
    localStorage.setItem(LANG_STORAGE_KEY, profileLang);
  } catch {
    // ignore
  }
  void i18next.changeLanguage(profileLang);
}

export { SUPPORTED_LANGS as SUPPORTED_UI_LANGUAGES };
