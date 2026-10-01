import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyStaticModule from '@fastify/static';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { shouldServeSpaFallback, isContentHashedAsset, spaCacheControl, spaStaticOptions } from './spaFallback.js';

/**
 * A stale browser tab requesting a hashed chunk that no longer exists after
 * a deploy must get a real 404 (so web/src/app/stale-chunk.ts can detect it
 * and recover), not index.html with a 200 — see spaFallback.ts's doc
 * comment for the full story.
 */
describe('shouldServeSpaFallback', () => {
  it('falls back for an ordinary client-side route', () => {
    expect(shouldServeSpaFallback('GET', '/s/sk-space/p/01M8Z9')).toBe(true);
    expect(shouldServeSpaFallback('GET', '/')).toBe(true);
  });

  it('does NOT fall back for a missing hashed asset — the prod bug', () => {
    expect(shouldServeSpaFallback('GET', '/assets/sequenceDiagram-WJ2MYXX4-oldhash.js')).toBe(false);
    expect(shouldServeSpaFallback('GET', '/assets/nope.js')).toBe(false);
  });

  it('does not fall back for the existing server-route prefixes', () => {
    expect(shouldServeSpaFallback('GET', '/api/health')).toBe(false);
    expect(shouldServeSpaFallback('GET', '/files/some-space/x.png')).toBe(false);
    expect(shouldServeSpaFallback('GET', '/a/deadbeef/file.pdf')).toBe(false);
    expect(shouldServeSpaFallback('GET', '/collab')).toBe(false);
  });

  it('never falls back for a non-GET method, even on an SPA-looking path', () => {
    expect(shouldServeSpaFallback('POST', '/s/sk-space/p/01M8Z9')).toBe(false);
  });
});

describe('spaCacheControl', () => {
  it('caches content-hashed chunks and assets for good', () => {
    for (const file of ['/app/web/dist/assets/index-C25_wABs.js', '/app/web/dist/assets/BoardCanvas-DtRVLazd.css', '/app/web/dist/assets/Assistant-Bold-gm-uSS1B.woff2', 'assets/docx_parser_bg-C1Wf3n7F.wasm']) {
      expect(isContentHashedAsset(file), file).toBe(true);
      expect(spaCacheControl(file)).toBe('public, max-age=31536000, immutable');
    }
  });

  it('revalidates what keeps its name across deploys', () => {
    for (const file of ['/app/web/dist/index.html', '/app/web/dist/assets/manifest.json', '/app/web/dist/favicon.svg']) {
      expect(isContentHashedAsset(file), file).toBe(false);
      expect(spaCacheControl(file)).toBe('no-cache');
    }
  });
});

/**
 * The exact options production mounts for the built SPA (spaStaticOptions),
 * on a real socket so the request line reaches the server untouched — an
 * in-process inject() would normalise `%2e%2e` away before the plugin saw it.
 * @fastify/static 10 hands `setHeaders` the Fastify reply (it was the raw
 * response before); this proves the cache headers still reach the client.
 */
describe('spaStaticOptions mounted on @fastify/static', () => {
  const HASHED = 'index-AbCd1234.js';
  let dir: string;
  let dist: string;
  let app: FastifyInstance;
  let port: number;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-spa-static-'));
    dist = path.join(dir, 'dist');
    await fs.mkdir(path.join(dist, 'assets'), { recursive: true });
    await fs.writeFile(path.join(dist, 'index.html'), '<!doctype html><title>spa</title>');
    await fs.writeFile(path.join(dist, 'assets', HASHED), 'console.log("bundle");');
    await fs.writeFile(path.join(dist, 'assets', 'manifest.json'), '{}');
    await fs.writeFile(path.join(dist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await fs.writeFile(path.join(dir, 'outside-secret.txt'), 'OUTSIDE-SECRET');
    await fs.writeFile(path.join(dist, 'assets', 'dist-secret.txt'), 'INSIDE-ASSETS');

    app = Fastify();
    await app.register(fastifyStaticModule.default, spaStaticOptions(dist));
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app?.close();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  /** One request with the path sent exactly as written. */
  function raw(rawPath: string, method = 'GET', headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: rawPath, method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('serves index.html at / and by name, revalidated every time', async () => {
    for (const url of ['/', '/index.html']) {
      const res = await raw(url);
      expect(res.status, url).toBe(200);
      expect(res.headers['content-type'], url).toContain('text/html');
      expect(res.headers['cache-control'], url).toBe('no-cache');
      expect(res.body, url).toContain('<title>spa</title>');
    }
  });

  it('serves a content-hashed chunk with the immutable year-long cache, and the unhashed manifest with no-cache', async () => {
    const chunk = await raw(`/assets/${HASHED}`);
    expect(chunk.status).toBe(200);
    expect(chunk.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(chunk.headers['content-type']).toContain('javascript');
    expect((await raw('/assets/manifest.json')).headers['cache-control']).toBe('no-cache');
    expect((await raw('/favicon.svg')).headers['cache-control']).toBe('no-cache');
  });

  it('keeps the cache header on HEAD and on a 304 revalidation', async () => {
    const first = await raw(`/assets/${HASHED}`);
    const head = await raw(`/assets/${HASHED}`, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const etag = String(first.headers.etag ?? '');
    expect(etag).not.toBe('');
    const revalidated = await raw(`/assets/${HASHED}`, 'GET', { 'if-none-match': etag });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('a missing file is left to the not-found handler (404 here), never a stack trace', async () => {
    const res = await raw('/assets/index-gone0000.js');
    expect(res.status).toBe(404);
    expect(res.body).not.toContain('bundle');
  });

  it('never hands out a file through traversal, however the dots and slashes are spelled', async () => {
    for (const url of [
      '/assets/%2e%2e/%2e%2e/outside-secret.txt',
      '/%2e%2e/outside-secret.txt',
      '/assets/..%2foutside-secret.txt',
      '/assets/%2e%2e%2f%2e%2e%2foutside-secret.txt',
      '/%252e%252e/outside-secret.txt',
      '/assets/%252e%252e/%252e%252e/outside-secret.txt',
      '/../outside-secret.txt',
      '/assets/../../outside-secret.txt',
      '/assets/%5c..%5coutside-secret.txt',
      '/assets/./dist-secret.txt/.',
    ]) {
      const res = await raw(url);
      expect(res.body, url).not.toContain('OUTSIDE-SECRET');
      expect(res.status, url).not.toBe(200);
    }
  });

  it('refuses non-canonical spellings of a real file instead of serving them around a route guard', async () => {
    for (const url of [`//assets/${HASHED}`, `/assets//${HASHED}`, `/assets/./${HASHED}`, `/./assets/${HASHED}`]) {
      const res = await raw(url);
      expect(res.status, url).toBe(403);
      expect(res.body, url).not.toContain('bundle');
    }
    expect((await raw(`/assets/${HASHED}`)).status).toBe(200); // the canonical spelling still works
  });
});
