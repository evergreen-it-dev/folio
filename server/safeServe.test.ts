/**
 * safeServe.ts — the policy deciding what a user-supplied file is served as.
 * Pure functions plus one temp-file case; no database, no server.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyStaticModule from '@fastify/static';
import { afterAll, describe, expect, it } from 'vitest';
import { SANDBOX_CSP, classifyForServing, headersFor, serveHeaders, serveHeadersForPath, svgRootStatus } from './safeServe.js';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
const buf = (s: string) => Buffer.from(s, 'utf8');

describe('svgRootStatus', () => {
  it('finds the root past a BOM, XML declaration, comments and a DOCTYPE with an internal subset', () => {
    const prolog =
      '﻿<?xml version="1.0" encoding="UTF-8"?>\n<!-- a > b ]]> still a comment -->\n' +
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [ <!ENTITY e "x>y"> ]>\n';
    expect(svgRootStatus(buf(prolog + SVG))).toBe('svg');
    expect(svgRootStatus(buf(`  \n${SVG}`))).toBe('svg');
    expect(svgRootStatus(buf('<svg:svg xmlns:svg="http://www.w3.org/2000/svg"/>'))).toBe('svg');
    expect(svgRootStatus(buf('<svg/>'))).toBe('svg');
  });

  it('reads past a very large leading comment, like the scene payload at the top of a board file', () => {
    expect(svgRootStatus(buf(`<!-- folio-scene: ${'A'.repeat(600_000)} -->${SVG}`))).toBe('svg');
  });

  it('refuses everything that is not an <svg> document element', () => {
    expect(svgRootStatus(buf('<!doctype html><html><body>' + SVG + '</body></html>'))).toBe('not-svg');
    expect(svgRootStatus(buf('<html xmlns="http://www.w3.org/1999/xhtml">' + SVG + '</html>'))).toBe('not-svg');
    expect(svgRootStatus(buf('<svgfoo/>'))).toBe('not-svg');
    expect(svgRootStatus(buf('some text before ' + SVG))).toBe('not-svg');
    expect(svgRootStatus(buf('<!-- never closed ' + SVG))).toBe('not-svg');
    expect(svgRootStatus(buf(''))).toBe('not-svg');
  });

  it('says "unknown" rather than guessing when only the start of a larger file was given', () => {
    expect(svgRootStatus(buf('<!-- cut off'), true)).toBe('unknown');
    expect(svgRootStatus(buf('<?xml version="1.0"?>\n<sv'), true)).toBe('unknown');
    expect(svgRootStatus(buf('<html><body>' + 'x'.repeat(200)), true)).toBe('not-svg');
  });
});

describe('classifyForServing', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

  it('recognises rasters and PDF by their bytes, whatever the name says', () => {
    expect(classifyForServing('a.svg', png)).toEqual({ contentType: 'image/png', inline: true, sandbox: false });
    expect(classifyForServing('a.png', Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 0]))).toMatchObject({ contentType: 'image/jpeg', inline: true });
    expect(classifyForServing('a', buf('GIF89a....'))).toMatchObject({ contentType: 'image/gif' });
    expect(classifyForServing('a', Buffer.concat([buf('RIFF'), Buffer.alloc(4), buf('WEBPVP8 ')]))).toMatchObject({ contentType: 'image/webp' });
    expect(classifyForServing('a', Buffer.concat([Buffer.alloc(4), buf('ftypavif'), Buffer.alloc(4)]))).toMatchObject({ contentType: 'image/avif' });
    expect(classifyForServing('a', Buffer.concat([Buffer.alloc(4), buf('ftypheic'), Buffer.alloc(4)]))).toMatchObject({ contentType: 'image/heic' });
    expect(classifyForServing('a', Buffer.from([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0]))).toMatchObject({ contentType: 'image/tiff' });
    expect(classifyForServing('a', Buffer.from([0, 0, 1, 0, 1, 0, 16, 16]))).toMatchObject({ contentType: 'image/x-icon' });
    const bmp = Buffer.alloc(30);
    bmp.write('BM', 0, 'latin1');
    bmp.writeUInt32LE(40, 14);
    expect(classifyForServing('a', bmp)).toMatchObject({ contentType: 'image/bmp' });
    expect(classifyForServing('a.txt', buf('%PDF-1.7\n'))).toEqual({ contentType: 'application/pdf', inline: true, sandbox: false });
  });

  it('does not take text that merely starts like a binary format for that format', () => {
    expect(classifyForServing('note.txt', buf('BM is a ticker symbol, not a bitmap'))).toMatchObject({ contentType: 'text/plain', inline: false });
    expect(classifyForServing('note.txt', buf('a long sentence that only mentions %PDF- somewhere in the middle'))).toMatchObject({ contentType: 'text/plain' });
    expect(classifyForServing('x.png', buf('<html>not a png</html>'))).toEqual({ contentType: 'application/octet-stream', inline: false, sandbox: true });
  });

  it('serves SVG inline under the sandbox policy, by content first and by name only when the start is inconclusive', () => {
    expect(classifyForServing('x.svg', buf(SVG))).toEqual({ contentType: 'image/svg+xml', inline: true, sandbox: true });
    expect(classifyForServing('x.png', buf(SVG))).toMatchObject({ contentType: 'image/svg+xml', sandbox: true });
    expect(classifyForServing('board.excalidraw.svg', buf('<!-- cut off'), true)).toMatchObject({ contentType: 'image/svg+xml', sandbox: true });
    expect(classifyForServing('x.bin', buf('<!-- cut off'), true)).toMatchObject({ contentType: 'application/octet-stream', inline: false });
    expect(classifyForServing('x.svg', buf('<html><script>1</script></html>'))).toEqual({ contentType: 'application/octet-stream', inline: false, sandbox: true });
  });

  it('turns every other file into a download: known document types by extension, the rest opaque', () => {
    expect(classifyForServing('r.DOCX', buf('PK'))).toMatchObject({ contentType: expect.stringContaining('wordprocessingml'), inline: false });
    expect(classifyForServing('d.zip', buf('PK'))).toMatchObject({ contentType: 'application/zip', inline: false });
    for (const name of ['p.html', 'p.htm', 'p.xhtml', 'p.xml', 'p.xsl', 'p.js', 'p.mjs', 'p.css', 'p.php', 'p.exe', 'noext', '.hidden', 'p.html.txt.html']) {
      expect(classifyForServing(name, buf('<html></html>')), name).toEqual({ contentType: 'application/octet-stream', inline: false, sandbox: true });
    }
  });
});

describe('headers', () => {
  it('SVG: inline, exact type, nosniff and the sandbox CSP', () => {
    expect(serveHeaders('d.svg', buf(SVG))).toEqual({
      'Content-Type': 'image/svg+xml',
      'Content-Disposition': `inline; filename="d.svg"; filename*=UTF-8''d.svg`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': SANDBOX_CSP,
    });
  });

  it('PNG: inline with nosniff and no CSP (a verified raster has nothing to sandbox)', () => {
    const headers = serveHeaders('p.png', Buffer.from('89504e470d0a1a0a00', 'hex'));
    expect(headers['Content-Type']).toBe('image/png');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Content-Security-Policy']).toBeUndefined();
  });

  it('unknown: opaque download with the CSP as a second layer', () => {
    const headers = serveHeaders('thing.bin', buf('x'));
    expect(headers['Content-Type']).toBe('application/octet-stream');
    expect(headers['Content-Disposition']).toMatch(/^attachment;/);
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Content-Security-Policy']).toBe(SANDBOX_CSP);
  });

  it('text: the charset is declared on the wire only, the policy keeps the bare type', () => {
    expect(classifyForServing('n.md', buf('# t')).contentType).toBe('text/markdown');
    expect(serveHeaders('n.md', buf('# t'))['Content-Type']).toBe('text/markdown; charset=utf-8');
    expect(serveHeaders('n.txt', buf('t'))['Content-Type']).toBe('text/plain; charset=utf-8');
    expect(serveHeaders('n.csv', buf('a,b'))['Content-Type']).toBe('text/csv; charset=utf-8');
    expect(serveHeaders('n.json', buf('{}'))['Content-Type']).toBe('application/json');
    expect(serveHeaders('n.bin', buf('x'))['Content-Type']).toBe('application/octet-stream');
  });

  it('keeps line breaks and quotes in a file name out of the header', () => {
    const value = headersFor({ contentType: 'text/plain', inline: false, sandbox: true }, 'a"b\r\nSet-Cookie: x=1.txt')['Content-Disposition'];
    expect(value).not.toMatch(/[\r\n]/);
    expect(value).toContain('filename="ab__Set-Cookie: x=1.txt"');
  });
});

describe('serveHeadersForPath', () => {
  let dir: string | undefined;
  afterAll(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it('reads only the start of a file and still applies the SVG policy to a board with an oversized scene comment', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-safeserve-'));
    const board = path.join(dir, 'board.excalidraw.svg');
    await fs.writeFile(board, `<!-- folio-scene: ${'A'.repeat(2_000_000)} -->${SVG}`);
    expect((await serveHeadersForPath(board, 'board.excalidraw.svg'))?.['Content-Security-Policy']).toBe(SANDBOX_CSP);

    const page = path.join(dir, 'page.html');
    await fs.writeFile(page, `<!doctype html><html>${'x'.repeat(2_000_000)}</html>`);
    const html = await serveHeadersForPath(page, 'page.html');
    expect(html?.['Content-Type']).toBe('application/octet-stream');
    expect(html?.['Content-Disposition']).toMatch(/^attachment;/);

    const fakeSvg = path.join(dir, 'fake.svg');
    await fs.writeFile(fakeSvg, `<html>${'x'.repeat(2_000_000)}</html>`);
    expect((await serveHeadersForPath(fakeSvg, 'fake.svg'))?.['Content-Type']).toBe('application/octet-stream');

    // Nothing to describe: the caller's own 404 handling answers.
    expect(await serveHeadersForPath(path.join(dir, 'missing.png'), 'missing.png')).toBeNull();
    expect(await serveHeadersForPath(dir, 'dir')).toBeNull();
  });
});

describe('serveHeadersForPath together with reply.sendFile (how a streaming handler uses it)', () => {
  let dir: string | undefined;
  let app: FastifyInstance | undefined;
  afterAll(async () => {
    await app?.close();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  async function build(root: string, mode: 'before' | 'onSend'): Promise<FastifyInstance> {
    const instance = Fastify();
    await instance.register(fastifyStaticModule.default, { root, serve: false });
    const headersFor = async (request: { params: unknown }) => {
      const rest = (request.params as { '*': string })['*'];
      return serveHeadersForPath(path.join(root, rest), path.basename(rest));
    };
    if (mode === 'onSend') {
      // After sendFile has chosen its own headers, so ours win.
      instance.addHook('onSend', async (request, reply) => {
        const headers = await headersFor(request);
        if (headers && reply.statusCode < 400) reply.headers(headers);
      });
    }
    instance.get('/f/*', async (request, reply) => {
      if (mode === 'before') {
        const headers = await headersFor(request);
        if (headers) reply.headers(headers);
      }
      return reply.sendFile((request.params as { '*': string })['*']);
    });
    await instance.ready();
    return instance;
  }

  it('headers set BEFORE reply.sendFile do not survive it (@fastify/static picks the type from the extension)', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-safeserve-static-'));
    await fs.writeFile(path.join(dir, 'page.html'), '<html><script>1</script></html>');
    const before = await build(dir, 'before');
    try {
      const html = await before.inject({ method: 'GET', url: '/f/page.html' });
      expect(html.headers['content-type']).toContain('text/html'); // the reason a handler must not rely on this order
    } finally {
      await before.close();
    }
  });

  it('headers applied in an onSend hook reach the client: type, disposition, nosniff and CSP; a missing file stays a plain 404', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-safeserve-static-'));
    await fs.writeFile(path.join(dir, 'chart.svg'), `<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>`);
    await fs.writeFile(path.join(dir, 'page.html'), '<html><script>1</script></html>');
    await fs.writeFile(path.join(dir, 'pixel.png'), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
    app = await build(dir, 'onSend');

    const svg = await app.inject({ method: 'GET', url: '/f/chart.svg' });
    expect(svg.headers['content-type']).toBe('image/svg+xml');
    expect(svg.headers['content-security-policy']).toBe(SANDBOX_CSP);
    expect(svg.headers['x-content-type-options']).toBe('nosniff');
    expect(String(svg.headers['content-disposition'])).toMatch(/^inline;/);

    const html = await app.inject({ method: 'GET', url: '/f/page.html' });
    expect(html.headers['content-type']).toBe('application/octet-stream');
    expect(String(html.headers['content-disposition'])).toMatch(/^attachment;/);
    expect(html.headers['x-content-type-options']).toBe('nosniff');

    const png = await app.inject({ method: 'GET', url: '/f/pixel.png' });
    expect(png.headers['content-type']).toBe('image/png');
    expect(png.headers['content-security-policy']).toBeUndefined();

    expect((await app.inject({ method: 'GET', url: '/f/missing.png' })).statusCode).toBe(404);

    // A revalidation answered 304 carries the policy as well.
    const etag = String(png.headers.etag ?? '');
    expect(etag).not.toBe('');
    const revalidated = await app.inject({ method: 'GET', url: '/f/pixel.png', headers: { 'if-none-match': etag } });
    expect(revalidated.statusCode).toBe(304);
    expect(revalidated.headers['x-content-type-options']).toBe('nosniff');
  });
});
