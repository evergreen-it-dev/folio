import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { GitPullRequest } from 'lucide-react';
import { api } from '../api';
import { useSpaceRole } from '../auth/AuthProvider';
import { canEditContent } from '../auth/roles';
import { useProposals } from './useProposals';
import '../i18n/register';

/**
 * "On review (N)" in the sidebar's lower part: the list of agent proposals waiting for an
 * editor, with the counter. Shown to editors and admins, and only while it means something:
 * the space is in review mode, or something is still waiting from before it was switched back.
 */
export function ReviewQueueButton({ space, onNavigate }: { space: string; onNavigate?: () => void }) {
  const { t } = useTranslation('app');
  const role = useSpaceRole(space);
  const [params, setParams] = useSearchParams();
  const canReview = canEditContent(role);
  const { data: spacesData } = useQuery({ queryKey: ['spaces'], queryFn: api.listSpaces });
  const inReviewMode = spacesData?.spaces.find((s) => s.slug === space)?.agentWriteMode === 'review';
  const { data } = useProposals(space, canReview);
  const count = data?.pendingCount ?? 0;
  if (!canReview || (!inReviewMode && count === 0)) return null;
  return (
    <button
      type="button"
      onClick={() => {
        onNavigate?.();
        const next = new URLSearchParams(params);
        next.set('review', 'all');
        setParams(next);
      }}
      className="flex items-center gap-2 rounded-md py-2 pl-1 pr-2 text-left text-[13px] leading-5 text-neutral-800 hover:bg-neutral-200/60 md:py-[3px] dark:text-neutral-200 dark:hover:bg-white/[0.06]"
    >
      <GitPullRequest size={14} className="mx-1 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{t('review.sidebar')}</span>
      {count > 0 && (
        <span aria-label={t('review.sidebarCount', { count })} className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-600 px-1 text-[10px] font-medium leading-none text-white">
          {count}
        </span>
      )}
    </button>
  );
}
