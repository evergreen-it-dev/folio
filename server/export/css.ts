/**
 * Round 23 (EXPORT) — the space's own print stylesheet and running
 * headers/footers, read from its git repo.
 *
 * DEV-PLAN, verbatim and non-negotiable: "Export CSS — `<slug>.export.css`
 * in the root of the space's repository, applied ONLY to the PDF/print
 * render. Security: strip @import and url() to external hosts (SSRF from a
 * headless browser), limit the file size."
 *
 * WHY THIS IS A SECURITY BOUNDARY, not styling hygiene: the file is authored
 * by whoever can write to the space's repo, and it is then handed to a
 * headless browser running INSIDE our network. `@import url(http://169.254.169.254/…)`
 * or `background: url(http://10.0.0.5/admin)` is a server-side request
 * forgery primitive with a side channel (whether the style applied), and
 * `url(file:///etc/passwd)` is a read primitive. So:
 *
 *   1. comments are stripped FIRST (they are the classic place to hide a
 *      second payload from a naive regex);
 *   2. every `@import` at-rule is removed outright — there is no such thing
 *      as a safe one here, since even a same-origin import would be a fetch;
 *   3. every `url()` whose target carries a SCHEME (`http:`, `https:`,
 *      `file:`, `ftp:`, anything) or is protocol-relative (`//host/…`) is
 *      replaced with `none`. `data:` URIs survive — they are inline bytes,
 *      not a request — and so do scheme-less relative paths, which cannot
 *      name a foreign host and which the renderer blocks at the network
 *      layer anyway (see print.ts's request interception);
 *   4. `</…` sequences are removed so the file cannot terminate the `<style>`
 *      element it is injected into and become HTML;
 *   5. the file is capped at MAX_EXPORT_CSS_BYTES.
 *
 * Defence in depth, deliberate: even with all of the above, the print page
 * itself blocks every non-`data:` request at the CDP level. Either layer
 * alone would do; both together mean a regex miss is not a breach.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import * as storage from '../storage.js';

/** 256 KB. A print stylesheet an order of magnitude bigger than this is not a stylesheet. */
export const MAX_EXPORT_CSS_BYTES = 256 * 1024;

