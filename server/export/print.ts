/**
 * Round 23 (EXPORT), Stage 2 — the print document chromium is asked to
 * print, plus the short-lived ticket that lets it be fetched over HTTP.
 *
 * DESIGN DECISION, resolving the spec's own "or": DEV-PLAN offers "access by
 * a short-lived token OR by an internal request" for the print route. The
 * PDF path takes the INTERNAL option — `buildPrintHtml` produces a fully
 * self-contained document (every local image and every board SVG inlined
 * from disk) which pdf.ts feeds to the browser via `page.setContent`. That
 * choice buys three things at once:
 *   - no auth problem: the browser never has to prove it may read the page;
 *   - no SSRF surface: the print page makes NO network requests at all, so
 *     the export stylesheet's sanitizer (css.ts) is a second line of defence
 *     rather than the only one;
 *   - deterministic output: nothing can half-load.
 * The ticket-based HTTP route still exists (routes.ts) so the exact document
 * can be inspected and so a preview UI has something to point at.
 *
 * The one cost of the self-contained approach is that images hosted on
 * OTHER hosts do not render. `EXPORT_ALLOW_REMOTE_ASSETS=1` lifts the block
 * for deployments that want it; it is off by default deliberately, because
 * "our headless browser will fetch any URL a page author writes" is exactly
 * the primitive the CSS rules above exist to deny.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import rehypeRaw from 'rehype-raw';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import * as storage from '../storage.js';
import type { PageIndexEntry } from '../storage.js';
import { rehypeHighlight } from '../../shared/highlight.js';
import { remarkUnderline } from '../../shared/underline.js';
import { STATUS_COLORS, STATUS_PALETTE, remarkStatusInText } from '../../shared/status.js';
import { escapeHtml, readSpaceExportAssets, renderHeaderFooterTemplate } from './css.js';

// ---------------------------------------------------------------------------
// markdown -> HTML
// ---------------------------------------------------------------------------

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  // `++underline++` -> <ins> (shared/underline.ts).
  .use(remarkUnderline)
  // shared/status.ts: `:status[Text]{color=…}` -> a coloured `<span class="folio-status …">`
  // (this pipeline has no remark-directive, so the tag is still plain text here).
  .use(remarkStatusInText)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  // shared/highlight.ts: `==text==`/`==text=={.token}` -> `<mark
  // class="folio-hl folio-hl-<token>">`; after rehype-raw (so legacy
  // `<mark>` HTML is already a real element and is left untouched — see
  // rehypeHighlight's own doc comment) and before stringify.
  .use(rehypeHighlight)
  .use(rehypeStringify, { allowDangerousHtml: true });

export async function markdownToHtml(markdown: string): Promise<string> {
  const file = await processor.process(markdown);
  return String(file);
}

/**
 * Raw HTML in a page body is authored by people who can already write to the
 * space's git repo, so this is not a trust boundary in the way css.ts is —
 * but a headless browser is still a browser, so nothing executable survives.
 * pdf.ts additionally disables JavaScript on the page outright.
 */
function stripExecutable(html: string): string {
  return html
    .replace(/<\s*script\b[\s\S]*?<\s*\/\s*script\s*>/gi, '')
    .replace(/<\s*script\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}

// ---------------------------------------------------------------------------
// asset inlining
// ---------------------------------------------------------------------------

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
};

/** Keeps a crafted `../../..` path in a page's markdown from reading outside the space. */
function insideSpace(spaceDir: string, candidate: string): boolean {
  const rel = path.relative(spaceDir, candidate);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

const IMG_RE = /<img\b([^>]*?)\ssrc="([^"]*)"([^>]*)>/gi;

/**
 * Replaces every `<img>` pointing into this space's own files with inline
 * bytes. A board's `.excalidraw.svg` is inlined as REAL SVG markup, not as a
 * data URI — R23 addendum 3: "the board's SVG is put into the flow as it is
 * (chromium renders SVG natively) ... it is not split between pages".
 */
