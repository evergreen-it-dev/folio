import { useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { GitPullRequest } from 'lucide-react';
import { useSpaceRole } from '../auth/AuthProvider';
import { canEditContent } from '../auth/roles';
import { usePageProposals } from './useProposals';
import '../i18n/register';

/** Thin banner on a page that has open agent proposals waiting for an editor (nothing for anyone else). */
export function ProposalBanner({ space, pageId }: { space: string; pageId: string }) {
  const { t } = useTranslation('app');
  const role = useSpaceRole(space);
  const [params, setParams] = useSearchParams();
  const { data } = usePageProposals(pageId, canEditContent(role));
  const items = data?.items ?? [];
  if (items.length === 0) return null;
  const open = () => {
    const next = new URLSearchParams(params);
    next.set('review', items[0].id);
    setParams(next);
  };
  return (
    <div role="status" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200">
      <GitPullRequest size={14} className="shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">{t('review.banner', { count: items.length })}</span>
      <button
        type="button"
        onClick={open}
        className="shrink-0 rounded-md border border-blue-300 bg-white px-2.5 py-1 text-xs font-medium hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-950 dark:hover:bg-blue-900"
      >
        {t('review.open')}
      </button>
    </div>
  );
}
