/**
 * F-06 — rasterizeSvg (the SVG -> PNG step of the DOCX export) used to open
 * its page with JavaScript off but with NO request interception, so an SVG an
 * author controls (a repository file) could make the server-side Chromium
 * request external or internal addresses (SSRF). renderPdf already blocked
 * everything but data: URLs; the two now share one page factory.
 *
 * A local HTTP server stands in for "somewhere the server must not reach"; the
 * test asserts it sees ZERO requests. A control page opened WITHOUT the
 * factory proves the server is reachable from Chromium, so a zero is not just
 * a broken setup. Needs a system Chromium and skips (never fakes) without one.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { inflateSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closeBrowser, findChromium, rasterizeSvg } from './pdf.js';

const NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"';
const BOX = 'width="80" height="40"';

/** One SVG (or markup the SVG is spliced into) per way a document can ask for a URL. */
function vectors(base: string): Record<string, string> {
  return {
    'svg <image href>': `<svg ${NS} ${BOX}><image href="${base}/image-href.png" ${BOX}/></svg>`,
    'svg <image xlink:href>': `<svg ${NS} ${BOX}><image xlink:href="${base}/image-xlink.png" ${BOX}/></svg>`,
    'svg <use href>': `<svg ${NS} ${BOX}><use href="${base}/sprite.svg#icon"/></svg>`,
    'svg <use xlink:href>': `<svg ${NS} ${BOX}><use xlink:href="${base}/sprite-xlink.svg#icon"/></svg>`,
    'css @import in <style>': `<svg ${NS} ${BOX}><style>@import url(${base}/import.css);</style><rect ${BOX}/></svg>`,
    'css url() as a paint server': `<svg ${NS} ${BOX}><style>rect{fill:url(${base}/paint.svg#p) #333}</style><rect ${BOX}/></svg>`,
    'css url() in a filter': `<svg ${NS} ${BOX}><rect ${BOX} style="filter:url(${base}/filter.svg#f)"/></svg>`,
    'css @font-face used by text': `<svg ${NS} ${BOX}><style>@font-face{font-family:probe;src:url(${base}/font.woff2)}text{font-family:probe}</style><text y="20">probe</text></svg>`,
    'css background on the wrapper': `<svg ${NS} ${BOX}><style>#w{background:url(${base}/background.png)}</style><rect ${BOX}/></svg>`,
    'foreignObject with an <img>': `<svg ${NS} ${BOX}><foreignObject ${BOX}><div xmlns="http://www.w3.org/1999/xhtml"><img src="${base}/foreign.png"></div></foreignObject></svg>`,
    'a redirecting URL': `<svg ${NS} ${BOX}><image href="${base}/redirect" ${BOX}/></svg>`,
    // The SVG text is spliced into an HTML page, so it can close its own element and add markup.
    'breakout <img>': `<svg ${NS} ${BOX}/></div><img src="${base}/breakout.png"><div>`,
    'breakout <iframe>': `<svg ${NS} ${BOX}/></div><iframe src="${base}/frame.html"></iframe><div>`,
    'breakout <link rel=stylesheet>': `<svg ${NS} ${BOX}/></div><link rel="stylesheet" href="${base}/link.css"><div>`,
    'breakout <link rel=preload>': `<svg ${NS} ${BOX}/></div><link rel="preload" as="image" href="${base}/preload.png"><div>`,
    // Chromium starts these outside the page's request interception; only the document's CSP stops them.
    'breakout <link rel=preconnect>': `<svg ${NS} ${BOX}/></div><link rel="preconnect" href="${base}"><div>`,
    'breakout <link rel=prefetch>': `<svg ${NS} ${BOX}/></div><link rel="prefetch" href="${base}/prefetch.png"><div>`,
    'breakout <link rel=prerender>': `<svg ${NS} ${BOX}/></div><link rel="prerender" href="${base}/prerender.html"><div>`,
    'breakout <link rel=modulepreload>': `<svg ${NS} ${BOX}/></div><link rel="modulepreload" href="${base}/module.js"><div>`,
    'breakout <meta refresh>': `<svg ${NS} ${BOX}/></div><meta http-equiv="refresh" content="0;url=${base}/refresh.html"><div>`,
    'breakout <video poster>': `<svg ${NS} ${BOX}/></div><video poster="${base}/poster.png"></video><div>`,
    'breakout <object>': `<svg ${NS} ${BOX}/></div><object data="${base}/object.svg" type="image/svg+xml"></object><div>`,
    'script (JavaScript stays off)': `<svg ${NS} ${BOX} onload="new Image().src='${base}/onload.png'"><script>new Image().src='${base}/script.png'</script></svg>`,
  };
}

