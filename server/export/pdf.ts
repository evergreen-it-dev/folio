/**
 * Round 23 (EXPORT), Stage 2 — PDF via a SYSTEM chromium driven by
 * puppeteer-core.
 *
 * WHY CHROMIUM AND NOT PANDOC (orchestrator's decision, DEV-PLAN R23): the
 * owner asked for running headers/footers on every page, and Chrome does not
 * implement CSS Paged Media running headers — but CDP printing does exactly
 * that through `displayHeaderFooter` + `headerTemplate`/`footerTemplate`.
 * A browser is also the only renderer that produces the same picture as
 * Reading mode: our own styles, already-rendered mermaid, excalidraw SVG,
 * webfonts.
 *
 * Operational shape the round asks for: ONE browser per process (pages per
 * request), a hard concurrency limit, and timeouts everywhere — a headless
 * browser is the single most expensive thing this server can be asked to do,
 * and an unbounded queue of them is how a wiki turns into an OOM.
 *
 * The executable is NEVER downloaded (puppeteer-core, not puppeteer): it is
 * `CHROMIUM_PATH` if set, otherwise the first of the usual system locations
 * that exists. When there is none, `isChromiumAvailable()` is false and the
 * route says so plainly instead of hanging.
 */
import fs from 'node:fs/promises';
import type { Browser } from 'puppeteer-core';
import { HttpError } from '../errors.js';
import type { PageIndexEntry } from '../storage.js';
import { buildPrintDocument } from './print.js';

const LINUX_CANDIDATES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/snap/bin/chromium',
];
const MAC_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** `CHROMIUM_PATH` wins; otherwise the first system location that exists. undefined when this box has no chromium. */
export async function findChromium(): Promise<string | undefined> {
  const fromEnv = process.env.CHROMIUM_PATH?.trim();
  if (fromEnv) return (await exists(fromEnv)) ? fromEnv : undefined;
  for (const candidate of [...LINUX_CANDIDATES, ...MAC_CANDIDATES]) {
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

export async function isChromiumAvailable(): Promise<boolean> {
  return (await findChromium()) !== undefined;
}

// ---------------------------------------------------------------------------
// one browser per process
// ---------------------------------------------------------------------------

let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (browserPromise) {
    const existing = await browserPromise.catch(() => null);
    if (existing && existing.connected) return existing;
    browserPromise = null;
  }
  browserPromise = (async () => {
    const executablePath = await findChromium();
    if (!executablePath) throw new HttpError(503, 'PDF export is unavailable: no chromium executable found (set CHROMIUM_PATH)');
    const { launch } = await import('puppeteer-core');
    const browser = await launch({
      executablePath,
      headless: true,
      // --no-sandbox is required in the container (no user namespaces); the
      // pages we open are our OWN generated HTML with JS disabled and no
      // network, so the sandbox is not the boundary that matters here.
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none'],
    });
    browser.once('disconnected', () => {
      browserPromise = null;
    });
    return browser;
  })();
  return browserPromise;
}

/** Closes the cached browser — called from tests; a server shutdown simply exits the process. */
export async function closeBrowser(): Promise<void> {
  const current = browserPromise;
  browserPromise = null;
  if (!current) return;
  await current.then((b) => b.close()).catch(() => {});
}

// ---------------------------------------------------------------------------
// concurrency limit
// ---------------------------------------------------------------------------

const MAX_CONCURRENT = Number(process.env.EXPORT_PDF_CONCURRENCY ?? 2);
const QUEUE_LIMIT = Number(process.env.EXPORT_PDF_QUEUE_LIMIT ?? 20);
let active = 0;
const waiting: (() => void)[] = [];

async function acquire(): Promise<() => void> {
  if (active >= MAX_CONCURRENT) {
    if (waiting.length >= QUEUE_LIMIT) throw new HttpError(503, 'export queue is full, try again shortly');
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  active++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active--;
    waiting.shift()?.();
  };
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

const RENDER_TIMEOUT_MS = Number(process.env.EXPORT_PDF_TIMEOUT_MS ?? 60_000);
const ALLOW_REMOTE_ASSETS = process.env.EXPORT_ALLOW_REMOTE_ASSETS === '1';

export interface RenderPdfOptions {
  markdown: string;
  entry: PageIndexEntry;
  baseUrl: string;
  landscape?: boolean;
}

export async function renderPdf(opts: RenderPdfOptions): Promise<Buffer> {
  const doc = await buildPrintDocument(opts);
  const release = await acquire();
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
      // Nothing on this page needs to run, and a print document that CAN run
      // code is a print document that can be made to do something else.
      await page.setJavaScriptEnabled(false);

      if (!ALLOW_REMOTE_ASSETS) {
        // Second line of defence behind css.ts's sanitizer: even a url() the
        // regex somehow missed cannot become an outbound request.
        await page.setRequestInterception(true);
        page.on('request', (req) => {
          const url = req.url();
          void (url.startsWith('data:') || url === 'about:blank' ? req.continue() : req.abort());
        });
      }

      await page.setContent(doc.html, { waitUntil: 'load', timeout: RENDER_TIMEOUT_MS });
      const pdf = await page.pdf({
        format: 'A4',
        landscape: opts.landscape ?? false,
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: doc.headerTemplate,
        footerTemplate: doc.footerTemplate,
        margin: { top: '20mm', bottom: '18mm', left: '16mm', right: '16mm' },
        timeout: RENDER_TIMEOUT_MS,
      });
      return Buffer.from(pdf);
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    release();
  }
}

/**
 * Rasterizes one board SVG to PNG with the same browser — DOCX cannot be
 * trusted with SVG (R23 addendum 3), so Stage 3 embeds a bitmap instead.
 * `width` is the CSS pixel width the SVG is laid out at before capture; the
 * deviceScaleFactor doubles the actual pixels so labels stay readable.
 */
export async function rasterizeSvg(svg: string, width = 1000): Promise<Buffer | null> {
  if (!(await isChromiumAvailable())) return null;
  const release = await acquire();
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
      await page.setJavaScriptEnabled(false);
      await page.setViewport({ width, height: 600, deviceScaleFactor: 2 });
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff}#w{display:inline-block}#w svg{max-width:${width}px;height:auto;display:block}</style></head><body><div id="w">${svg}</div></body></html>`;
      await page.setContent(html, { waitUntil: 'load', timeout: RENDER_TIMEOUT_MS });
      const el = await page.$('#w');
      if (!el) return null;
      const shot = await el.screenshot({ type: 'png' });
      return Buffer.from(shot);
    } finally {
      await page.close().catch(() => {});
    }
  } catch {
    return null; // a board that will not rasterize must not fail the whole DOCX
  } finally {
    release();
  }
}
