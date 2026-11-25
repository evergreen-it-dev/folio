import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../api';
import { forgetDeniedDocument, saveDocumentForOfflineReading, verifyOfflineDocuments } from './readerAccess';
import * as store from './savedDocuments';
import { offlineReaderReady } from './readerReady';

vi.mock('./readerReady', () => ({ offlineReaderReady: vi.fn() }));
vi.mock('./savedDocuments', () => ({
  listOfflineDocumentIds: vi.fn(), saveOfflineDocument: vi.fn(), removeOfflineDocument: vi.fn(), clearOfflineReaderAccount: vi.fn(),
}));

afterEach(() => vi.unstubAllGlobals());

const account = 'alice';
const page = { id: 'one', space: 'team', title: 'Notes', kind: 'doc', markdown: '# Saved on the server' } as const;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe('offline reading access', () => {
  it('saves only the current server Markdown after confirming the account and installed reader', async () => {
    vi.mocked(offlineReaderReady).mockResolvedValue(true);
    const getPage = vi.spyOn(api, 'getPage').mockResolvedValue(page as Awaited<ReturnType<typeof api.getPage>>);
    await saveDocumentForOfflineReading(account, page.id, page.space);
    expect(getPage).toHaveBeenCalledWith(page.id, account);
    expect(store.saveOfflineDocument).toHaveBeenCalledWith(account, { id: 'one', space: 'team', title: 'Notes', markdown: page.markdown, savedAt: expect.any(Number) });
  });

  it('requires an account acknowledgement on the response that supplied the Markdown', async () => {
    vi.mocked(offlineReaderReady).mockResolvedValue(true);
    const fetch = vi.fn(async () => Response.json(page));
    vi.stubGlobal('fetch', fetch);
    await expect(saveDocumentForOfflineReading(account, page.id, page.space)).rejects.toThrow('could not confirm');
    expect(fetch).toHaveBeenCalledWith('/api/pages/one', expect.objectContaining({
      cache: 'no-store', redirect: 'error', headers: { 'x-folio-offline-account': account },
    }));
    expect(store.saveOfflineDocument).not.toHaveBeenCalled();
  });

  it('declines a save when the active browser account changed', async () => {
    vi.mocked(offlineReaderReady).mockResolvedValue(true);
    vi.spyOn(api, 'getPage').mockRejectedValue(new ApiError(409, 'The account has changed.'));
    await expect(saveDocumentForOfflineReading(account, page.id, page.space)).rejects.toThrow();
    expect(store.saveOfflineDocument).not.toHaveBeenCalled();
    expect(store.clearOfflineReaderAccount).toHaveBeenCalledWith(account);
  });

  it('removes denied and missing documents while preserving copies during temporary failures', async () => {
    vi.mocked(store.listOfflineDocumentIds).mockResolvedValue(['can-read', 'role-revoked', 'forbidden', 'missing', 'outage']);
    vi.spyOn(api, 'getMyPageRole')
      .mockResolvedValueOnce({ role: 'viewer' }).mockResolvedValueOnce({ role: null })
      .mockRejectedValueOnce(new ApiError(403, 'forbidden')).mockRejectedValueOnce(new ApiError(404, 'gone'))
      .mockRejectedValueOnce(new TypeError('network error'));
    await verifyOfflineDocuments(account, new AbortController().signal);
    expect(vi.mocked(store.removeOfflineDocument).mock.calls).toEqual([[account, 'role-revoked'], [account, 'forbidden'], [account, 'missing']]);
    expect(store.clearOfflineReaderAccount).not.toHaveBeenCalled();
  });

  it('ends verification at a confirmed loss of session', async () => {
    vi.mocked(store.listOfflineDocumentIds).mockResolvedValue(['one', 'two']);
    const roles = vi.spyOn(api, 'getMyPageRole').mockRejectedValue(new ApiError(401, 'signed out'));
    await verifyOfflineDocuments(account, new AbortController().signal);
    expect(roles).toHaveBeenCalledTimes(1);
    expect(store.clearOfflineReaderAccount).toHaveBeenCalledWith(account);
  });

  it('does not discard a copy on a transient page fetch error', async () => {
    await forgetDeniedDocument(account, 'one', new ApiError(502, 'temporary'));
    expect(store.removeOfflineDocument).not.toHaveBeenCalled();
  });
});
