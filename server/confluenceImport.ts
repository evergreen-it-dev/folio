/**
 * Round 12: Confluence import. Ports the orchestrator's own proven, hands-run
 * migration scripts (a Python REST-walk exporter + a Node turndown-based
 * converter, both written and refined this session against a real on-prem
 * Confluence instance) into one server-side async job:
 *  - REST-walk the page tree (child/page, paginated) instead of a headless
 *    browser — export_view HTML is already server-rendered.
 *  - export_view HTML -> GFM markdown via turndown + turndown-plugin-gfm,
 *    with the same custom rules the hands-run script needed: Confluence
 *    panels -> GFM alerts, syntaxhighlighter <pre> -> fenced code, inline
 *    task lists -> GFM checkboxes, emoji <img> -> alt text, a table
 *    preprocessor that collapses block tags inside td/th (GFM tables don't
 *    survive nested <p>/<br>/<li>), internal links rewritten relative to the
 *    OTHER imported pages, and images downloaded through the asset store
 *    (/a/<sha>) instead of committed as loose files.
 *  - translit-slug filenames reuse THIS project's own translit.ts (not a
 *    parallel reimplementation) — same contract as round 2's page/space slugs.
 *  - tree -> folders: a page with imported children becomes dir/index.md,
 *    a leaf becomes dir/page.md; frontmatter `order` matches sibling position
 *    (same (index+1)*10 spacing convention new pages already use elsewhere).
 *
 * Runs as a fire-and-forget async job tracked in an in-memory registry (per
 * DEV-PLAN: "in-memory registry is fine, keyed by id, per-user") — polled via
 * GET /api/import/jobs/:id. A real network run isn't unit-testable here (no
 * Confluence credentials in this environment); the pure conversion/tree/
 * translit pieces below are, and have their own tests in
 * server/confluenceImport.test.ts.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { JSDOM, type DomDocument, type DomElement, type DomNode, type DomTableElement } from 'jsdom';
import { ulid } from 'ulidx';
import * as matterNS from 'gray-matter';
import type { ConfluenceSource, ImportJob } from '../shared/contracts.js';
import { translitSlug } from './translit.js';
import * as storage from './storage.js';
import * as assets from './assets.js';
import * as git from './git.js';
import * as authStore from './auth/store.js';
import * as userConfluenceCredentials from './userConfluenceCredentials.js';
import * as whiteboard from './confluenceWhiteboard.js';
import { badRequest, notFound } from './errors.js';
import { serverText } from './serverText.js';

// gray-matter is CJS (`export =`) — same interop pattern as storage.ts.
const matter = (typeof matterNS === 'function' ? matterNS : (matterNS as unknown as { default: typeof matterNS }).default) as typeof matterNS;

// ---------------------------------------------------------------------------
// Confluence REST types (only the fields we actually read)
// ---------------------------------------------------------------------------

interface ConfluenceAuth {
  header: string; // full "Authorization" header value -- never logged, never put on the job
}

function buildAuthHeader(auth: ConfluenceSource['auth']): ConfluenceAuth {
  if (auth.kind === 'pat') return { header: `Bearer ${auth.token}` };
  const email = auth.email ?? '';
  return { header: `Basic ${Buffer.from(`${email}:${auth.token}`).toString('base64')}` };
}

/**
 * A failed Confluence REST/download call that DID get an HTTP response (as
 * opposed to a network-level failure — see ConfluenceNetworkError below).
 * Carries the status so the job's error handler (confluenceJobErrorCode) can
 * tell the client to show a human explanation (owner report 22.09.2026: raw
 * "Confluence API 401 Unauthorized for ..." reaching the UI) while `.message`
 * keeps the full technical detail for the job's `error` field / logs.
 */
export class ConfluenceApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ConfluenceApiError';
  }
}

/** fetch() itself failed (DNS, timeout, connection refused, ...) — no HTTP status at all. */
export class ConfluenceNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfluenceNetworkError';
  }
}

/** GET base+restPath with the given auth, retrying transient failures 3x (same backoff shape as the hands-run exporter). */
async function confluenceGet(base: string, restPath: string, auth: ConfluenceAuth): Promise<unknown> {
  const url = `${base}${restPath}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { Authorization: auth.header, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        // Never include the URL's query string verbatim in a thrown message if it
        // somehow carried anything sensitive -- it doesn't here (REST paths only),
        // but the auth header itself is never part of `url` in the first place.
        throw new ConfluenceApiError(res.status, `Confluence API ${res.status} ${res.statusText} for ${restPath}`);
      }
      return await res.json();
    } catch (err) {
      lastErr = err instanceof ConfluenceApiError ? err : new ConfluenceNetworkError(err instanceof Error ? err.message : String(err));
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function confluenceGetBinary(base: string, restPath: string, auth: ConfluenceAuth): Promise<Buffer> {
  const url = restPath.startsWith('http') ? restPath : `${base}${restPath}`;
  const res = await fetch(url, { headers: { Authorization: auth.header }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new ConfluenceApiError(res.status, `Confluence download ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Maps a failed import job's error to a coarse, human-explainable bucket for
 * ImportJob.errorCode — only for errors that actually came from a Confluence
 * REST/download call. Anything else (bad target space, a conversion bug, ...)
 * returns undefined, so the client keeps rendering `error` as-is for those.
 */
function confluenceJobErrorCode(err: unknown): ImportJob['errorCode'] {
  if (err instanceof ConfluenceApiError) {
    if (err.status === 401) return 'unauthorized';
    if (err.status === 403) return 'forbidden';
    if (err.status === 404) return 'notFound';
    if (err.status === 429) return 'rateLimited';
    if (err.status >= 500) return 'unavailable';
    return undefined;
  }
  if (err instanceof ConfluenceNetworkError) return 'unavailable';
  return undefined;
}

// ---------------------------------------------------------------------------
// URL parsing: pageUrl -> { base, pageId } (or a title/space guess for the
// CQL fallback a "pretty" cloud URL needs).
// ---------------------------------------------------------------------------

export interface ParsedConfluenceUrl {
  base: string; // origin + '/wiki' (on-prem and cloud both use this mount point)
  pageId?: string;
  spaceKey?: string;
  titleGuess?: string;
}

const PAGE_ID_RE = /\/wiki\/(?:spaces\/[^/]+\/pages|pages\/viewpage\.action\?pageId=)\/?(\d+)/;
const SPACE_KEY_RE = /\/wiki\/spaces\/([^/]+)\//;

/**
 * Any Confluence content URL shape that carries a numeric content id — a
 * superset of PAGE_ID_RE (which only knows /pages/<id> and viewpage.action).
 * Real link inventories from a live migration also contain `/pages/edit-v2/`,
 * `/folder/` (Cloud folders — in a Cloud↔Server sync setup the folder's id is
 * the id of its Server page twin), `/whiteboard/` and `/database/` links, all
 * of which the old regex silently left pointing at Confluence.
 */
const CONTENT_URL_RE =
  /\/wiki\/(?:spaces\/[^/\s]+\/(?:pages\/(?:edit-v2\/)?|folder\/|whiteboard\/|database\/)(\d+)|pages\/viewpage\.action\?pageId=(\d+))/;

export interface ConfluenceContentRef {
  id: string;
  kind: 'page' | 'folder' | 'whiteboard' | 'database';
}

function safeDecodeUriComponent(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text; // a stray % that isn't an escape — the raw text is still a usable filename
  }
}

/**
 * The ATTACHMENT filename a Confluence URL points at, or null when it points
 * at something else. Two real shapes:
 *
 *  - `…/pages/1000000001/Title?preview=%2F1000000001%2F1000000002%2Ffile.pdf`
 *    — what the `view-file` macro renders to. Its path is the HOST PAGE's,
 *    so extractConfluenceContentId matched the page and resolveLink rewrote
 *    the link to that page's own index.md: every attached document on 42 reference
 *    pages became a link back to the page you were already reading. This is
 *    checked BEFORE any page-id match for exactly that reason.
 *  - `…/download/attachments/<id>/file.png` and its `thumbnails` twin — the
 *    ordinary inline-image and "download this file" href.
 */
/**
 * What to do with a Confluence link this import can't turn into an in-app one
 * — returns a replacement href, or undefined to leave it exactly as it is.
 * Two real problems from the link inventory of the reference space, both of which produce a link
 * that is WORSE than an honest external one:
 *
 *  - a ROOT-RELATIVE `/wiki/spaces/DOCS/pages/…` href (58 of them on one page's
 *    `children` macro alone). Left as-is, the browser resolves it against
 *    FOLIO's own host, so the reader gets a Folio 404 for a page that exists
 *    perfectly well in Confluence. Absolutized against the source instance.
 *  - `…/pages/edit-v2/<id>` (18 across the fixtures) — Confluence's EDITOR
 *    URL. Following one drops the reader into an edit session of someone
 *    else's wiki page. Rewritten to the same page's view URL.
 */
export function normalizeUnresolvedConfluenceHref(href: string, base: string): string | undefined {
  const trimmed = href.trim();
  if (!trimmed) return undefined;

  let absolute: string;
  if (/^https?:\/\//i.test(trimmed)) {
    absolute = trimmed;
  } else if (trimmed.startsWith('/')) {
    try {
      absolute = new URL(trimmed, base).toString();
    } catch {
      return undefined;
    }
  } else {
    return undefined; // in-page anchor, mailto:, or a genuinely relative link — not ours to touch
  }

  // `/pages/edit-v2/<id>` -> `/pages/<id>`: the canonical view URL on Cloud,
  // and a valid one on Server/DC too. Anything after the id is edit-session
  // state with no meaning in view mode.
  const edit = /^(.*\/pages)\/edit-v2\/(\d+)/i.exec(absolute);
  if (edit) return `${edit[1]}/${edit[2]}`;

  return absolute === trimmed ? undefined : absolute;
}

export function extractConfluenceAttachmentName(url: string): string | null {
  const preview = /[?&]preview=([^&#]+)/.exec(url);
  if (preview) {
    // A query-string value: "+" is a space here, unlike in a path.
    const name = safeDecodeUriComponent(preview[1].replace(/\+/g, ' ')).split('/').filter(Boolean).pop();
    if (name) return name;
  }
  const download = /\/download\/(?:attachments|thumbnails)\/[^?#]*?\/([^/?#]+)(?:[?#]|$)/.exec(url);
  if (download) return safeDecodeUriComponent(download[1]);
  return null;
}

/** Extracts the content id (and coarse kind) from any known Confluence URL shape, or null. */
export function extractConfluenceContentId(url: string): ConfluenceContentRef | null {
  const m = CONTENT_URL_RE.exec(url);
  if (!m) return null;
  const id = m[1] ?? m[2];
  const kind: ConfluenceContentRef['kind'] = url.includes('/folder/')
    ? 'folder'
    : url.includes('/whiteboard/')
      ? 'whiteboard'
      : url.includes('/database/')
        ? 'database'
        : 'page';
  return { id, kind };
}

// ---------------------------------------------------------------------------
// Persistent per-space map of Confluence content id -> imported rel path.
// Written by every import job, read by every later one: it is what lets a
// SECOND job (a whiteboard import, or another page subtree) resolve links to
// content a PREVIOUS job already imported — round 12's in-memory relPaths only
// ever covered one job's own pages. Lives as a dotfile at the space content
// root: scanSpace only indexes *.md/*.excalidraw.svg/*.table.md, so it never
// becomes a page, and it rides the space's own git history like everything
// else.
// ---------------------------------------------------------------------------

const CONFLUENCE_MAP_FILE = '.confluence-map.json';

export async function readConfluenceMap(spaceSlug: string): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(path.join(storage.getSpaceDir(spaceSlug), CONFLUENCE_MAP_FILE), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
    }
  } catch {
    /* no map yet, or unreadable — same as empty */
  }
  return {};
}

export async function mergeConfluenceMap(spaceSlug: string, entries: Record<string, string>): Promise<void> {
  if (Object.keys(entries).length === 0) return;
  const current = await readConfluenceMap(spaceSlug);
  const merged = { ...current, ...entries };
  const sorted = Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)));
  await fs.writeFile(path.join(storage.getSpaceDir(spaceSlug), CONFLUENCE_MAP_FILE), JSON.stringify(sorted, null, 1) + '\n', 'utf8');
}

export function parseConfluenceUrl(pageUrl: string): ParsedConfluenceUrl {
  // Look for "/wiki" in the PATH only: a host that itself starts with "wiki"
  // (wiki.example.org) would otherwise match at the scheme's "//" and yield a
  // base of "https://wiki".
  const schemeIdx = pageUrl.indexOf('://');
  const pathStart = schemeIdx === -1 ? 0 : pageUrl.indexOf('/', schemeIdx + 3);
  const wikiIdx = pathStart === -1 ? -1 : pageUrl.indexOf('/wiki', pathStart);
  if (wikiIdx === -1) throw badRequest('this does not look like a Confluence URL (no "/wiki" path segment found)');
  const base = pageUrl.slice(0, wikiIdx) + '/wiki';

  const idMatch = pageUrl.match(PAGE_ID_RE);
  const spaceMatch = pageUrl.match(SPACE_KEY_RE);
  if (idMatch) return { base, pageId: idMatch[1], spaceKey: spaceMatch?.[1] };

  // "Pretty" URL with no numeric id (common on Cloud): .../wiki/spaces/SPACE/pages/title-slug-words
  // last path segment, dashes -> spaces, is our best title guess for a CQL search.
  const afterWiki = pageUrl.slice(wikiIdx + '/wiki'.length).split('?')[0].replace(/\/+$/, '');
  const segments = afterWiki.split('/').filter(Boolean);
  const titleGuess = segments.length ? decodeURIComponent(segments[segments.length - 1]).replace(/[-+]/g, ' ') : undefined;
  return { base, spaceKey: spaceMatch?.[1], titleGuess };
}

/** Resolves a parsed URL to a definite page id, using a CQL title search when the URL itself had no numeric id. */
async function resolvePageId(parsed: ParsedConfluenceUrl, auth: ConfluenceAuth): Promise<string> {
  if (parsed.pageId) return parsed.pageId;
  if (!parsed.titleGuess) throw badRequest('could not determine a Confluence page id or title from this URL');
  const cql = parsed.spaceKey
    ? `space="${parsed.spaceKey}" and title="${parsed.titleGuess}"`
    : `title="${parsed.titleGuess}"`;
  const data = (await confluenceGet(parsed.base, `/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=1`, auth)) as {
    results?: { id: string }[];
  };
  const id = data.results?.[0]?.id;
  if (!id) throw badRequest(`could not find a Confluence page matching "${parsed.titleGuess}" via CQL search`);
  return id;
}

// ---------------------------------------------------------------------------
// Tree walk + content fetch
// ---------------------------------------------------------------------------

interface RawPage {
  id: string;
  title: string;
  parentId?: string;
  children: string[];
  exportHtml: string;
  /** body.storage — the authored source. Empty string when the instance didn't return one. */
  storageXml: string;
}

interface RawAttachment {
  title: string;
  downloadPath: string; // Confluence's own relative download URL
  mediaType: string;
  fileSize: number | null;
}

async function fetchChildren(base: string, pageId: string, auth: ConfluenceAuth): Promise<{ id: string; title: string }[]> {
  const out: { id: string; title: string }[] = [];
  let start = 0;
  for (;;) {
    const d = (await confluenceGet(base, `/rest/api/content/${pageId}/child/page?limit=100&start=${start}`, auth)) as {
      results?: { id: string; title: string }[];
      size?: number;
    };
    out.push(...(d.results ?? []));
    if ((d.size ?? 0) < 100) break;
    start += 100;
  }
  return out;
}

/** Recursively walks the subtree rooted at rootId. includeChildren=false imports just the one page. */
async function walkTree(base: string, rootId: string, auth: ConfluenceAuth, includeChildren: boolean): Promise<Map<string, string[]>> {
  const tree = new Map<string, string[]>();
  async function walk(pid: string): Promise<void> {
    const kids = includeChildren || pid === rootId ? await fetchChildren(base, pid, auth) : [];
    const kidIds = includeChildren ? kids.map((k) => k.id) : [];
    tree.set(pid, kidIds);
    for (const kid of kidIds) await walk(kid);
  }
  await walk(rootId);
  return tree;
}

async function fetchPageContent(base: string, id: string, auth: ConfluenceAuth, children: string[]): Promise<RawPage> {
  // body.storage is fetched ALONGSIDE body.export_view, not instead of it:
  // export_view is the rendered page (the only thing that knows what a macro
  // actually produced), storage is the authored source (the only thing that
  // still has what the renderer failed at or silently dropped). See the
  // "Storage-format repairs" section below for what is folded back in.
  const d = (await confluenceGet(base, `/rest/api/content/${id}?expand=body.export_view,body.storage,version,ancestors`, auth)) as {
    id: string;
    title: string;
    ancestors?: { id: string }[];
    body?: { export_view?: { value?: string }; storage?: { value?: string } };
  };
  return {
    id: d.id,
    title: d.title,
    parentId: (d.ancestors ?? []).at(-1)?.id,
    children,
    exportHtml: d.body?.export_view?.value ?? '',
    storageXml: d.body?.storage?.value ?? '',
  };
}

