import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api';
import { useApiErrorText } from '../errorText';
import '../i18n/register';

/**
 * "Ask for access" on the 404/"maybe no rights" screen (routes/NotFound.tsx).
 *
 * After success the button is gone — a "request sent" line stays: the server
 * is idempotent anyway (a repeated press returns the same live request), but a
 * button that looks unchanged after a press provokes pressing again and
 * wondering whether it got through.
 *
 * A 409 here is not an error but a separate state: "you already have access".
 * As raw error text it would look like a failure, while the only meaningful
 * action is to reload the page (the rights could have appeared a minute ago,
 * and the tab does not know about it).
 */
export function RequestAccessButton({ space }: { space: string }) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const [error, setError] = useState<string | null>(null);
  const [alreadyHasAccess, setAlreadyHasAccess] = useState(false);

  const send = useMutation({
    mutationFn: () => api.createAccessRequest(space),
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

  if (alreadyHasAccess) {
    return <p className="max-w-sm text-sm text-neutral-500 dark:text-neutral-400">{t('notifications.requestAccess.already')}</p>;
  }

  if (send.isSuccess) {
    return <p className="max-w-sm text-sm text-neutral-500 dark:text-neutral-400">{t('notifications.requestAccess.sent')}</p>;
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        disabled={send.isPending}
        onClick={() => send.mutate()}
        className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {send.isPending ? t('notifications.requestAccess.sending') : t('notifications.requestAccess.action')}
      </button>
      {error && <p className="max-w-sm text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
