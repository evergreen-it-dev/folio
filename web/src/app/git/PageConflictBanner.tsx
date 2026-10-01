import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { api } from '../api';
import { useSpaceRole } from '../auth/AuthProvider';
import { canManageMembers } from '../auth/roles';
import { ResetToRemoteDialog } from './ResetToRemoteDialog';
import '../i18n/register';

export interface PageConflictBannerProps {
  space: string;
  pageId: string;
}

/**
 * Thin banner at the top of a page whose own underlying file currently has
 * unresolved git conflict markers — driven by SpaceGitInfo.conflicts (server/
 * gitSync.ts's getSpaceConflicts), the same list the space-level
 * ConflictBanner shows. Renders nothing for any other page, including on a
 * space that's merely `status: 'conflict'` elsewhere. Space admins get the
 * same "Take the version from Git" action offered everywhere else this round.
 */
export function PageConflictBanner({ space, pageId }: PageConflictBannerProps) {
  const { t } = useTranslation('app');
  const role = useSpaceRole(space);
  const [resetting, setResetting] = useState(false);
  const { data: spacesData } = useQuery({ queryKey: ['spaces'], queryFn: api.listSpaces });
  const conflicts = spacesData?.spaces.find((s) => s.slug === space)?.git?.conflicts ?? [];
  const conflicted = conflicts.some((c) => c.pageId === pageId);

  if (!conflicted) return null;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
      <AlertTriangle size={14} className="shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">{t('git.pageConflictBanner.text')}</span>
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