export async function inlineLocalAssets(html: string, space: string, baseUrl: string): Promise<string> {
  const spaceDir = storage.getSpaceDir(space);
  const prefixes = [`${baseUrl}/files/${space}/`, `/files/${space}/`];

  const matches = [...html.matchAll(IMG_RE)];
  const replacements = new Map<string, string>();

  for (const m of matches) {
    const [whole, before, src, after] = m;
    if (replacements.has(whole)) continue;

    const prefix = prefixes.find((p) => src.startsWith(p));
    if (!prefix) continue;

    const withoutPrefix = src.slice(prefix.length).split('#')[0].split('?')[0];
    let relPath: string;
    try {
      relPath = decodeURIComponent(withoutPrefix);
    } catch {
      continue;
    }

    const abs = path.resolve(spaceDir, relPath);
    if (!insideSpace(spaceDir, abs)) continue;

    const ext = path.extname(abs).toLowerCase();
    try {
      if (relPath.endsWith('.excalidraw.svg')) {
        const svg = await fs.readFile(abs, 'utf8');
        const altMatch = /\salt="([^"]*)"/i.exec(`${before} ${after}`);
        const caption = altMatch ? altMatch[1] : '';
        // Drop the leading `<!-- folio-id: … -->` / `<!-- folio-order: … -->`
        // bookkeeping comments; keep the rest verbatim.
        const inlineSvg = svg.replace(/^(?:\s*<!--\s*folio-[a-z-]+:[^>]*-->)+\s*/i, '').trim();
        replacements.set(
          whole,
          `<figure class="folio-board">${inlineSvg}${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ''}</figure>`,
        );
        continue;
      }
      const mime = MIME_BY_EXT[ext];
      if (!mime) continue;
      const data = await fs.readFile(abs);
      replacements.set(whole, `<img${before} src="data:${mime};base64,${data.toString('base64')}"${after}>`);
    } catch {
      // Missing/unreadable file: leave the original tag. A broken image is a
      // far better outcome than a failed export.
    }
  }

  let out = html;
  for (const [from, to] of replacements) out = out.split(from).join(to);
  return out;
}

// ---------------------------------------------------------------------------
// the print document
// ---------------------------------------------------------------------------

/**
 * Base print stylesheet. Two spec-mandated bits live here:
 *
 *  - `thead { display: table-header-group }` — R23 addendum 4: a data table's
 *    header row must repeat on every printed page.
 *  - WIDE TABLE STRATEGY, chosen and recorded as the spec asks: shrink and
 *    wrap, never clip. `table-layout: fixed` + `word-break: break-word` makes
 *    every column share the measure, and `.folio-wide` (set when a table has
 *    many columns) drops the font a further step. Rotating the page to
 *    landscape automatically was rejected — it would make one wide table
 *    silently reorient a whole document — so landscape is an explicit
 *    `?landscape=1` on the export request instead.
 */
