// READER is generated alongside this script from the built offline entry.
const cachePrefix = 'folio-offline-reader-';
const cacheName = cachePrefix + READER.version;

self.addEventListener('install', (event) => {
  // addAll is atomic. Integrity also catches gateways returning a successful login page.
  const requests = Object.entries(READER.assets).map(([path, integrity]) =>
    new Request(new URL(path, self.location.origin), { integrity, redirect: 'error', credentials: 'same-origin', cache: 'reload' }),
  );
  event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll(requests)));
});

self.addEventListener('activate', (event) => {
  // Use the normal waiting phase so readers using a previous version keep their assets.
  event.waitUntil(caches.keys().then((names) =>
    Promise.all(names.filter((name) => name.startsWith(cachePrefix) && name !== cacheName).map((name) => caches.delete(name))),
  ));
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.search) return;
  if (Object.hasOwn(READER.assets, url.pathname)) {
    event.respondWith(caches.open(cacheName).then(async (cache) => (await cache.match(request)) ?? fetch(request)));
    return;
  }
  if (request.mode !== 'navigate' || request.destination !== 'document') return;
  if (url.pathname !== '/' && !/^\/s\/[^/]+\/p\/[^/]+$/.test(url.pathname)) return;
  event.respondWith(fetch(request).catch(() => new Response(READER.html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  })));
});
