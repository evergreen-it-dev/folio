import { useTranslation } from 'react-i18next';
import type { UiLanguage } from '@shared/contracts';
import { setUiLanguage } from '../../i18n';
import { UI_LANGUAGES, languageName } from '../../i18n/languages';
import '../i18n/register';

/**
 * Small language picker pinned to the top-right corner of the signed-out screens (login, first-run setup), so a
 * visitor whose browser language is not the one they want can switch before signing in. Same look as the
 * segmented control in Settings. There is no profile yet, so the choice is only kept in localStorage.
 */
export function LoginLanguageSwitcher() {
  const { t, i18n } = useTranslation('app');
  if (UI_LANGUAGES.length < 2) return null;
  const current = i18n.language?.slice(0, 2);
  return (
    <div
      role="group"
      aria-label={t('settings.language.label')}
      className="absolute right-3 top-3 flex gap-0.5 rounded-md bg-neutral-100 p-0.5 dark:bg-neutral-800"
    >
      {UI_LANGUAGES.map((lang: UiLanguage) => (
        <button
          key={lang}
          type="button"
          lang={lang}
          aria-pressed={current === lang}
          onClick={() => void setUiLanguage(lang, { persist: false })}
          className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
            current === lang
              ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-600 dark:text-neutral-50'
              : 'text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200'
          }`}
        >
          {languageName(lang)}
        </button>
      ))}
    </div>
  );
}