const BASE_PRINT_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif;
  font-size: 11pt; line-height: 1.55; color: #1a1a1a; background: #fff; margin: 0;
}
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.2em 0 0.5em; break-after: avoid; page-break-after: avoid; }
h1 { font-size: 20pt; } h2 { font-size: 16pt; } h3 { font-size: 13pt; } h4 { font-size: 11.5pt; }
p, ul, ol, blockquote { margin: 0 0 0.75em; }
li { margin: 0.15em 0; }
a { color: #0b5fff; text-decoration: none; word-break: break-word; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em; background: #f4f4f5; padding: 0.1em 0.3em; border-radius: 3px; }
mark { background-color: #fff3bf; color: inherit; padding: 0 0.15em; border-radius: 2px; }
mark.folio-hl-yellow { background-color: #fff3bf; }
mark.folio-hl-green { background-color: #d3f9d8; }
mark.folio-hl-teal { background-color: #c5f6fa; }
mark.folio-hl-blue { background-color: #d0ebff; }
mark.folio-hl-purple { background-color: #e5dbff; }
mark.folio-hl-red { background-color: #ffdeeb; }
mark.folio-hl-orange { background-color: #ffe8cc; }
mark.folio-hl-gray { background-color: #e9ecef; }
.folio-status { display: inline-block; padding: 0 0.4em; border-radius: 3px; font-size: 0.75em; font-weight: 700; line-height: 1.5; text-transform: uppercase; white-space: nowrap; }
${STATUS_COLORS.map((c) => `.folio-status--${c} { background-color: ${STATUS_PALETTE[c].bg}; color: ${STATUS_PALETTE[c].fg}; }`).join('\n')}
pre { background: #f4f4f5; padding: 0.7em 0.9em; border-radius: 5px; overflow: hidden; white-space: pre-wrap; word-break: break-word; break-inside: avoid; }
pre code { background: none; padding: 0; }
blockquote { border-left: 3px solid #d4d4d8; padding-left: 0.9em; color: #52525b; }
hr { border: 0; border-top: 1px solid #e4e4e7; margin: 1.6em 0; break-after: page; page-break-after: always; }
img { max-width: 100%; height: auto; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 9pt; margin: 0 0 1em; }
th, td { border: 1px solid #d4d4d8; padding: 4px 6px; text-align: left; vertical-align: top; word-break: break-word; overflow-wrap: anywhere; }
th { background: #f4f4f5; font-weight: 600; }
thead { display: table-header-group; }
tfoot { display: table-footer-group; }
tr { break-inside: avoid; page-break-inside: avoid; }
table.folio-wide { font-size: 7.5pt; }
table.folio-wide th, table.folio-wide td { padding: 2px 4px; }
figure.folio-board { margin: 1em 0; text-align: center; break-inside: avoid; page-break-inside: avoid; }
figure.folio-board svg { max-width: 100%; height: auto; }
figure.folio-board figcaption { font-size: 9pt; color: #52525b; margin-top: 0.4em; }
@page { size: A4; margin: 18mm 16mm; }
`;

/** Tags a table as "wide" so the stylesheet above can shrink it. Threshold picked at the point A4 stops fitting comfortably. */
const WIDE_TABLE_COLUMNS = 6;
function markWideTables(html: string): string {
  return html.replace(/<table>([\s\S]*?)<\/table>/gi, (whole, inner: string) => {
    const firstRow = /<tr>([\s\S]*?)<\/tr>/i.exec(inner);
    const columns = firstRow ? (firstRow[1].match(/<t[hd]\b/gi) ?? []).length : 0;
    return columns >= WIDE_TABLE_COLUMNS ? whole.replace('<table>', '<table class="folio-wide">') : whole;
  });
}

export interface PrintDocumentOptions {
  markdown: string;
  entry: PageIndexEntry;
  baseUrl: string;
}

export interface PrintDocument {
  html: string;
  headerTemplate: string;
  footerTemplate: string;
}

const HEADER_FOOTER_WRAPPER =
  'font-size:8pt;width:100%;padding:0 16mm;color:#71717a;-webkit-print-color-adjust:exact;display:flex;justify-content:space-between;align-items:center;';

/** A document with no configured header/footer still gets page numbers — the whole point of choosing CDP printing. */
const DEFAULT_FOOTER = '<span></span><span>{{page}} / {{pages}}</span>';

export async function buildPrintDocument(opts: PrintDocumentOptions): Promise<PrintDocument> {
  const { css, headerHtml, footerHtml } = await readSpaceExportAssets(opts.entry.space);
  const spaceInfo = await storage.getSpaceInfo(opts.entry.space);
  const ctx = {
    title: opts.entry.title,
    space: spaceInfo?.name ?? opts.entry.space,
    date: new Date().toISOString().slice(0, 10),
  };

  const rendered = markWideTables(stripExecutable(await markdownToHtml(opts.markdown)));
  const body = await inlineLocalAssets(rendered, opts.entry.space, opts.baseUrl);

  const html = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    `<title>${escapeHtml(opts.entry.title)}</title>`,
    `<style>${BASE_PRINT_CSS}</style>`,
    css ? `<style>${css}</style>` : '',
    '</head><body class="folio-export">',
    body,
    '</body></html>',
  ].join('');

  const wrap = (inner: string): string => `<div style="${HEADER_FOOTER_WRAPPER}">${inner}</div>`;

  return {
    html,
    headerTemplate: wrap(headerHtml ? renderHeaderFooterTemplate(headerHtml, ctx) : ''),
    footerTemplate: wrap(renderHeaderFooterTemplate(footerHtml ?? DEFAULT_FOOTER, ctx)),
  };
}

export async function buildPrintHtml(opts: PrintDocumentOptions): Promise<string> {
  return (await buildPrintDocument(opts)).html;
}

// ---------------------------------------------------------------------------
// short-lived print tickets
// ---------------------------------------------------------------------------

export const PRINT_TICKET_TTL_MS = 60_000;
const tickets = new Map<string, { html: string; expires: number }>();

/** Lazy sweep — no interval timer, so this can never hold the process open at shutdown. */
function sweep(now: number): void {
  for (const [id, t] of tickets) if (t.expires <= now) tickets.delete(id);
}

/** Mints a one-shot, 60-second ticket for an already-authorized print document. */
export function issuePrintTicket(html: string): string {
  const now = Date.now();
  sweep(now);
  const id = randomBytes(24).toString('hex');
  tickets.set(id, { html, expires: now + PRINT_TICKET_TTL_MS });
  return id;
}

/** Single use: a ticket is consumed by the first fetch and is dead afterwards. */
export function consumePrintTicket(id: string): string | undefined {
  const now = Date.now();
  sweep(now);
  const t = tickets.get(id);
  if (!t) return undefined;
  tickets.delete(id);
  return t.html;
}

export function __clearPrintTicketsForTests(): void {
  tickets.clear();
}
