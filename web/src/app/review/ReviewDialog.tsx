import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { PageProposalSummary } from '@shared/proposals';
import { PROPOSAL_STALE_CODE } from '@shared/proposals';
import { api, ApiError } from '../api';
import { useApiErrorText } from '../errorText';
import { formatDateTime } from '../formatDate';
import { Modal } from '../ui/Modal';
import { ProposalDiff } from './ProposalDiff';
import { useProposals } from './useProposals';
import '../i18n/register';

export interface ReviewDialogProps {
  space: string;
  /** Proposal to open first; when absent (or gone) the first of the list. */
  proposalId?: string;
  onClose: () => void;
}

function sourceLabel(t: (key: string) => string, p: PageProposalSummary): string {
  return t(`review.source.${p.source}`);
}

/**
 * "On review": the open proposals of a space on the left, the selected one on the right as a
 * line diff against the text the page has RIGHT NOW. Accept / Reject are for editors and admins
 * (the list itself is empty for anyone else). A stale proposal says so; accepting it sends the hash
 * of the text this diff was drawn against — the server refuses a stale accept without it, so the
 * button cannot be pressed "blind" even from a script.
 */
export function ReviewDialog({ space, proposalId, onClose }: ReviewDialogProps) {
  const { t, i18n } = useTranslation('app');
  const errorText = useApiErrorText();
  const queryClient = useQueryClient();
  const list = useProposals(space, true);
  const items = list.data?.items ?? [];
  const [selected, setSelected] = useState<string | undefined>(proposalId);
  const [comment, setComment] = useState('');

  const activeId = items.find((p) => p.id === selected)?.id ?? items[0]?.id;
  useEffect(() => setComment(''), [activeId]);

  const detail = useQuery({
    queryKey: ['proposal', activeId],
    queryFn: () => api.getProposal(activeId!),
    enabled: activeId !== undefined,
    retry: false,
  });
  const proposal = detail.data;
  const stale = proposal?.status === 'stale';

  const decide = useMutation({
    mutationFn: (decision: 'accept' | 'reject') =>
      api.decideProposal(activeId!, {
        decision,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
        // What the diff on screen was drawn against; the server demands it for a stale proposal.
        ...(decision === 'accept' && proposal?.currentHash ? { currentHash: proposal.currentHash } : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['proposals'] });
      void queryClient.invalidateQueries({ queryKey: ['proposal'] });
      void queryClient.invalidateQueries({ queryKey: ['page'] });
      void queryClient.invalidateQueries({ queryKey: ['tree', space] });
      void queryClient.invalidateQueries({ queryKey: ['resolve'] });
    },
    onError: (err) => {
      // The page moved again while the diff was open: reload the detail so the NEW differences are what the reviewer sees.
      if (err instanceof ApiError && (err.body as { code?: string } | undefined)?.code === PROPOSAL_STALE_CODE) {
        void queryClient.invalidateQueries({ queryKey: ['proposal'] });
        void queryClient.invalidateQueries({ queryKey: ['proposals'] });
      }
    },
  });

  return (
    <Modal title={t('review.title')} size="xl" onClose={decide.isPending ? () => {} : onClose}>
      <div className="flex min-h-[18rem] flex-col gap-4 md:flex-row">
        <ul className="flex max-h-48 shrink-0 flex-col gap-1 overflow-y-auto md:max-h-[60vh] md:w-64" aria-label={t('review.listLabel')}>
          {list.isLoading && <li className="text-sm text-neutral-400">{t('review.loading')}</li>}
          {!list.isLoading && items.length === 0 && <li className="text-sm text-neutral-500">{t('review.empty')}</li>}
          {items.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => setSelected(p.id)}
                aria-current={p.id === activeId}
                className={`flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800 ${
                  p.id === activeId ? 'bg-neutral-100 dark:bg-neutral-800' : ''
                }`}
              >
                <span className="truncate font-medium">{p.title || t('notifications.untitledPage')}</span>
                <span className="truncate text-xs text-neutral-500 dark:text-neutral-400">
                  {p.kind === 'create' ? t('review.kind.create') : t('review.kind.update')} · {p.authorName ?? t('notifications.someone')} · {sourceLabel(t, p)}
                </span>
                {p.status === 'stale' && <span className="text-xs text-amber-700 dark:text-amber-400">{t('review.status.stale')}</span>}
              </button>
            </li>
          ))}
        </ul>

        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {detail.isLoading && activeId && <p className="text-sm text-neutral-400">{t('review.loading')}</p>}
          {detail.isError && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {errorText(detail.error, 'review.loadFailed')}
            </p>
          )}
          {proposal && (
            <>
              <div className="flex flex-col gap-0.5">
                <h3 className="text-sm font-semibold">{proposal.title || t('notifications.untitledPage')}</h3>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  {t('review.meta', { name: proposal.authorName ?? t('notifications.someone'), source: sourceLabel(t, proposal), date: formatDateTime(proposal.updatedAt, i18n.language) })}
                </p>
              </div>
              {stale && (
                <p role="status" className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                  {t('review.staleNotice')}
                </p>
              )}
              {proposal.kind === 'create' && <p className="text-xs text-neutral-500">{t('review.createNotice', { path: proposal.parentPath || '/' })}</p>}
              <ProposalDiff current={proposal.currentMarkdown} proposed={proposal.markdown} />
              <label className="flex flex-col gap-1">
                <span className="text-xs text-neutral-500 dark:text-neutral-400">{t('review.commentLabel')}</span>
                <textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  rows={2}
                  maxLength={2000}
                  className="rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 text-sm dark:border-neutral-700"
                />
              </label>
              {decide.isError && (
                <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                  {decide.error instanceof ApiError && (decide.error.body as { code?: string } | undefined)?.code === PROPOSAL_STALE_CODE
                    ? t('review.staleAgain')
                    : errorText(decide.error, 'review.decideFailed')}
                </p>
              )}
              {decide.isSuccess && <p role="status" className="text-xs text-green-700 dark:text-green-400">{t('review.decided')}</p>}
              <div className="flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate('reject')}
                  className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
                >
                  {t('review.reject')}
                </button>
                <button
                  type="button"
                  disabled={decide.isPending || detail.isFetching}
                  onClick={() => decide.mutate('accept')}
                  className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
                >
                  {stale ? t('review.acceptStale') : t('review.accept')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
