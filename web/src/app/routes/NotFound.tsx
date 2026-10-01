import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useDocumentTitle } from '../hooks';
import { RequestAccessButton } from '../notifications/RequestAccessButton';
import '../i18n/register';

export interface NotFoundProps {
  message?: string;
  /** Second line, e.g. "maybe you have no rights — ask for access". */
  hint?: string;
  /**
   * The space that access can be asked for (round 31). Optional on purpose:
   * the same screen is shown where there is no space at all (a garbage URL,
   * the catch-all in App.tsx) — there is nothing to ask access to then, and
   * there must be no button.
   */
  space?: string;
}

/** Generic 404 view: bad page id, unresolved space, or a garbage URL. */
export function NotFound({ message, hint, space }: NotFoundProps) {
  const { t } = useTranslation('app');
  useDocumentTitle(t('routes.notFound.title'));
  return (
    <div className="flex h-full min-h-[60vh] flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="text-5xl font-bold text-neutral-300 dark:text-neutral-700">404</div>
      <p className="max-w-sm text-sm text-neutral-500 dark:text-neutral-400">{message ?? t('routes.notFound.pageNotFound')}</p>
      {hint && <p className="max-w-sm text-sm text-neutral-500 dark:text-neutral-400">{hint}</p>}
      {space && <RequestAccessButton space={space} />}
      <Link
        to="/"
        className="text-sm text-blue-600 underline underline-offset-2 dark:text-blue-400"
      >
        {t('admin.backHome')}
      </Link>
    </div>
  );
}
