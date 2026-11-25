import { useEffect } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import type { AuthState } from '@shared/contracts';
import { UNAUTHORIZED_EVENT } from '../api';
import { clearOfflineReaderAccount, setOfflineReaderAccount } from './savedDocuments';
import { verifyOfflineDocuments } from './readerAccess';

/** Follow server-confirmed account changes on the gated app and on the independent invite/sign-out surface. */
export function useOfflineReaderSession(auth: UseQueryResult<AuthState>) {
  const { data, isFetchedAfterMount, isSuccess, dataUpdatedAt, refetch } = auth;
  const account = data?.user?.id;
  // A connection failure or a cached result initially supplied by another route cannot select a device account.
  const confirmed = isFetchedAfterMount && isSuccess && data ? (data.user === null ? null : account) : undefined;
  useEffect(() => {
    if (confirmed === undefined) return;
    const controller = new AbortController();
    void setOfflineReaderAccount(confirmed).then(() => {
      if (confirmed && !controller.signal.aborted) return verifyOfflineDocuments(confirmed, controller.signal);
    }).catch(() => { /* The online wiki also runs in browsers with local storage disabled. */ });
    return () => controller.abort();
  }, [confirmed, dataUpdatedAt]);

  useEffect(() => {
    function unauthorized() {
      if (account) void clearOfflineReaderAccount(account).catch(() => {});
      void refetch();
    }
    const online = () => { void refetch(); };
    window.addEventListener(UNAUTHORIZED_EVENT, unauthorized);
    window.addEventListener('online', online);
    return () => {
      window.removeEventListener(UNAUTHORIZED_EVENT, unauthorized);
      window.removeEventListener('online', online);
    };
  }, [account, refetch]);
}
