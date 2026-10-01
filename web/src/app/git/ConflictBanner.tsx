import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { api } from '../api';
import { useSpaceRole } from '../auth/AuthProvider';
import { canManageMembers } from '../auth/roles';
import { ResetToRemoteDialog } from './ResetToRemoteDialog';
import '../i18n/register';

export interface ConflictBannerProps {
  space: string;
}

/**
 * Persistent banner above the content area while the space's git status is
 * 'conflict'. Lists every conflicted file via SpaceGitInfo.conflicts (server/
 * gitSync.ts's getSpaceConflicts, populated from git.listConflictedFiles —
 * the WHOLE working tree, not just this space's own rootPath, so a conflict
 * in a file another space owns in a shared repo still shows up here as a
 * path-only entry) — a page title linking to the page when the path
 * resolves to one, the raw repo path otherwise. Space admins additionally
 * get "Take the version from Git" front and center here, the same action the
 * sidebar space menu always offers when a remote exists.
 */
export function ConflictBanner({ space }: ConflictBannerProps) {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const role = useSpaceRole(space);
  const [resetting, setResetting] = useState(false);
  const { data: spacesData } = useQuery({ queryKey: ['spaces'], queryFn: api.listSpaces });
  const git = spacesData?.spaces.find((s) => s.slug === space)?.git;

  if (git?.status !== 'conflict') return null;
  const conflicts = git.conflicts ?? [];

  return (
    <div className="flex flex-wrap items-start gap-2 border-b border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
      <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p>
          {t('git.conflictBanner.intro')}{' '}
          <code className="rounded bg-red-100 px-1 py-0.5 text-xs dark:bg-red-900">&lt;&lt;&lt;&lt;&lt;&lt;&lt;</code>{' '}
          {t('git.conflictBanner.outro')}
        </p>
        {conflicts.length > 0 && (
          <p className="mt-1">
            {t('git.conflictBanner.affectedPages')}{' '}
            {conflicts.map((c, i) => (
              <span key={c.path}>
                {i > 0 && ', '}
                {c.pageId ? (
                  <button
                    type="button"
                    onClick={() => navigate(`/s/${space}/p/${c.pageId}`)}
                    className="underline underline-offset-2 hover:opacity-80"
                  >
                    {c.title ?? c.path}
                  </button>
                ) : (
                  <code className="rounded bg-red-100 px-1 py-0.5 text-xs dark:bg-red-900">{c.path}</code>
                )}
              </span>
            ))}
          </p>
        )}
      </div>
      {canManageMembers(role) && (
        <button
          type="button"
          onClick={() => setResetting(true)}
          className="shrink-0 rounded-md border border-red-300 bg-white px-2.5 py-1 text-xs font-medium hover:bg-red-100 dark:border-red-800 dark:bg-red-950 dark:hover:bg-red-900"
        >
          {t('git.resetToRemote.menuLabel')}
        </button>
      )}
      {resetting && <ResetToRemoteDialog space={space} onClose={() => setResetting(false)} />}
    </div>
  );
}
