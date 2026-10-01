/**
 * F-04 — an uploaded SVG used to be served as an active document on Folio's
 * own origin: the upload took the client's multipart MIME type at face value
 * and GET /a/:sha/:filename sent every `image/*` inline with that stored type
 * and no sandboxing policy, so `image/svg+xml` opened as a document that
 * could run script with the visitor's session.
 *
 * Real PG (isolated schema), the real upload route and the real /a route
 * through Fastify's inject. The last describe block drives a real Chromium
 * against a listening instance and SKIPS (never fakes) when there is none.
 */
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import * as fastifyMultipartModule from '@fastify/multipart';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerAssetRoute } from './assetRoute.js';
import * as authStore from './auth/store.js';
import * as session from './auth/session.js';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import { HttpError } from './errors.js';
import { findChromium } from './export/pdf.js';
import { registerRoutes } from './routes.js';
import * as storage from './storage.js';

const SANDBOX_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";

// 1x1 PNG / minimal JPEG / PDF headers: only the leading bytes matter for type detection.
const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0marker-jpeg-test')]);
const PDF_BYTES = Buffer.from('%PDF-1.4\n% marker pdf for the serving test\n%%EOF\n');

const svgWithScript = (marker: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><script>document.documentElement.setAttribute('data-ran', 'yes')</script><rect width="40" height="20" fill="#333"/><!-- ${marker} --></svg>`;

function multipartBody(filename: string, mime: string, content: Buffer): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----folio-serving-test';
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, content, tail]), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('authUser', null);
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
  });
  await app.register(fastifyCookieModule.default);
  await app.register(fastifyMultipartModule.default, { limits: { fileSize: 50 * 1024 * 1024 } });
  registerAssetRoute(app); // public, like in server/index.ts
  await app.register(async (protectedScope) => {
    protectedScope.addHook('onRequest', session.requireSession);
    registerRoutes(protectedScope);
  });
  return app;
}

describe('GET /a/:sha/:filename — what an uploaded file is served as (F-04)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let editorCookie: string;
  let space: string;

  async function upload(filename: string, claimedMime: string, content: Buffer): Promise<{ url: string; sha256: string }> {
    const { payload, headers } = multipartBody(filename, claimedMime, content);
    const res = await app.inject({ method: 'POST', url: `/api/spaces/${space}/assets`, payload, headers: { ...headers, cookie: editorCookie } });
    expect(res.statusCode).toBe(201);
    return res.json() as { url: string; sha256: string };
  }

  async function fetchAsset(url: string) {
    const res = await app.inject({ method: 'GET', url }); // no cookie: the route is public by design
    expect(res.statusCode).toBe(200);
    return res;
  }

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const editor = await authStore.createUser({ email: `asset-serving-${Date.now()}@test.local`, name: 'Editor', passwordHash: 'x', isAdmin: false });
    editorCookie = `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(editor.id)).token}`;
    space = (await storage.createSpace(`Asset Serving ${Date.now()}`, editor.id)).slug;
    await authStore.setMembership(space, editor.id, 'editor');
    app = await buildApp();
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await deleteTestSpace(space);
    await teardownSchema();
  });

  it('serves an uploaded SVG with the sandbox policy and nosniff, so opening it directly cannot run its script', async () => {
    const { url } = await upload('diagram.svg', 'image/svg+xml', Buffer.from(svgWithScript('plain-svg')));
    const res = await fetchAsset(url);
    expect(res.headers['content-type']).toBe('image/svg+xml');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe(SANDBOX_CSP);
    expect(res.headers['content-security-policy']).toContain('sandbox');
    // A sandboxed SVG still displays on a direct visit (and, as a plain <img>, anywhere): it stays inline.
    expect(String(res.headers['content-disposition'])).toMatch(/^inline;/);
    expect(res.body).toContain('<script>'); // stored byte-for-byte: neutralised by headers, not rewritten
  });

  it('does not let a "image/png" label turn SVG bytes into an unsandboxed image', async () => {
    const { url } = await upload('photo.png', 'image/png', Buffer.from(svgWithScript('svg-labelled-png')));
    const res = await fetchAsset(url);
    expect(res.headers['content-type']).not.toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe(SANDBOX_CSP);
  });

  it('does not let a "image/png" label turn HTML bytes into anything but a download', async () => {
    const html = Buffer.from('<!doctype html><html><body><script>document.title = "ran"</script>html-labelled-png</body></html>');
    for (const filename of ['page.png', 'page.html', 'page']) {
      const body = Buffer.concat([html, Buffer.from(`\n<!-- ${filename} -->`)]);
      const { url } = await upload(filename, 'image/png', body);
      const res = await fetchAsset(url);
      expect(res.headers['content-type'], filename).toBe('application/octet-stream');
      expect(String(res.headers['content-disposition']), filename).toMatch(/^attachment;/);
      expect(res.headers['x-content-type-options'], filename).toBe('nosniff');
    }
  });

  it('serves everything that could run when opened directly as an opaque download, whatever type the client claimed', async () => {
    const cases: Array<[string, string]> = [
      ['page.html', 'text/html'],
      ['page.htm', 'text/html'],
      ['page.xhtml', 'application/xhtml+xml'],
      ['data.xml', 'text/xml'],
      ['data.xsl', 'application/xml'],
      ['code.js', 'text/javascript'],
      ['code.mjs', 'application/javascript'],
      ['image-that-is-html.gif', 'image/gif'],
      ['fake.svg', 'image/svg+xml'], // named and labelled SVG, but the document element is <html>
      ['notes.bin', 'application/x-something-odd'],
    ];
    for (const [filename, claimed] of cases) {
      const { url } = await upload(filename, claimed, Buffer.from(`<html><script>1</script></html><!-- ${filename} ${claimed} -->`));
      const res = await fetchAsset(url);
      expect(res.headers['content-type'], filename).toBe('application/octet-stream');
      expect(String(res.headers['content-disposition']), filename).toMatch(/^attachment;/);
      expect(res.headers['x-content-type-options'], filename).toBe('nosniff');
      expect(res.headers['content-security-policy'], filename).toContain('sandbox');
    }
  });

  it('keeps ordinary raster images inline with their REAL type, ignoring what the client claimed', async () => {
    const png = await fetchAsset((await upload('pixel.png', 'image/png', PNG_BYTES)).url);
    expect(png.headers['content-type']).toBe('image/png');
    expect(String(png.headers['content-disposition'])).toMatch(/^inline;/);
    expect(png.headers['x-content-type-options']).toBe('nosniff');
    expect(png.headers['content-security-policy']).toBeUndefined();
    expect(Buffer.compare(png.rawPayload, PNG_BYTES)).toBe(0);

    const jpeg = await fetchAsset((await upload('photo.jpg', 'image/jpeg', JPEG_BYTES)).url);
    expect(jpeg.headers['content-type']).toBe('image/jpeg');
    expect(String(jpeg.headers['content-disposition'])).toMatch(/^inline;/);
    expect(jpeg.headers['x-content-type-options']).toBe('nosniff');

    // The claim is not trusted in the other direction either: a JPEG labelled as SVG is a JPEG.
    const relabelled = await fetchAsset((await upload('relabelled.svg', 'image/svg+xml', Buffer.concat([JPEG_BYTES, Buffer.from('relabelled')]))).url);
    expect(relabelled.headers['content-type']).toBe('image/jpeg');
    expect(relabelled.headers['content-security-policy']).toBeUndefined();
  });

  it('keeps a PDF inline, with nosniff and without the sandbox policy (a verified PDF has nothing to sandbox)', async () => {
    const res = await fetchAsset((await upload('manual.pdf', 'application/pdf', PDF_BYTES)).url);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(String(res.headers['content-disposition'])).toMatch(/^inline;/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeUndefined();

    const fake = await fetchAsset((await upload('fake.pdf', 'application/pdf', Buffer.from('<html>not a pdf, fake.pdf</html>'))).url);
    expect(fake.headers['content-type']).toBe('application/octet-stream');
    expect(String(fake.headers['content-disposition'])).toMatch(/^attachment;/);
  });

  it('keeps office documents and archives as downloads with their proper type', async () => {
    const docx = await fetchAsset((await upload('report.docx', 'application/octet-stream', Buffer.from('PK\x03\x04 docx marker'))).url);
    expect(docx.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(String(docx.headers['content-disposition'])).toMatch(/^attachment;/);
    expect(docx.headers['x-content-type-options']).toBe('nosniff');

    const txt = await fetchAsset((await upload('notes.txt', 'text/plain', Buffer.from('plain notes marker'))).url);
    expect(txt.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(String(txt.headers['content-disposition'])).toMatch(/^attachment;/);
  });

  it('sends nosniff on every asset response and keeps the long cache lifetime of a content-addressed URL', async () => {
    const res = await fetchAsset((await upload('cache.png', 'image/png', Buffer.concat([PNG_BYTES, Buffer.from('cache-marker')]))).url);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('ignores the type stored in the assets table: rows written before the fix hold the uploader\'s claim', async () => {
    const { sha256, url } = await upload('legacy.svg', 'image/svg+xml', Buffer.from(svgWithScript('legacy-row')));
    const { query } = await import('./db/pool.js');
    await query('UPDATE assets SET mime = $1 WHERE sha256 = $2', ['image/png', sha256]);
    const res = await fetchAsset(url);
    expect(res.headers['content-type']).toBe('image/svg+xml');
    expect(res.headers['content-security-policy']).toBe(SANDBOX_CSP);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('still serves a non-ASCII file name (ASCII fallback plus RFC 5987), with the same safety headers', async () => {
    const { putAsset } = await import('./assets.js');
    const stored = await putAsset(Buffer.concat([PNG_BYTES, Buffer.from('cyrillic-name-marker')]), { mime: 'image/png', filename: '\u0414\u0456\u0430\u0433\u0440\u0430\u043c\u0430 "v2".png' }, null);
    const res = await fetchAsset(stored.url);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-disposition']).toBe(`inline; filename="________ v2.png"; filename*=UTF-8''${encodeURIComponent('\u0414\u0456\u0430\u0433\u0440\u0430\u043c\u0430 "v2".png')}`);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('answers 404 for an unknown or malformed hash, with nothing active in the reply', async () => {
    const missing = await app.inject({ method: 'GET', url: `/a/${'0'.repeat(64)}/x.svg` });
    expect(missing.statusCode).toBe(404);
    const malformed = await app.inject({ method: 'GET', url: '/a/not-a-hash/x.svg' });
    expect(malformed.statusCode).toBe(404);
  });

  it('derives the stored metadata from the content too, so the assets table does not keep the client claim', async () => {
    const bytes = Buffer.from(svgWithScript('stored-meta'));
    const { sha256 } = await upload('claimed.png', 'image/png', bytes);
    expect(sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    const { query } = await import('./db/pool.js');
    const rows = await query<{ mime: string }>('SELECT mime FROM assets WHERE sha256 = $1', [sha256]);
    expect(rows[0].mime).toBe('image/svg+xml');
  });
});

// ---------------------------------------------------------------------------
// real browser (skipped, never faked, when there is no chromium)
// ---------------------------------------------------------------------------

describe('GET /a/... in a real browser (F-04)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let base = '';
  let chromium: string | undefined;
  let svgUrl = '';
  let editorCookie = '';
  let space = '';

  beforeAll(async () => {
    chromium = await findChromium();
    teardownSchema = await setUpTestSchema();
    const editor = await authStore.createUser({ email: `asset-serving-browser-${Date.now()}@test.local`, name: 'Editor', passwordHash: 'x', isAdmin: false });
    editorCookie = `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(editor.id)).token}`;
    space = (await storage.createSpace(`Asset Serving Browser ${Date.now()}`, editor.id)).slug;
    await authStore.setMembership(space, editor.id, 'editor');
    app = await buildApp();
    app.get('/host', async (_request, reply) => reply.type('text/html').send(`<!doctype html><img id="pic" src="${svgUrl}">`));
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

    const { payload, headers } = multipartBody('browser.svg', 'image/svg+xml', Buffer.from(svgWithScript('browser-test')));
    const res = await app.inject({ method: 'POST', url: `/api/spaces/${space}/assets`, payload, headers: { ...headers, cookie: editorCookie } });
    svgUrl = (res.json() as { url: string }).url;
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await deleteTestSpace(space);
    await teardownSchema();
  });

  it('opening the SVG directly does not run its script, while the same file still renders through <img>', async (ctx) => {
    if (!chromium) return ctx.skip();
    const { launch } = await import('puppeteer-core');
    const browser = await launch({
      executablePath: chromium,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    try {
      const direct = await browser.newPage();
      await direct.goto(`${base}${svgUrl}`, { waitUntil: 'load' });
      // The server tsconfig has no DOM lib, so the page-side code goes in as strings.
      const ran = await direct.evaluate('document.documentElement.getAttribute("data-ran")');
      expect(ran).toBeNull();

      const host = await browser.newPage();
      await host.goto(`${base}/host`, { waitUntil: 'load' });
      await host.waitForFunction('document.getElementById("pic").complete');
      const width = await host.evaluate('document.getElementById("pic").naturalWidth');
      expect(width).toBe(40);
    } finally {
      await browser.close().catch(() => {});
    }
  }, 120_000);
});