const IMPORT_RE = /@import\b[^;{]*(;|(?=\{))/gi;
const COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const URL_RE = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;

/** True for a `url()` target that could reach off-box: any scheme except `data:`, or protocol-relative. */
function isExternalUrlTarget(raw: string): boolean {
  const target = raw.trim();
  if (target.startsWith('//')) return true;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(target);
  if (!scheme) return false;
  return scheme[1].toLowerCase() !== 'data';
}

export interface SanitizedCss {
  css: string;
  /** What was taken out, for the report/log — never silently dropped. */
  removed: { imports: number; externalUrls: number; truncatedBytes: number };
}

export function sanitizeExportCss(raw: string): SanitizedCss {
  let truncatedBytes = 0;
  let css = raw;
  if (Buffer.byteLength(css, 'utf8') > MAX_EXPORT_CSS_BYTES) {
    const buf = Buffer.from(css, 'utf8');
    truncatedBytes = buf.length - MAX_EXPORT_CSS_BYTES;
    // Cut on a whole-character boundary, then drop the (now possibly
    // unterminated) trailing rule by cutting back to the last `}`.
    const cut = buf.subarray(0, MAX_EXPORT_CSS_BYTES).toString('utf8');
    const lastBrace = cut.lastIndexOf('}');
    css = lastBrace === -1 ? '' : cut.slice(0, lastBrace + 1);
  }

  css = css.replace(COMMENT_RE, ' ');

  let imports = 0;
  css = css.replace(IMPORT_RE, () => {
    imports++;
    return '';
  });

  let externalUrls = 0;
  css = css.replace(URL_RE, (whole, _q: string, target: string) => {
    if (!isExternalUrlTarget(target)) return whole;
    externalUrls++;
    return 'none';
  });

  // Cannot be allowed to close the <style> element it is injected into.
  css = css.replace(/<\s*\//g, '');

  return { css, removed: { imports, externalUrls, truncatedBytes } };
}

// ---------------------------------------------------------------------------
// header/footer templates
// ---------------------------------------------------------------------------

/**
 * Final stored size of ONE header/footer template, AFTER save-time image
 * inlining (`server/export/headerFooterImages.ts`) has turned every external
 * `<img src="http(s)://…">` into a `data:` URI. Sized around that module's
 * own `MAX_HEADER_FOOTER_IMAGE_BYTES` (300 KB): base64 inflates a downloaded
 * image by ~4/3 (≈400 KB), so 1 MiB comfortably fits a couple of embedded
 * images (say, two logos) plus markup, while still refusing anything that
 * would make the two Chrome header/footer template strings unreasonably
 * large. This is BOTH the render-time cap below (a hand-edited `.folio` file
 * in the repo is not bound by the PUT's own validation) and the write-time
 * cap `spaceSettings.ts` enforces right after inlining — one constant, two
 * enforcement points, so they cannot silently drift apart.
 */
export const MAX_HEADER_FOOTER_STORED_BYTES = 1024 * 1024;

/**
 * Chromium's own header/footer document is a separate mini-page; anything
 * scripted or externally sourced in it is both useless (it renders before
 * anything could run) and a liability. Allowlist by removal: no elements
 * that fetch or execute, no inline event handlers, no non-`data:` `src`.
 */
export function sanitizeHeaderFooterHtml(raw: string): string {
  return raw
    .replace(/<\s*(script|iframe|object|embed|link|meta|base)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|iframe|object|embed|link|meta|base)\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi, (whole, attr: string, dq?: string, sq?: string, bare?: string) => {
      const value = (dq ?? sq ?? bare ?? '').trim();
      return /^data:/i.test(value) ? whole : '';
    })
    .slice(0, MAX_HEADER_FOOTER_STORED_BYTES);
}

export interface HeaderFooterContext {
  title: string;
  space: string;
  date: string;
}

/**
 * `{{page}}/{{pages}}/{{title}}/{{space}}/{{date}}`. The first two become
 * chromium's own `pageNumber`/`totalPages` spans — the whole reason this
 * round chose CDP printing over CSS Paged Media, which Chrome does not
 * implement running headers for.
 */
export function renderHeaderFooterTemplate(template: string, ctx: HeaderFooterContext): string {
  return sanitizeHeaderFooterHtml(template)
    .replace(/\{\{\s*page\s*\}\}/g, '<span class="pageNumber"></span>')
    .replace(/\{\{\s*pages\s*\}\}/g, '<span class="totalPages"></span>')
    .replace(/\{\{\s*title\s*\}\}/g, escapeHtml(ctx.title))
    .replace(/\{\{\s*space\s*\}\}/g, escapeHtml(ctx.space))
    .replace(/\{\{\s*date\s*\}\}/g, escapeHtml(ctx.date));
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// reading them off disk
// ---------------------------------------------------------------------------

export interface SpaceExportAssets {
  css: string;
  headerHtml?: string;
  footerHtml?: string;
  removed: SanitizedCss['removed'];
}

async function readIfPresent(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * `<slug>.export.css` at the space's REPO ROOT (where `<slug>.folio` lives —
 * see storage.ts's note on why repo root rather than content root), with the
 * content root checked as a fallback because that is where an author editing
 * through Folio actually sees their files. Header/footer templates come from
 * the `export` section of `<slug>.folio`, matching
 * `spaceExportSettingsSchema` in shared/contracts.ts.
 */
export async function readSpaceExportAssets(space: string): Promise<SpaceExportAssets> {
  const repoDir = storage.getRepoDir(space);
  const contentDir = storage.getSpaceDir(space);

  const rawCss =
    (await readIfPresent(path.join(repoDir, `${space}.export.css`))) ??
    (await readIfPresent(path.join(contentDir, `${space}.export.css`))) ??
    (await readIfPresent(path.join(repoDir, 'export.css'))) ??
    '';
  const { css, removed } = sanitizeExportCss(rawCss);

  let headerHtml: string | undefined;
  let footerHtml: string | undefined;
  const meta = await readIfPresent(path.join(repoDir, `${space}.folio`));
  if (meta) {
    try {
      const parsed = JSON.parse(meta) as { export?: { headerHtml?: unknown; footerHtml?: unknown } };
      if (typeof parsed.export?.headerHtml === 'string') headerHtml = parsed.export.headerHtml;
      if (typeof parsed.export?.footerHtml === 'string') footerHtml = parsed.export.footerHtml;
    } catch {
      // corrupt/foreign file — treated exactly as absent, same as storage.ts's readFolioMeta
    }
  }

  return { css, headerHtml, footerHtml, removed };
}