/**
 * EVERY attachment, not just `image/*`. The old image-only filter is what made
 * a `view-file` macro (42 pages of the reference space) import as a link to the page's own
 * index.md and a video attachment import as `![Workflows.mp4]()` — an image
 * tag with an empty src, i.e. a broken-image icon where a real file was: the
 * file was never fetched, so nothing downstream could ever resolve it.
 */
async function fetchAttachments(base: string, id: string, auth: ConfluenceAuth): Promise<RawAttachment[]> {
  try {
    const a = (await confluenceGet(base, `/rest/api/content/${id}/child/attachment?limit=200`, auth)) as {
      results?: {
        title: string;
        metadata?: { mediaType?: string };
        extensions?: { mediaType?: string; fileSize?: number };
        _links?: { download?: string };
      }[];
    };
    const out: RawAttachment[] = [];
    for (const att of a.results ?? []) {
      if (!att._links?.download) continue;
      const size = att.extensions?.fileSize;
      out.push({
        title: att.title,
        downloadPath: att._links.download,
        mediaType: att.metadata?.mediaType ?? att.extensions?.mediaType ?? '',
        fileSize: typeof size === 'number' && Number.isFinite(size) ? size : null,
      });
    }
    return out;
  } catch {
    return []; // attachments are a best-effort enrichment -- never fail the whole page over them
  }
}

/**
 * The upper bound on ONE attachment this importer will pull into the asset
 * store. assets.putAsset takes a whole Buffer (never a stream), so an import
 * that happily fetched a multi-gigabyte video would take the server's memory
 * with it — and a wiki page's own inline media is nowhere near this size. An
 * attachment over the limit is skipped, exactly like one whose download
 * fails: the page still imports, that one reference just stays unresolved.
 */
const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;

/** One attachment already fetched and put in the asset store. */
interface UploadedAttachment {
  /** `sanitizeFilenameTail(filename)` — the key the page's own <img src>/href are matched on. */
  filenameTail: string;
  filename: string;
  url: string;
  isImage: boolean;
}

// ---------------------------------------------------------------------------
// Pure conversion pieces (unit-tested directly in confluenceImport.test.ts)
// ---------------------------------------------------------------------------

/**
 * GFM tables don't survive block tags nested inside td/th (turndown emits
 * broken pipes for a <p> or <br> inside a cell) — collapse them to a single
 * line first, keeping <br> as a literal (GFM renders it) and turning <li>
 * into a "• " prefix joined by <br>.
 *
 * Round 16: no longer called from convertPageHtml's own pipeline — a table
 * with a real nested list needs its hierarchy PRESERVED now (not squashed
 * into a "• " string), which this function's whole job was to do, so it's
 * superseded there by the DOM-based classify-then-handle pass below
 * (preprocessConfluenceDom / processTables). Left exported and covered by
 * its own tests as-is: it's still a correct, narrowly-scoped regex utility,
 * just no longer the tool for THIS job.
 */
export function preprocessTables(html: string): string {
  return html.replace(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, tag: string, inner: string) => {
    const flat = inner
      .replace(/<br[^>]*>/gi, '¶BR¶')
      .replace(/<\/(p|div|h[1-6])>/gi, '¶BR¶')
      .replace(/<(p|div|h[1-6])[^>]*>/gi, '')
      .replace(/<li[^>]*>/gi, '¶BR¶• ')
      .replace(/<\/?(ul|ol|li)[^>]*>/gi, '')
      .replace(/[\r\n]+/g, ' ')
      .replace(/(¶BR¶\s*)+/g, '¶BR¶')
      .replace(/^¶BR¶|¶BR¶$/g, '');
    return `<${tag}>${flat}</${tag}>`;
  });
}

/**
 * Confluence's own junk: `<style>`/`<script>` blocks, raw CDATA leftovers and
 * the auto-generated "rbtoc" anchor/TOC lists export_view sometimes includes.
 *
 * Two fixes measured on real fixtures:
 *  - the TOC matcher required DOUBLE quotes around the class, but on-prem
 *    export_view writes SINGLE ones (`<div class='toc-macro rbtoc1788086156812'>`)
 *    — 0 matches against 1 for the quote-agnostic form, so every `toc` macro
 *    (175 pages of the reference space) landed in the body as a list of anchors that are all dead
 *    (the `id="Widget2.0-Crisp"` targets they point at never survive the
 *    markdown conversion) AND duplicates Folio's own built-in page outline.
 *  - a `toc` macro is always preceded by a `<style>` element holding its
 *    generated CSS, wrapped in a comment-delimited CDATA section. Only the
 *    CDATA markers themselves used to be stripped, which left the comment
 *    delimiters behind as an empty C comment inside a `<style>` turndown has
 *    no rule for — so that empty comment was escaped into the page body as
 *    visible text on 163 pages of the reference space. Dropping the whole element, ahead of every
 *    DOM pass, also keeps its CSS text out of `body.textContent`, which the
 *    storage-repair alignment below reads.
 */
