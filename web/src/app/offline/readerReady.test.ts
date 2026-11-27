// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { maintainOfflineReader, offlineReaderReady } from './readerReady';
import * as store from './savedDocuments';

vi.mock('./savedDocuments', () => ({
  DEFAULT_SESSION_TTL_MS: 30 * 86_400_000,
  listOfflineDocuments: vi.fn(), pruneExpiredOfflineDocuments: vi.fn(async () => 0),
}));

function serviceWorker(existing?: { update: () => Promise<void>; unregister?: () => Promise<boolean> }) {
  const register = vi.fn(async () => ({ active: { scriptURL: location.origin + '/sw.js', state: 'activated' } }));
  const container = {
    register, getRegistration: vi.fn(async () => existing),
    getRegistrations: vi.fn(async () => existing ? [{ ...existing, active: { scriptURL: location.origin + '/sw.js' } }] : []),
  };
  Object.defineProperty(navigator, 'serviceWorker', { value: container, configurable: true });
  return container;
}

beforeEach(() => {
  vi.stubEnv('PROD', true);
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  vi.mocked(store.listOfflineDocuments).mockResolvedValue([]);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  document.head.innerHTML = '';
});

describe('maintainOfflineReader (runs on every app mount)', () => {
  it('does not register a worker for someone with no saved documents and no registration', async () => {
    const sw = serviceWorker();
    await maintainOfflineReader();
    expect(sw.register).not.toHaveBeenCalled();
  });

  it('only checks for a new worker version when one is already registered', async () => {
    const update = vi.fn(async () => {});
    const sw = serviceWorker({ update });
    await maintainOfflineReader();
    expect(update).toHaveBeenCalledOnce();
    expect(sw.register).not.toHaveBeenCalled();
  });

  it('registers again if copies exist on the device but the worker is gone', async () => {
    vi.mocked(store.listOfflineDocuments).mockResolvedValue([{ id: 'a', space: 's', title: 'A' }]);
    const sw = serviceWorker();
    await maintainOfflineReader();
    expect(sw.register).toHaveBeenCalledOnce();
  });

  it('unregisters an existing worker instead of updating it when the server has FOLIO_PWA=off', async () => {
    document.head.innerHTML = '<meta name="folio-pwa" content="off">';
    const unregister = vi.fn(async () => true);
    const update = vi.fn(async () => {});
    const sw = serviceWorker({ update, unregister });
    const deleteDatabase = vi.fn();
    vi.stubGlobal('indexedDB', { deleteDatabase });
    await maintainOfflineReader();
    expect(deleteDatabase).toHaveBeenCalledWith('folio-offline-reader');
    expect(unregister).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
    expect(sw.register).not.toHaveBeenCalled();
  });
});

describe('offlineReaderReady (called when saving)', () => {
  it('registers the worker', async () => {
    const sw = serviceWorker();
    await offlineReaderReady();
    expect(sw.register).toHaveBeenCalledWith(expect.any(URL), { scope: '/', updateViaCache: 'none' });
  });

  it('does nothing when the server has FOLIO_PWA=off', async () => {
    document.head.innerHTML = '<meta name="folio-pwa" content="off">';
    const sw = serviceWorker();
    expect(await offlineReaderReady()).toBe(false);
    expect(sw.register).not.toHaveBeenCalled();
  });
});
