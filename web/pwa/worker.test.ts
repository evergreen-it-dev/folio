import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const origin = 'https://wiki.example';
const html = '<!doctype html><title>Saved documents</title>';
const path = '/assets/offline-12345678.js';
const integrity = 'sha256-rLlIvXzuAWsk2RRzsWgOmKvI8ZZ68McM+2JSQAKQfdU=';

function worker(network: typeof fetch) {
  const listeners = new Map<string, (event: object) => void>();
  const cached = new Response('compiled reader');
  const cache = { addAll: vi.fn(), match: async () => cached };
  const script = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
  runInNewContext(script, {
    READER: { version: 'build1', html, assets: { [path]: integrity } },
    self: { location: new URL(origin), addEventListener: (type: string, fn: (event: object) => void) => listeners.set(type, fn) },
    URL, Request, Response, fetch: network, caches: { open: async () => cache },
  });
  return {
    cache,
    install() {
      let installed: Promise<void> | undefined;
      listeners.get('install')!({ waitUntil: (p: Promise<void>) => { installed = p; } });
      return installed;
    },
    request(path: string, mode = 'navigate', method = 'GET', destination = 'document') {
      let response: Promise<Response> | undefined;
      listeners.get('fetch')!({
        request: { mode, method, destination, url: new URL(path, origin).href },
        respondWith: (p: Promise<Response>) => { response = p; },
      });
      return response;
    },
  };
}

describe('the offline reader service worker', () => {
  it('installs only the fingerprinted reader assets and fails on redirects or integrity mismatches', async () => {
    const w = worker(fetch);
    await w.install();
    expect(w.cache.addAll.mock.calls[0][0]).toMatchObject([{ url: origin + path, redirect: 'error', integrity }]);
  });

  it('offers the built reader for a normal document or home navigation if the network fails', async () => {
    const w = worker(vi.fn().mockRejectedValue(new TypeError('offline')));
    for (const url of ['/', '/s/field-notes/p/doc-123']) {
      const response = await w.request(url);
      expect(await response?.text()).toEqual(html);
      expect(response?.headers.get('cache-control')).toBe('no-store');
    }
    expect(await (await w.request(path, 'cors'))?.text()).toBe('compiled reader');
    for (const url of ['/api/auth/state', '/auth/callback', '/share/token', '/public/wiki', '/s/a/p/b?signin=1', '/?code=1', '/s/a/p/b/more', 'https://elsewhere.example/']) {
      expect(w.request(url), url).toBeUndefined();
    }
    expect(w.request('/', 'cors')).toBeUndefined();
    expect(w.request('/', 'navigate', 'POST')).toBeUndefined();
    expect(w.request('/', 'navigate', 'GET', 'iframe')).toBeUndefined();
  });

  it('passes through online redirects and HTTP errors', async () => {
    for (const status of [200, 302, 401, 403, 404, 503]) {
      const network = new Response(null, { status });
      expect(await worker(vi.fn().mockResolvedValue(network)).request('/')).toBe(network);
    }
  });
});