export function stripConfluenceCruft(html: string): string {
  return html
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<div[^>]*class=(['"])[^'"]*(?:rbtoc|toc-macro)[^'"]*\1[^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<p[^>]*>\s*<a[^>]*name=(['"])[^'"]*\1[^>]*><\/a>\s*<\/p>/gi, ''); // anchor-only TOC target paragraphs
}

// ---------------------------------------------------------------------------
// Storage-format repairs. export_view is a RENDER: whatever the on-prem
// renderer failed at, or never emits at all, is simply absent from the HTML
// this importer used to be handed — while still sitting there, verbatim and
// structured, in body.storage. The job now fetches BOTH bodies and this pass
// folds the storage-only facts back into the rendered DOM before anything
// else touches it. Two things are recovered, both measured on the 10 real
// pages in .qa/imp:
//
//  1. `jira` macros (245 pages of the reference space). The applink to Jira is down, so every one
//     of them rendered as the literal sentence "Unable to render Jira issues
//     macro, execution error." inside a `.jim-error-message` span — 28 of
//     them across the fixtures, i.e. the issue key the author actually wrote
//     was replaced by an error message in the imported page. The pairing is
//     exact and mechanical: on every single fixture the count of
//     `<ac:structured-macro ac:name="jira">` in storage, the count of their
//     `<ac:parameter ac:name="key">` values, and the count of
//     `.jim-error-message` spans in export_view are all equal (3/3/3, 4/4/4,
//     11/11/11, 1/1/1, 4/4/4, 5/5/5), so the Nth span is the Nth macro.
//
//  2. Classic `<ac:emoticon>` (question 116, blue-star 89, tick 71, plus 35,
//     minus 31, cross 12 pages of the reference space). 79 in the fixtures' storage vs 18
//     `<img class="emoticon">` in their export_view. The split is not random:
//     every emoticon whose `ac:emoji-id` is a unicode codepoint sequence
//     ("2b50", "1f449") renders, and every `atlassian-*` one is dropped —
//     61 of the 79, and the two counts match to the unit on all ten pages.
//     Restoring them needs a POSITION in the rendered DOM, which storage
//     can't hand over directly, so they're placed by anchoring on the
//     surrounding text (see placeStorageEmoticons): 61/61 placed on the
//     fixtures, with a miss being a no-op rather than a misplacement.
// ---------------------------------------------------------------------------

/** `<ac:parameter>`s whose value Confluence ALSO renders as visible text: a
 *  status lozenge's `title`, and a jira macro's `key` once repairJiraMacros
 *  below has substituted it into the DOM. Every other parameter (serverId,
 *  server, colour, …) is configuration that never reaches the page, and
 *  keeping it would desynchronize the two texts the emoticon anchoring
 *  compares. */
const STORAGE_VISIBLE_PARAM_RE = /<ac:parameter\b[^>]*ac:name=(['"])(?:title|key)\1[^>]*>([\s\S]*?)<\/ac:parameter>/gi;
const STORAGE_ANY_PARAM_RE = /<ac:parameter\b[\s\S]*?<\/ac:parameter>/gi;
const STORAGE_JIRA_MACRO_RE = /<ac:structured-macro\b[^>]*ac:name=(['"])jira\1[\s\S]*?<\/ac:structured-macro>/gi;
const STORAGE_JIRA_KEY_RE = /<ac:parameter\b[^>]*ac:name=(['"])key\1[^>]*>([^<]*)<\/ac:parameter>/i;
const STORAGE_EMOTICON_RE = /<ac:emoticon\b[^>]*\/>/gi;
const JIRA_ERROR_SELECTOR = '.jim-error-message';

const XML_NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
};

/** Storage is XML, so it only ever carries the five XML entities plus numeric
 *  ones — but real Confluence storage also contains the handful of HTML named
 *  entities below, and an unrecognized `&…;` is left alone rather than eaten. */
function decodeStorageEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (whole, dec: string, hex: string, name: string) => {
    try {
      if (dec) return String.fromCodePoint(Number(dec));
      if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    } catch {
      return whole; // out-of-range codepoint — not our problem to fix
    }
    return XML_NAMED_ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** Lowercases only when that leaves the string's LENGTH untouched — the
 *  compact-index mapping below addresses characters by position, and a few
 *  codepoints (İ) lowercase to two. Falls back to the original, i.e. to
 *  case-sensitive matching, rather than corrupting the mapping. */
function foldCaseSafely(text: string): string {
  const lower = text.toLowerCase();
  return lower.length === text.length ? lower : text;
}

const WHITESPACE_CHAR_RE = /[\s ]/;

/** The issue keys of every `jira` macro on the page, in document order. */
export function extractJiraIssueKeys(storageXml: string): string[] {
  const out: string[] = [];
  for (const macro of storageXml.match(STORAGE_JIRA_MACRO_RE) ?? []) {
    const key = STORAGE_JIRA_KEY_RE.exec(macro)?.[2]?.trim();
    if (key) out.push(decodeStorageEntities(key));
  }
  return out;
}

/**
 * The `.jim-error-message` spans, replaced by the issue key the author
 * actually wrote (a link when the caller knows where this instance's Jira
 * lives, plain text otherwise — a made-up `/browse/` URL on a host we never
 * verified would be worse than no link at all). A count mismatch means the
 * 1:1 sequence this relies on doesn't hold for THIS page, so nothing is
 * paired up: the error spans are simply removed, which is still strictly
 * better than importing "Unable to render Jira issues macro, execution
 * error." as page content.
 */
function repairJiraMacros(document: DomDocument, storageXml: string, jiraBrowseUrl?: (key: string) => string | undefined): void {
  const errors = Array.from(document.querySelectorAll(JIRA_ERROR_SELECTOR));
  if (errors.length === 0) return;
  const keys = extractJiraIssueKeys(storageXml);
  const paired = keys.length === errors.length;
  errors.forEach((el, i) => {
    const key = paired ? keys[i] : undefined;
    if (!key) {
      el.remove();
      return;
    }
    // Padded with spaces on both sides: the error span sat flush against the
    // preceding text on some pages ("multi-scenario widget<span…>"), which
    // would otherwise glue the key onto the last word. Markdown collapses the
    // duplicate where the source already had one.
    const url = jiraBrowseUrl?.(key);
    if (url) {
      const a = document.createElement('a');
      a.setAttribute('href', url);
      a.textContent = key;
      el.replaceWith(document.createTextNode(' '), a, document.createTextNode(' '));
    } else {
      el.replaceWith(document.createTextNode(` ${key} `));
    }
  });
}

interface DroppedEmoticon {
  /** Index into the marker-free compact storage text at which this emoji belongs. */
  at: number;
  emoji: string;
}

/**
 * The compact (whitespace-free, case-folded) plain text of the STORAGE
 * document, plus where each dropped emoticon sits inside it. Compact rather
 * than whitespace-normalized because storage and export_view disagree
 * constantly about whitespace — a tag boundary is a word boundary in one and
 * nothing in the other — and dropping whitespace from BOTH sides removes that
 * entire class of mismatch (measured: 52/61 emoticons placed with
 * whitespace-normalized matching, 61/61 with compact matching).
 */
function compactStorageText(storageXml: string): { text: string; dropped: DroppedEmoticon[] } {
  const source = storageXml
    .replace(STORAGE_VISIBLE_PARAM_RE, (_m, _q, inner: string) => inner)
    .replace(STORAGE_ANY_PARAM_RE, '')
    .replace(/<ri:[^>]*\/?>/gi, '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');

  const dropped: DroppedEmoticon[] = [];
  let text = '';
  const tags = /<ac:emoticon\b[^>]*\/>|<[^>]+>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const append = (chunk: string): void => {
    text += decodeStorageEntities(chunk).replace(/[\s ]+/g, '');
  };
  while ((m = tags.exec(source))) {
    append(source.slice(last, m.index));
    last = m.index + m[0].length;
    if (!m[0].startsWith('<ac:emoticon')) continue;
    const emojiId = /ac:emoji-id=(['"])([^'"]*)\1/.exec(m[0])?.[2] ?? '';
    // ONLY the atlassian-* ones: those are exactly the emoticons this
    // renderer drops (proven on all ten fixtures), and restoring one the
    // renderer DID emit would double it.
    if (!emojiId.startsWith('atlassian-')) continue;
    const name = /ac:name=(['"])([^'"]*)\1/.exec(m[0])?.[2] ?? '';
    const emoji = emoticonToText({ emojiId, className: name ? `emoticon emoticon-${name}` : 'emoticon' });
    if (emoji) dropped.push({ at: text.length, emoji });
  }
  append(source.slice(last));
  return { text: foldCaseSafely(text), dropped };
}

interface CompactDom {
  text: string;
  /** For compact character i: the text node it came from and its offset inside that node's value. */
  nodes: DomNode[];
  nodeOf: number[];
  offsetOf: number[];
}

/** The same compact text for the RENDERED document, with every character
 *  still addressable back to the exact text node and offset it came from. */
function compactDomText(root: DomNode): CompactDom {
  const nodes: DomNode[] = [];
  const nodeOf: number[] = [];
  const offsetOf: number[] = [];
  const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  let text = '';
  const walk = (node: DomNode): void => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3) {
        const raw: string = child.nodeValue ?? '';
        if (!raw) continue;
        const idx = nodes.push(child) - 1;
        for (let i = 0; i < raw.length; i++) {
          if (WHITESPACE_CHAR_RE.test(raw[i])) continue;
          text += raw[i];
          nodeOf.push(idx);
          offsetOf.push(i);
        }
      } else if (child.nodeType === 1 && !skip.has(child.nodeName)) {
        walk(child);
      }
    }
  };
  walk(root);
  return { text: foldCaseSafely(text), nodes, nodeOf, offsetOf };
}

/** How much surrounding text an emoticon is anchored by, and the shortest
 *  anchor still specific enough to trust. 24 characters of Cyrillic/Latin
 *  prose is far past the point of accidental repetition, and the search is
 *  additionally forward-only from the previous placement. */
const EMOTICON_ANCHOR_LENGTH = 24;
const EMOTICON_ANCHOR_MIN = 6;

/**
 * Puts each dropped emoticon back where its author wrote it, by finding the
 * text that FOLLOWED it in storage (or, when that text isn't in the render at
 * all, the text that preceded it) inside the rendered document. Anchoring is
 * forward-only — the Nth emoticon is never placed before the (N-1)th — so a
 * page that repeats the same phrase can't scatter them. An emoticon whose
 * anchor can't be found is skipped entirely: the page then reads exactly as
 * it does today, which is the honest floor for a heuristic like this.
 */
function placeStorageEmoticons(document: DomDocument, storageXml: string): void {
  const { text: storageText, dropped } = compactStorageText(storageXml);
  if (dropped.length === 0) return;
  // If this renderer DOES emit atlassian-* emoticons (Cloud does), everything
  // above is a no-op at best and a duplicate at worst -- leave it alone.
  if (document.querySelectorAll('img.emoticon[data-emoji-id^="atlassian-"]').length > 0) return;

  const dom = compactDomText(document.body);
  if (!dom.text) return;

  const insertions: { node: DomNode; offset: number; emoji: string }[] = [];
  let cursor = 0;
  for (const { at, emoji } of dropped) {
    const after = storageText.slice(at, at + EMOTICON_ANCHOR_LENGTH);
    const before = storageText.slice(Math.max(0, at - EMOTICON_ANCHOR_LENGTH), at);
    let pos = after.length >= EMOTICON_ANCHOR_MIN ? dom.text.indexOf(after, cursor) : -1;
    if (pos === -1 && before.length >= EMOTICON_ANCHOR_MIN) {
      const found = dom.text.indexOf(before, cursor);
      if (found !== -1) pos = found + before.length;
    }
    if (pos === -1) continue;
    cursor = pos;
    if (pos < dom.text.length) {
      insertions.push({ node: dom.nodes[dom.nodeOf[pos]], offset: dom.offsetOf[pos], emoji });
    } else {
      const lastNode = dom.nodes[dom.nodeOf[dom.text.length - 1]];
      insertions.push({ node: lastNode, offset: (lastNode.nodeValue ?? '').length, emoji });
    }
  }

  // Applied last-first so an earlier insertion never shifts a later one's
  // offset inside the same text node.
  for (const { node, offset, emoji } of insertions.reverse()) {
    const value: string = node.nodeValue ?? '';
    const head = value.slice(0, offset);
    const tail = value.slice(offset);
    const lead = head.length > 0 && !WHITESPACE_CHAR_RE.test(head[head.length - 1]) ? ' ' : '';
    const trail = tail.length > 0 && !WHITESPACE_CHAR_RE.test(tail[0]) ? ' ' : '';
    node.nodeValue = `${head}${lead}${emoji}${trail}${tail}`;
  }
}

/**
 * export_view HTML + its body.storage source -> export_view HTML with the
 * storage-only facts folded back in. A page whose storage wasn't fetched (an
 * instance that doesn't return it, or any caller that doesn't have it) gets
 * the HTML back untouched — every repair here is additive.
 */
export function applyStorageRepairs(exportHtml: string, storageXml: string, jiraBrowseUrl?: (key: string) => string | undefined): string {
  if (!storageXml.trim()) return exportHtml;
  const dom = new JSDOM(exportHtml);
  try {
    const { document } = dom.window;
    // Jira first: it puts the issue KEY into the rendered text, which the
    // emoticon anchoring below then gets to match against (storage has the
    // same key in its own <ac:parameter ac:name="key">).
    repairJiraMacros(document, storageXml, jiraBrowseUrl);
    placeStorageEmoticons(document, storageXml);
    return document.body.innerHTML;
  } finally {
    dom.window.close();
  }
}

// ---------------------------------------------------------------------------
// Round 16: export_view DOM preprocessing (runs BEFORE turndown ever sees the
// HTML). Symptom (DEV-PLAN): a complex "layout" table imported as a raw
// view-HTML blob (aui expand buttons, comment-marker spans, status lozenges)
// with nested lists flattened into "<br>•…" strings. Root cause traced into
// turndown-plugin-gfm's own `tables` rule: it `.keep()`s (raw outerHTML
// passthrough, verbatim) any <table> whose first row isn't a "real" all-<th>
// heading row — completely orthogonal to whether a CELL's content is simple
// or complex. The real page this reproduces has a 5/2/2-column ragged table with
// zero <th> cells anywhere — exactly what triggers that fallback. Since a
// pipe table can't represent that shape correctly EITHER way (forcing a
// ragged, ARIA-button-and-span-riddled table into GFM rows would misalign
// content across columns even once the chrome is cleaned up), this uses jsdom
// (see server/types/jsdom.d.ts for why it needs its own tiny type shim) to:
//   1. pair expand-macro controls with their content and turn them into
//      <details><summary>,
//   2. unwrap inline-comment-marker spans,
//   3. turn status-macro lozenges into <strong>,
//   4. clean up other stray aui/conf-macro chrome,
//   5. classify each table as simple/complex and handle it deterministically
//      ourselves — never leaving the pipe-vs-raw decision to gfm's own
//      heading-row heuristic.
// ---------------------------------------------------------------------------

/** HTML attribute this module uses, internally only, to mark a <table> element
 *  (already fully sanitized by sanitizeForCleanTable below) for verbatim raw
 *  HTML passthrough — see the `folio-raw-table` turndown rule in
 *  buildTurndownService. Never visible in the final output: the rule strips
 *  it off again right before reading outerHTML. */
const TABLE_RAW_MARKER = 'data-folio-raw-table';

/** DEV-PLAN Round 16 point 4's own disqualifying-tag list for "inline-simple"
 *  cells, plus DIV (also named in this round's own task delegation, absent
 *  from DEV-PLAN's shorter prose list but strictly safer to include). */
const COMPLEX_CELL_TAGS = new Set(['UL', 'OL', 'P', 'DIV', 'DETAILS', 'TABLE']);

/** The same list without UL/OL — round 28's "is a LIST the only thing keeping
 *  this table out of the pipe format?" question (see reduceCellLists). UL/OL
 *  stay in COMPLEX_CELL_TAGS itself on purpose: any list that survives the
 *  rewrite (nested inside a `<details>`, say) must still freeze its table
 *  rather than be silently dropped by the pipe branch. */
const COMPLEX_CELL_TAGS_EXCEPT_LISTS = new Set(['P', 'DIV', 'DETAILS', 'TABLE']);

/** Attributes stripped unconditionally from a complex table's whole subtree
 *  (DEV-PLAN: "strip all classes/styles/colgroup/data attributes/buttons").
 *  href/src/alt/colspan/rowspan are deliberately NOT in this list — they're
 *  structural/functional, not presentational cruft. */
const STRIP_ATTR_EXACT = new Set(['class', 'style', 'id', 'width', 'height', 'valign', 'align', 'bgcolor', 'border', 'cellpadding', 'cellspacing']);
const STRIP_ATTR_PREFIXES = ['data-', 'aria-'];

function unwrapElement(el: DomElement): void {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

const EXPAND_CONTROL_SELECTOR = 'button.aui-button[aria-controls], .expand-control';

/**
 * Finds the content container paired with an expand-macro control, trying
 * every shape DEV-PLAN asks for ("both variants — cloud and on-prem"):
 *  1. aria-controls -> #<id> (the modern/on-prem-server button shape this
 *     round's real fixture actually uses),
 *  2. a shared `.expand-container` (or `[data-macro-name="expand"]`) wrapper
 *     holding both the control and a `.expand-content`/`#expander-content-*`
 *     sibling (the classic on-prem macro shape, no aria-controls at all),
 *  3. a plain next-sibling `.expand-content`/`#expander-content-*` with no
 *     wrapper.
 * Returns null when NONE of these match — which happens for real, in
 * production: the "BA - Business Analyst" page's export_view has buttons
 * whose aria-controls id never appears anywhere in the document at all (see
 * the dedicated test for this exact shape).
 */
function findExpandContainer(control: DomElement, document: DomDocument): DomElement | null {
  const controlsId = control.getAttribute('aria-controls');
  if (controlsId) {
    const byId = document.getElementById(controlsId);
    if (byId) return byId;
  }
  const wrapper = control.closest('.expand-container, [data-macro-name="expand"]');
  if (wrapper) {
    const content = wrapper.querySelector('.expand-content, [id^="expander-content-"]');
    if (content) return content;
  }
  let sib = control.nextElementSibling;
  while (sib) {
    if (sib.matches('.expand-content, [id^="expander-content-"]')) return sib;
    sib = sib.nextElementSibling;
  }
  return null;
}

/** DEV-PLAN point 1: expand-macro control+content pairs -> <details><summary>.
 *  Round 16 also decided the details' BODY would stay cleaned HTML rather than
 *  be converted, on the grounds that turndown's `.keep()` reads outerHTML
 *  verbatim anyway. Round 28b reversed that: the tags stay HTML, the body is
 *  converted like any other content -- see buildTurndownService's
 *  `folio-details-block` rule for what changed and why. Nothing here needed
 *  to change for it; this still just builds the element. */
function convertExpandMacros(document: DomDocument): void {
  const controls = Array.from(document.querySelectorAll<DomElement>(EXPAND_CONTROL_SELECTOR));
  for (const control of controls) {
    const labelEl = control.querySelector('.expand-control-text');
    const label = ((labelEl ? labelEl.textContent : control.textContent) || '').replace(/\s+/g, ' ').trim();
    const container = findExpandContainer(control, document);

    if (container) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = label;
      details.appendChild(summary);
      while (container.firstChild) details.appendChild(container.firstChild);
      container.remove();
      const host = control.closest('.expand-container') ?? control;
      host.replaceWith(details);
    } else {
      // No paired container in THIS export (seen in production on the "BA -
      // Business Analyst" page: aria-controls names an id that appears
      // nowhere in export_view) -- degrade to the label as inline bold text
      // rather than fabricate an empty collapsible. Matches point 5's "drop
      // the chrome, keep the meaningful text" spirit instead of losing the
      // one bit of human-authored content (the label) the button carried.
      const strong = document.createElement('strong');
      strong.textContent = label;
      control.replaceWith(strong);
    }
  }
}

/** DEV-PLAN point 2: span.inline-comment-marker -> unwrap (bare text). */
function unwrapCommentMarkers(document: DomDocument): void {
  for (const el of Array.from(document.querySelectorAll('span.inline-comment-marker'))) {
    unwrapElement(el);
  }
}

/**
 * The `status` macro's COLOUR is the whole point of it — a row of lozenges
 * where one is green and the rest grey says "this is the one", and
 * `<strong>TEXT</strong>` for all of them says nothing at all (the real
 * symptom: `**STARTER GROWTH SCALE STRATEGIC**`, with no way to tell which
 * segment was selected). Confluence writes the colour as an `aui-lozenge-*`
 * class, which 38 of the 39 lozenges across the fixtures carry, so it maps
 * to a coloured dot in front of the label. Grey — the macro's default, and
 * the one lozenge with no colour class — deliberately gets no dot: it is the
 * absence of a highlight, and marking it would drown out the ones that mean
 * something.
 *
 * A dot rather than one of Folio's own `folio-bg-*` tokens: those tokens are
 * table-cell classes, and this lozenge is usually mid-sentence, where nothing
 * carries a class through to the rendered markdown.
 */
const LOZENGE_COLOR_DOT: [string, string][] = [
  ['aui-lozenge-error', '🔴'],
  ['aui-lozenge-removed', '🔴'],
  ['aui-lozenge-success', '🟢'],
  ['aui-lozenge-moved', '🟡'],
  ['aui-lozenge-current', '🔵'],
  ['aui-lozenge-complete', '🔵'],
  ['aui-lozenge-new', '🟣'],
];

function convertStatusLozenges(document: DomDocument): void {
  for (const el of Array.from(document.querySelectorAll('span.status-macro, span.aui-lozenge'))) {
    const tokens = classTokenSet(el);
    const dot = LOZENGE_COLOR_DOT.find(([cls]) => tokens.has(cls))?.[1];
    const label = (el.textContent || '').trim();
    const strong = document.createElement('strong');
    strong.textContent = dot ? `${dot} ${label}` : label;
    el.replaceWith(strong);
  }
}

/**
 * The `pagetree` macro (26 pages of the reference space) renders as an EMPTY `plugin_pagetree`
 * container plus a hidden fieldset of parameters — the actual tree is fetched
 * by Confluence's own JavaScript at view time — so turndown had nothing to
 * convert and the macro vanished without a trace. Folio has the same feature
 * natively, so it becomes `::pagetree`, the live child list of the page it
 * sits on.
 *
 * Confluence's `rootPage`/`rootPageId` can in principle point the tree at
 * some OTHER page; Folio's directive only ever means "this page", and on the
 * fixture the two ids are the same page. Emitting it unconditionally is still
 * strictly better than the silent disappearance it replaces.
 */
function convertPageTrees(document: DomDocument): void {
  for (const el of Array.from(document.querySelectorAll('div.plugin_pagetree'))) {
    const directive = document.createElement('p');
    directive.textContent = PAGETREE_MARKER;
    el.replaceWith(directive);
  }
}

/** Placed as a paragraph so turndown gives it its own line with blank lines
 *  around it, then restored by convertPageHtml's final string pass — the same
 *  trick the table-background metadata line uses, and for the same reason
 *  (turndown would otherwise escape the leading colons). */
const PAGETREE_MARKER = '¶FOLIO-PAGETREE¶';
const PAGETREE_MARKER_RE = /¶FOLIO-PAGETREE¶/g;

/**
 * composePageBody always writes the page's own title as the `# H1`, and a
 * Confluence body routinely has H1s of its own for its top-level sections
 * (up to 7 on one fixture). Two competing H1 levels means the page outline —
 * and every heading-based navigation built on it — reads the sections as
 * siblings of the title. Every heading shifts down one level so the title
 * stays the only H1; H6 has nowhere left to go and stays put.
 *
 * A no-op unless the body actually has an H1: a page that already starts at
 * H2 is correctly nested as it is, and shifting it would only waste levels.
 */
function demoteBodyHeadings(document: DomDocument): void {
  if (document.querySelectorAll('h1').length === 0) return;
  for (const heading of Array.from(document.querySelectorAll<DomElement>('h1, h2, h3, h4, h5'))) {
    const level = Number.parseInt(heading.nodeName.slice(1), 10);
    const replacement = document.createElement(`h${Math.min(6, level + 1)}`);
    for (const attr of Array.from(heading.attributes)) replacement.setAttribute(attr.name, attr.value);
    while (heading.firstChild) replacement.appendChild(heading.firstChild);
    heading.replaceWith(replacement);
  }
}

/**
 * Confluence wraps a list item's text in a `<p>` — `<li><p>text</p></li>` —
 * and turndown then renders each item as its content plus a blank line's
 * worth of trailing spaces, producing the ragged "loose list" every imported
 * page is full of. Unwrapped only when the item has exactly ONE direct-child
 * paragraph: an item deliberately written as two paragraphs keeps them, and a
 * nested `<ul>`/`<ol>` alongside the single `<p>` is untouched either way.
 */
function unwrapListItemParagraphs(document: DomDocument): void {
  for (const li of Array.from(document.querySelectorAll<DomElement>('li'))) {
    const paragraphs = Array.from(li.children).filter((child) => child.nodeName === 'P');
    if (paragraphs.length !== 1) continue;
    unwrapElement(paragraphs[0]);
  }
}

/** DEV-PLAN point 5: other aui/conf-macro chrome not already handled above —
 *  decorative icon spans, any other stray button, leftover macro-render
 *  wrapper spans. Removes the wrapping node, keeps its text/children. */
function removeAuiCruftNodes(root: DomElement): void {
  for (const el of Array.from(root.querySelectorAll('span.aui-icon, span[class*="aui-iconfont"]'))) {
    if (!el.textContent || !el.textContent.trim()) el.remove(); // purely decorative -- no text to lose
  }
  for (const btn of Array.from(root.querySelectorAll('button'))) {
    unwrapElement(btn); // expand buttons are already gone by the time this runs; this is the net for anything else
  }
  for (const el of Array.from(root.querySelectorAll('span.conf-macro-render'))) {
    unwrapElement(el);
  }
}

/** Structure a pipe-table cell genuinely cannot express, so a cell containing
 *  any of these still disqualifies its table (nesting must be PRESERVED, which
 *  is the whole point of the raw-HTML branch — see round 16's note above).
 *  Round 28 took `ul, ol` off this list: a list in a cell now HAS a pipe-table
 *  representation (see reduceCellLists below), so it no longer freezes the
 *  whole table, and the cell's own `<p>` wrappers are reducible again. */
const IRREDUCIBLE_CELL_SELECTOR = 'table, details';

/** Block wrappers a pipe-table cell CAN express, as one line each joined by
 *  `<br>`. `P` leads the list because Confluence's editor wraps every single
 *  cell's content in one whether it needs it or not. */
const REDUCIBLE_CELL_BLOCK_SELECTOR = 'p, div, h1, h2, h3, h4, h5, h6';

/** True when anything with actual content follows `node` among its siblings. */
function hasFollowingContent(node: DomNode): boolean {
  for (let sib = node.nextSibling; sib; sib = sib.nextSibling) {
    if (sib.nodeType === 1) return true;
    if ((sib.textContent || '').trim()) return true;
  }
  return false;
}

/** The two directions round 28 needs when it splices a flattened list back
 *  into a cell: is there content on that side, and is it already separated
 *  from the list by a `<br>`? A `<br>` reduceCellBlocks already inserted after
 *  a preceding `<p>` must not be doubled — two `<br>`s in a row read as a
 *  blank line inside the cell. Whitespace-only text between them is ignored,
 *  which is why this can't just look at `previousSibling`/`nextSibling`. */
function neighbouringContent(node: DomNode, direction: 'previous' | 'next'): 'none' | 'break' | 'content' {
  for (let sib = direction === 'previous' ? node.previousSibling : node.nextSibling; sib; sib = direction === 'previous' ? sib.previousSibling : sib.nextSibling) {
    if (sib.nodeType === 1) return sib.nodeName === 'BR' ? 'break' : 'content';
    if ((sib.textContent || '').trim()) return 'content';
  }
  return 'none';
}

/**
 * Confluence's editor wraps the content of essentially every table cell in a
 * `<p>`, and `P` was on the disqualifying-tag list — so literally every
 * "classic" page's tables were classified complex and frozen as raw HTML: 25
 * of the 44 tables across the fixtures, 100% of them on the older pages.
 * That is not a cosmetic problem. A raw-HTML table is an opaque block in the
 * editor (none of Folio's own row/colour/sort tools apply to it), and one
 * stray keypress lands inside a tag and destroys the table.
 *
 * So before a table is classified, each cell's block WRAPPERS are reduced to
 * what a pipe cell can actually hold: paragraphs, divs and headings become
 * plain inline content, joined by `<br>` wherever more than one of them
 * carried content (`<br>` is exactly what neutralizeBreaksForPipeTable
 * already carries through the pipe format for simple tables). A cell holding
 * a nested table or a `<details>` is skipped untouched — that structure is
 * real, can't survive the reduction, and rightly keeps the whole table on the
 * raw-HTML branch. (A cell holding a LIST used to be skipped here too; round
 * 28's reduceCellLists gives lists a representation of their own, so this
 * pass now reduces the `<p>` wrappers inside them as well.)
 *
 * Measured over the fixtures: 21 of 44 tables classified simple before this,
 * 39 after; the 5 that remain complex are the 4 with real lists in a cell and
 * 1 with a rowspan.
 */
function reduceCellBlocks(table: DomTableElement): void {
  for (const row of Array.from(table.rows)) {
    for (const cell of Array.from(row.cells)) {
      if (cell.querySelectorAll(IRREDUCIBLE_CELL_SELECTOR).length > 0) continue;
      const blocks = Array.from(cell.querySelectorAll<DomElement>(REDUCIBLE_CELL_BLOCK_SELECTOR));
      // Reverse document order: a child is always unwrapped before its parent,
      // so no reference in the snapshot is invalidated by an earlier step.
      for (const block of blocks.reverse()) {
        const parent = block.parentNode;
        if (!parent) continue;
        const hasContent = Boolean((block.textContent || '').trim()) || block.querySelectorAll('img').length > 0;
        if (hasContent && hasFollowingContent(block)) {
          const br = block.ownerDocument?.createElement('br');
          if (br) parent.insertBefore(br, block.nextSibling);
        }
        unwrapElement(block);
      }
    }
  }
}

/**
 * Round 28 — a LIST inside a table cell.
 *
 * NORMATIVE SOURCE: `web/src/markdown/tableSyntax.ts`, section "lists inside a
 * cell" (`parseCellLines` / `formatCellLines` / `splitCellBreaks`). That file
 * is shared verbatim between the reading renderer and the editable grid; the
 * server cannot import it (`server/**` is its own tsconfig project, and only
 * `shared/**` crosses the boundary), so the FORMAT is restated here — the
 * three constants below and nothing else. The parsing/serialising LOGIC is
 * deliberately NOT duplicated: this side only ever writes.
 *
 *   line       ::= indent marker " " inline-markdown
 *   indent     ::= "  " repeated (depth - 1) times
 *   marker     ::= "•"          a bullet item
 *                | "<n>."       a numbered item, numbered CONSECUTIVELY
 *                | "[ ]" | "[x]" a checklist item (Confluence's inline tasks)
 *   lines are joined by `<br>`, and a line with no marker is a plain
 *   paragraph line inside the same cell
 *
 * Why write it as text at all: `<br>` and a literal bullet are legal GFM cell
 * content, so github/gitlab render the cell as separate bulleted lines — the
 * round-17 IRON RULE (whatever we write stays a valid GFM pipe table) holds.
 * A real block `<ul>` fits into a pipe table in no parser, and the raw-HTML
 * block it used to fall back to is exactly what this round exists to stop
 * producing: 18 of the 44 tables across the fixtures were frozen as raw
 * HTML, every one of them purely because a cell held a list.
 *
 * Numbering runs 1, 2, 3 rather than `1.` on every line for the same IRON RULE
 * reason: inside a cell this text is what a plain GFM renderer literally
 * prints, and `1. 1. 1.` would show github a list whose every item is the
 * first. A nested level starts its own count at 1, and the run rules match
 * formatCellLines exactly (see numberCellListLines below).
 */
const CELL_LIST_BULLET = '•';
const CELL_LIST_INDENT = '  ';
const cellListOrderedMarker = (ordinal: number): string => `${ordinal}.`;
const cellListTaskMarker = (checked: boolean): string => (checked ? '[x]' : '[ ]');

/**
 * The item prefix travels through turndown as a MARKER, not as its final text,
 * because every one of the three forms is something turndown would otherwise
 * corrupt on the way out:
 *  - turndown collapses whitespace inside every non-`<pre>` text node, so the
 *    two-spaces-per-level indent would come out as a single space (and four
 *    spaces as one too — every nesting level would flatten into the same one);
 *  - its markdown escaping rewrites a leading `1. ` to `1\. `, which
 *    `parseCellLines` does not recognise as a numbered item at all;
 *  - and it escapes `[` to `\[`, which does the same to a `[ ]` checklist item.
 * Restored by convertPageHtml's final string pass, alongside `¶BR¶` and the
 * table-background marker, once the page is already plain markdown text. The
 * marker body is ASCII letters/digits/`:` only — none of turndown's escape
 * patterns touch it.
 *
 * `arg` carries the ordinal for `ol`, 1/0 for a checked/unchecked `task`, and
 * is ignored for `ul`.
 */
const CELL_LIST_MARKER_RE = /¶FOLIO-CELL-LI:(\d+):(ul|ol|task):(\d+)¶/g;

function cellListMarker(depth: number, kind: CellListKind, arg: number): string {
  return `¶FOLIO-CELL-LI:${depth}:${kind}:${arg}¶`;
}

function renderCellListMarker(depth: number, kind: string, arg: number): string {
  const indent = CELL_LIST_INDENT.repeat(Math.max(0, depth - 1));
  if (kind === 'ol') return `${indent}${cellListOrderedMarker(arg)} `;
  if (kind === 'task') return `${indent}${cellListTaskMarker(arg === 1)} `;
  return `${indent}${CELL_LIST_BULLET} `;
}

type CellListKind = 'ul' | 'ol' | 'task';

interface CellListLine {
  depth: number;
  kind: CellListKind;
  /** `task` only: the state of the checkbox. */
  checked: boolean;
  /** `ol` only: filled in by numberCellListLines. */
  ordinal: number;
  /** True when the item's own content already contains a `<br>` (a multi-
   *  paragraph `<li>`, which reduceCellBlocks has flattened by now). Those
   *  extra lines carry no marker, so `parseCellLines` reads them as paragraph
   *  lines — and a paragraph line ends every numbered run. */
  splitsRun: boolean;
  /** The item's OWN child nodes, nested lists excluded — moved, not cloned, so
   *  inline markup (bold, links, code, images) survives untouched. */
  nodes: DomNode[];
}

const LIST_TAGS = new Set(['UL', 'OL']);

/** The same signal buildTurndownService's `confluence-tasks` rule uses for a
 *  task list OUTSIDE a table: export_view renders `<ac:task-list>` as
 *  `<ul class="inline-task-list"><li class="checked">…`. Kept identical on
 *  purpose — the same Confluence construct must not read as a checklist in
 *  running text and as a bullet inside a cell. */
function isTaskItem(list: DomElement, item: DomElement): boolean {
  return /task-list-item|inline-task/.test(`${list.className || ''} ${item.className || ''}`);
}

function isCheckedTaskItem(item: DomElement): boolean {
  return /checked/.test(item.className || '') || Boolean(item.querySelector('input[checked]'));
}

/**
 * Drops the whitespace an `<li>`'s own markup leaves at either end of the item
 * — Confluence's inline tasks in particular are `<span>telegram </span>`, with
 * the trailing space inside the span. It survives turndown and lands right
 * before the `<br>` that ends the line. Harmless to a reader and to
 * parseCellLines (which trims), but formatCellLines writes the trimmed text
 * back, so leaving it in means the first edit of an imported table produces a
 * whitespace-only diff on every line.
 */
function trimCellLineNodes(nodes: DomNode[]): DomNode[] {
  const isBlank = (n: DomNode): boolean => n.nodeType === 3 && !(n.nodeValue || '').trim();
  let start = 0;
  let end = nodes.length;
  while (start < end && isBlank(nodes[start])) start++;
  while (end > start && isBlank(nodes[end - 1])) end--;
  const trimmed = nodes.slice(start, end);
  // The edge text node can be nested — an inline task's whole body is
  // `<span class="placeholder-inline-tasks">telegram </span>`.
  const first = edgeTextNode(trimmed[0], 'first');
  const last = edgeTextNode(trimmed[trimmed.length - 1], 'last');
  if (first) first.nodeValue = (first.nodeValue || '').replace(/^\s+/, '');
  if (last) last.nodeValue = (last.nodeValue || '').replace(/\s+$/, '');
  return trimmed;
}

/** The first (or last) text node of `node`'s subtree, `node` itself included. */
function edgeTextNode(node: DomNode, edge: 'first' | 'last'): DomNode | null {
  if (!node) return null;
  if (node.nodeType === 3) return node;
  if (node.nodeType !== 1) return null;
  const children: DomNode[] = [];
  for (let c: DomNode = node.firstChild; c; c = c.nextSibling) children.push(c);
  if (edge === 'last') children.reverse();
  for (const child of children) {
    const found = edgeTextNode(child, edge);
    if (found) return found;
  }
  return null;
}

/**
 * Numbers the `ol` lines, byte-for-byte the run rules formatCellLines applies
 * when the same cell is written back out from the editor — anything else and
 * the first edit of an imported table would silently renumber it. A run ends
 * at a paragraph line, at a shallower line (which ends the deeper runs), and
 * at a non-`ol` item of the same depth. Nesting alone does NOT end it:
 * `1. / 1.1 / 1.2 / 2.` keeps counting the outer list.
 */
function numberCellListLines(lines: CellListLine[]): void {
  const counters = new Map<number, number>();
  for (const line of lines) {
    for (const d of [...counters.keys()]) if (d > line.depth) counters.delete(d);
    if (line.kind !== 'ol') counters.delete(line.depth);
    else {
      line.ordinal = (counters.get(line.depth) ?? 0) + 1;
      counters.set(line.depth, line.ordinal);
    }
    if (line.splitsRun) counters.clear();
  }
}

/**
 * Flattens one list into R28 lines, depth-first. Handles both nestings a real
 * export produces: the well-formed `<li>text<ul>…</ul></li>`, and the
 * malformed-but-common `<ul><li>a</li><ul><li>b</li></ul></ul>` where the
 * sub-list is a SIBLING of the item it belongs to.
 */
function collectCellListLines(list: DomElement, depth: number, lines: CellListLine[]): void {
  const listKind: CellListKind = list.nodeName === 'OL' ? 'ol' : 'ul';
  for (const child of Array.from(list.children)) {
    if (LIST_TAGS.has(child.nodeName)) {
      collectCellListLines(child, depth + 1, lines);
      continue;
    }
    if (child.nodeName !== 'LI') continue;
    const own: DomNode[] = [];
    const nested: DomElement[] = [];
    // firstChild/nextSibling rather than childNodes: server/types/jsdom.d.ts
    // declares only the surface this module actually uses, and the rest of the
    // file walks children this way for the same reason.
    for (let node: DomNode = child.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === 1 && LIST_TAGS.has(node.nodeName)) nested.push(node as DomElement);
      else own.push(node);
    }
    // An `<li>` holding nothing but its sub-list (or Confluence's empty
    // `<li><p><br/></p></li>` filler) would become a bullet with no text.
    const hasOwnContent = own.some((n) => Boolean((n.textContent || '').trim()) || (n.nodeType === 1 && (n as DomElement).querySelectorAll('img').length > 0));
    if (hasOwnContent) {
      const task = isTaskItem(list, child);
      lines.push({
        depth,
        kind: task ? 'task' : listKind,
        checked: task && isCheckedTaskItem(child),
        ordinal: 1,
        splitsRun: own.some((n) => n.nodeType === 1 && ((n as DomElement).nodeName === 'BR' || (n as DomElement).querySelectorAll('br').length > 0)),
        nodes: trimCellLineNodes(own),
      });
    }
    for (const sub of nested) collectCellListLines(sub, depth + 1, lines);
  }
}

/** Every list in the cell that is not itself nested inside another list — the
 *  entry points collectCellListLines recurses from. */
function topLevelCellLists(cell: DomElement): DomElement[] {
  return Array.from(cell.querySelectorAll<DomElement>('ul, ol')).filter((list) => {
    for (let p = list.parentElement; p && p !== cell; p = p.parentElement) {
      if (LIST_TAGS.has(p.nodeName)) return false;
    }
    return true;
  });
}

function flattenCellLists(cell: DomElement): void {
  const document = cell.ownerDocument;
  if (!document) return;
  for (const list of topLevelCellLists(cell)) {
    const parent = list.parentNode;
    if (!parent) continue;
    const lines: CellListLine[] = [];
    collectCellListLines(list, 1, lines);
    if (lines.length === 0) {
      parent.removeChild(list);
      continue;
    }
    numberCellListLines(lines);
    if (neighbouringContent(list, 'previous') === 'content') parent.insertBefore(document.createElement('br'), list);
    // Spliced in one node at a time, in front of the list, rather than through
    // a DocumentFragment (not in this module's jsdom type surface). Each of
    // line.nodes is MOVED, never cloned, so the item's inline markup — bold,
    // links, code, an emoticon `<img>` — arrives intact.
    lines.forEach((line, i) => {
      if (i > 0) parent.insertBefore(document.createElement('br'), list);
      const arg = line.kind === 'ol' ? line.ordinal : Number(line.checked);
      parent.insertBefore(document.createTextNode(cellListMarker(line.depth, line.kind, arg)), list);
      for (const node of line.nodes) parent.insertBefore(node, list);
    });
    if (neighbouringContent(list, 'next') === 'content') parent.insertBefore(document.createElement('br'), list.nextSibling);
    parent.removeChild(list);
  }
}

/**
 * Round 28's pass: rewrites every cell list in the table as R28 lines, so the
 * table can be classified simple and come out a real pipe table.
 *
 * Gated on the table having no OTHER reason to stay complex. A table that is
 * ragged, or has a real colspan/rowspan, or nests a table/`<details>` in a
 * cell, is going to the raw-HTML branch whatever we do to its lists — and
 * there the `<ul>` renders as a genuine list, strictly better than a line of
 * bullets. One fixture is exactly that case (page 1786478593: ragged 5/2 AND
 * colspan AND rowspan AND lists), which is why this is a gate and not an
 * unconditional rewrite.
 */
function reduceCellLists(table: DomTableElement): void {
  if (!isSimpleTable(table, COMPLEX_CELL_TAGS_EXCEPT_LISTS)) return;
  for (const row of Array.from(table.rows)) {
    for (const cell of Array.from(row.cells)) flattenCellLists(cell);
  }
}

function cellDisqualifiesSimpleTable(cell: DomElement, complexTags: ReadonlySet<string>): boolean {
  const colspan = cell.getAttribute('colspan');
  const rowspan = cell.getAttribute('rowspan');
  if (colspan && colspan !== '1') return true;
  if (rowspan && rowspan !== '1') return true;
  return Array.from(cell.querySelectorAll('*')).some((el) => complexTags.has(el.nodeName));
}

/**
 * DEV-PLAN point 4: a table converts to a plain GFM pipe table only when
 * EVERY cell is "inline-simple" (no ul/ol/p/div/details/nested-table inside
 * it anywhere). Extended with two disqualifiers found while reproducing the
 * actual prod symptom (see the module doc comment above): a cell with a real
 * colspan/rowspan can't be represented in a pipe table at all, and a
 * Confluence "layout" table can have a RAGGED cell count per row with no
 * colspan/rowspan explaining it (the real fixture is 5, then 2, then 2) —
 * forcing that into a fixed-width pipe grid would silently misalign labeled
 * fields into the wrong columns, which is worse than an honest HTML table.
 *
 * `complexTags` is the disqualifying-tag list to apply. It is a parameter for
 * exactly one caller: reduceCellLists asks the question with UL/OL taken off
 * the list — "would this table be simple if its lists were written as R28
 * lines?" — before it rewrites anything.
 */
function isSimpleTable(table: DomTableElement, complexTags: ReadonlySet<string> = COMPLEX_CELL_TAGS): boolean {
  const rows = Array.from(table.rows);
  if (rows.length === 0) return true;
  const width = rows[0].cells.length;
  for (const row of rows) {
    const cells = Array.from(row.cells);
    if (cells.length !== width) return false;
    if (cells.some((cell) => cellDisqualifiesSimpleTable(cell, complexTags))) return false;
  }
  return true;
}

/**
 * The other two halves of gfm's `isHeadingRow` gate, both of which a real
 * Confluence export trips even when row 0 is already all-`<th>`:
 *
 *  - it requires the heading row's parent to be a THEAD, the TABLE, or the
 *    FIRST TBODY — and its `isFirstTbody` insists the TBODY have no previous
 *    sibling at all (or an empty THEAD). Confluence emits `<colgroup>` before
 *    `<tbody>` on every table it lays out with fixed column widths, which is
 *    a previous sibling, so `.keep()` fired and the table came out as raw
 *    HTML no matter how simple its cells were. colgroup/col are purely
 *    presentational (sanitizeForCleanTable already drops them on the other
 *    branch), so they go here too.
 *  - it walks the row's raw `childNodes`, not its cells, and requires EVERY
 *    one to be a TH — so a single newline between two `<th>` tags is enough
 *    to fail it. Whitespace-only text nodes are dropped from the table's own
 *    structural elements for the same reason.
 */
function stripPipeTableObstacles(table: DomTableElement): void {
  for (const el of Array.from(table.querySelectorAll('colgroup, col'))) el.remove();
  const scopes: DomElement[] = [table, ...Array.from(table.querySelectorAll<DomElement>('thead, tbody, tfoot, tr'))];
  for (const scope of scopes) {
    let child: DomNode = scope.firstChild;
    while (child) {
      const next: DomNode = child.nextSibling;
      if (child.nodeType === 3 && !(child.nodeValue || '').trim()) scope.removeChild(child);
      child = next;
    }
  }
}

/** Forces row 0 into an all-<th> heading row so turndown-plugin-gfm's OWN
 *  `isHeadingRow` check (parentNode is a THEAD, or first row + every cell TH)
 *  passes deterministically -- a real Confluence "layout" table classified
 *  simple here routinely has zero <th> cells at all (every row is <td>), and
 *  gfm's `.keep()` fallback for a missing heading row is EXACTLY the raw-HTML
 *  passthrough bug this round fixes. No-op if already satisfied. */
function ensureHeadingRow(table: DomTableElement, document: DomDocument): void {
  const firstRow = table.rows[0];
  if (!firstRow) return;
  if (firstRow.parentNode && firstRow.parentNode.nodeName === 'THEAD') return;
  const cells = Array.from(firstRow.cells);
  if (cells.length > 0 && cells.every((c) => c.nodeName === 'TH')) return;
  for (const cell of cells) {
    if (cell.nodeName === 'TH') continue;
    const th = document.createElement('th');
    while (cell.firstChild) th.appendChild(cell.firstChild);
    cell.replaceWith(th);
  }
}

/** A literal <br> inside a SIMPLE table's cell would otherwise turndown into
 *  a real newline (turndown's default `br` rule), breaking the one-line-per-
 *  row GFM pipe format -- neutralize it the same way the old preprocessTables
 *  did (a marker restored to a literal <br> by convertPageHtml's own final
 *  string pass, once the whole page is already plain markdown text). */
function neutralizeBreaksForPipeTable(table: DomTableElement): void {
  for (const br of Array.from(table.querySelectorAll('br'))) {
    br.replaceWith('¶BR¶');
  }
}

/** DEV-PLAN point 4's "else" branch: strip everything presentational
 *  (classes, styles, id, colgroup, data- and aria- attributes, legacy layout
 *  attributes) and any remaining aui chrome, WITHOUT touching structure or
 *  nesting — no flattening of lists, no collapsing rows/cells into one. */
function sanitizeForCleanTable(table: DomElement): void {
  for (const el of Array.from(table.querySelectorAll('colgroup, col'))) el.remove();
  removeAuiCruftNodes(table);

  const stripAttrs = (el: DomElement): void => {
    const names = Array.from(el.attributes).map((a) => a.name); // snapshot -- attributes is a live collection
    for (const name of names) {
      const lower = name.toLowerCase();
      if (STRIP_ATTR_EXACT.has(lower) || STRIP_ATTR_PREFIXES.some((p) => lower.startsWith(p))) {
        el.removeAttribute(name);
      }
    }
  };
  stripAttrs(table);
  for (const el of Array.from(table.querySelectorAll<DomElement>('*'))) stripAttrs(el);
}

/**
 * What one `<a href>` should point at after the import. An ATTACHMENT always
 * wins over a page: the `view-file` macro renders as a link whose path is the
 * HOST PAGE's own (`…/pages/<id>/Title?preview=%2F…%2Ffile.pdf`), so resolving
 * the content id first turned every attached document on 42 pages of the reference space into a
 * link back to the page the reader was already on. Kept here, in the one place
 * both the turndown rule and the raw-table pass go through, rather than left
 * to each caller's own resolveLink to remember.
 */
function resolveHref(ctx: PageConversionContext, href: string): string | undefined {
  return ctx.resolveAsset?.(href)?.url ?? ctx.resolveLink(href);
}

/**
 * Links/images inside a table marked for raw HTML passthrough will NEVER be
 * visited by turndown's own per-page links-rewrite/img-rewrite rules (a
 * `.keep()`-style rule reads the node's CURRENT outerHTML directly and never
 * recurses into children) -- so this replicates the same resolution +
 * fallback behavior those rules apply everywhere else on the page, right
 * here in the DOM, before the table gets frozen into a string.
 */
function resolveLinksAndImagesWithin(root: DomElement, ctx: PageConversionContext): void {
  for (const a of Array.from(root.querySelectorAll('a'))) {
    const href = a.getAttribute('href') || '';
    const resolved = resolveHref(ctx, href);
    if (resolved) a.setAttribute('href', resolved);
  }
  for (const img of Array.from(root.querySelectorAll('img'))) {
    const src = img.getAttribute('src') || '';
    if (/\/placeholder\/error/.test(src)) {
      img.remove();
      continue;
    }
    // An emoticon inside a raw table used to fall through to the alt-text
    // branch below, which is how "⭐" and "⚒️" became the literal English
    // words "star" and "hammer and pick" — everywhere ELSE on the page the
    // `emoticons` turndown rule handles them. Same conversion, same helper.
    if (/emoticon|emoji/.test(img.className || '')) {
      const emoji = emoticonToText({
        fallback: img.getAttribute('data-emoji-fallback'),
        shortname: img.getAttribute('data-emoji-shortname') ?? img.getAttribute('data-emoji-short-name'),
        emojiId: img.getAttribute('data-emoji-id'),
        alt: img.getAttribute('alt'),
        className: img.className || '',
      });
      if (emoji) img.replaceWith(emoji);
      else img.remove();
      continue;
    }
    const resolved = ctx.resolveImage(src);
    if (resolved) {
      img.setAttribute('src', resolved);
      continue;
    }
    const asset = ctx.resolveAsset?.(src);
    if (asset?.isImage) {
      img.setAttribute('src', asset.url);
      continue;
    }
    const alt = img.getAttribute('alt') || '';
    if (asset) {
      // A non-image attachment: a link, not an <img> pointing at a video.
      const link = img.ownerDocument?.createElement('a');
      if (link) {
        link.setAttribute('href', asset.url);
        link.textContent = alt || asset.filename;
        img.replaceWith(link);
        continue;
      }
    }
    if (alt) img.replaceWith(alt);
    else img.remove();
  }
}

// ---------------------------------------------------------------------------
// Round 16b: a cell's background colour, carried over into OUR fixed palette
// of tokens. Confluence's own "cell background" feature writes the colour in
// one of a few shapes depending on version/deployment (server/DC vs cloud,
// which export_view generation rendered it) -- an attribute, an inline
// style, or a class -- so all of them are read, defensively: whatever
// doesn't parse is simply not a colour, never a thrown error.
//
// BG_TOKENS/bgClass and the A1-style cell addressing below are a byte-for-
// byte duplicate of web/src/markdown/tableSyntax.ts's own contract (the
// shared vocabulary round 17 introduces for the editor's own colour palette
// and the pipe-table metadata line) -- NOT an import: tsconfig.node.json
// (server's own program) only includes server/shared/db, and
// tableSyntax.ts lives in web/, a boundary this round's own instructions
// keep this file on the right side of. Keep the two definitions in sync by
// hand if the palette or the addressing scheme ever changes.
// ---------------------------------------------------------------------------

/** The fixed background palette -- shared with the editor/reading-mode token set (round 17). Values must match tableSyntax.ts's BG_TOKENS exactly; order is cosmetic. */
export const BG_TOKENS = ['yellow', 'green', 'teal', 'blue', 'purple', 'red', 'orange', 'gray'] as const;
export type BgToken = (typeof BG_TOKENS)[number];

/** The class a token renders as on a complex table's `<td>`/`<th>` -- markdown.css (round 17, web/**, not this round's zone) is the single source of truth for what it looks like in either theme. */
export function bgClass(token: BgToken): string {
  return `folio-bg-${token}`;
}

const HEX_COLOR_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB_COLOR_RE = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)$/i;
const TRANSPARENT_KEYWORDS = new Set(['transparent', 'inherit', 'initial', 'unset', 'none', '']);

/**
 * Normalizes any of the colour forms this round reads into a plain
 * `#rrggbb` (lowercase, 6 digits), or null when it isn't a colour at all --
 * an explicit transparent/inherit/empty value, or text this doesn't
 * recognize. Never throws: an unrecognized value is just "no colour".
 */
export function parseHexColor(raw: string): string | null {
  const text = raw.trim();
  if (!text || TRANSPARENT_KEYWORDS.has(text.toLowerCase())) return null;

  const hex = HEX_COLOR_RE.exec(text);
  if (hex) {
    let digits = hex[1].toLowerCase();
    if (digits.length === 3) digits = digits.split('').map((c) => c + c).join('');
    return `#${digits}`;
  }

  // Defensive fallback -- not one of the shapes DEV-PLAN names, but cheap to
  // accept: an rgb()/rgba() background-color is a real form some hand-edited
  // or older export carries instead of a hex literal.
  const rgb = RGB_COLOR_RE.exec(text);
  if (rgb) {
    const alpha = rgb[4] === undefined ? 1 : Number.parseFloat(rgb[4]);
    if (!Number.isFinite(alpha) || alpha <= 0) return null; // fully transparent
    const channels = [rgb[1], rgb[2], rgb[3]].map((n) => Math.min(255, Number.parseInt(n, 10)));
    if (channels.some((n) => !Number.isFinite(n))) return null;
    return `#${channels.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
  }

  return null;
}

interface Hsl {
  h: number; // 0-360
  s: number; // 0-100
  l: number; // 0-100
}

function hexToHsl(hex: string): Hsl {
  const digits = hex.replace('#', '');
  const r = Number.parseInt(digits.slice(0, 2), 16) / 255;
  const g = Number.parseInt(digits.slice(2, 4), 16) / 255;
  const b = Number.parseInt(digits.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s: s * 100, l: l * 100 };
}

/**
 * Saturation below this reads as "no real hue" -- gray, whatever the hue
 * happens to compute to. Confluence's own two grey swatches (#F4F5F7,
 * #DFE1E6) measure s=15.8%/12.3%; every one of its other swatches (yellow/
 * green/blue/red/purple/teal, subtle and bold) measures s=69.8-100%. 25%
 * sits in the middle of that ~54-point gap, nowhere near either side --
 * see the report for the full measured table.
 */
const GRAY_SATURATION_THRESHOLD = 25;

/**
 * Hue-wheel boundaries, degrees, that Confluence's own 6 hued swatches
 * (measured from the hex values this round's DEV-PLAN task gives) land
 * inside with a comfortable margin: red 12°, yellow 48°, green 149-151°,
 * teal 187-188°, blue 214-216°, purple 250°. `orange` has no Confluence
 * swatch of its own -- carved out of the 36°-wide gap between red and
 * yellow for a custom/hand-picked colour that lands there (Confluence's own
 * picker never produces one, which is also why our own token dictionary
 * needing it at all comes from the editor's palette, round 17, not from
 * anything this importer has ever seen in the wild).
 */
const HUE_BOUNDARIES: [number, BgToken][] = [
  [25, 'red'],
  [40, 'orange'],
  [70, 'yellow'],
  [172, 'green'],
  [202, 'teal'],
  [236, 'blue'],
  [300, 'purple'],
  [360, 'red'],
];

function hueToToken(h: number): BgToken {
  const hue = ((h % 360) + 360) % 360;
  for (const [max, token] of HUE_BOUNDARIES) {
    if (hue < max) return token;
  }
  return 'red'; // unreachable -- the last boundary is 360
}

/**
 * hex (`#rrggbb`) -> our palette token. Saturation decides gray vs. a real
 * hue FIRST (see GRAY_SATURATION_THRESHOLD) -- otherwise grey's own hue
 * (Confluence's swatch measures ~220°) would land in the blue bucket.
 */
export function hexToBgToken(hex: string): BgToken {
  const { h, s } = hexToHsl(hex);
  return s < GRAY_SATURATION_THRESHOLD ? 'gray' : hueToToken(h);
}

/**
 * Any recognized colour form (raw attribute/style/class text) -> our token,
 * or null for "no colour" -- unparsed and transparent both land here,
 * deliberately indistinguishable (DEV-PLAN: "an unknown color → none").
 */
export function resolveBgToken(raw: string | null | undefined): BgToken | null {
  if (!raw) return null;
  const hex = parseHexColor(raw);
  return hex ? hexToBgToken(hex) : null;
}

/**
 * Pulls a `background-color` declaration's value out of a full inline
 * `style="..."` attribute -- Confluence writes just that one declaration,
 * but this defensively tolerates others around it, `!important`, and
 * case/spacing variance.
 */
function styleBackgroundColor(style: string): string | null {
  const m = /background-color\s*:\s*([^;]+)/i.exec(style);
  return m ? m[1].replace(/!important/i, '').trim() : null;
}

/**
 * Classes seen for a cell's own highlight colour across Confluence
 * versions: `highlight-<hex>` (the on-prem/server export_view shape) and
 * assorted `highlight[-_]?colou?r[-_]?<hex>` camelCase/kebab variants
 * (DEV-PLAN: "highlightColour..."). Defensive: any class token that reduces
 * to a bare hex once a leading "highlight" (+ optional colour/color +
 * separators) is stripped counts; anything else is left alone.
 */
function classHighlightColor(classAttr: string): string | null {
  for (const cls of classAttr.split(/\s+/)) {
    if (!cls) continue;
    const stripped = cls.replace(/^highlight[-_]?(?:colou?r)?[-_]?/i, '');
    if (stripped === cls) continue; // no "highlight..." prefix at all
    if (HEX_COLOR_RE.test(stripped)) return stripped;
  }
  return null;
}

/**
 * Reads a background colour off ONE element, trying every known form in
 * turn (first match wins -- DEV-PLAN doesn't say what to do if more than
 * one is present on the same real export, and no Confluence version this
 * was written against emits more than one at once).
 */
function rawColorFromElement(el: DomElement): string | null {
  const attr = el.getAttribute('data-highlight-colour') ?? el.getAttribute('data-highlight-color');
  if (attr && attr.trim()) return attr;

  const style = el.getAttribute('style');
  const fromStyle = style ? styleBackgroundColor(style) : null;
  if (fromStyle) return fromStyle;

  const cls = el.className || '';
  return cls ? classHighlightColor(cls) : null;
}

/**
 * A cell's own colour wins; its row's is only a fallback when the cell
 * itself carries no signal at all. Confluence has no documented "row
 * background" feature (the picker is per-cell) but this makes one behave
 * sensibly if a defensively-parsed row-level style/class/attribute is ever
 * actually seen, WITHOUT inventing a row-level construct anywhere
 * downstream -- both output shapes (the class on a complex table's `<td>`,
 * the `A1:token` entry for a simple one) are already per-cell, so "the row
 * is yellow" is written here as "every one of its cells is yellow".
 */
function cellBgToken(cell: DomElement, row: DomElement): BgToken | null {
  return resolveBgToken(rawColorFromElement(cell)) ?? resolveBgToken(rawColorFromElement(row));
}

interface CellBgEntry {
  row: number; // 0-based within table.rows, header included
  col: number; // 0-based within its row's cells
  token: BgToken;
}

/**
 * Every cell in the table with a resolved colour, addressed by its position
 * in `table.rows`/`row.cells` -- read BEFORE any attribute-stripping or
 * heading-row rewrite touches the table, since both of those can discard
 * the very attributes this reads (see the two call sites in processTables).
 */
function extractTableBg(table: DomTableElement): CellBgEntry[] {
  const out: CellBgEntry[] = [];
  Array.from(table.rows).forEach((row, rowIdx) => {
    Array.from(row.cells).forEach((cell, colIdx) => {
      const token = cellBgToken(cell, row);
      if (token) out.push({ row: rowIdx, col: colIdx, token });
    });
  });
  return out;
}

/** `0 -> A`, `25 -> Z`, `26 -> AA` -- byte-for-byte the same algorithm as web/src/markdown/tableSyntax.ts's columnLabel (see this section's own header comment on why it's duplicated, not imported). */
function columnLabel(col: number): string {
  let out = '';
  let n = col;
  while (n >= 0) {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  }
  return out;
}

/**
 * Applies each resolved colour as the ONLY class on a complex table's cell
 * -- called AFTER sanitizeForCleanTable has already stripped every original
 * class/style/data- attribute, so there is nothing else to collide with.
 * Addresses by the same (row, col) extractTableBg captured;
 * sanitizeForCleanTable/resolveLinksAndImagesWithin only ever strip
 * attributes or rewrite href/src, never add/remove/reorder rows or cells,
 * so the indices still point at the right element.
 */
function applyBgClasses(table: DomTableElement, entries: readonly CellBgEntry[]): void {
  for (const entry of entries) {
    const cell = table.rows[entry.row]?.cells[entry.col];
    cell?.setAttribute('class', bgClass(entry.token));
  }
}

/**
 * Formats the `bg=A1:yellow,B2:green` payload for the metadata line, sorted
 * column-then-row the same way web/src/markdown/tableSyntax.ts's own
 * compareCellKeys does (cosmetic -- it's a dict either way -- but matching
 * it means an import and a hand-edit of the same table produce the same
 * ordering, not just an equivalent one). Row/col here are 0-based
 * table.rows/row.cells positions; row 0 is always the header
 * (ensureHeadingRow forces it, the same convention tableSyntax.ts's own
 * HEADER_ROW addressing assumes), so the sheet row number is simply
 * `row + 1` -- `A1` is header col A, `A2` the first body row.
 */
function formatBgAttrPayload(entries: readonly CellBgEntry[]): string | null {
  if (entries.length === 0) return null;
  const sorted = [...entries].sort((a, b) => a.col - b.col || a.row - b.row);
  return sorted.map((e) => `${columnLabel(e.col)}${e.row + 1}:${e.token}`).join(',');
}

/**
 * A simple table's colours can't be written into the DOM at all -- by the
 * time turndown's gfm rule is done, there is no per-cell node left, just a
 * string built from each cell's own recursively-converted content. Instead
 * this drops an invisible marker paragraph right before the `<table>`,
 * which turndown converts to its own line the same as any other paragraph
 * (guaranteeing exactly one blank line on each side, the same padding gfm's
 * own table rule gets -- see turndown's `join()`, which caps adjoining
 * blank lines at one regardless of how many either side asks for).
 * convertPageHtml's final string pass (same idea as its existing ¶BR¶
 * fixup) turns the marker back into the real metadata line, in the exact
 * placement web/src/markdown/tableSyntax.ts's own writer uses: ABOVE the
 * table with a blank line, not "right under the header delimiter" (that
 * phrasing is DEV-PLAN's; tableSyntax.ts's own doc comment explains why it
 * deviates -- measured against four independent parsers, that is the only
 * placement all of them read back as a table with a non-table line before
 * it, not inside it, and the under-the-delimiter shape survives there only
 * as a read-only legacy fallback, not something new output should target).
 * The marker text is plain ASCII letters/digits/`:`/`,`, chosen so
 * turndown's own markdown-escaping (backslash/asterisk/underscore/
 * brackets/leading `-+#>` and digit-dot patterns) never touches it.
 */
const TABLE_BG_MARKER_RE = /¶FOLIO-TABLE-BG:([^¶]*)¶/g;

function insertSimpleTableBgMarker(table: DomTableElement, document: DomDocument, entries: readonly CellBgEntry[]): void {
  const payload = formatBgAttrPayload(entries);
  if (!payload) return;
  const marker = document.createElement('p');
  marker.textContent = `¶FOLIO-TABLE-BG:${payload}¶`;
  table.parentNode?.insertBefore(marker, table);
}

/** Classifies and handles every table in the document. Skips a table nested
 *  inside another table entirely: a nested <table> unconditionally makes its
 *  ANCESTOR complex (COMPLEX_CELL_TAGS includes TABLE), and that ancestor's
 *  own sanitizeForCleanTable/resolveLinksAndImagesWithin already sweep the
 *  whole subtree (including the nested table) -- classifying the nested
 *  table a SECOND time as its own top-level entry would be redundant at
 *  best, and at worst leaves a stray TABLE_RAW_MARKER attribute sitting
 *  inside the ancestor's own frozen outerHTML forever (the `folio-raw-table`
 *  turndown rule only strips the marker off the OUTER node it actually
 *  fired for, never recursing into already-frozen descendants).
 *
 *  Round 28 briefly had a second skip here, `insideKeptHtmlBlock`: a table
 *  inside an expand macro was FORCED onto the clean-HTML branch, because
 *  round 16 kept the whole `<details>` verbatim and a pipe table built inside
 *  one would never have reached the file. Round 28b converts an expand's body
 *  like any other content (see buildTurndownService's `folio-details-block`),
 *  so that exception is gone and a table in a `<details>` is classified on its
 *  own merits again — which is what turns page 2440233005's thirteen frozen
 *  HTML tables into thirteen pipe tables. */
function processTables(document: DomDocument, ctx: PageConversionContext): void {
  for (const table of Array.from(document.querySelectorAll<DomTableElement>('table'))) {
    if (table.parentElement && table.parentElement.closest('table')) continue;
    reduceCellBlocks(table);
    // Round 28: AFTER reduceCellBlocks, never before — the `<p>` Confluence
    // wraps each `<li>`'s content in has to be gone before the item's nodes
    // are spliced into a single cell line, and reduceCellBlocks' own `<br>`
    // bookkeeping needs the list still standing as one element to know that
    // something follows the paragraph before it.
    reduceCellLists(table);
    // Round 16b: read colours BEFORE either branch mutates the table -- a
    // simple table's ensureHeadingRow can rebuild row 0's cells from scratch
    // (dropping their attributes) and a complex table's sanitizeForCleanTable
    // strips class/style/data- unconditionally; either would erase the very
    // signal this reads if it ran first.
    const bg = extractTableBg(table);
    if (isSimpleTable(table)) {
      stripPipeTableObstacles(table);
      ensureHeadingRow(table, document);
      neutralizeBreaksForPipeTable(table);
      insertSimpleTableBgMarker(table, document, bg);
    } else {
      // Links/images FIRST: sanitizeForCleanTable strips every class and
      // data- attribute, which is exactly what tells an <img> apart as an
      // emoticon (`class="emoticon…" data-emoji-id="…"`). Running it first
      // is how "⚒️" used to come out as the words "hammer and pick".
      resolveLinksAndImagesWithin(table, ctx);
      sanitizeForCleanTable(table);
      applyBgClasses(table, bg);
      table.setAttribute(TABLE_RAW_MARKER, '1');
    }
  }
}

/**
 * Round 16 entry point: runs every export_view DOM preprocessing pass above
 * and returns the resulting HTML as a string for turndown. `ctx` is only
 * needed for tables that end up frozen as raw HTML (see
 * resolveLinksAndImagesWithin) -- everywhere else on the page, link/image
 * resolution stays exactly as it was, handled by convertPageHtml's own
 * per-page turndown rules.
 */
export function preprocessConfluenceDom(html: string, ctx: PageConversionContext): string {
  const dom = new JSDOM(html);
  try {
    const { document } = dom.window;
    convertExpandMacros(document);
    unwrapCommentMarkers(document);
    convertStatusLozenges(document);
    convertPageTrees(document);
    demoteBodyHeadings(document);
    unwrapListItemParagraphs(document);
    removeAuiCruftNodes(document.body);
    processTables(document, ctx);
    return document.body.innerHTML;
  } finally {
    dom.window.close(); // a full import job can preprocess hundreds of pages in one loop -- don't accumulate jsdom windows
  }
}

/**
 * Confluence callout macro -> GFM alert. Matched on the class SUFFIX, never
 * as a bare substring: every one of these macros also carries the shared base
 * class `confluence-information-macro`, so the old `/information/` entry
 * (checked first) matched a `warning`, a `note` and a `tip` alike and
 * collapsed every callout of a ~259-page import into "> [!NOTE]" — on one real
 * fixture, 16 of 16 panels came out as a note.
 *
 * `note` -> WARNING and `warning` -> CAUTION is not a typo: Confluence's
 * "note" is the yellow attention box and its "warning" is the red one, which
 * is what GFM calls WARNING and CAUTION respectively.
 */
const PANEL_KIND: [RegExp, string][] = [
  [/confluence-information-macro-(?:warning|error)\b/, 'CAUTION'],
  [/confluence-information-macro-note\b/, 'WARNING'],
  [/confluence-information-macro-tip\b/, 'TIP'],
  [/confluence-information-macro-(?:information|info)\b/, 'NOTE'],
  [/aui-message-(?:error|warning)\b/, 'CAUTION'],
  [/aui-message-success\b/, 'TIP'],
  [/aui-message-(?:info|information)\b/, 'NOTE'],
];

/** on-prem export_view also states the kind in plain words on the wrapper
 *  (`role="region" aria-label="Note"`) — a second, independent signal used
 *  when the class carries no recognizable suffix. */
const PANEL_ARIA_KIND: Record<string, string> = {
  note: 'WARNING',
  warning: 'CAUTION',
  error: 'CAUTION',
  info: 'NOTE',
  information: 'NOTE',
  tip: 'TIP',
};

function classTokenSet(node: { className?: string | null }): Set<string> {
  return new Set(String(node.className || '').split(/\s+/).filter(Boolean));
}

/** Every line of an alert's body prefixed with the blockquote marker. */
function quoteLines(content: string): string {
  return content
    .trim()
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
}

const PANEL_HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';

/**
 * The element's own start tag, children excluded — `<details>`, `<details
 * open="">`, `<summary class="x">`. `&` and `"` are the only two characters
 * that can end a double-quoted attribute value early; `<`/`>` are legal
 * inside one and every parser reads them literally.
 */
function startTagHtml(node: DomElement): string {
  const attrs = Array.from(node.attributes)
    .map((a) => ` ${a.name}="${a.value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`)
    .join('');
  return `<${node.nodeName.toLowerCase()}${attrs}>`;
}

/** The `<summary>` a `<details>` opens with, or null. Direct children only, and
 *  only the FIRST one — a (malformed) second `<summary>` is somebody's content
 *  and must not silently vanish, so the `folio-details-summary` rule below
 *  drops exactly the element this returns and keeps any other. */
function detailsSummary(details: DomElement): DomElement | null {
  return Array.from(details.children).find((child) => child.nodeName === 'SUMMARY') ?? null;
}

/** Builds a fresh TurndownService with the panel/code/task/emoji rules — everything context-FREE (doesn't need to know about other pages or assets). Link/image rules are added per-page (see convertPageHtml) since they need page context. */
export function buildTurndownService(): TurndownService {
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  td.use(gfm);
  // turndown has no rule of its own for either, so their raw CSS/JS text would
  // be emitted as page content. stripConfluenceCruft already removes both from
  // every export_view; this is the net for any other entry point.
  td.remove(['style', 'script']);

  // Round 16: a table preprocessConfluenceDom already classified complex and
  // fully sanitized must ALWAYS come out as that already-clean HTML,
  // regardless of what turndown-plugin-gfm's own `tables` rule would have
  // done with it (its `.keep()` fallback only triggers when row 0 isn't an
  // all-<th> heading row -- unrelated to cell complexity; a complex table
  // WITH a real heading row would otherwise be run through gfm's normal
  // per-cell recursive conversion and come out broken). Added via addRule
  // (rules.array), which turndown always checks before either gfm's own
  // `table` rule or its `.keep()` entries, so this wins regardless of
  // registration order.
  td.addRule('folio-raw-table', {
    filter: (node) => node.nodeName === 'TABLE' && node.getAttribute(TABLE_RAW_MARKER) === '1',
    replacement: (_content, node) => {
      node.removeAttribute(TABLE_RAW_MARKER); // internal-only marker -- never visible in the output
      return `\n\n${node.outerHTML}\n\n`;
    },
  });

  /*
   * Round 28b — an expand macro's WRAPPER stays HTML, its BODY becomes
   * markdown.
   *
   * Round 16 reached for `td.keep(['details','summary'])` and said so out
   * loud: turndown's keep replacement prints `node.outerHTML` no matter what
   * its children converted to, so "there's no way to get markdown-converted
   * content inside a kept element without a much more invasive rule". True
   * about `keep` — but it kept far more than it had to. Only the two TAGS
   * have no markdown equivalent; everything between them does, and freezing
   * it cost three real things:
   *   1. no table inside an expand could ever be a pipe table (thirteen on
   *      page 2440233005 alone) — round 28 chased that for a whole round
   *      through cell formatting before finding the frozen block underneath;
   *   2. LINKS inside an expand were never rewritten. The link rules live on
   *      the markdown conversion (convertPageHtml's `links-rewrite`), which
   *      a kept subtree never reaches, so every collapsed block on every
   *      imported page still pointed at Confluence — the same leak we closed
   *      everywhere else;
   *   3. the body was one opaque HTML block in the editor, uneditable.
   *
   * So the wrapper is printed by hand and `content` — the children's real
   * markdown, summary excluded — goes between the tags, padded with a BLANK
   * LINE on each side. The blank lines are the whole trick and they are not
   * cosmetic: by CommonMark an HTML block ends at the first blank line, so
   * what follows is parsed as markdown, and the bare `</details>` line opens
   * a second HTML block that closes the element. It is the shape github's own
   * collapsed sections use, the shape `rehypeRaw` stitches back into one
   * element for the reading view, and — one line at a time — the exact shape
   * this project's own `/expand` slash command writes
   * (web/src/editor/block-commands.ts's `insertExpand`), which is what lets
   * live mode show an imported expand as a real disclosure widget
   * (`collectDetailsBlocks`) instead of an opaque HTML block.
   *
   * Still verbatim: the `<details>`/`<summary>` tags themselves, attributes
   * and all (`<details open>` survives, and the editor reads it). Newly
   * converted: everything inside.
   */
  td.addRule('folio-details-block', {
    filter: 'details',
    replacement: (content, node) => {
      const summary = detailsSummary(node);
      const open = `${startTagHtml(node)}${summary ? summary.outerHTML : ''}`;
      const body = content.trim();
      return body ? `\n\n${open}\n\n${body}\n\n</details>\n\n` : `\n\n${open}\n\n</details>\n\n`;
    },
  });

  // The summary belongs on the OPENING line, inside the HTML block, where the
  // renderer (and `parseDetailsOpen` in the editor) look for it -- so the
  // `details` rule above prints it and this one drops it from the body it
  // would otherwise land in. Kept verbatim rather than converted: between
  // `<summary>` and `</summary>` on one line there is no blank line yet, so
  // that text is still raw HTML and markdown written there wouldn't render.
  // A stray `<summary>` with no `<details>` around it is nobody's body and
  // keeps its own markup, exactly as round 16's `.keep()` left it.
  td.addRule('folio-details-summary', {
    filter: 'summary',
    replacement: (_content, node) => {
      const parent = node.parentNode;
      const printedByParent = parent?.nodeName === 'DETAILS' && detailsSummary(parent) === node;
      return printedByParent ? '' : node.outerHTML;
    },
  });

  td.addRule('confluence-panels', {
    // Matched on whole class TOKENS, not substrings. Three real wrappers were
    // being swept up by the old substring test and each one broke something:
    //  - `code panel pdl`, the `code` macro's own wrapper (93 pages of the reference space) — the
    //    fenced block ended up nested inside a quote;
    //  - `confluence-information-macro-body`, the INNER half of a callout that
    //    the same rule had already matched on its parent — one alert per
    //    callout came out doubly quoted;
    //  - `panelContent`, likewise inner (it survives `panel\b` only by luck).
    filter: (node) => {
      if (node.nodeName !== 'DIV') return false;
      const tokens = classTokenSet(node);
      if (tokens.has('code')) return false;
      return tokens.has('confluence-information-macro') || tokens.has('aui-message') || tokens.has('panel');
    },
    replacement: (content, node) => {
      const cls = node.className || '';
      const label = (node.getAttribute('aria-label') || '').trim().toLowerCase();
      const kind = PANEL_KIND.find(([re]) => re.test(cls))?.[1] ?? PANEL_ARIA_KIND[label];
      // A bare `panel` macro (no kind anywhere) is not a callout at all — it's
      // Confluence's "put a coloured box around this" primitive, and on the reference
      // fixtures 13 of its 14 uses wrap nothing but a section HEADING. Forcing
      // those into an alert buried the heading inside a blockquote and erased
      // it from the page outline, so an untyped panel is simply unwrapped and
      // its content kept exactly as authored.
      if (!kind) {
        if (node.querySelector?.(PANEL_HEADING_SELECTOR)) return `\n\n${content.trim()}\n\n`;
        return `\n\n> [!NOTE]\n${quoteLines(content)}\n\n`;
      }
      return `\n\n> [!${kind}]\n${quoteLines(content)}\n\n`;
    },
  });

  td.addRule('confluence-code', {
    filter: (node) => node.nodeName === 'PRE' && /syntaxhighlighter/.test(node.className || ''),
    replacement: (_c, node) => {
      const params = node.getAttribute('data-syntaxhighlighter-params') || '';
      const lang = (params.match(/brush:\s*([a-z0-9]+)/i) || [])[1] || '';
      return `\n\n\`\`\`${lang}\n${(node.textContent || '').replace(/\n$/, '')}\n\`\`\`\n\n`;
    },
  });

  td.addRule('confluence-tasks', {
    filter: (node) => node.nodeName === 'LI' && /task-list-item|inline-task/.test((node.parentNode?.className || '') + ' ' + (node.className || '')),
    replacement: (content, node) => {
      const checked = /checked/.test(node.className || '') || node.querySelector?.('input[checked]');
      return `- [${checked ? 'x' : ' '}] ${content.trim()}\n`;
    },
  });

  // An `iframe` macro's embed (a Figma board, a Loom recording, a Google
  // form) has no markdown equivalent, and turndown's default for an unknown
  // empty element is to emit nothing at all — so the embed simply vanished.
  // A link to whatever it framed keeps the reference reachable.
  td.addRule('confluence-iframe', {
    filter: 'iframe',
    replacement: (_c, node) => {
      const src = (node.getAttribute('src') || '').trim();
      if (!src) return '';
      const title = (node.getAttribute('title') || '').replace(/[[\]]/g, '').trim();
      return `\n\n[${title || src}](${src})\n\n`;
    },
  });

  td.addRule('emoticons', {
    filter: (node) => node.nodeName === 'IMG' && /emoticon|emoji/.test(node.className || ''),
    replacement: (_c, node) =>
      emoticonToText({
        fallback: node.getAttribute('data-emoji-fallback'),
        // Cloud writes `data-emoji-shortname`, Server/DC `data-emoji-short-name` — read both.
        shortname: node.getAttribute('data-emoji-shortname') ?? node.getAttribute('data-emoji-short-name'),
        emojiId: node.getAttribute('data-emoji-id'),
        alt: node.getAttribute('alt'),
        className: node.className || '',
      }),
  });

  return td;
}

// ---------------------------------------------------------------------------
// Emoticons -> text. Two real-world gaps in the old fallback||alt logic
// (both measured against live exports, see the tests):
//  - Cloud's OWN custom emoji (`data-emoji-id="atlassian-check_mark"`) carry
//    the SHORTCODE as their fallback (`data-emoji-fallback=":check_mark:"`),
//    so pages imported with literal ":check_mark:" text;
//  - Server/DC export_view has NO data-emoji-fallback at all — only
//    `data-emoji-id="1f6a9"` (the unicode codepoint(s) in hex) and a words-y
//    alt ("triangular flag"), so pages imported with the words instead of 🚩.
// ---------------------------------------------------------------------------

/** Atlassian's built-in custom emoji (id `atlassian-<name>`) -> closest unicode. */
const ATLASSIAN_EMOJI: Record<string, string> = {
  check_mark: '✅', cross_mark: '❌', minus: '➖', plus: '➕', question_mark: '❓',
  warning: '⚠️', info: 'ℹ️', light_bulb_on: '💡', light_bulb_off: '🔅',
  yellow_star: '⭐', blue_star: '🌟', red_star: '🔴', green_star: '🟢',
};

/** Legacy Server emoticon set, keyed by the `emoticon-<name>` class suffix. */
const LEGACY_EMOTICONS: Record<string, string> = {
  smile: '🙂', sad: '🙁', cheeky: '😛', laugh: '😆', wink: '😉',
  'thumbs-up': '👍', 'thumbs-down': '👎', information: 'ℹ️', tick: '✅',
  cross: '❌', warning: '⚠️', plus: '➕', minus: '➖', question: '❓',
  'light-on': '💡', 'light-off': '🔅', 'yellow-star': '⭐', 'red-star': '🔴',
  'green-star': '🟢', 'blue-star': '🌟', heart: '❤️', 'broken-heart': '💔',
};

const SHORTCODE_RE = /^:[a-z0-9_+-]+:$/i;
const CODEPOINTS_RE = /^[0-9a-f]{2,6}(?:-[0-9a-f]{2,6})*$/i;

export function emoticonToText(attrs: {
  fallback?: string | null;
  shortname?: string | null;
  emojiId?: string | null;
  alt?: string | null;
  className?: string | null;
}): string {
  const fallback = attrs.fallback?.trim();
  if (fallback && !SHORTCODE_RE.test(fallback)) return fallback;

  const emojiId = attrs.emojiId?.trim() ?? '';
  if (CODEPOINTS_RE.test(emojiId)) {
    try {
      return emojiId
        .split('-')
        .map((h) => String.fromCodePoint(Number.parseInt(h, 16)))
        .join('');
    } catch {
      /* not a valid codepoint sequence after all — fall through */
    }
  }
  if (emojiId.startsWith('atlassian-')) {
    const mapped = ATLASSIAN_EMOJI[emojiId.slice('atlassian-'.length)];
    if (mapped) return mapped;
  }

  const classMatch = /(?:^|\s)emoticon-([a-z-]+)/.exec(attrs.className ?? '');
  if (classMatch && LEGACY_EMOTICONS[classMatch[1]]) return LEGACY_EMOTICONS[classMatch[1]];

  const shortname = attrs.shortname?.trim();
  if (shortname && SHORTCODE_RE.test(shortname)) {
    const mapped = ATLASSIAN_EMOJI[shortname.slice(1, -1)];
    if (mapped) return mapped;
  }
  // Nothing recognizable: prefer the shortcode (`:name:` at least names the
  // emoji) over a words-y alt, over nothing.
  return shortname || fallback || attrs.alt || '';
}

/** A link to a Confluence person, in any of the shapes the fixtures carry:
 *  the `confluence-userlink`/`user-mention` class the on-prem renderer puts on
 *  a mention, and the `/display/~<user>` (Server) / `/people/<id>` (Cloud)
 *  profile paths. */
function isConfluenceUserLink(node: { className?: string | null }, href: string): boolean {
  const tokens = classTokenSet(node);
  if (tokens.has('confluence-userlink') || tokens.has('user-mention')) return true;
  return /\/(?:display\/~|people\/)/.test(href);
}

export interface ResolvedAsset {
  /** The stored asset's URL (`/a/<sha>/<name>`). */
  url: string;
  /** The attachment's own filename — the natural link text when there's no better one. */
  filename: string;
  isImage: boolean;
}

export interface PageConversionContext {
  /** Given a Confluence <a href>, return a relative link to another imported page, or undefined to leave it as-is (external). */
  resolveLink: (href: string) => string | undefined;
  /** Given a Confluence <img src>, return the replacement (already-uploaded asset) URL, or undefined if it couldn't be resolved. */
  resolveImage: (src: string) => string | undefined;
  /** Given any Confluence URL that names an attachment (`?preview=…`, `/download/attachments/…`), the stored asset behind it. Images and non-images alike — the caller decides how to render each. */
  resolveAsset?: (url: string) => ResolvedAsset | undefined;
  /** This page's body.storage, when the caller fetched it — see applyStorageRepairs. Omitted/empty simply skips those repairs. */
  storageXml?: string;
  /** Where this instance's Jira lives, if the caller knows: issue key -> browse URL. Without it a recovered key lands as plain text rather than a link to a host we never verified. */
  jiraBrowseUrl?: (key: string) => string | undefined;
}

/**
 * Converts one page's export_view HTML to markdown. Link/image rules are
 * added and removed around a single turndown() call (turndown has no
 * per-call context, only per-instance rules) — same pattern the hands-run
 * script used.
 */
export function convertPageHtml(td: TurndownService, html: string, ctx: PageConversionContext): string {
  const cleaned = stripConfluenceCruft(html);
  const repaired = ctx.storageXml ? applyStorageRepairs(cleaned, ctx.storageXml, ctx.jiraBrowseUrl) : cleaned;
  const preprocessed = preprocessConfluenceDom(repaired, ctx);

  td.addRule('links-rewrite', {
    filter: 'a',
    replacement: (content, node) => {
      const rawHref = node.getAttribute('href') || '';
      // A @mention of a Confluence user. The link goes to a profile page on an
      // instance the Folio reader may not even have an account on, and its URL
      // spells out the person's corporate email address (`/display/~name@co`)
      // in the page body. The display name is the only part worth keeping.
      if (isConfluenceUserLink(node, rawHref)) return content.trim() || '';
      const resolved = resolveHref(ctx, rawHref);
      const href = resolved ?? rawHref;
      if (!content.trim()) return href ? `<${href}>` : '';
      // Confluence often renders a pasted URL as its own link text. When the
      // href gets rewritten (an edit-v2 URL to its view form, say), a label
      // still spelling out the OLD URL is actively misleading.
      const label = content.trim() === rawHref.trim() ? href : content;
      return `[${label}](${href})`;
    },
  });
  td.addRule('img-rewrite', {
    filter: (node) => node.nodeName === 'IMG' && !/emoticon|emoji/.test(node.className || ''),
    replacement: (_c, node) => {
      const src = node.getAttribute('src') || '';
      const alt = (node.getAttribute('alt') || '').replace(/[[\]]/g, '');
      if (/\/placeholder\/error/.test(src)) return '';
      const resolved = ctx.resolveImage(src);
      if (resolved) return `![${alt}](${resolved})`;
      // Confluence renders a NON-image attachment (a video, a document) with
      // an <img> too — a generated placeholder thumbnail. Pointing an image
      // tag at the real file would render as broken; a link to it doesn't.
      const asset = ctx.resolveAsset?.(src);
      if (asset) return asset.isImage ? `![${alt}](${asset.url})` : `[${alt || asset.filename}](${asset.url})`;
      // Nothing to point at: keep the alt text as plain words rather than
      // emitting `![alt]()`, an image reference with an empty src that every
      // renderer draws as a broken-image icon.
      return alt;
    },
  });

  let md: string;
  try {
    md = td.turndown(preprocessed);
  } catch (err) {
    md = `_Conversion error: ${String(err)}_\n\n` + preprocessed.replace(/<[^>]+>/g, ' ').slice(0, 4000);
  }
  td.rules.array = td.rules.array.filter((r) => r.name !== 'links-rewrite' && r.name !== 'img-rewrite');

  return md
    .replace(/¶BR¶/g, '<br>')
    .replace(CELL_LIST_MARKER_RE, (_m, depth: string, kind: string, arg: string) => renderCellListMarker(Number(depth), kind, Number(arg)))
    .replace(TABLE_BG_MARKER_RE, (_m, payload: string) => `[//]: # (folio-table: bg=${payload})`)
    .replace(PAGETREE_MARKER_RE, '::pagetree')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Round 19 point 5b (prod bug): a Confluence page whose export_view converts
 * to nothing visible — genuinely blank in Confluence, or entirely macro-only
 * content this importer drops — used to land as a bare "# Title" with an
 * empty body underneath, indistinguishable from a lost-content bug. This
 * makes the "nothing was lost, the source page was just empty" case
 * explicit with a `[!NOTE]` alert instead of silence.
 *
 * The bracket form `[!NOTE]` is the ONLY syntax web/src/markdown/alerts.ts
 * recognizes (its own doc comment: "the marker must be alone on the
 * blockquote's first line, e.g. \"> [!NOTE]\"") — a bare `> !NOTE` without
 * brackets (the broken shape seen in already-imported prod content) is not a
 * valid alert marker at all and renders as a plain, un-styled blockquote.
 */
export function composePageBody(title: string, md: string, language?: string): string {
  const content = md.trim() || `> [!NOTE]\n> ${serverText('import.emptyPage', language)}`;
  return `# ${title}\n\n${content}\n`;
}

// ---------------------------------------------------------------------------
// Tree -> file paths (unit-tested directly)
// ---------------------------------------------------------------------------

export interface PathAssignable {
  id: string;
  title: string;
  children: string[];
}

/**
 * Assigns each page a repo-relative path: a page with imported children
 * becomes <slug>/index.md (a directory), a leaf becomes <slug>.md, siblings
 * get -2/-3/... suffixes on a translit-slug collision. rootId always maps to
 * "index.md" directly under `baseDir` (a nested import target -> baseDir is
 * non-empty and IS the root's own directory, matching how a normal Folio
 * space's own top-level index.md works).
 */
export function assignPaths(rootId: string, pagesById: Map<string, PathAssignable>, baseDir: string): Map<string, string> {
  const rel = new Map<string, string>();
  const prefix = baseDir ? `${baseDir.replace(/\/+$/, '')}/` : '';
  rel.set(rootId, `${prefix}index.md`);

  function assign(id: string, dir: string): void {
    const page = pagesById.get(id);
    if (!page) return;
    const kids = page.children.filter((k) => pagesById.has(k));
    const used = new Set<string>();
    for (const kid of kids) {
      const kidPage = pagesById.get(kid)!;
      let slug = translitSlug(kidPage.title);
      let n = 2;
      while (used.has(slug)) slug = `${translitSlug(kidPage.title)}-${n++}`;
      used.add(slug);
      const grandkids = kidPage.children.filter((k) => pagesById.has(k));
      rel.set(kid, grandkids.length ? `${dir}${slug}/index.md` : `${dir}${slug}.md`);
      assign(kid, grandkids.length ? `${dir}${slug}/` : dir);
    }
  }
  assign(rootId, prefix);
  return rel;
}

// ---------------------------------------------------------------------------
// Job registry + orchestration
// ---------------------------------------------------------------------------

interface JobInternal extends ImportJob {
  userId: string;
  /**
   * Round 24, both pending shared/contracts.ts additions to ImportJob (see
   * the SERVER round-24 report): non-fatal notes worth surfacing in the
   * finished job's summary (an unknown Confluence stamp id, a node the
   * converter skipped) and how many whiteboards this run turned into Folio
   * boards. Extra properties on the object `getJob` returns — structurally
   * assignable to today's ImportJob, so the wire response already carries
   * them and the UI can start reading them the moment the contract lands.
   */
  warnings: string[];
  boards: number;
}

const jobs = new Map<string, JobInternal>();

export function getJob(id: string): ImportJob | undefined {
  const job = jobs.get(id);
  if (!job) return undefined;
  const { userId: _userId, ...pub } = job;
  return pub;
}

export function getJobOwner(id: string): string | undefined {
  return jobs.get(id)?.userId;
}

function setJob(id: string, patch: Partial<JobInternal>): void {
  const current = jobs.get(id);
  if (current) jobs.set(id, { ...current, ...patch });
}

export interface ResolvedTargetSpace {
  slug: string;
  /** true iff this call just created the space — the route uses this to skip the editor+ role check (any authenticated user may create a space, round 2) rather than requiring one on a space that didn't exist a moment ago. */
  isNew: boolean;
}

/**
 * Bug fix: the import UI's "new space" mode sends `targetSpace` as the
 * DESIRED NAME of a space that doesn't exist yet, not an existing slug —
 * `POST /api/import/confluence` used to unconditionally require editor+ role
 * on `targetSpace`, which 404s ("space not found") for a name that was
 * never supposed to exist yet. Called from the ROUTE (synchronously, before
 * ever starting the async job) rather than from inside runImportJob, for two
 * reasons: (1) the caller must be permission-checked (or the space created)
 * before any work starts, not discovered mid-job; (2) unlike the "no
 * targetSpace at all" case below (which waits for the Confluence root page's
 * title — only known after the network walk), an EXPLICIT targetSpace name
 * is already known immediately, so there's no reason to defer.
 *
 * Existence is checked BOTH ways — the literal input treated as a slug, and
 * its translit-slug form — because "new space" mode's typed name might
 * translit to an slug that ALREADY exists (e.g. typing "Engineering" when
 * "engineering" is already a space): that has to resolve to the EXISTING
 * space (with a permission check), not silently create "engineering-2" and
 * import into the wrong place. Only when NEITHER matches is a new space
 * actually created — same as POST /api/spaces with just a name: git init,
 * DB row, and the creator granted admin on it.
 */
export async function resolveOrCreateTargetSpace(targetSpaceInput: string, createdBy: string): Promise<ResolvedTargetSpace> {
  if (await storage.spaceExists(targetSpaceInput)) return { slug: targetSpaceInput, isNew: false };
  const asSlug = translitSlug(targetSpaceInput);
  if (asSlug !== targetSpaceInput && (await storage.spaceExists(asSlug))) return { slug: asSlug, isNew: false };
  const created = await storage.createSpace(targetSpaceInput, createdBy);
  await authStore.setMembership(created.slug, createdBy, 'admin');
  return { slug: created.slug, isNew: true };
}

// ---------------------------------------------------------------------------
// Round 22b: saved Confluence credentials — credentialId instead of a raw
// token, with save=true persisting a freshly-typed one for next time.
// ---------------------------------------------------------------------------

/**
 * POST /api/import/confluence body — a pending shared/contracts.ts addition
 * (see the SERVER round-22b report for the exact shape). Round 12's own
 * confluenceSourceSchema (contracts.ts, unchanged by this round) required
 * `auth` unconditionally; this superset makes it OPTIONAL and adds
 * `credentialId` as the alternative, plus `save`. Exactly one of
 * credentialId/auth is required. Defined here rather than in contracts.ts
 * per this round's own instructions ("do not touch contracts.ts") — the route
 * parses request bodies with this schema, then resolveImportAuth below
 * turns the result into the concrete `ConfluenceSource` startImportJob has
 * always taken (its own signature is untouched by this round).
 */
export const confluenceImportBodySchema = z
  .object({
    pageUrl: z.string().min(1),
    credentialId: z.string().optional(),
    auth: z.object({ kind: z.enum(['pat', 'basic']), token: z.string().min(1), email: z.string().optional() }).optional(),
    save: z.boolean().optional(),
    targetSpace: z.string().optional(),
    targetPath: z.string().default(''),
    includeChildren: z.boolean().default(true),
  })
  .refine((v) => Boolean(v.credentialId) !== Boolean(v.auth), {
    message: 'provide exactly one of credentialId or auth',
    path: ['auth'],
  });
export type ConfluenceImportBody = z.infer<typeof confluenceImportBodySchema>;

/**
 * Maps this round's saved-credential `kind` ('pat' | 'cloud') onto round
 * 12's own wire vocabulary for auth.kind ('pat' | 'basic') — 'cloud' and
 * 'basic' mean the exact same thing (HTTP Basic auth with an email); the
 * two names just come from two different rounds' own choices. See
 * userConfluenceCredentials.ts's module doc comment for the same note from
 * the other direction.
 */
function credentialToAuth(cred: userConfluenceCredentials.DecryptedConfluenceCredential): ConfluenceSource['auth'] {
  if (cred.kind === 'pat') return { kind: 'pat', token: cred.token };
  return { kind: 'basic', token: cred.token, email: cred.email };
}

/**
 * Resolves what auth to actually use for one import run — called from the
 * ROUTE, synchronously, before startImportJob (same "resolve before the
 * async job starts" shape as resolveOrCreateTargetSpace above):
 *  - credentialId given -> decrypt the CALLER'S OWN saved credential
 *    (ownership enforced by userConfluenceCredentials.getDecryptedTokenById
 *    the exact same way deleteCredential does it elsewhere — id = $1 AND
 *    user_id = $2); missing OR belonging to someone else is a 404,
 *    identical treatment either way, never a 403 that would confirm the id
 *    is real.
 *  - otherwise -> the raw `auth` from the request body is used as-is (the
 *    "one-off import" path DEV-PLAN explicitly keeps around). When `save`
 *    is true, it's ALSO persisted under the host parsed from pageUrl, so
 *    the NEXT import against this host can use credentialId instead — a
 *    cloud credential with no email fails this save with a 400
 *    (userConfluenceCredentials.saveCredential's own validation); the
 *    import itself still proceeds with whatever raw auth was given either
 *    way, since save is a side effect layered on top, not a precondition.
 *  - the caller must supply EXACTLY one of credentialId/auth — the route's
 *    own confluenceImportBodySchema already enforces this before this
 *    function ever runs, so a call with neither is only reachable from a
 *    test calling this function directly, not from a validated request.
 */
export async function resolveImportAuth(
  userId: string,
  pageUrl: string,
  input: { credentialId?: string; auth?: ConfluenceSource['auth']; save?: boolean },
): Promise<ConfluenceSource['auth']> {
  if (input.credentialId) {
    const cred = await userConfluenceCredentials.getDecryptedTokenById(userId, input.credentialId);
    if (!cred) throw notFound('a saved Confluence credential');
    return credentialToAuth(cred);
  }
  if (!input.auth) throw badRequest('either credentialId or auth is required');
  if (input.save) {
    const host = new URL(parseConfluenceUrl(pageUrl).base).host;
    const kind: userConfluenceCredentials.ConfluenceCredentialKind = input.auth.kind === 'pat' ? 'pat' : 'cloud';
    await userConfluenceCredentials.saveCredential(userId, host, kind, input.auth.token, { email: input.auth.email });
  }
  return input.auth;
}

/**
 * Starts the import as a fire-and-forget background task and returns
 * immediately with the job's initial (queued) state — GET /api/import/jobs/:id
 * polls for progress. Errors during the async run are caught and recorded on
 * the job (status: 'error'), never thrown back into an unattended promise.
 */
/** Who the import is done for: the author of its commit, and the language of the text the import itself writes into pages. */
export interface ImportIdentity {
  name: string;
  email: string;
  lang?: string;
}

export function startImportJob(source: ConfluenceSource, userId: string, editorIdentity: ImportIdentity): ImportJob {
  const id = randomUUID();
  const job: JobInternal = { id, userId, status: 'queued', total: 0, done: 0, currentTitle: null, error: null, targetSpace: source.targetSpace ?? null, warnings: [], boards: 0 };
  jobs.set(id, job);
  void runImportJob(id, source, editorIdentity).catch((err) => {
    // Belt-and-suspenders: runImportJob already catches internally and sets
    // status:'error', but if something throws BEFORE its own try/catch is
    // reached (e.g. a bug in this wiring), the job must not just hang at
    // 'queued' forever with no explanation.
    setJob(id, { status: 'error', error: sanitizeErrorMessage(err), errorCode: confluenceJobErrorCode(err) });
  });
  return getJob(id)!;
}

/** Never let a raw error (which could echo back request internals) leak the auth token — it's never IN the error text we construct ourselves, but a fetch()-level TypeError could in principle include the URL; Confluence REST paths never carry the token (it's header-only), so this is a defensive strip, not the primary guard. */
function sanitizeErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/Basic\s+\S+/gi, 'Basic [redacted]');
}

// ---------------------------------------------------------------------------
// Round 24: whiteboards. A Confluence whiteboard is not a page — it has no
// export_view HTML at all — so a /whiteboard/<id> URL takes a separate branch
// through the SAME job, target-space resolution and commit machinery, and
// lands as a kind='board' .excalidraw.svg instead of a markdown page.
// ---------------------------------------------------------------------------

export type ImportTarget = { kind: 'page' } | { kind: 'whiteboard'; target: whiteboard.WhiteboardTarget };

/**
 * Decides which importer a pageUrl belongs to, and rejects the two whiteboard
 * shapes that can only ever fail, up front with an actionable message rather
 * than as an opaque 404 halfway through a job:
 *  - a /whiteboard/<id> URL on a non-Cloud host — Server/Data Center has no
 *    whiteboards, so there is nothing to fetch (parseWhiteboardUrl throws);
 *  - a Cloud whiteboard with a `pat` credential — Confluence Cloud
 *    authenticates with HTTP Basic email:api-token ('cloud' in round 22b's
 *    saved-credential vocabulary, 'basic' in round 12's wire vocabulary), and
 *    a bare bearer PAT is an on-prem-shaped credential that Cloud's REST v2 +
 *    GraphQL gateway will simply 401.
 * Anything without /whiteboard/<id> in it is a page, exactly as before —
 * ordinary page URLs never match, so this cannot change their behaviour.
 * Called from the ROUTE (synchronously, before the job starts) and again from
 * runImportJob, the same "resolve before the async job starts" shape
 * resolveImportAuth/resolveOrCreateTargetSpace already use.
 */
export function resolveImportTarget(pageUrl: string, auth: ConfluenceSource['auth']): ImportTarget {
  if (!whiteboard.looksLikeWhiteboardUrl(pageUrl)) return { kind: 'page' };
  const target = whiteboard.parseWhiteboardUrl(pageUrl);
  if (!target) return { kind: 'page' };
  if (auth.kind !== 'basic') {
    throw badRequest('importing a Confluence Cloud whiteboard needs a Cloud credential (email + API token), not a personal access token');
  }
  return { kind: 'whiteboard', target };
}

/**
 * One whiteboard -> one Folio board. Shares every downstream step with the
 * page importer: the same target-space rules (an explicit slug must exist; no
 * targetSpace means a new space named after the board), the same
 * getEntryIdByExactPath id reuse (writing a FRESH id onto a path some other id
 * already owns is a guaranteed unique-constraint violation on the next scan,
 * not a harmless duplicate), the same write-then-scanSpace-then-commit tail.
 * The board file itself is written exactly as storage.createPage writes a new
 * board — folio-id comment + svg — so scanSpace indexes it as kind='board'
 * with the id we chose.
 */
async function runWhiteboardImportJob(
  jobId: string,
  source: ConfluenceSource,
  target: whiteboard.WhiteboardTarget,
  auth: ConfluenceAuth,
  editorIdentity: ImportIdentity,
): Promise<void> {
  setJob(jobId, { total: 1 });
  const { metadata, document } = await whiteboard.fetchWhiteboard(target, auth.header);
  setJob(jobId, { currentTitle: metadata.title });

  // The target space is resolved BEFORE conversion (it used to be after):
  // link resolution below needs the space's persisted Confluence map and its
  // pages index to turn a board's Confluence links into in-app links.
  let spaceSlug = source.targetSpace;
  if (spaceSlug) {
    if (!(await storage.spaceExists(spaceSlug))) throw badRequest(`target space "${spaceSlug}" does not exist`);
  } else {
    const created = await storage.createSpace(metadata.title, null);
    spaceSlug = created.slug;
  }
  setJob(jobId, { targetSpace: spaceSlug });

  // Confluence links on the board -> app-absolute Folio links. App-absolute
  // (not relative): an excalidraw element's `link` opens as a plain href from
  // whatever page URL the viewer is on, so only `/s/<space>/p/<id>` is stable.
  const priorMap = await readConfluenceMap(spaceSlug);
  const entryByPath = new Map((await storage.listEntries(spaceSlug)).map((e) => [e.relPath, e]));
  const resolveTarget = (rawUrl: string) => {
    const ref = extractConfluenceContentId(rawUrl);
    if (!ref || ref.kind === 'database') return undefined;
    const rel = priorMap[ref.id];
    return rel ? entryByPath.get(rel) : undefined;
  };

  // Pure, offline, and selfchecked (dangling bindings / clipped bound text
  // throw here rather than silently shipping a board that opens wrong).
  const converted = whiteboard.whiteboardDocumentToSvg(document, {
    resolveLink: (rawUrl) => {
      const entry = resolveTarget(rawUrl);
      return entry ? `/s/${spaceSlug}/p/${entry.id}` : undefined;
    },
    resolveLinkLabel: (rawUrl) => resolveTarget(rawUrl)?.title,
    linkLegendHeading: serverText('whiteboard.linksHeading', editorIdentity.lang),
  });

  const dir = (source.targetPath ?? '').replace(/^\/+|\/+$/g, '');
  const relPath = `${dir ? `${dir}/` : ''}${translitSlug(metadata.title)}.excalidraw.svg`;
  const boardId = (await storage.getEntryIdByExactPath(spaceSlug, relPath)) ?? ulid();
  const absPath = path.join(storage.getSpaceDir(spaceSlug), relPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, storage.withBoardId(converted.svg, boardId), 'utf8');

  await mergeConfluenceMap(spaceSlug, { [target.whiteboardId]: relPath });
  await storage.scanSpace(spaceSlug);
  await git.commitAll(storage.getRepoDir(spaceSlug), `docs: import board from Confluence «${metadata.title}»`, editorIdentity);

  setJob(jobId, { status: 'done', done: 1, boards: 1, currentTitle: null, warnings: converted.warnings });
}

async function runImportJob(jobId: string, source: ConfluenceSource, editorIdentity: ImportIdentity): Promise<void> {
  setJob(jobId, { status: 'running' });
  const auth = buildAuthHeader(source.auth);

  const importTarget = resolveImportTarget(source.pageUrl, source.auth);
  if (importTarget.kind === 'whiteboard') {
    await runWhiteboardImportJob(jobId, source, importTarget.target, auth, editorIdentity);
    return;
  }

  const parsed = parseConfluenceUrl(source.pageUrl);
  const rootId = await resolvePageId(parsed, auth);

  const tree = await walkTree(parsed.base, rootId, auth, source.includeChildren);
  const ids = [...tree.keys()];
  setJob(jobId, { total: ids.length });

  const pages = new Map<string, RawPage>();
  const attachmentsByPage = new Map<string, UploadedAttachment[]>();

  let doneCount = 0;
  for (const id of ids) {
    const raw = await fetchPageContent(parsed.base, id, auth, tree.get(id) ?? []);
    pages.set(id, raw);
    setJob(jobId, { currentTitle: raw.title });

    const attachments = await fetchAttachments(parsed.base, id, auth);
    const uploaded: UploadedAttachment[] = [];
    for (const att of attachments) {
      if (att.fileSize !== null && att.fileSize > MAX_ATTACHMENT_BYTES) continue;
      try {
        const buf = await confluenceGetBinary(parsed.base, att.downloadPath, auth);
        if (buf.length > MAX_ATTACHMENT_BYTES) continue; // no fileSize was reported, and it turned out to be huge
        // Confluence knows the real media type; guessImageMime only ever knew
        // the handful of image extensions and called everything else
        // application/octet-stream.
        const mime = att.mediaType || guessImageMime(att.title);
        const stored = await assets.putAsset(buf, { mime, filename: att.title }, null);
        uploaded.push({ filenameTail: sanitizeFilenameTail(att.title), filename: att.title, url: stored.url, isImage: mime.startsWith('image/') });
      } catch {
        // one bad attachment must not sink the whole page's import
      }
    }
    attachmentsByPage.set(id, uploaded);

    doneCount += 1;
    setJob(jobId, { done: doneCount });
  }

  const root = pages.get(rootId);
  if (!root) throw new Error('root page fetch failed');

  // ---- resolve/create the target space --------------------------------
  let spaceSlug = source.targetSpace;
  if (spaceSlug) {
    if (!(await storage.spaceExists(spaceSlug))) throw badRequest(`target space "${spaceSlug}" does not exist`);
  } else {
    const created = await storage.createSpace(root.title, null);
    spaceSlug = created.slug;
  }
  setJob(jobId, { targetSpace: spaceSlug });

  // ---- tree -> paths, then write every file straight to disk (same shape
  // as a normal Folio page: gray-matter frontmatter + body), THEN a single
  // scanSpace() indexes everything at once -- mirrors exactly how the
  // hands-run script wrote a whole tree of files before any indexing step
  // existed to read them back. ------------------------------------------
  const pathAssignable = new Map<string, PathAssignable>(
    [...pages.values()].map((p) => [p.id, { id: p.id, title: p.title, children: p.children }]),
  );
  const relPaths = assignPaths(rootId, pathAssignable, source.targetPath);

  // Global filename-tail -> asset index (mirrors the hands-run script's
  // "search downloaded attachments by filename tail, preferring the current
  // page's own" behavior) -- export_view <img src> URLs don't carry a page id
  // in a directly-matchable form, only the attachment's own filename.
  const allAttachmentsByTail = new Map<string, (UploadedAttachment & { pageId: string })[]>();
  for (const [pageId, uploaded] of attachmentsByPage) {
    for (const att of uploaded) {
      const list = allAttachmentsByTail.get(att.filenameTail) ?? [];
      list.push({ ...att, pageId });
      allAttachmentsByTail.set(att.filenameTail, list);
    }
  }

  const td = buildTurndownService();
  const spaceDir = storage.getSpaceDir(spaceSlug);
  // Links to content imported by PREVIOUS jobs into this same space resolve
  // through the persisted map; this job's own pages (below) win over it.
  const priorMap = await readConfluenceMap(spaceSlug);

  for (const [id, page] of pages) {
    const relPath = relPaths.get(id);
    if (!relPath) continue;
    const myDir = path.posix.dirname(relPath) === '.' ? '' : `${path.posix.dirname(relPath)}/`;

    /** The attachment stored under this filename tail — this page's own copy wins over another page's. */
    const pickAttachment = (tail: string): UploadedAttachment | undefined => {
      const candidates = allAttachmentsByTail.get(tail);
      if (!candidates?.length) return undefined;
      return candidates.find((c) => c.pageId === id) ?? candidates[0];
    };
    const resolveAsset = (url: string): ResolvedAsset | undefined => {
      const name = extractConfluenceAttachmentName(url);
      const hit = name ? pickAttachment(sanitizeFilenameTail(name)) : undefined;
      return hit ? { url: hit.url, filename: hit.filename, isImage: hit.isImage } : undefined;
    };

    const ctx: PageConversionContext = {
      storageXml: page.storageXml,
      // Attachment hrefs are handled by the converter itself (resolveHref) —
      // it checks resolveAsset before ever calling this.
      resolveLink: (href) => {
        const ref = extractConfluenceContentId(href);
        if (!ref || ref.kind === 'database') return undefined; // databases are never imported
        const targetRel = relPaths.get(ref.id) ?? priorMap[ref.id];
        if (!targetRel) return normalizeUnresolvedConfluenceHref(href, parsed.base);
        return relLink(relPath, targetRel);
      },
      resolveImage: (src) => {
        const tail = sanitizeFilenameTail(safeDecodeUriComponent(src.split('?')[0].split('/').pop() || ''));
        const hit = pickAttachment(tail);
        return hit?.isImage ? hit.url : undefined;
      },
      resolveAsset,
    };

    const md = convertPageHtml(td, page.exportHtml, ctx);
    const siblings = page.parentId ? (pages.get(page.parentId)?.children ?? []).filter((k) => pages.has(k)) : [];
    const order = siblings.indexOf(id);
    // Reuse an EXISTING id if this path is already indexed (always true for the
    // confluence root landing on a brand-new space's own placeholder index.md;
    // possible for any page if re-importing over existing content) — minting a
    // fresh ulid here unconditionally caused a real bug: scanSpace's own upsert
    // keys ON CONFLICT (id), not (space_slug, path), so a fresh id at an
    // already-occupied path is a guaranteed unique-constraint violation on the
    // very next scan, not just a harmless "extra" page.
    const pageId = (await storage.getEntryIdByExactPath(spaceSlug, relPath)) ?? ulid();
    const fm: Record<string, unknown> = { id: pageId };
    if (order >= 0) fm.order = (order + 1) * 10;

    const body = composePageBody(page.title, md, editorIdentity.lang);
    const out = matter.stringify(body, fm);
    const absPath = path.join(spaceDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, out, 'utf8');
    void myDir; // computed for parity with the hands-run script's per-page asset dir; assets themselves already live in the global store, not alongside the page.
  }

  await mergeConfluenceMap(spaceSlug, Object.fromEntries([...relPaths].filter(([pid]) => pages.has(pid))));
  await storage.scanSpace(spaceSlug);
  await git.commitAll(storage.getRepoDir(spaceSlug), `docs: import from Confluence «${root.title}»`, editorIdentity);

  setJob(jobId, { status: 'done', currentTitle: null });
}

function relLink(fromRelPath: string, toRelPath: string): string {
  let r = path.posix.relative(path.posix.dirname('/' + fromRelPath), '/' + toRelPath);
  if (!r.startsWith('.')) r = './' + r;
  return r;
}

function sanitizeFilenameTail(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_');
}

function guessImageMime(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' };
  return map[ext] ?? 'application/octet-stream';
}
