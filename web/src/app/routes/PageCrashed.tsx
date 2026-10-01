import { useTranslation } from 'react-i18next';
import '../i18n/register';

/** What the main area shows when the routed page threw while rendering — the sidebar and the header stay usable around it. */
export function PageCrashed({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation('app');
  return (
    <div className="flex flex-col items-start gap-3 p-8 text-sm text-neutral-600 dark:text-neutral-300">
      <p>{t('routes.page.crashed')}</p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-800"
      >
        {t('auth.retry')}
      </button>
    </div>
  );
}