describe('F-06 rasterizeSvg makes no network requests', () => {
  let chromium: string | undefined;
  let server: http.Server;
  let base = '';
  let requests: string[] = [];
  let connections = 0;

  beforeAll(async () => {
    chromium = await findChromium();
    if (!chromium) {
      // eslint-disable-next-line no-console
      console.warn('[F-06] no system chromium on this machine — rasterizeSvg network tests skipped (set CHROMIUM_PATH to run them)');
    }
    server = http.createServer((req, res) => {
      requests.push(req.url ?? '');
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/after-redirect.png' }).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'image/svg+xml' }).end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    });
    server.on('connection', () => {
      connections += 1;
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => {
    requests = [];
    connections = 0;
    delete process.env.EXPORT_ALLOW_REMOTE_ASSETS;
  });

  afterAll(async () => {
    await closeBrowser();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('control: a Chromium page that is not locked down does reach the test server (so the zeros below mean something)', async (ctx) => {
    if (!chromium) return ctx.skip();
    const { launch } = await import('puppeteer-core');
    const browser = await launch({ executablePath: chromium, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
    try {
      const page = await browser.newPage();
      await page.setContent(`<!doctype html><img src="${base}/control.png">`, { waitUntil: 'load' });
    } finally {
      await browser.close().catch(() => {});
    }
    expect(requests).toContain('/control.png');
    expect(connections).toBeGreaterThan(0);
  }, 60_000);

  it('sends nothing to the network for any way an SVG (or markup around it) can ask for a URL', async (ctx) => {
    if (!chromium) return ctx.skip();
    const leaks: Record<string, string[]> = {};
    for (const [name, svg] of Object.entries(vectors(base))) {
      const png = await rasterizeSvg(svg, 200);
      // The picture itself may or may not come out; what must hold is that the server saw nothing.
      await new Promise((resolve) => setTimeout(resolve, 100));
      // A bare TCP connection counts too: preconnect opens one without sending a request.
      if (requests.length > 0 || connections > 0) leaks[name] = [...requests, `${connections} connection(s)`];
      requests = [];
      connections = 0;
      if (png) expect(png.subarray(1, 4).toString('latin1'), name).toBe('PNG');
    }
    expect(leaks).toEqual({});
  }, 240_000);

  it('ignores EXPORT_ALLOW_REMOTE_ASSETS: that setting is for print documents, never for author-supplied SVG', async (ctx) => {
    if (!chromium) return ctx.skip();
    process.env.EXPORT_ALLOW_REMOTE_ASSETS = '1';
    await rasterizeSvg(`<svg ${NS} ${BOX}><image href="${base}/allowed.png" ${BOX}/></svg>`, 200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(requests).toEqual([]);
    expect(connections).toBe(0);
  }, 60_000);

  it('still renders an SVG with an embedded data: image, at the expected size and colour', async (ctx) => {
    if (!chromium) return ctx.skip();
    const redDot = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
    const png = await rasterizeSvg(`<svg ${NS} ${BOX}><rect ${BOX} fill="#fff"/><image href="${redDot}" ${BOX} preserveAspectRatio="none"/></svg>`, 200);
    expect(png).not.toBeNull();
    // IHDR width/height: 80x40 CSS px at the 2x device scale factor.
    expect([png!.readUInt32BE(16), png!.readUInt32BE(20)]).toEqual([160, 80]);
    // The first pixel of the first row is the same whatever filter type the encoder picked (nothing precedes it).
    const idat: Buffer[] = [];
    for (let at = 8; at < png!.length; ) {
      const length = png!.readUInt32BE(at);
      if (png!.toString('latin1', at + 4, at + 8) === 'IDAT') idat.push(png!.subarray(at + 8, at + 8 + length));
      at += 12 + length;
    }
    const pixel = inflateSync(Buffer.concat(idat)).subarray(1, 4);
    expect([...pixel]).toEqual([255, 0, 0]);
    expect(requests).toEqual([]);
    expect(connections).toBe(0);
  }, 60_000);
});
