// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import type { UseQueryResult } from '@tanstack/react-query';
import type { AuthState } from '@shared/contracts';
import { api, UNAUTHORIZED_EVENT } from '../api';
import { reportRequest, resetConnectivityForTests } from './connectivity';
import { clearOfflineReaderAccount, setOfflineReaderAccount } from './savedDocuments';
import { verifyOfflineDocuments } from './readerAccess';
import { useOfflineReaderSession } from './useOfflineReaderSession';

vi.mock('./savedDocuments', () => ({
  setOfflineReaderAccount: vi.fn(async () => {}), clearOfflineReaderAccount: vi.fn(async () => {}),
}));
vi.mock('./readerAccess', () => ({ verifyOfflineDocuments: vi.fn(async () => {}) }));

const refetch = vi.fn();

function auth(user: string | null, confirmed: boolean, success = true) {
  return {
    data: { user: user && { id: user } }, dataUpdatedAt: 1, isFetchedAfterMount: confirmed, isSuccess: success, refetch,
  } as unknown as UseQueryResult<AuthState>;
}

beforeEach(() => { vi.clearAllMocks(); resetConnectivityForTests(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('changes the device account only after a confirmed auth read and revalidates its saved pages', async () => {
  const { rerender } = renderHook(({ state }) => useOfflineReaderSession(state), { initialProps: { state: auth('alice', false) } });
  expect(setOfflineReaderAccount).not.toHaveBeenCalled();
  rerender({ state: auth('alice', true) });
  await waitFor(() => expect(verifyOfflineDocuments).toHaveBeenCalledWith('alice', expect.any(AbortSignal)));
  rerender({ state: auth(null, true, false) });
  expect(setOfflineReaderAccount).not.toHaveBeenCalledWith(null);
  rerender({ state: auth('bob', true) });
  await waitFor(() => expect(verifyOfflineDocuments).toHaveBeenCalledWith('bob', expect.any(AbortSignal)));
  window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  expect(clearOfflineReaderAccount).toHaveBeenCalledWith('bob');
  rerender({ state: auth(null, true) });
  await waitFor(() => expect(setOfflineReaderAccount).toHaveBeenCalledWith(null));
});

it('rechecks the session once when the server returns with the network interface still online', async () => {
  renderHook(() => useOfflineReaderSession(auth('alice', true)));
  await waitFor(() => expect(verifyOfflineDocuments).toHaveBeenCalledTimes(1));
  reportRequest(false); // degraded
  reportRequest(false); // offline
  expect(refetch).not.toHaveBeenCalled();
  reportRequest(true);  // server reachable again
  reportRequest(true);
  window.dispatchEvent(new Event('online')); // React Query handles ordinary system reconnects itself.
  expect(refetch.mock.calls).toEqual([[{ cancelRefetch: false }]]);
});

it('discards offline copies on explicit sign-out even when the server is unreachable', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network unavailable')));
  await expect(api.logout()).rejects.toThrow('network unavailable');
  expect(setOfflineReaderAccount).toHaveBeenCalledWith(null);
});
