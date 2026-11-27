/**
 * Switch for the installable app / offline reader (FOLIO_PWA, on by default).
 *
 * `FOLIO_PWA=off` is the rollback tool. Once a browser has registered /sw.js it keeps that worker
 * for good: an image that no longer has the file would answer /sw.js with the SPA's index.html, the
 * worker's update check would fail and the old worker would stay. With the switch off the server
 * answers /sw.js with a replacement worker that removes the offline reader's caches and database
 * and unregisters itself. Roll back in this order: set FOLIO_PWA=off, wait until browsers have
 * fetched it (a day at most), then deploy the older image.
 */
import type { FastifyInstance } from 'fastify';

export function pwaEnabled(): boolean {
  return !['off', '0', 'false'].includes((process.env.FOLIO_PWA ?? '').trim().toLowerCase());
}

// Keep the names in step with web/src/app/offline/savedDocuments.ts (DATABASE) and web/pwa/worker.js (cachePrefix).
// Deliberately NOT Clear-Site-Data: it would also wipe the queue of edits made offline.
export const PWA_KILL_WORKER = `// FOLIO_PWA=off: remove the offline reader and unregister this worker.
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name.startsWith('folio-offline-reader')).map((name) => caches.delete(name)));
    } catch (error) { /* nothing to delete */ }
    try {
      await new Promise((resolve) => {
        const request = indexedDB.deleteDatabase('folio-offline-reader');
        request.onsuccess = request.onerror = request.onblocked = () => resolve();
      });
    } catch (error) { /* no database */ }
    try { await self.clients.claim(); } catch (error) { /* ignore */ }
    await self.registration.unregister();
  })());
});
`;

/** Call before the static plugin so the route wins over the SPA's own /sw.js. */
export function registerPwaKillSwitch(app: FastifyInstance): void {
  if (pwaEnabled()) return;
  app.get('/sw.js', async (_request, reply) => reply
    .header('Cache-Control', 'no-cache')
    .type('application/javascript; charset=utf-8')
    .send(PWA_KILL_WORKER));
}
