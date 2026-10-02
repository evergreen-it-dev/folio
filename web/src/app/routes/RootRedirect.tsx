import { useQuery } from '@tanstack/react-query';
import { Navigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { Onboarding } from '../onboarding/Onboarding';
import { readLastSpace } from '../lastSpace';
import '../i18n/register';

/** `/` — redirects to the first space, or starts the welcome wizard if there are none yet. */
export function RootRedirect() {
  const { t } = useTranslation('app');
  const { data, isLoading, isError } = useQuery({ queryKey: ['spaces'], queryFn: api.listSpaces });

  if (isLoading) {
    return <div className="flex h-full items-center justify-center text-sm text-neutral-400">{t('ui.loading')}</div>;
  }

  if (isError) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-red-600 dark:text-red-400">
        {t('routes.root.connectionError')}
      </div>
    );
  }

  const spaces = data?.spaces ?? [];
  if (spaces.length > 0) {
    // Back to where the user actually was, not to whatever sorts first —
    // /admin/access and /trash both link "back" to `/` (see lastSpace.ts).
    // Checked against the list the SERVER just returned, so a remembered
    // space the user has lost access to (or that no longer exists) falls
    // through to the old first-space behaviour rather than 404ing them.
    const remembered = readLastSpace();
    const target = remembered && spaces.some((space) => space.slug === remembered) ? remembered : spaces[0].slug;
    return <Navigate to={`/s/${target}`} replace />;
  }

  // No space at all: someone who has just installed Folio (or has just been
  // let in and shares nothing yet). The welcome wizard takes it from here.
  return <Onboarding />;
}
