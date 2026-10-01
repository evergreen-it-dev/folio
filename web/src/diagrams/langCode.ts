/**
 * Round 18 — maps Folio's UI language (i18next.language: 'uk' | 'en' | 'ru',
 * see shared/contracts.ts's UiLanguage) to the `langCode` prop Excalidraw
 * expects for its own interface (toolbar, menus, dialogs, tooltips).
 *
 * Excalidraw's bundled locales use BCP-47-ish codes that don't always match
 * Folio's two-letter ones — 'uk' -> 'uk-UA', 'ru' -> 'ru-RU' are real,
 * shipped locale files in this version of @excalidraw/excalidraw (see the
 * uk-UA-*.js and ru-RU-*.js chunks under this package's dist build,
 * alongside dev and prod locales directories); 'en' matches as-is (it's
 * Excalidraw's own defaultLang.code).
 */
export function mapToExcalidrawLangCode(i18nextLanguage: string | null | undefined): string {
  const base = (i18nextLanguage ?? '').slice(0, 2).toLowerCase();
  switch (base) {
    case 'uk':
      return 'uk-UA';
    case 'ru':
      return 'ru-RU';
    case 'en':
      return 'en';
    default:
      // i18next.language should always be one of uk/en/ru here (Folio's
      // central i18n constrains it via supportedLngs — see
      // web/src/i18n/index.ts), but fall back to Excalidraw's own default
      // rather than passing through something it won't recognize.
      return 'en';
  }
}
