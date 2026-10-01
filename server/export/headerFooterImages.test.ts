/**
 * Round 23 tail follow-up ("an image in the PDF header or footer does not render") —
 * the save-time SSRF gateway that turns `<img src="http(s)://…">` in a
 * header/footer template into an inlined `data:` URI. See
 * headerFooterImages.ts's module doc for the full rule list this guards.
 *
 * Real local HTTP servers throughout (same convention as gitProviders.test.ts)
 * — no mocked `fetch`/`http`, so what's tested is the actual bytes-on-the-wire
 * behavior. The one seam used is `inlineExternalImages`'s optional
 * `resolveAddress` parameter, which lets the "successful fetch" and
 * "too-large" tests point the REAL fetch+sanitize+encode pipeline at a local
 * server without that server needing a routable public address (sandboxed
 * test runs have none) — the address-blocking gate itself
 * (`resolvePublicAddress`/`isPrivateOrLoopbackIp`) is exercised UNMOCKED,
 * against real loopback/private literals, in its own describe block below.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { sanitizeHeaderFooterHtml } from './css.js';
import {
  fetchViaPinnedIp,
  inlineExternalImages,
  isPrivateOrLoopbackIp,
  MAX_HEADER_FOOTER_IMAGE_BYTES,
  resolvePublicAddress,
  sanitizeSvgForEmbedding,
} from './headerFooterImages.js';

function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ port: number; server: http.Server }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ port, server });
    });
  });
}

// A tiny real PNG (1x1, transparent) — real magic bytes, not a fixture string.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

describe('isPrivateOrLoopbackIp', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.255.255.255', true],
    ['10.0.0.1', true],
    ['10.255.255.255', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['192.168.0.1', true],
    ['192.168.255.255', true],
    ['169.254.169.254', true], // cloud metadata endpoint
    ['0.0.0.0', true],
    ['::1', true],
    ['::', true],
    ['fc00::1', true],
    ['fd12:3456:789a::1', true],
    ['fe80::1', true],
    ['::ffff:127.0.0.1', true], // IPv4-mapped IPv6 literal
    ['::ffff:10.0.0.1', true],
    // public / not blocked
    ['8.8.8.8', false],
    ['1.1.1.1', false],
    ['172.15.255.255', false], // just outside 172.16/12
    ['172.32.0.0', false], // just outside 172.16/12
    ['192.167.255.255', false], // just outside 192.168/16
    ['169.253.255.255', false], // just outside 169.254/16
    ['2606:4700:4700::1111', false], // a real public IPv6 (Cloudflare)
  ])('%s -> blocked=%s', (ip, blocked) => {
    expect(isPrivateOrLoopbackIp(ip)).toBe(blocked);
  });
});

describe('resolvePublicAddress', () => {
  it('refuses a loopback literal', async () => {
    await expect(resolvePublicAddress('127.0.0.1')).rejects.toThrow(/private\/loopback/);
  });

  it('refuses every RFC1918 literal named by the owner', async () => {
    await expect(resolvePublicAddress('10.1.2.3')).rejects.toThrow(/private\/loopback/);
    await expect(resolvePublicAddress('172.16.5.5')).rejects.toThrow(/private\/loopback/);
    await expect(resolvePublicAddress('192.168.1.1')).rejects.toThrow(/private\/loopback/);
  });

  it('refuses the link-local range, which is also where cloud metadata lives', async () => {
    await expect(resolvePublicAddress('169.254.169.254')).rejects.toThrow(/private\/loopback/);
  });

  it('refuses IPv6 loopback and unique-local literals', async () => {
    await expect(resolvePublicAddress('::1')).rejects.toThrow(/private\/loopback/);
    await expect(resolvePublicAddress('fc00::1')).rejects.toThrow(/private\/loopback/);
  });

  it('resolves a public-looking literal to itself', async () => {
    await expect(resolvePublicAddress('8.8.8.8')).resolves.toBe('8.8.8.8');
  });
});

describe('fetchViaPinnedIp (real local server, ip passed explicitly)', () => {
  let openServer: http.Server | undefined;
  afterEach(async () => {
    if (openServer) await new Promise((r) => openServer!.close(r));
    openServer = undefined;
  });

  it('fetches a small image and reports its content type', async () => {
    const { port, server } = await startServer((_req, res) => {
      res.setHeader('Content-Type', 'image/png');
      res.end(TINY_PNG);
    });
    openServer = server;

    const url = new URL('http://logo.example/x.png');
    url.port = String(port);
    const result = await fetchViaPinnedIp(url, '127.0.0.1');
    expect(result.contentType).toBe('image/png');
    expect(result.data.equals(TINY_PNG)).toBe(true);
  });

  it('rejects a response declaring an oversized Content-Length up front', async () => {
    const { port, server } = await startServer((_req, res) => {
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Length', String(MAX_HEADER_FOOTER_IMAGE_BYTES + 1));
      res.end(); // never actually sends that many bytes — the header alone must trip the guard
    });
    openServer = server;

    const url = new URL(`http://x/y`);
    url.port = String(port);
    await expect(fetchViaPinnedIp(url, '127.0.0.1')).rejects.toThrow(/exceeds .* bytes/);
  });

  it('rejects a body that exceeds the cap while streaming, even with no honest Content-Length', async () => {
    const oversized = Buffer.alloc(MAX_HEADER_FOOTER_IMAGE_BYTES + 1024, 1);
    const { port, server } = await startServer((_req, res) => {
      res.setHeader('Content-Type', 'image/png');
      // No Content-Length: chunked transfer, so only the streaming guard can catch this.
      res.end(oversized);
    });
    openServer = server;

    const url = new URL(`http://x/y`);
    url.port = String(port);
    await expect(fetchViaPinnedIp(url, '127.0.0.1')).rejects.toThrow(/exceeds .* bytes/);
  });

  it('rejects an unsupported/missing content type', async () => {
    const { port, server } = await startServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end('<html>not an image</html>');
    });
    openServer = server;

    const url = new URL(`http://x/y`);
    url.port = String(port);
    await expect(fetchViaPinnedIp(url, '127.0.0.1')).rejects.toThrow(/content type/);
  });

  it('rejects a non-2xx response', async () => {
    const { port, server } = await startServer((_req, res) => {
      res.statusCode = 404;
      res.end('not found');
    });
    openServer = server;

    const url = new URL(`http://x/y`);
    url.port = String(port);
    await expect(fetchViaPinnedIp(url, '127.0.0.1')).rejects.toThrow(/404/);
  });

  it('does not follow a redirect', async () => {
    const { port, server } = await startServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader('Location', 'http://evil.example/steal');
      res.end();
    });
    openServer = server;

    const url = new URL(`http://x/y`);
    url.port = String(port);
    await expect(fetchViaPinnedIp(url, '127.0.0.1')).rejects.toThrow(/redirect/);
  });
});

describe('sanitizeSvgForEmbedding', () => {
  it('strips script tags and event handlers', () => {
    const out = sanitizeSvgForEmbedding('<svg onload="steal()"><script>fetch("https://evil.example")</script><rect/></svg>');
    expect(out).not.toContain('script');
    expect(out).not.toContain('onload');
    expect(out).toContain('<rect/>');
  });

  it('strips an external href/xlink:href but keeps a same-document #fragment and a data: URI', () => {
    const out = sanitizeSvgForEmbedding(
      '<svg><image href="https://evil.example/track.png"/><use xlink:href="#icon"/><image href="data:image/png;base64,AAAA"/></svg>',
    );
    expect(out).not.toContain('evil.example');
    expect(out).toContain('href="#icon"');
    expect(out).toContain('href="data:image/png;base64,AAAA"');
  });
});

describe('inlineExternalImages (full pipeline)', () => {
  let openServer: http.Server | undefined;
  afterEach(async () => {
    if (openServer) await new Promise((r) => openServer!.close(r));
    openServer = undefined;
  });

  it('an <img> with no external src is returned untouched', async () => {
    const html = '<span><img src="data:image/png;base64,AAAA"></span>';
    await expect(inlineExternalImages(html)).resolves.toBe(html);
  });

  it('rejects on a private/loopback address — the REAL gate, unmocked', async () => {
    const html = '<img src="http://127.0.0.1:1/logo.png">';
    await expect(inlineExternalImages(html)).rejects.toThrow(/private\/loopback/);
  });

  it('rejects on a file over the size cap, naming the reason', async () => {
    const oversized = Buffer.alloc(MAX_HEADER_FOOTER_IMAGE_BYTES + 1024, 1);
    const { port, server } = await startServer((_req, res) => {
      res.setHeader('Content-Type', 'image/png');
      res.end(oversized);
    });
    openServer = server;

    const html = `<img src="http://logo.example:${port}/big.png">`;
    await expect(inlineExternalImages(html, async () => '127.0.0.1')).rejects.toThrow(/exceeds .* bytes/);
  });

  it('a successful fetch inlines a data: URI that survives sanitizeHeaderFooterHtml', async () => {
    const { port, server } = await startServer((_req, res) => {
      res.setHeader('Content-Type', 'image/png');
      res.end(TINY_PNG);
    });
    openServer = server;

    const html = `<span><img src="http://logo.example:${port}/logo.png" alt="Logo"></span>`;
    const out = await inlineExternalImages(html, async () => '127.0.0.1');
    expect(out).toContain('src="data:image/png;base64,');
    expect(out).not.toContain('http://logo.example');
    expect(out).toContain('alt="Logo"'); // other attributes survive untouched

    // The point of this whole feature: what gets SAVED must pass the render-time
    // sanitizer unchanged, since a data: src is exactly what it's built to allow.
    const sanitized = sanitizeHeaderFooterHtml(out);
    expect(sanitized).toContain('src="data:image/png;base64,');
  });

  it('an SVG is sanitized before being inlined', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="1" height="1"/></svg>';
    const { port, server } = await startServer((_req, res) => {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.end(svg);
    });
    openServer = server;

    const html = `<img src="http://logo.example:${port}/logo.svg">`;
    const out = await inlineExternalImages(html, async () => '127.0.0.1');
    const match = /src="data:image\/svg\+xml;base64,([^"]+)"/.exec(out);
    expect(match).not.toBeNull();
    const decoded = Buffer.from(match![1], 'base64').toString('utf8');
    expect(decoded).not.toContain('script');
  });

  it('fetches an identical URL only once, even if it appears twice', async () => {
    let hits = 0;
    const { port, server } = await startServer((_req, res) => {
      hits++;
      res.setHeader('Content-Type', 'image/png');
      res.end(TINY_PNG);
    });
    openServer = server;

    const html = `<img src="http://logo.example:${port}/logo.png"><img src="http://logo.example:${port}/logo.png">`;
    await inlineExternalImages(html, async () => '127.0.0.1');
    expect(hits).toBe(1);
  });
});
