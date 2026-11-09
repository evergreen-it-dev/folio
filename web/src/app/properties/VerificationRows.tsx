import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { formatVerificationDay } from '../page-meta/VerificationBadge';
import '../i18n/register';

const FIELD =
  'h-7 w-full min-w-0 rounded border border-transparent bg-transparent px-1.5 text-sm text-neutral-900 outline-none hover:border-neutral-300 focus:border-neutral-400 disabled:opacity-60 dark:text-neutral-100 dark:hover:border-neutral-700 dark:focus:border-neutral-500';
const ROW = 'grid grid-cols-[minmax(5rem,9rem)_minmax(0,1fr)_1.5rem] items-start gap-x-3 py-0.5 text-sm';
const LABEL = 'min-w-0 truncate px-1.5 py-1 text-neutral-500 dark:text-neutral-400';

/**
 * Owner and review of a page, drawn as three rows of the properties section (owner, last verified, next review) -
 * `owner`, `verified` and `review_by` are the front matter keys behind them, so the ordinary rows leave those keys out.
 * Reading mode (`editable` false) only shows the values that exist; Live and Source get the owner picker (people of
 * the space with a username, the list the @ picker offers), the date field and "Mark as verified". Writes go through
 * PUT /api/pages/:id/verification.
 */
export function VerificationRows({ space, pageId, editable, forceShow }: { space: string; pageId: string; editable: boolean; forceShow: boolean }) {
  const { t, i18n } = useTranslation('app');
  const queryClient = useQueryClient();
  const errorText = useApiErrorText();
  const [error, setError] = useState<string | null>(null);

  const { data: page } = useQuery({ queryKey: ['page', pageId], queryFn: () => api.getPage(pageId) });
  const { data: people } = useQuery({
    queryKey: ['mentionable', space],
    queryFn: () => api.listMentionable(space),
    enabled: editable,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const save = useMutation({
    mutationFn: (body: Parameters<typeof api.updateVerification>[1]) => api.updateVerification(pageId, body),
    onMutate: () => setError(null),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['page', pageId] });
      void queryClient.invalidateQueries({ queryKey: ['tree', space] });
      void queryClient.invalidateQueries({ queryKey: ['page-properties', pageId] });
    },
    onError: (err) => setError(errorText(err, 'verification.saveFailed')),
  });

  const verification = page?.verification;
  const owner = verification?.owner ?? '';
  const verified = verification?.verified;
  const reviewBy = verification?.reviewBy ?? '';
  const choices = people?.users ?? [];
  const ownerKnown = owner === '' || choices.some((u) => u.username === owner);
  const day = (value: string) => formatVerificationDay(value, i18n.language);

  const showOwner = editable || owner !== '';
  const showVerified = verified !== undefined || editable;
  const showReview = editable || reviewBy !== '';
  if (!editable && !verification) return null;
  if (editable && !verification && !forceShow) return null;
  if (!showOwner && !showVerified && !showReview) return null;

  return (
    <div data-testid="verification-rows">
      {showOwner && (
        <div role="group" aria-label={t('verification.owner')} data-property="owner" className={ROW}>
          <div className={LABEL}>{t('verification.owner')}</div>
          <div className="min-w-0">
            {editable ? (
              <select
                aria-label={t('verification.owner')}
                value={owner}
                disabled={save.isPending}
                onChange={(event) => save.mutate({ owner: event.target.value === '' ? null : event.target.value })}
                className={FIELD}
              >
                <option value="">{t('verification.noOwner')}</option>
                {!ownerKnown && <option value={owner}>{t('verification.unknownOwner', { name: owner })}</option>}
                {choices.map((user) => (
                  <option key={user.username} value={user.username}>
                    {user.name} (@{user.username})
                  </option>
                ))}
              </select>
            ) : (
              <span className="break-words px-1.5 py-0.5 text-neutral-700 dark:text-neutral-300">@{owner}</span>
            )}
          </div>
          <div />
        </div>
      )}

      {showVerified && (
        <div role="group" aria-label={t('verification.verifiedOn')} data-property="verified" className={ROW}>
          <div className={LABEL}>{t('verification.verifiedOn')}</div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="px-1.5 py-0.5 text-neutral-700 dark:text-neutral-300">{verified ? day(verified) : '—'}</span>
            {editable && (
              <button
                type="button"
                disabled={save.isPending}
                onClick={() => save.mutate({ markVerified: true })}
                className="h-6 rounded-md bg-neutral-900 px-2 text-[12px] font-medium text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
              >
                {t('verification.mark')}
              </button>
            )}
          </div>
          <div />
        </div>
      )}

      {showReview && (
        <div role="group" aria-label={t('verification.reviewBy')} data-property="review_by" className={ROW}>
          <div className={LABEL}>{t('verification.reviewBy')}</div>
          <div className="min-w-0">
            {editable ? (
              <input
                type="date"
                aria-label={t('verification.reviewBy')}
                value={reviewBy}
                disabled={save.isPending}
                onChange={(event) => save.mutate({ reviewBy: event.target.value === '' ? null : event.target.value })}
                className={FIELD}
              />
            ) : (
              <span className="px-1.5 py-0.5 text-neutral-700 dark:text-neutral-300">{day(reviewBy)}</span>
            )}
          </div>
          <div />
        </div>
      )}

      {verification?.invalid && verification.invalid.length > 0 && (
        <p className="px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-300">{t('verification.invalid', { keys: verification.invalid.join(', ') })}</p>
      )}
      {error && (
        <p role="alert" className="px-1.5 py-0.5 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
