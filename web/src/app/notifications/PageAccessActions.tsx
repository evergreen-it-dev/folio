import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api';
import { useApiErrorText } from '../errorText';
import '../i18n/register';

const BUTTON = 'rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50';
const NOTE = 'max-w-sm text-sm text-neutral-500 dark:text-neutral-400';

/**
 * "Request access" for ONE restricted page, on the "no access" screen (routes/NoAccess.tsx) — for a person who has
 * a role in the space but is shut out by the page's restriction. The request goes to the owner of the restriction.
 * Shows "request sent" when a live request already exists (GET /api/pages/:id/access-request), so a reload does not
 * turn the button back on.
 */
export function RequestPageAccessButton({ space, pageId }: { space: string; pageId: string }) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const [error, setError] = useState<string | null>(null);
  const [alreadyHasAccess, setAlreadyHasAccess] = useState(false);
  const state = useQuery({ queryKey: ['page-access-request', pageId], queryFn: () => api.getPageAccessRequestState(pageId), retry: false });

  const send = useMutation({
    mutationFn: () => api.createAccessRequest(space, pageId),
    onMutate: () => {
      setError(null);
      setAlreadyHasAccess(false);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        setAlreadyHasAccess(true);
        return;
      }
      setError(errorText(err, 'notifications.requestAccess.failed'));
    },
  });

  if (alreadyHasAccess) return <p className={NOTE}>{t('notifications.requestAccess.pageAlready')}</p>;
  if (send.isSuccess || state.data?.pending) return <p className={NOTE}>{t('notifications.requestAccess.pageSent')}</p>;
  return (
    <div className="flex flex-col items-center gap-2">
      <button type="button" disabled={send.isPending || state.isLoading} onClick={() => send.mutate()} className={BUTTON}>
        {send.isPending ? t('notifications.requestAccess.sending') : t('notifications.requestAccess.action')}
      </button>
      {error && <p className="max-w-sm text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

/**
 * "Give myself access" for an instance admin on a restricted page: a recorded grant (space access log), then the
 * page is opened again. There is no admin bypass, so this is the only way in besides being added by the owner.
 */
export function GiveMyselfAccessButton({ pageId, onDone }: { pageId: string; onDone?: () => void }) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const [error, setError] = useState<string | null>(null);
  const grant = useMutation({
    mutationFn: () => api.selfGrantPageAccess(pageId),
    onMutate: () => setError(null),
    onSuccess: () => (onDone ?? (() => window.location.reload()))(),
    onError: (err) => setError(errorText(err, 'notifications.requestAccess.selfGrantFailed')),
  });
  return (
    <div className="flex flex-col items-center gap-2">
      <button type="button" disabled={grant.isPending} onClick={() => grant.mutate()} className={BUTTON}>
        {grant.isPending ? t('notifications.requestAccess.selfGranting') : t('notifications.requestAccess.selfGrant')}
      </button>
      {error && <p className="max-w-sm text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
