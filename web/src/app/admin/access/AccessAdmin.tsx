import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Link2, Plus } from 'lucide-react';
import { api } from '../../api';
import { useAuth } from '../../auth/AuthProvider';
import { useDocumentTitle } from '../../hooks';
import { Tabs } from '../../ui/Tabs';
import { InviteDialog } from '../../invites/InviteDialog';
import { AddPersonDialog } from './AddPersonDialog';
import { PeopleTab } from './PeopleTab';
import { MatrixTab } from './MatrixTab';
import { SpacesTab } from './SpacesTab';
import '../../i18n/register';

type TabKey = 'people' | 'matrix' | 'spaces';
const TAB_KEYS: TabKey[] = ['people', 'matrix', 'spaces'];

/**
 * `/admin/access` (round 27, docs/spec-access.md §6) — instance-admin only.
 * Consolidates the old `/admin/users` + `/admin/spaces` pages into one
 * section with three tabs, per spec §6's "one section instead of the present
 * scattered /admin/users and /admin/spaces" — see this round's report for
 * why UsersAdmin/SpacesAdmin/CreateUserDialog were retired rather than kept
 * alongside this page. Client-guarded the same way those pages were (the
 * server independently enforces the same restriction on every endpoint this
 * page calls); the ?tab= search param keeps deep links (and the old routes'
 * redirect targets) working.
 */
export function AccessAdmin() {
  const { t } = useTranslation('app');
  const { user } = useAuth();
  useDocumentTitle(t('access.title'));

  if (!user.isAdmin) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('admin.noAccess')}</p>
        <Link to="/" className="text-sm text-blue-600 underline underline-offset-2 dark:text-blue-400">
          {t('admin.backHome')}
        </Link>
      </div>
    );
  }

  return <AccessAdminContent />;
}

function AccessAdminContent() {
  const { t } = useTranslation('app');
  const [searchParams, setSearchParams] = useSearchParams();
  const [adding, setAdding] = useState(false);
  const [inviting, setInviting] = useState(false);

  const rawTab = searchParams.get('tab');
  const tab: TabKey = TAB_KEYS.includes(rawTab as TabKey) ? (rawTab as TabKey) : 'people';

  function selectTab(key: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', key);
      return next;
    });
  }

  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ['access', 'matrix'], queryFn: api.getAccessMatrix });

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-white dark:bg-neutral-950">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-neutral-200 px-3 dark:border-neutral-800 md:gap-3 md:px-4">
        <Link
          to="/"
          aria-label={t('ui.back')}
          className="inline-flex shrink-0 items-center justify-center rounded-md p-1.5 text-neutral-500 hover:bg-neutral-100 max-md:min-h-10 max-md:min-w-10 dark:hover:bg-neutral-800"
        >
          <ArrowLeft size={17} />
        </Link>
        <h1 className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">{t('access.title')}</h1>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {/* Round 27: standalone invite management (view/revoke every invite,
              create a free-form multi-space one) — the entry point UsersAdmin.tsx
              used to own before this page consolidated it, see this round's report. */}
          <button
            type="button"
            onClick={() => setInviting(true)}
            aria-label={t('invites.createLink')}
            title={t('invites.createLink')}
            className="flex items-center gap-1.5 rounded-md border border-neutral-300 px-2 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100 max-md:min-h-10 max-md:min-w-10 max-md:justify-center dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800 md:px-3"
          >
            <Link2 size={14} className="shrink-0" /> <span className="hidden md:inline">{t('invites.createLink')}</span>
          </button>
          <button
            type="button"
            onClick={() => setAdding(true)}
            aria-label={t('access.addPerson.title')}
            title={t('access.addPerson.title')}
            className="flex items-center gap-1.5 rounded-md bg-neutral-900 px-2 py-1.5 text-sm text-white hover:bg-neutral-700 max-md:min-h-10 max-md:min-w-10 max-md:justify-center dark:bg-white dark:text-neutral-900 md:px-3"
          >
            <Plus size={14} className="shrink-0" /> <span className="hidden md:inline">{t('access.addPerson.title')}</span>
          </button>
        </div>
      </header>

      <main className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col overflow-hidden p-4 md:p-6">
        <Tabs
          className="mb-4 shrink-0"
          active={tab}
          onSelect={selectTab}
          items={[
            { key: 'people', label: t('access.tabs.people') },
            { key: 'matrix', label: t('access.tabs.matrix') },
            { key: 'spaces', label: t('access.tabs.spaces') },
          ]}
        />

        {isLoading && <p className="text-sm text-neutral-400">{t('ui.loading')}</p>}

        {isError && (
          <p className="text-sm text-red-600 dark:text-red-400">
            {t('access.loadFailed')}{' '}
            <button type="button" onClick={() => refetch()} className="underline underline-offset-2">
              {t('auth.retry')}
            </button>
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-hidden">
          {data && tab === 'people' && <PeopleTab matrix={data} />}
          {data && tab === 'matrix' && <MatrixTab matrix={data} />}
          {data && tab === 'spaces' && <SpacesTab matrix={data} />}
        </div>
      </main>

      {adding && <AddPersonDialog onClose={() => setAdding(false)} />}
      {inviting && <InviteDialog onClose={() => setInviting(false)} />}
    </div>
  );
}
