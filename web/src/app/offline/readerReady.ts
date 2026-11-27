import { listOfflineDocuments, pruneExpiredOfflineDocuments } from './savedDocuments';
import { pwaSwitchedOff } from './sessionLifetime';

export function canRegisterOfflineReader(): boolean {
  return import.meta.env.PROD && window.isSecureContext && 'serviceWorker' in navigator && !pwaSwitchedOff();
}

/**
 * Keeps the worker current without installing one for people who never asked for it: the first
 * registration happens when a document is saved for offline reading (readerAccess.ts). With the
 * server switch off (FOLIO_PWA=off) any registration is removed instead; the replacement worker
 * the server then serves at /sw.js does the same for browsers that never open the app again.
 */
export async function maintainOfflineReader(): Promise<void> {
  try {
    if (!import.meta.env.PROD || !window.isSecureContext || !('serviceWorker' in navigator)) return;
    if (pwaSwitchedOff()) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.filter((r) => new URL((r.active ?? r.waiting ?? r.installing)?.scriptURL ?? 'about:blank').pathname === '/sw.js')
        .map((r) => r.unregister()));
      if (typeof caches !== 'undefined') {
        await Promise.all((await caches.keys()).filter((name) => name.startsWith('folio-offline-reader')).map((name) => caches.delete(name)));
      }
      // The app unregisters before the replacement worker ever runs, so the saved copies go here too.
      if (typeof indexedDB !== 'undefined') indexedDB.deleteDatabase('folio-offline-reader');
      return;
    }
    await pruneExpiredOfflineDocuments();
    const registration = await navigator.serviceWorker.getRegistration('/');
    if (registration) await registration.update();
    else if ((await listOfflineDocuments()).length) await offlineReaderReady();
  } catch {
    // Storage or the network may be unavailable; the online wiki does not depend on this.
  }
}

/** The worker only activates after an atomic install of the offline reader. */
export async function offlineReaderReady(): Promise<boolean> {
  if (!canRegisterOfflineReader()) return false;
  try {
    const url = new URL('/sw.js', window.location.origin);
    const registration = await navigator.serviceWorker.register(url, { scope: '/', updateViaCache: 'none' });
    const worker = [registration.active, registration.installing, registration.waiting].find((w) => w?.scriptURL === url.href);
    if (!worker) return false;
    if (worker.state === 'activated') return true;
    if (worker.state === 'redundant') return false;
    return await new Promise<boolean>((resolve) => {
      const onStateChange = () => {
        if (worker.state === 'activated' || worker.state === 'redundant') {
          worker.removeEventListener('statechange', onStateChange);
          resolve(worker.state === 'activated');
        }
      };
      worker.addEventListener('statechange', onStateChange);
    });
  } catch {
    // Insecure origins and browsers which disallow storage still run the online wiki.
    return false;
  }
}
