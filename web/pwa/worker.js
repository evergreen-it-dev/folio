// READER is generated alongside this script from the built offline entry.
const cachePrefix = 'folio-offline-reader-';
const cacheName = cachePrefix + READER.version;

self.addEventListener('install', (event) => {
  // A new version takes over without waiting for every window to close. The reader's assets of the
  // previous version may disappear under an open reader page; that page only reloads to the live app.
  self.skipWaiting();
  // addAll is atomic. Integrity also catches gateways returning a successful login page.
  const requests = Object.entries(READER.assets).map(([path, integrity]) =>
    new Request(new URL(path, self.location.origin), { integrity, redirect: 'error', credentials: 'same-origin', cache: 'reload' }),
  );
  event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll(requests)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((names) =>
    Promise.all(names.filter((name) => name.startsWith(cachePrefix) && name !== cacheName).map((name) => caches.delete(name))),
  ).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.search) return;
  if (Object.hasOwn(READER.assets, url.pathname)) {
    // Installation and module loads can send different Origin headers. Every response
    // here is pinned to the build's exact bytes, independent of its Vary header.
    event.respondWith(caches.open(cacheName).then(async (cache) => (await cache.match(url.href, { ignoreVary: true })) ?? fetch(request)));
    return;
  }
  if (request.mode !== 'navigate' || request.destination !== 'document') return;
  if (url.pathname !== '/' && !/^\/s\/[^/]+\/p\/[^/]+$/.test(url.pathname)) return;
  // A redeploy briefly makes the proxy answer 502/503/504; to the person that is the same as no network.
  const reader = () => new Response(READER.html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });
  event.respondWith(fetch(request).then((response) => [502, 503, 504].includes(response.status) ? reader() : response, reader));
});
