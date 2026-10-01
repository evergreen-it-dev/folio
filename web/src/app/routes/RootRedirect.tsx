import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Navigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { CreateSpaceDialog } from '../sidebar/CreateSpaceDialog';
import { readLastSpace } from '../lastSpace';
import '../i18n/register';

/** `/` — redirects to the first space, or offers to create one if there are none yet. */
export function RootRedirect() {
  const { t } = useTranslation('app');
  const { data, isLoading, isError } = useQuery({ queryKey: ['spaces'], queryFn: api.listSpaces });
  const [creating, setCreating] = useState(false);

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

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">{t('routes.root.welcome')}</h1>
      <p className="max-w-sm text-center text-sm text-neutral-500 dark:text-neutral-400">{t('routes.root.noSpacesYet')}</p>
      <button
        type="button"
        onClick={() => setCreating(true)}
        className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900"
      >
        {t('routes.root.createSpace')}
      </button>
      {creating && <CreateSpaceDialog onClose={() => setCreating(false)} />}
    </div>
  );
}
