import vm from 'node:vm';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { PWA_KILL_WORKER, pwaEnabled, registerPwaKillSwitch } from './pwa.js';
import { renderIndexHtml } from './pageMeta.js';

const BUILT_INDEX = `<!doctype html>
<html lang="en">
  <head>
    <link rel="icon" href="/favicon.svg" />
    <link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials" />
    <link rel="apple-touch-icon" href="/icons/folio-180.png" />
    <title>Folio</title>
  </head>
  <body></body>
</html>
`;

afterEach(() => {
  delete process.env.FOLIO_PWA;
  delete process.env.FOLIO_SESSION_TTL_DAYS;
});

describe('FOLIO_PWA', () => {
  it('is on unless set to off', () => {
    expect(pwaEnabled()).toBe(true);
    process.env.FOLIO_PWA = '1';
    expect(pwaEnabled()).toBe(true);
    for (const value of ['off', 'OFF', ' off ', '0', 'false']) {
      process.env.FOLIO_PWA = value;
      expect(pwaEnabled(), value).toBe(false);
    }
  });

  it('answers /sw.js with the replacement worker, never cached, when off', async () => {
    process.env.FOLIO_PWA = 'off';
    const app = Fastify();
    registerPwaKillSwitch(app);
    const response = await app.inject({ url: '/sw.js' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/javascript');
    expect(response.headers['cache-control']).toBe('no-cache');
    expect(response.body).toBe(PWA_KILL_WORKER);
    await app.close();
  });

  it('registers no route when on, so the built worker is served', async () => {
    const app = Fastify();
    registerPwaKillSwitch(app);
    expect((await app.inject({ url: '/sw.js' })).statusCode).toBe(404);
    await app.close();
  });

  it('the replacement worker deletes the reader caches and database, claims clients and unregisters', async () => {
    const listeners = new Map<string, (event: { waitUntil(p: Promise<void>): void }) => void>();
    const calls: string[] = [];
    const request: { onsuccess?: () => void; onerror?: () => void; onblocked?: () => void } = {};
    vm.runInNewContext(PWA_KILL_WORKER, {
      self: {
        addEventListener: (type: string, fn: never) => listeners.set(type, fn),
        skipWaiting: () => calls.push('skipWaiting'),
        clients: { claim: async () => { calls.push('claim'); } },
        registration: { unregister: async () => { calls.push('unregister'); return true; } },
      },
      caches: {
        keys: async () => ['folio-offline-reader-abc', 'unrelated'],
        delete: async (name: string) => { calls.push('cache:' + name); return true; },
      },
      indexedDB: { deleteDatabase: (name: string) => { calls.push('db:' + name); queueMicrotask(() => request.onsuccess?.()); return request; } },
    });
    listeners.get('install')!({ waitUntil() {} });
    let done!: Promise<void>;
    listeners.get('activate')!({ waitUntil: (p) => { done = p; } });
    await done;
    expect(calls).toEqual(['skipWaiting', 'cache:folio-offline-reader-abc', 'db:folio-offline-reader', 'claim', 'unregister']);
  });
});

describe('index.html and the switch', () => {
  it('keeps the manifest and tells the client the session lifetime when on', () => {
    process.env.FOLIO_SESSION_TTL_DAYS = '7';
    const html = renderIndexHtml(BUILT_INDEX, 'https://wiki.example', '/');
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('<meta name="folio-session-ttl-days" content="7" />');
    expect(html).not.toContain('folio-pwa');
  });

  it('drops the manifest and icon and flags the client when off', () => {
    process.env.FOLIO_PWA = 'off';
    const html = renderIndexHtml(BUILT_INDEX, 'https://wiki.example', '/');
    expect(html).not.toContain('rel="manifest"');
    expect(html).not.toContain('apple-touch-icon');
    expect(html).toContain('<meta name="folio-pwa" content="off" />');
  });
});
