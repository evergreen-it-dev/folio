import { createHash } from 'node:crypto';
/**
 * File storage + PostgreSQL-backed page index for Folio (round 4 PG core;
 * round 3 git-native layout; round 5 folder/readme/icon/cover bits).
 *
 * Content root moved from data/spaces/<slug> (round 1/2) to
 * data/repos/<slug>/<rootPath> (round 3) — a git clone (or `git init`'d
 * empty repo) per space, git-native. This module still owns all filesystem
 * I/O for page content; the index (id -> meta, space -> tree) lives in the
 * `pages_index` table, safe to drop and rebuild from a scan. Structural
 * mutations run under a per-space Redis advisory lock (server/db/redis.ts).
 *
 * Tree/rendering (round 3): a directory WITH index.md renders as before;
 * WITHOUT index.md but WITH README.md, the README *is* the directory's page
 * (kind doc); with neither, it's a synthetic, unpersisted 'folder' node
 * (id `dir:<relpath>`) — see getTree(). `_templates/` is excluded from the
 * tree (round 5) but still indexed/searchable and reachable via
 * listTemplates().
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import * as matterNS from 'gray-matter';
import { ulid } from 'ulidx';
import type { CreatePageBody, FormDoc, PageKind, PageMeta, PageStatus, SpaceGitStatus, SpaceInfo, SpaceVisibility, TableColumn, TableDoc, TableView, TreeNode } from '../shared/contracts.js';
import { officeFormat } from '../shared/contracts.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { translitSlug } from './translit.js';
import { query, queryOne, withTransaction } from './db/pool.js';
import { withSpaceLock } from './db/redis.js';
import * as links from './links.js';
import * as git from './git.js';
import { setSpaceToken, removeSpaceToken, ensureAskpassScript } from './gitCredentials.js';
import { encodeCell, isTableParseError, parseTableFile, serializeTableFile } from '../shared/tables/index.js';
import { deriveFieldsFromColumns, isFormParseError, parseFormFile, serializeFormFile, systemColumns } from '../shared/forms/index.js';
import { decodeScenePayload, extractScenePayload } from './confluenceWhiteboard.js';
import { AGENT_FOLDER } from './agentPath.js';
import { serverText } from './serverText.js';

// gray-matter is CJS (`export =`). `import * as matterNS` typechecks and runs fine
// under tsx/Node, but under Vite/Vitest's esbuild-based CJS interop the callable
// lands on `.default` instead of on the namespace object itself — fall back to
// whichever one is actually a function so this module behaves the same in both.
const matter = (typeof matterNS === 'function' ? matterNS : (matterNS as unknown as { default: typeof matterNS }).default) as typeof matterNS;

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(SERVER_DIR, '..');
export const REPOS_DIR = path.join(APP_ROOT, 'data', 'repos');
const LEGACY_SPACES_DIR = path.join(APP_ROOT, 'data', 'spaces');
/** Exported for the trash round (server/trash/*): list/restore/purge/backfill resolve trash_items.trash_path against this root. */
export const TRASH_DIR = path.join(APP_ROOT, 'data', '.trash');
const TEMPLATES_DIR_NAME = '_templates';

/** Sentinel for pages with no explicit `order`: sorts after every explicitly-ordered sibling. */
const ORDER_SENTINEL = Number.MAX_SAFE_INTEGER;

export interface PageIndexEntry {
  id: string;
  space: string;
  /** POSIX path relative to the space's CONTENT ROOT (repo dir + rootPath), e.g. "architecture/data-flow.md". */
  relPath: string;
  absPath: string;
  kind: 'doc' | 'board' | 'table' | 'pdf' | 'office' | 'form';
  /** True when this entry represents its containing directory in the tree (index.md, or README.md when index.md is absent there). */
  isIndex: boolean;
  /** POSIX dir containing this file, relative to the content root ("" for root-level files). */
  dirPath: string;
  title: string;
  order: number;
  explicitOrder?: number;
  status: PageStatus;
  explicitStatus?: PageStatus;
  icon?: string;
  cover?: string;
  updatedAt: string;
  /**
   * Cached plain-text content — used for search and as a GET fallback. For
   * docs: the raw markdown body. For tables (round 26): the denormalized
   * "column name: value" text (see tableDocToPlainText below) plus the
   * surrounding head/tail prose. Boards never populate this.
   */
  body?: string;
}

// ---------------------------------------------------------------------------
// Space content-root resolution: repo dir + rootPath. rootPath rarely changes
// (set at space creation), so a cache refreshed at scan/creation time avoids
// making the extremely-hot spaceDir() async everywhere it's used.
// ---------------------------------------------------------------------------

const rootPathCache = new Map<string, string>();

function repoDir(space: string): string {
  if (!space || space.includes('/') || space.includes('\\') || space === '.' || space === '..' || space.includes('\0')) {
    throw badRequest('invalid space');
  }
  return path.join(REPOS_DIR, space);
}

/** The space's content root: data/repos/<slug>/<rootPath>. */
function spaceDir(space: string): string {
  const rootPath = rootPathCache.get(space) ?? '';
  return rootPath ? path.join(repoDir(space), rootPath) : repoDir(space);
}

function posixParent(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}
function dirBasename(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Guards a `parentPath`/`toParentPath` param: no leading "/", no "..", no traversal tricks. */
export function normalizeDirParam(p: string): string {
  const segments = (p ?? '')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s && s !== '.');
  if (segments.some((s) => s === '..' || s.includes('\0'))) throw badRequest('invalid path');
  return segments.join('/');
}

/** Resolves a relative link path (may contain "..") against the space root; rejects escapes. */
function normalizeResolvePath(p: string): string {
  const segments: string[] = [];
  for (const seg of (p ?? '').trim().split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (segments.length === 0) throw badRequest('path escapes the space root');
      segments.pop();
    } else {
      segments.push(seg);
    }
  }
  return segments.join('/');
}

function humanize(slug: string): string {
  return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function isUnderTemplates(relPath: string): boolean {
  return relPath === TEMPLATES_DIR_NAME || relPath.startsWith(`${TEMPLATES_DIR_NAME}/`);
}

// ---------------------------------------------------------------------------
// Text helpers: slugs, titles, frontmatter
// ---------------------------------------------------------------------------

/**
 * Round 1 used this to preserve casing/spacing in a board's filename (which
 * doubles as its title). Round 2's translitSlug() now names every NEW page/
 * board/space instead, so this is only still needed for uploaded asset
 * filenames below, where keeping the original name readable is what you want.
 */
function sanitizeFilenameStem(input: string): string {
  const illegalChars = ['\\', '/', ':', '*', '?', '"', '<', '>', '|'];
  let base = input.trim();
  for (const ch of illegalChars) base = base.split(ch).join('');
  base = base.replace(/\s+/g, ' ').trim();
  return base || `Board ${Date.now().toString(36)}`;
}

function sanitizeAssetFilename(original: string): string {
  const ext = path.extname(original).replace(/[^a-zA-Z0-9.]/g, '');
  const stemRaw = path.basename(original, path.extname(original));
  const stem = sanitizeFilenameStem(stemRaw).replace(/\s+/g, '-');
  return `${stem || 'asset'}${ext}`;
}

const H1_RE = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE_RE = /^(```+|~~~+)/;

/** Line index of the first true ATX H1 (single '#'), skipping fenced code blocks. -1 if none. */
function findH1LineIndex(lines: string[]): number {
  let inFence = false;
  let fenceMarker = '';
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const fenceMatch = FENCE_RE.exec(trimmed);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fenceMatch[1][0];
      } else if (trimmed.startsWith(fenceMarker)) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    const m = H1_RE.exec(lines[i]);
    if (m && m[1].trim()) return i;
  }
  return -1;
}

export function extractH1(body: string): string | null {
  const lines = body.split('\n');
  const idx = findH1LineIndex(lines);
  return idx === -1 ? null : H1_RE.exec(lines[idx])![1].trim();
}

/** Rewrites the first H1 in place; prepends one if the body has none. Pure — reused by collab.ts. */
export function replaceFirstH1(body: string, newTitle: string): string {
  const clean = newTitle.trim();
  const lines = body.split('\n');
  const idx = findH1LineIndex(lines);
  if (idx === -1) return `# ${clean}\n\n${body}`;
  lines[idx] = `# ${clean}`;
  return lines.join('\n');
}

/**
 * Makes sure a document body made from caller-supplied markdown names itself the
 * way the page was asked to be named. A doc's title IS its first H1 (extractH1;
 * without one the title falls back to the file's slug), so markdown handed to a
 * new page without an H1 would silently retitle it to "release-notes".
 *
 *  - The first non-blank line is an H1: the body is returned untouched, even when
 *    that heading differs from `title`. The heading is the page's real title and
 *    the file name was already derived from `title`; rewriting the caller's own
 *    heading would silently change their content, whereas keeping it only makes
 *    the title in the reply differ from the argument — and the reply states it.
 *  - Anything else (no heading, a paragraph or a fenced block first, a `##`
 *    heading, an empty string): `# <title>` and a blank line are put above it, the
 *    same starter heading a blank page gets. An H1 further down the body does not
 *    count: extractH1 would otherwise let it override the requested title.
 *
 * "First non-blank line" and "is an H1" use the very same test as extractH1 (an
 * ATX `# text` line, no indentation), so the answer here and the title that ends
 * up in the index cannot disagree. `body` must already be free of front matter.
 */
export function ensureLeadingTitle(body: string, title: string): string {
  const rest = body.replace(/^(?:[ \t]*\r?\n)+/, '');
  const firstLine = rest.split('\n', 1)[0];
  const m = H1_RE.exec(firstLine);
  if (m && m[1].trim()) return body;
  const heading = `# ${title.trim()}`;
  return rest.trim() === '' ? `${heading}\n` : `${heading}\n\n${rest}`;
}

function titleFallback(relPath: string, kind: PageKind): string {
  const base = path.basename(relPath);
  if (kind === 'board') return base.slice(0, -'.excalidraw.svg'.length);
  // `.table.md` must be stripped whole (round 26) — slicing only '.md' off a
  // table file's basename would leave a bogus ".table" suffix on the title.
  if (kind === 'table') return base.slice(0, -'.table.md'.length);
  // Same whole-suffix rule, round FORMS: `<slug>.form.md`.
  if (kind === 'form') return base.slice(0, -'.form.md'.length);
  // A FILE page (pdf/docx/xlsx/pptx) keeps its EXTENSION in the title — the
  // whole basename, not the stem (owner, 16.09: the same offer exported as
  // .pptx and .pdf sat in the tree as two identical-looking rows). Markdown,
  // boards and tables deliberately keep their stem: there the extension is
  // Folio's own storage detail, while here the file IS the page and its
  // format is what the reader needs to tell two rows apart.
  if (kind === 'pdf' || kind === 'office') return base;
  return base.slice(0, -'.md'.length);
}

function numericOrder(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function validStatus(v: unknown): PageStatus | undefined {
  return v === 'draft' || v === 'published' || v === 'archived' ? v : undefined;
}
function validStringField(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

interface FrontmatterFields {
  id: string;
  order?: number;
  status?: PageStatus;
  icon?: string;
  cover?: string;
}

/**
 * What `matter(file).content` reads back after `persistDocFrontmatter` wrote
 * `body`: the same text with a trailing newline guaranteed. A collab room's
 * Y.Text has no such guarantee (a user who typed at the end of the page leaves
 * it without one), so bindState compares the FILE against this — not against
 * the raw Y.Text — when it decides whether the file "moved on" while the room
 * was away. Without it a page whose text merely lacks the final "\n" looked
 * changed on every resume and got its whole body replaced (delete + reinsert),
 * which a client holding edits on top of the old text merges as a doubling.
 */
export function docFileBody(body: string): string {
  return body.endsWith('\n') ? body : `${body}\n`;
}

/** Serializes body + canonical frontmatter (id, order, status, icon, cover — only the ones present) and writes it. */
async function persistDocFrontmatter(abs: string, data: FrontmatterFields, body: string): Promise<void> {
  const fm: Record<string, unknown> = { id: data.id };
  if (data.order !== undefined) fm.order = data.order;
  if (data.status !== undefined) fm.status = data.status;
  if (data.icon !== undefined) fm.icon = data.icon;
  if (data.cover !== undefined) fm.cover = data.cover;
  const out = matter.stringify(docFileBody(body), fm);
  await fs.writeFile(abs, out, 'utf8');
}

/**
 * A client may PUT a full file (frontmatter block + body) instead of a bare
 * body — the collab Y.Text only ever carries the body, but round 5's "icon
 * picker writes through PUT markdown (frontmatter block)" implies the
 * client-authored payload can legitimately include one. Detected defensively
 * so either shape works; id/order/status in a submitted frontmatter block
 * are never trusted (the server stays authoritative for those).
 */
export function splitLeadingFrontmatter(markdown: string): { icon?: string; cover?: string; body: string } {
  if (!markdown.startsWith('---')) return { body: markdown };
  const parsed = matter(markdown);
  if (Object.keys(parsed.data).length === 0 && parsed.content === markdown) return { body: markdown };
  return { icon: validStringField(parsed.data.icon), cover: validStringField(parsed.data.cover), body: parsed.content };
}

/**
 * Sets (or, with `undefined`, removes) top-level `order` and `icon` keys in
 * `raw`'s leading frontmatter block, leaving every OTHER key and the whole body
 * exactly as they were. Used for `.table.md` files, whose frontmatter is the
 * table SCHEMA owned by shared/tables/codec.ts — persistDocFrontmatter would
 * throw the schema away, and re-serializing through the codec would need
 * `order` threaded through TableDoc. `lineWidth: -1` matches the codec's own
 * dump options so long labels/descriptions still never wrap.
 */
export function withTablePageFields(raw: string, order: number | undefined, icon: string | undefined): string {
  const parsed = matter(raw);
  const data: Record<string, unknown> = { ...parsed.data };
  if (order === undefined) delete data.order;
  else data.order = order;
  if (icon === undefined) delete data.icon;
  else data.icon = icon;
  return matter.stringify(parsed.content, data, { lineWidth: -1 } as Parameters<typeof matter.stringify>[2]);
}

const FOLIO_ID_RE = /^<!--\s*folio-id:\s*([A-Za-z0-9]+)\s*-->\s*$/;
const FOLIO_ORDER_RE = /^<!--\s*folio-order:\s*(-?\d+)\s*-->\s*$/;
// title/icon values ride base64-encoded (see encode/decodeBoardHeaderValue below), so the
// captured group is deliberately the base64 alphabet only — never raw user text.
const FOLIO_TITLE_RE = /^<!--\s*folio-title:\s*([A-Za-z0-9+/=]*)\s*-->\s*$/;
const FOLIO_ICON_RE = /^<!--\s*folio-icon:\s*([A-Za-z0-9+/=]*)\s*-->\s*$/;

/**
 * A board's title/icon are free-form user text (a title can contain quotes,
 * `-->`, angle brackets, newlines, emoji, Cyrillic — anything) but have to
 * live inside a single-line XML/SVG comment, which cannot contain a literal
 * newline or the two-character sequence `--` anywhere in it (not just as
 * `-->`) without corrupting the file. Rather than rejecting or stripping
 * characters (which would silently mangle a title the user actually typed),
 * the value is base64-encoded: the base64 alphabet (A-Za-z0-9+/=) contains
 * neither `-` nor `>` nor a newline, so ANY UTF-8 string round-trips exactly
 * and can never break out of the comment or the SVG.
 */
function encodeBoardHeaderValue(v: string): string {
  return Buffer.from(v, 'utf8').toString('base64');
}
function decodeBoardHeaderValue(v: string): string {
  return Buffer.from(v, 'base64').toString('utf8');
}

/**
 * A board file's own metadata block: the leading run of `<!-- folio-*: … -->`
 * comment lines, plus everything after it (`rest`) held VERBATIM.
 *
 * A `.excalidraw.svg` has no frontmatter — the id has always ridden in a
 * leading SVG comment, and `order` (round 22's tree reorder, unblocked here)
 * rides in a second one right below it for exactly the same reasons: it
 * travels with the file through git like a doc's frontmatter `order` does,
 * and it survives a full scanSpace rebuild — which a pages_index column
 * could not, since PG is a DERIVED index in this architecture (db/migrations/
 * 001_init.sql: "safe to drop and rebuild from a scan"). `title`/`icon`
 * (this round) are the doc-shaped fix for a board's title being its
 * filename: they now ride two more comments in the same block, base64-
 * encoded (see encodeBoardHeaderValue) — the filename itself is left alone,
 * so renaming a board no longer moves the file or breaks a link to it.
 *
 * `rest` is deliberately the raw remainder, never re-serialized: the
 * excalidraw scene payload embedded in `<metadata>` IS the drawing, and any
 * round-trip through an XML/SVG parser risks mangling it. An order-only
 * write therefore rewrites the comment lines and copies the scene byte
 * for byte.
 */
interface BoardHeader {
  id: string | null;
  order: number | undefined;
  title: string | undefined;
  icon: string | undefined;
  rest: string;
}

function splitBoardHeader(svg: string): BoardHeader {
  const lines = svg.split('\n');
  let id: string | null = null;
  let order: number | undefined;
  let title: string | undefined;
  let icon: string | undefined;
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    const idMatch = FOLIO_ID_RE.exec(line);
    if (idMatch) {
      if (id === null) id = idMatch[1];
      continue;
    }
    const orderMatch = FOLIO_ORDER_RE.exec(line);
    if (orderMatch) {
      if (order === undefined) order = Number(orderMatch[1]);
      continue;
    }
    const titleMatch = FOLIO_TITLE_RE.exec(line);
    if (titleMatch) {
      if (title === undefined) title = decodeBoardHeaderValue(titleMatch[1]);
      continue;
    }
    const iconMatch = FOLIO_ICON_RE.exec(line);
    if (iconMatch) {
      if (icon === undefined) icon = decodeBoardHeaderValue(iconMatch[1]);
      continue;
    }
    break; // first non-folio line — the SVG itself starts here
  }
  return { id, order, title, icon, rest: lines.slice(i).join('\n') };
}

/** Exported since the trash round: the trash backfill reads a trashed board's page id from the same leading comment scanSpace does — a second, parallel spelling of FOLIO_ID_RE would drift. */
export function extractBoardId(svg: string): string | null {
  return splitBoardHeader(svg).id;
}

function renderBoardHeader(id: string, order: number | undefined, title: string | undefined, icon: string | undefined): string {
  const lines = [`<!-- folio-id: ${id} -->`];
  if (order !== undefined) lines.push(`<!-- folio-order: ${order} -->`);
  if (title !== undefined) lines.push(`<!-- folio-title: ${encodeBoardHeaderValue(title)} -->`);
  if (icon !== undefined) lines.push(`<!-- folio-icon: ${encodeBoardHeaderValue(icon)} -->`);
  return `${lines.join('\n')}\n`;
}

/**
 * Strips any existing leading folio-* comment block and prepends the
 * canonical one, PRESERVING whatever id/order/title/icon was already
 * recorded in the file (see withBoardHeader for the variant that sets them
 * explicitly). Exported since round 24: the Confluence WHITEBOARD importer
 * writes board files straight to disk (same "write the whole tree, then
 * scanSpace once" shape the page importer has always used) and must stamp
 * the id the exact same way createPage/writeBoardSvg do — a second, parallel
 * spelling of this one-line format is precisely the kind of drift that
 * silently re-mints ids on the next scan.
 */
export function withBoardId(svg: string, id: string): string {
  const { order, title, icon, rest } = splitBoardHeader(svg);
  return renderBoardHeader(id, order, title, icon) + rest;
}

/**
 * Same, but with explicit `order`/`title`/`icon` (each undefined clears that
 * comment — e.g. no order comment falls back to title/name ordering, exactly
 * as a board with no order comment has always done). Note `svg`'s OWN header
 * is ignored: the caller supplies the authoritative values, mirroring how
 * writeBoardSvg already forces the canonical id regardless of what a client
 * PUTs — callers that mean to PRESERVE the current title/icon (an order-only
 * or an ordinary scene-only save) must read them off the current on-disk
 * header themselves first (see setBoardOrder/writeBoardSvg).
 */
export function withBoardHeader(svg: string, id: string, order: number | undefined, title: string | undefined, icon: string | undefined): string {
  return renderBoardHeader(id, order, title, icon) + splitBoardHeader(svg).rest;
}

/**
 * True if `svg` has a non-empty embedded excalidraw scene — the base64 blob
 * excalidraw's own SVG export puts in <metadata> between
 * `<!-- payload-start -->` and `<!-- payload-end -->`. Used only for the
 * blank-overwrite sanity guard below: a real excalidraw save always embeds
 * one, so a PUT with none is a strong signal of a client-side bug (e.g. a
 * save firing before the canvas finished hydrating), not a deliberate edit.
 */
function hasExcalidrawScenePayload(svg: string): boolean {
  const start = svg.indexOf('<!-- payload-start -->');
  const end = svg.indexOf('<!-- payload-end -->');
  if (start === -1 || end === -1 || end <= start) return false;
  return svg.slice(start + '<!-- payload-start -->'.length, end).trim().length > 0;
}

/** Number of live elements in an embedded scene; null means absent/corrupt. */
function excalidrawLiveElementCount(svg: string): number | null {
  const payload = extractScenePayload(svg)?.trim();
  if (!payload) return null;
  try {
    const scene = decodeScenePayload(payload);
    return Array.isArray(scene.elements) ? scene.elements.filter((element) => !element.isDeleted).length : null;
  } catch {
    // Older Excalidraw exports may store a plain base64 JSON scene.
    try {
      const parsed = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as {
        encoded?: string;
        elements?: Array<{ isDeleted?: boolean }>;
      };
      const scene = Array.isArray(parsed.elements)
        ? parsed
        : typeof parsed.encoded === 'string'
          ? (JSON.parse(parsed.encoded) as { elements?: Array<{ isDeleted?: boolean }> })
          : null;
      return Array.isArray(scene?.elements) ? scene.elements.filter((element) => !element.isDeleted).length : null;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// pages_index row <-> PageIndexEntry mapping
// ---------------------------------------------------------------------------

interface PagesIndexRow {
  id: string;
  space_slug: string;
  path: string;
  kind: 'doc' | 'board' | 'table' | 'pdf' | 'office' | 'form';
  title: string;
  sort_order: number | null;
  status: PageStatus | null;
  icon: string | null;
  cover: string | null;
  updated_at: string;
  plain_text: string | null;
  is_index: boolean;
}

function rowToEntry(row: PagesIndexRow): PageIndexEntry {
  const relPath = row.path;
  return {
    id: row.id,
    space: row.space_slug,
    relPath,
    absPath: path.join(spaceDir(row.space_slug), relPath),
    kind: row.kind,
    isIndex: row.is_index,
    dirPath: posixParent(relPath),
    title: row.title,
    order: row.sort_order ?? ORDER_SENTINEL,
    explicitOrder: row.sort_order ?? undefined,
    status: row.status ?? 'published',
    explicitStatus: row.status ?? undefined,
    icon: row.icon ?? undefined,
    cover: row.cover ?? undefined,
    updatedAt: new Date(row.updated_at).toISOString(),
    body: row.plain_text ?? undefined,
  };
}

async function upsertPagesIndexRow(entry: PageIndexEntry, fileMtime: Date, fileSize: number, restoredRule?: PageAccessRule): Promise<void> {
  // Round 26: a table's `body` is populated (by indexTableFile/writeTableDoc) with its
  // denormalized "column: value" text, same slot docs use for their markdown — see
  // PageIndexEntry.body's doc comment. Boards still index as unsearchable (null).
  // Round FORMS: a form's body is its title/description/field labels (indexFormFile) —
  // small, but enough that a form shows up for its own field names in search.
  const plainText = entry.kind === 'doc' || entry.kind === 'table' || entry.kind === 'form' ? (entry.body ?? '') : null;
  const sql = `INSERT INTO pages_index (id, space_slug, path, kind, title, sort_order, status, icon, cover, updated_at, plain_text, is_index, file_mtime, file_size, tsv)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
       setweight(to_tsvector('simple', unaccent($5)), 'A') ||
       setweight(to_tsvector('simple', unaccent(coalesce($15, ''))), 'B'))
     ON CONFLICT (id) DO UPDATE SET
       space_slug = EXCLUDED.space_slug, path = EXCLUDED.path, kind = EXCLUDED.kind,
       title = EXCLUDED.title, sort_order = EXCLUDED.sort_order, status = EXCLUDED.status,
       icon = EXCLUDED.icon, cover = EXCLUDED.cover,
       updated_at = EXCLUDED.updated_at, plain_text = EXCLUDED.plain_text, is_index = EXCLUDED.is_index,
       file_mtime = EXCLUDED.file_mtime, file_size = EXCLUDED.file_size, tsv = EXCLUDED.tsv`;
  const params = [
    entry.id,
    entry.space,
    entry.relPath,
    entry.kind,
    entry.title,
    entry.explicitOrder ?? null,
    entry.explicitStatus ?? null,
    entry.icon ?? null,
    entry.cover ?? null,
    entry.updatedAt,
    plainText,
    entry.isIndex,
    fileMtime,
    fileSize,
    plainText === null ? null : capForTsvector(plainText),
  ];
  if (!restoredRule) {
    await query(sql, params);
    return;
  }
  // A page coming back from the trash gets its access rule in the SAME
  // transaction as its index row: the row is not visible to anybody before the
  // rule is, so there is no moment at which a restored private page is open.
  await withTransaction(async (client) => {
    await client.query(sql, params);
    await insertPageAccess(client, entry.id, restoredRule);
  });
}

/**
 * Postgres refuses a tsvector over 1 MB ("string is too long for tsvector").
 * A single ~1.8 MB page in a connected repository hit exactly that (prod,
 * 15.09): the upsert threw, the space never finished indexing, and — through
 * the boot scan — took the whole server down. The column keeps the full text;
 * only what goes into the search VECTOR is capped. ~600 KB of UTF-8 input keeps
 * the vector comfortably under the limit even for text with few repeated
 * words, and the first 600 KB of a page is what search realistically needs.
 * Sliced by characters so a multi-byte letter is never cut in half.
 */
const TSVECTOR_INPUT_BYTE_BUDGET = 600_000;

export function capForTsvector(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= TSVECTOR_INPUT_BYTE_BUDGET) return text;
  let bytes = 0;
  let end = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (bytes + size > TSVECTOR_INPUT_BYTE_BUDGET) break;
    bytes += size;
    end += ch.length;
  }
  return text.slice(0, end);
}

// ---------------------------------------------------------------------------
// Boot-time layout migration + repo registration (round 3)
// ---------------------------------------------------------------------------

async function listDirs(dir: string): Promise<string[]> {
  try {
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    return dirents.filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name);
  } catch {
    return [];
  }
}

/** data/spaces/<slug> (round 1/2 layout) -> data/repos/<slug>, git-initialized if not already a repo. Runs once per directory (skips any slug already present under data/repos). */
export async function migrateLegacySpaces(): Promise<void> {
  const legacySlugs = await listDirs(LEGACY_SPACES_DIR);
  if (legacySlugs.length === 0) return;
  await fs.mkdir(REPOS_DIR, { recursive: true });
  const alreadyMigrated = new Set(await listDirs(REPOS_DIR));

  for (const slug of legacySlugs) {
    if (alreadyMigrated.has(slug)) continue;
    const from = path.join(LEGACY_SPACES_DIR, slug);
    const to = path.join(REPOS_DIR, slug);
    await fs.rename(from, to);
    if (!(await git.isGitRepo(to))) {
      await git.initWithCommit(to, 'init: import existing space');
    }
    // eslint-disable-next-line no-console
    console.log(`[migrate] moved data/spaces/${slug} -> data/repos/${slug}`);
  }
}

async function peekTitleFromRoot(dir: string): Promise<string | null> {
  for (const filename of ['index.md', 'README.md']) {
    try {
      const raw = await fs.readFile(path.join(dir, filename), 'utf8');
      const title = extractH1(matter(raw).content);
      if (title) return title;
    } catch {
      /* try the next filename */
    }
  }
  return null;
}

/** For every dir under data/repos not yet in the `spaces` registry, insert a row (rootPath '', no remote -> status 'local'). Visibility stays membership-based — an auto-registered space is invisible to non-admins until someone adds members, by design. */
async function registerReposOnBoot(): Promise<void> {
  await fs.mkdir(REPOS_DIR, { recursive: true });
  const slugs = await listDirs(REPOS_DIR);
  for (const slug of slugs) {
    const exists = await queryOne<{ exists: boolean }>('SELECT EXISTS(SELECT 1 FROM spaces WHERE slug = $1) AS exists', [slug]);
    if (exists?.exists) continue;
    const dir = path.join(REPOS_DIR, slug);
    const name = (await peekTitleFromRoot(dir)) ?? humanize(slug);
    await query(
      `INSERT INTO spaces (slug, name, repo_url, branch, root_path, status) VALUES ($1, $2, NULL, 'main', '', 'local') ON CONFLICT (slug) DO NOTHING`,
      [slug, name],
    );
    // eslint-disable-next-line no-console
    console.log(`[boot] registered pre-existing repo as space "${slug}"`);
  }
}

async function refreshRootPathCache(): Promise<void> {
  const rows = await query<{ slug: string; root_path: string }>('SELECT slug, root_path FROM spaces');
  rootPathCache.clear();
  for (const row of rows) rootPathCache.set(row.slug, row.root_path ?? '');
}

// ---------------------------------------------------------------------------
// Scanning (streaming: one file's body in memory at a time; skips unchanged
// files via (mtime, size) staleness so a re-scan of an unchanged 16k-file
// repo does almost no work — DEV-PLAN round 4 scan-perf follow-up)
// ---------------------------------------------------------------------------

/** Stable id for a doc whose frontmatter can't be parsed (see indexDocFile) — derived, never written into the file. */
function unparseableDocId(space: string, relPath: string): string {
  return `unparsed-${createHash('sha1').update(`${space}\0${relPath}`).digest('hex').slice(0, 20)}`;
}

async function indexDocFile(space: string, relPath: string, abs: string, mtime: Date, isIndex: boolean): Promise<PageIndexEntry | null> {
  let raw: string;
  try {
    raw = await fs.readFile(abs, 'utf8');
  } catch {
    return null;
  }
  // gray-matter THROWS on YAML it can't parse — and hand-written frontmatter
  // breaks it all the time (`title: Fix: login` is an "incomplete explicit
  // mapping pair"; an unclosed quote runs off the end of the stream). Unguarded,
  // one such file aborted scanSpace for the WHOLE space, and during
  // createSpaceFromRepo that surfaced as a bare 500 after the space row was
  // already inserted: the owner's three attempts to connect a repo's `_tasks`
  // folder left three invisible orphan spaces on prod (15.09). indexTableFile
  // below has carried exactly this guard for a while; the doc indexer didn't.
  //
  // A file we can't parse is still indexed — as its raw text, so it shows up
  // and can be opened and fixed — but it is NEVER rewritten: persisting an id
  // into frontmatter we failed to read would mean re-serialising content we
  // don't understand. Its id is therefore derived from (space, path) rather
  // than stored, which keeps it stable across rescans for as long as the file
  // stays put.
  let parsed: matterNS.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[scan] ${space}/${relPath}: unreadable frontmatter, indexing as plain text:`, err instanceof Error ? err.message.split('\n')[0] : err);
    return {
      id: unparseableDocId(space, relPath),
      space,
      relPath,
      absPath: abs,
      kind: 'doc',
      isIndex,
      dirPath: posixParent(relPath),
      title: extractH1(raw) ?? titleFallback(relPath, 'doc'),
      order: ORDER_SENTINEL,
      explicitOrder: undefined,
      status: 'published',
      explicitStatus: undefined,
      icon: undefined,
      cover: undefined,
      updatedAt: mtime.toISOString(),
      body: raw,
    };
  }
  let id = typeof parsed.data.id === 'string' && parsed.data.id ? (parsed.data.id as string) : null;
  const body = parsed.content;
  const explicitOrder = numericOrder(parsed.data.order);
  const explicitStatus = validStatus(parsed.data.status);
  const icon = validStringField(parsed.data.icon);
  const cover = validStringField(parsed.data.cover);
  if (!id) {
    id = ulid();
    await persistDocFrontmatter(abs, { id, order: explicitOrder, status: explicitStatus, icon, cover }, body);
  }
  return {
    id,
    space,
    relPath,
    absPath: abs,
    kind: 'doc',
    isIndex,
    dirPath: posixParent(relPath),
    title: extractH1(body) ?? titleFallback(relPath, 'doc'),
    order: explicitOrder ?? ORDER_SENTINEL,
    explicitOrder,
    status: explicitStatus ?? 'published',
    explicitStatus,
    icon,
    cover,
    updatedAt: mtime.toISOString(),
    body,
  };
}

async function indexBoardFile(space: string, relPath: string, abs: string, mtime: Date): Promise<PageIndexEntry | null> {
  let raw: string;
  try {
    raw = await fs.readFile(abs, 'utf8');
  } catch {
    return null;
  }
  // `order` is read straight back out of the file's own comment block, so an
  // explicit board order survives a full index rebuild (drop pages_index,
  // rescan) exactly like a doc's frontmatter `order` does.
  const header = splitBoardHeader(raw);
  let id = header.id;
  if (!id) {
    id = ulid();
    await fs.writeFile(abs, withBoardId(raw, id), 'utf8');
  }
  return {
    id,
    space,
    relPath,
    absPath: abs,
    kind: 'board',
    isIndex: false,
    dirPath: posixParent(relPath),
    // A header-less board (every pre-existing one, until someone renames it)
    // keeps showing its filename exactly as before — non-destructive,
    // backward-compatible migration, not a gap.
    title: header.title ?? titleFallback(relPath, 'board'),
    // No order comment -> the sentinel, i.e. "sorts after every explicitly
    // ordered sibling, then by title" — the pre-existing behaviour, never a
    // random slot.
    order: header.order ?? ORDER_SENTINEL,
    explicitOrder: header.order,
    status: 'published',
    icon: header.icon,
    updatedAt: mtime.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Binary page files (PDF, round PDF; DOCX/XLSX/PPTX, round OFFICE)
//
// A pdf/office page is the owner's own binary file from their repository, so
// Folio NEVER writes into it. (A first version stamped a /FolioID into every
// PDF's catalog via a full re-serialize: the first scan would have rewritten
// every PDF in every repo, committed and pushed them, and broken signed
// documents.) The id lives only in pages_index, resolved in this order:
//  1. a claim registered by the Folio operation that just put the file at
//     this path — move, copy, trash restore (claimBinaryId);
//  2. the existing index row at the same path (the ordinary rescan);
//  3. an index row of the SAME kind and size whose file is gone from disk —
//     a rename/move Folio did not perform itself (folder move, `git mv`,
//     slug rename);
//  4. otherwise a deterministic id from space + path, so a rebuilt index
//     gets the same id back for a file that never moved.
const binaryIdClaims = new Map<string, string>();
/** Per scan: orphaned binary-file rows already handed to a renamed file, so two same-size files of the same kind can't take one id. Reset at the start of scanSpace. */
const binaryOrphanClaims = new Map<string, Set<string>>();

/** Pins the id the next scan gives the pdf/office file at `abs` — see "Binary page files" above. */
export function claimBinaryId(abs: string, id: string): void {
  binaryIdClaims.set(path.resolve(abs), id);
}

function binaryIdForPath(kind: 'pdf' | 'office', space: string, relPath: string): string {
  const prefix = kind === 'pdf' ? 'pdf' : 'office';
  return `${prefix}-${createHash('sha1').update(`${space}\0${relPath}`).digest('hex').slice(0, 24)}`;
}

async function resolveBinaryId(kind: 'pdf' | 'office', space: string, relPath: string, abs: string, size: number): Promise<string> {
  const key = path.resolve(abs);
  const claimed = binaryIdClaims.get(key);
  if (claimed) {
    binaryIdClaims.delete(key);
    return claimed;
  }
  const byPath = await getEntryIdByExactPath(space, relPath);
  if (byPath) return byPath;

  const root = abs.slice(0, abs.length - relPath.length);
  const taken = binaryOrphanClaims.get(space) ?? new Set<string>();
  binaryOrphanClaims.set(space, taken);
  const candidates = await query<{ id: string; path: string }>(
    'SELECT id, path FROM pages_index WHERE space_slug = $1 AND kind = $2 AND file_size = $3',
    [space, kind, size],
  );
  for (const candidate of candidates) {
    if (taken.has(candidate.id)) continue;
    const stillThere = await fs.access(path.join(root, candidate.path)).then(
      () => true,
      () => false,
    );
    if (stillThere) continue;
    taken.add(candidate.id);
    return candidate.id;
  }
  return binaryIdForPath(kind, space, relPath);
}

/** Shared by indexPdfFile and indexOfficeFile — same id resolution, same "never read the bytes" rule, same non-searchable stub shape. */
async function indexBinaryFile(kind: 'pdf' | 'office', space: string, relPath: string, abs: string, mtime: Date): Promise<PageIndexEntry | null> {
  // stat only — the bytes are never read, let alone rewritten (see "Binary page files").
  let size: number;
  try {
    size = (await fs.stat(abs)).size;
  } catch {
    return null;
  }
  const id = await resolveBinaryId(kind, space, relPath, abs, size);

  // A pdf/office page's order/icon live ONLY in this row (see setBinaryPageOrder's
  // doc comment for the trade-off) — nothing on disk carries them, so this scan
  // must inherit whatever the row already has under this SAME id or a rescan
  // (and a rename resolveBinaryId just followed) would silently reset both back
  // to the defaults below. Looked up by id, not by relPath, precisely because
  // resolveBinaryId may have just carried this id over from a different path.
  const existing = await queryOne<{ sort_order: number | null; icon: string | null }>(
    'SELECT sort_order, icon FROM pages_index WHERE id = $1',
    [id],
  );

  return {
    id,
    space,
    relPath,
    absPath: abs,
    kind,
    isIndex: false,
    dirPath: posixParent(relPath),
    title: titleFallback(relPath, kind),
    order: existing?.sort_order ?? ORDER_SENTINEL,
    explicitOrder: existing?.sort_order ?? undefined,
    status: 'published',
    icon: existing?.icon ?? undefined,
    updatedAt: mtime.toISOString(),
    // No plain_text — search by title only (see upsertPagesIndexRow: only
    // 'doc'/'table' populate plainText, so this stays null for tsvector too).
    body: undefined,
  };
}

function indexPdfFile(space: string, relPath: string, abs: string, mtime: Date): Promise<PageIndexEntry | null> {
  return indexBinaryFile('pdf', space, relPath, abs, mtime);
}

/** A .docx/.xlsx/.pptx file becomes a kind:'office' page — same machinery as a pdf, see "Binary page files" above. */
function indexOfficeFile(space: string, relPath: string, abs: string, mtime: Date): Promise<PageIndexEntry | null> {
  return indexBinaryFile('office', space, relPath, abs, mtime);
}

/**
 * Round 26 (DATA TABLES), spec §11: FTS content for a table page is the
 * denormalized "column name: value" text of every row, plus the free prose
 * above/below the table (`head`/`tail` — head includes the H1). Exported so
 * server/tables/service.ts's direct (non-collab) write path can recompute
 * the same plain_text after a mutation without duplicating this logic.
 */
export function tableDocToPlainText(doc: TableDoc): string {
  const rowLines = doc.rows
    .map((row) => doc.columns.map((col) => `${col.name}: ${encodeCell(col, row.values[col.id] ?? null)}`).join(', '))
    .filter((line) => line.replace(/[,:\s]/g, '').length > 0);
  return [doc.head, rowLines.join('\n'), doc.tail].filter((s) => s && s.trim().length > 0).join('\n\n');
}

/**
 * Round 26 (DATA TABLES). `.table.md` before plain `.md` in scanSpace's own
 * dispatch is what keeps this from ever running on a doc file — see that
 * call site's comment for why the ordering itself is the load-bearing part.
 *
 * A structurally invalid file (bad frontmatter, mismatched row/column
 * counts, hand-edit gone wrong) is never dropped from the index or allowed
 * to abort the whole space scan (spec §1: "does not lose data silently") — it's
 * indexed as a best-effort stub instead: whatever id/title can be recovered
 * from the raw frontmatter/prose, no searchable row content (plain_text
 * stays empty), so the page still exists, is still navigable, and still
 * shows up in the tree. The client is expected to open it in a "raw file"
 * warning mode (spec §1) — that's a later wave's concern, not scanSpace's.
 */
async function indexTableFile(space: string, relPath: string, abs: string, mtime: Date): Promise<PageIndexEntry | null> {
  let raw: string;
  try {
    raw = await fs.readFile(abs, 'utf8');
  } catch {
    return null;
  }

  // `order` is NOT part of TableDoc (the codec owns the table's schema, not
  // the page's position in the tree) — it's read straight off the raw
  // frontmatter, the same key an ordinary doc uses, so it also survives a
  // full index rebuild. See setTableOrder/writeTableDoc for the write half.
  // (guarded: a table file with unparseable YAML still has to index as a stub
  // below rather than abort the whole space scan)
  let explicitOrder: number | undefined;
  let explicitIcon: string | undefined;
  try {
    const data = matter(raw).data;
    explicitOrder = numericOrder(data?.order);
    explicitIcon = validStringField(data?.icon);
  } catch {
    explicitOrder = undefined;
    explicitIcon = undefined;
  }

  const parsed = parseTableFile(raw);
  if (isTableParseError(parsed)) {
    let id: string | undefined;
    let head = '';
    try {
      const fm = matter(raw);
      if (typeof fm.data.id === 'string' && fm.data.id) id = fm.data.id;
      head = fm.content;
    } catch {
      /* even the YAML frontmatter itself is unparseable — nothing recoverable from it */
    }
    // eslint-disable-next-line no-console
    console.error(`[scan] ${space}/${relPath}: invalid table file — ${parsed.message}`);
    return {
      id: id ?? ulid(),
      space,
      relPath,
      absPath: abs,
      kind: 'table',
      isIndex: false,
      dirPath: posixParent(relPath),
      title: extractH1(head) ?? titleFallback(relPath, 'table'),
      order: explicitOrder ?? ORDER_SENTINEL,
      explicitOrder,
      icon: explicitIcon,
      status: 'published',
      updatedAt: mtime.toISOString(),
    };
  }

  return {
    id: parsed.meta.id,
    space,
    relPath,
    absPath: abs,
    kind: 'table',
    isIndex: false, // spec §1: a table file never becomes a directory's index page
    dirPath: posixParent(relPath),
    title: extractH1(parsed.head) ?? titleFallback(relPath, 'table'),
    order: explicitOrder ?? ORDER_SENTINEL,
    explicitOrder,
    icon: explicitIcon,
    status: 'published',
    updatedAt: mtime.toISOString(),
    body: tableDocToPlainText(parsed),
  };
}

/**
 * Round FORMS — FTS content for a form page: title + description + every
 * field's label/help, denormalized the same "small but searchable" way
 * indexTableFile does for a table's rows. A form has no rows of its own —
 * its content IS the definition.
 */
export function formDocToPlainText(doc: FormDoc): string {
  const fieldLines = doc.fields.map((f) => [f.label, f.help].filter(Boolean).join(': ')).filter((s) => s.trim().length > 0);
  return [doc.title, doc.description ?? '', fieldLines.join('\n')].filter((s) => s.trim().length > 0).join('\n\n');
}

/**
 * Round FORMS. `.form.md` before plain `.md` in scanSpace's own dispatch,
 * same load-bearing ordering `.table.md` already needs (see indexTableFile's
 * own doc comment) — a form file also ends in `.md`.
 *
 * Same "never silently drop a page" rule as indexTableFile: a structurally
 * invalid form file (bad frontmatter, dangling `table` reference — checked
 * lazily, not here) is indexed as a best-effort stub rather than aborting
 * the whole space scan.
 */
async function indexFormFile(space: string, relPath: string, abs: string, mtime: Date): Promise<PageIndexEntry | null> {
  let raw: string;
  try {
    raw = await fs.readFile(abs, 'utf8');
  } catch {
    return null;
  }

  // `order`/`icon` live in the same top-level frontmatter keys a table's page
  // position does (see withTablePageFields, reused for forms too) — read
  // straight off the raw frontmatter so they survive a full index rebuild.
  let explicitOrder: number | undefined;
  let explicitIcon: string | undefined;
  try {
    const data = matter(raw).data;
    explicitOrder = numericOrder(data?.order);
    explicitIcon = validStringField(data?.icon);
  } catch {
    explicitOrder = undefined;
    explicitIcon = undefined;
  }

  const parsed = parseFormFile(raw);
  if (isFormParseError(parsed)) {
    let id: string | undefined;
    try {
      const fm = matter(raw);
      if (typeof fm.data.id === 'string' && fm.data.id) id = fm.data.id;
    } catch {
      /* even the YAML frontmatter itself is unparseable — nothing recoverable from it */
    }
    // eslint-disable-next-line no-console
    console.error(`[scan] ${space}/${relPath}: invalid form file — ${parsed.message}`);
    return {
      id: id ?? ulid(),
      space,
      relPath,
      absPath: abs,
      kind: 'form',
      isIndex: false,
      dirPath: posixParent(relPath),
      title: titleFallback(relPath, 'form'),
      order: explicitOrder ?? ORDER_SENTINEL,
      explicitOrder,
      icon: explicitIcon,
      status: 'published',
      updatedAt: mtime.toISOString(),
    };
  }

  return {
    id: parsed.meta.id,
    space,
    relPath,
    absPath: abs,
    kind: 'form',
    isIndex: false,
    dirPath: posixParent(relPath),
    title: parsed.title || titleFallback(relPath, 'form'),
    order: explicitOrder ?? ORDER_SENTINEL,
    explicitOrder,
    icon: explicitIcon,
    status: 'published',
    updatedAt: mtime.toISOString(),
    body: formDocToPlainText(parsed),
  };
}

export interface ScanStats {
  filesRead: number;
  filesSkipped: number;
  durationMs: number;
}

export interface ScanProgress {
  processedFiles: number;
  totalFiles: number;
}

/** Rescans one space's directory tree and mirrors it into pages_index (upsert changed/new, delete stale). Streaming: files are read, indexed and persisted one at a time — nothing holds more than one file's body at once. */
/** A failure that means the database (or the network to it) is gone — not a problem with one file's data. */
export function isConnectionFailure(err: unknown): boolean {
  const e = err as { code?: unknown } | null;
  const code = typeof e?.code === 'string' ? e.code : '';
  // SQLSTATE class 08 = connection exception; 57P01-03 = admin shutdown / crash / cannot connect now.
  if (/^08/.test(code) || /^57P0[123]$/.test(code)) return true;
  return code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE';
}

export async function scanSpace(space: string, onProgress?: (progress: ScanProgress) => void, restoredAccess?: RestoredAccess): Promise<ScanStats> {
  const startedAt = Date.now();
  const appliedRules = new Set<PageAccessRule>();
  const root = spaceDir(space);
  binaryOrphanClaims.delete(space);

  const existingRows = await query<{ path: string; file_mtime: string | null; file_size: string | null; kind: string; title: string }>(
    'SELECT path, file_mtime, file_size, kind, title FROM pages_index WHERE space_slug = $1',
    [space],
  );
  const existingByPath = new Map(existingRows.map((r) => [r.path, r]));
  const stillPresent = new Set<string>();
  let filesRead = 0;
  let filesSkipped = 0;
  let failedFiles = 0;
  let lastFailure: unknown = null;
  let processedFiles = 0;
  let totalFiles = 0;

  if (onProgress) {
    async function count(absDir: string, isRoot: boolean): Promise<void> {
      const dirents = await fs.readdir(absDir, { withFileTypes: true }).catch(() => []);
      for (const dirent of dirents) {
        // `.agent/` at the space's CONTENT ROOT is the one dotfile exception
        // (owner spec, 21.09.2026) — see the matching comment in walk() below.
        const isAgentRoot = isRoot && dirent.name === AGENT_FOLDER;
        if (!isAgentRoot && (dirent.name.startsWith('.') || dirent.name === 'assets')) continue;
        const abs = path.join(absDir, dirent.name);
        if (dirent.isDirectory()) await count(abs, false);
        else if (dirent.isFile()) {
          const lower = dirent.name.toLowerCase();
          if (lower.endsWith('.md') || lower.endsWith('.excalidraw.svg') || lower.endsWith('.pdf') || officeFormat(lower)) totalFiles++; // `.form.md` is also `.md`, already counted
        }
      }
    }
    await count(root, true);
    onProgress({ processedFiles, totalFiles });
  }

  async function walk(absDir: string, relDir: string): Promise<void> {
    let dirents;
    try {
      dirents = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    const names = new Set(dirents.map((d) => d.name));
    const hasIndexMd = names.has('index.md');

    for (const dirent of dirents) {
      const name = dirent.name;
      // "assets/" holds uploaded attachments, not pages; dotfiles are never
      // pages — EXCEPT `.agent/` at the space's own content root (relDir ===
      // '', i.e. this walk call is rooted at `root` itself): admin-only rules
      // pages for the AI assistant (owner spec, 21.09.2026), indexed like any
      // other page. A NESTED `.agent` (someone's `notes/.agent/x.md`) is not
      // this folder and stays skipped, same as every other dotfile.
      const isAgentRoot = relDir === '' && name === AGENT_FOLDER;
      if (!isAgentRoot && (name.startsWith('.') || name === 'assets')) continue;
      const abs = path.join(absDir, name);
      const relPath = relDir ? `${relDir}/${name}` : name;
      if (dirent.isDirectory()) {
        await walk(abs, relPath);
        continue;
      }
      if (!dirent.isFile()) continue;
      const lower = name.toLowerCase();
      // Round 26: `.table.md` MUST be checked BEFORE plain `.md` — a table file also
      // ends in `.md`, so `isMd` is deliberately defined to EXCLUDE anything `isTable`
      // already claimed. Getting this order backwards would misindex every table file
      // as an ordinary doc (and, since a table's rows/columns live in frontmatter that
      // a doc's parser never expects, silently mangle it) — see the mandatory
      // storage.test.ts collision test for what this guards against.
      const isTable = lower.endsWith('.table.md');
      // Round FORMS: same load-bearing ordering as isTable — `.form.md` also
      // ends in `.md`, so isMd below deliberately excludes it too.
      const isForm = !isTable && lower.endsWith('.form.md');
      const isMd = !isTable && !isForm && lower.endsWith('.md');
      const isBoard = lower.endsWith('.excalidraw.svg');
      // Round PDF: case-insensitive, same as every other extension check here
      // (a repo checked out on a case-preserving filesystem can hold `.PDF`).
      const isPdf = lower.endsWith('.pdf');
      // Round OFFICE: same case-insensitive rule; officeFormat is the one
      // source of truth for which of the three extensions this is.
      const isOffice = officeFormat(lower) !== undefined;
      // Anything else — including a `.folio` metadata file (round 22) — is never a page:
      // skipped here, so it can never enter pages_index/the tree/search in the first place.
      if (!isMd && !isBoard && !isTable && !isForm && !isPdf && !isOffice) continue;

      const reportProcessed = () => {
        processedFiles++;
        onProgress?.({ processedFiles, totalFiles });
      };

      const stat = await fs.stat(abs).catch(() => null);
      if (!stat) continue;
      stillPresent.add(relPath);

      const existing = existingByPath.get(relPath);
      // The mtime+size fast path skips a file whose BYTES are the same — but
      // the title is derived from the PATH and the current titleFallback rule,
      // not from the bytes. When that rule changes (16.09: a file page's title
      // gained its extension), every already-indexed file stayed on its old
      // title forever, because nothing ever re-derived it. Comparing the
      // derived title too costs one pure string call per file and makes such a
      // change self-healing on the next scan — for pages whose title comes
      // from INSIDE the file (doc's H1, board's header) titleFallback is only
      // a fallback, so they are deliberately left to the bytes check alone.
      const derivedTitle = isPdf || isOffice ? titleFallback(relPath, isPdf ? 'pdf' : 'office') : undefined;
      const unchanged =
        existing &&
        existing.file_mtime &&
        existing.file_size !== null &&
        new Date(existing.file_mtime).getTime() === stat.mtime.getTime() &&
        Number(existing.file_size) === stat.size &&
        (derivedTitle === undefined || existing.title === derivedTitle);
      if (unchanged) {
        filesSkipped++;
        reportProcessed();
        continue;
      }
      filesRead++;

      // README.md is the directory's index only when this directory has no index.md.
      const isIndex = isMd && (name === 'index.md' || (name === 'README.md' && !hasIndexMd));
      // One file must not be able to sink the scan of a whole space. Before
      // this, any throw from a single file's indexing or upsert aborted
      // scanSpace outright — and during createSpaceFromRepo that meant a bare
      // 500 for the whole import (prod, 15.09: a repo's `_tasks` folder). The
      // unparseable-frontmatter case is handled precisely in indexDocFile; this
      // is the backstop for the ones nobody has named yet (the documented
      // (space_slug, path) trap when a file is replaced without its id, and
      // whatever an arbitrary external repository brings along). A skipped
      // file keeps its existing row: it was already added to `stillPresent`
      // above, so the cleanup below won't delete what it failed to refresh.
      let entry: PageIndexEntry | null;
      try {
        entry = isTable
          ? await indexTableFile(space, relPath, abs, stat.mtime)
          : isForm
            ? await indexFormFile(space, relPath, abs, stat.mtime)
            : isMd
              ? await indexDocFile(space, relPath, abs, stat.mtime, isIndex)
              : isPdf
                ? await indexPdfFile(space, relPath, abs, stat.mtime)
                : isOffice
                  ? await indexOfficeFile(space, relPath, abs, stat.mtime)
                  : await indexBoardFile(space, relPath, abs, stat.mtime);
        if (entry) {
          // Page access that travelled with a trash item (see RestoredAccess): by id first, then by the path the file landed on.
          const rule = restoredAccess ? (restoredAccess.byId.get(entry.id) ?? restoredAccess.byPath.get(entry.relPath)) : undefined;
          const give = rule && !appliedRules.has(rule) ? rule : undefined;
          await upsertPagesIndexRow(entry, stat.mtime, stat.size, give);
          if (give) appliedRules.add(give);
        }
      } catch (err) {
        failedFiles++;
        lastFailure = err;
        // eslint-disable-next-line no-console
        console.warn(`[scan] ${space}/${relPath}: skipped, could not index:`, err instanceof Error ? err.message.split('\n')[0] : err);
        reportProcessed();
        continue;
      }
      if (!entry) continue;
      if (entry.kind === 'doc') {
        await links.reindexPageLinks(entry.id, entry.space, entry.relPath, entry.body ?? '').catch((err) => {
          // eslint-disable-next-line no-console
          console.error(`[links] failed to index ${space}/${relPath}:`, err);
        });
      }
      reportProcessed();
    }
  }

  await walk(root, '');

  // Tolerating individual files must not hide a SYSTEMIC failure — but the
  // first version of this guard decided "systemic" by counting ("every file we
  // tried failed"), and that is precisely what took prod down on 15.09: on a
  // rescan only the one changed file is read, so one bad file is "every file",
  // the scan threw, and the old boot order turned that into a dead process on
  // every restart. Only a genuine loss of the database connection is systemic.
  if (failedFiles > 0 && isConnectionFailure(lastFailure)) throw lastFailure;

  // A restored page whose file the loop above skipped as unchanged (somebody else's scan indexed it first) still gets its rule.
  if (restoredAccess) await reconcileRestoredAccess(space, restoredAccess, appliedRules);

  if (stillPresent.size > 0) {
    await query('DELETE FROM pages_index WHERE space_slug = $1 AND NOT (path = ANY($2::text[]))', [space, [...stillPresent]]);
  } else {
    await query('DELETE FROM pages_index WHERE space_slug = $1', [space]);
  }

  const stats: ScanStats = { filesRead, filesSkipped, durationMs: Date.now() - startedAt };
  // eslint-disable-next-line no-console
  console.log(`[scan] ${space}: ${filesRead} read, ${filesSkipped} unchanged, ${stats.durationMs}ms`);
  return stats;
}

/**
 * The fast half of the boot scan: the spaces REGISTRY only — legacy dir
 * migration, registering data/repos dirs that aren't in `spaces` yet, the
 * root-path cache. Cheap regardless of repository size, and the one thing the
 * rest of startup (importJsonIfNeeded's space_members FKs, periodic fetch,
 * collab room lookups) actually depends on. Returns the slugs whose PAGES still
 * need indexing — see server/bootScan.ts, which does that in the background.
 */
export async function prepareSpacesRegistry(): Promise<string[]> {
  await migrateLegacySpaces();
  await registerReposOnBoot();
  await refreshRootPathCache();
  return listDirs(REPOS_DIR);
}

/**
 * One space's page scan at boot, under that space's own lock — the server is
 * already serving by the time this runs (bootScan.ts), so it must serialise
 * with a page write or a git sync on the same space exactly like performSync's
 * own scan does.
 */
export async function scanSpaceForBoot(slug: string): Promise<ScanStats> {
  return withSpaceLock(slug, () => scanSpace(slug));
}

/** Registry + every space's pages, in the foreground. Kept for callers outside the boot path (tests, tooling). */
export async function scanAllSpaces(): Promise<void> {
  const slugs = await prepareSpacesRegistry();
  for (const slug of slugs) await scanSpace(slug);
}

// ---------------------------------------------------------------------------
// Read API
// ---------------------------------------------------------------------------

export function toPageMeta(e: PageIndexEntry): PageMeta {
  // ORDER_SENTINEL (MAX_SAFE_INTEGER) is an internal "sorts after every explicitly
  // ordered sibling" marker used by getTree()'s sort — boards always carry it (they
  // have nowhere to persist an explicit order) and so does any doc without one.
  // getTree() captures its own sort key straight from PageIndexEntry.order before
  // ever calling toPageMeta, so remapping it to a sane default only HERE, in the
  // serialized response, cannot change actual sibling ordering.
  const order = e.order === ORDER_SENTINEL ? 0 : e.order;
  const meta: PageMeta = { id: e.id, space: e.space, path: e.relPath, kind: e.kind, title: e.title, order, status: e.status, updatedAt: e.updatedAt };
  if (e.icon) meta.icon = e.icon;
  if (e.cover) meta.cover = e.cover;
  return meta;
}

export async function getEntry(id: string): Promise<PageIndexEntry | undefined> {
  if (id.startsWith('dir:')) throw badRequest('not a page id (synthetic folder node)');
  const row = await queryOne<PagesIndexRow>('SELECT * FROM pages_index WHERE id = $1', [id]);
  return row ? rowToEntry(row) : undefined;
}

export async function requireEntry(id: string): Promise<PageIndexEntry> {
  const entry = await getEntry(id);
  if (!entry) throw notFound('page');
  return entry;
}

/**
 * Exact-path lookup (no index.md/README.md fallback chasing like resolve()
 * does) — round 12's Confluence importer uses this to detect when it's about
 * to write a page onto a path that's ALREADY indexed (most commonly a brand
 * new space's own placeholder index.md, created by createSpace above) and
 * reuse that id instead of minting a fresh one. pages_index has a UNIQUE
 * constraint on (space_slug, path); scanSpace's own upsert keys ON CONFLICT
 * (id), not path — so writing fresh content with a NEW id to a path some
 * OTHER id already owns is a guaranteed constraint violation on the next
 * scan, not just a logical duplicate.
 */
export async function getEntryIdByExactPath(space: string, relPath: string): Promise<string | undefined> {
  const row = await queryOne<{ id: string }>('SELECT id FROM pages_index WHERE space_slug = $1 AND path = $2', [space, relPath]);
  return row?.id;
}

/**
 * Round FORMS bugfix (owner repro, 22.09.2026: "Edit form" permanently
 * refused to save with a "waiting for the table" banner). `form.table` is a
 * space-root-relative path snapshotted once, at pairing time (createPage's
 * 'form' branch / createFormFromTable) — see shared/forms/codec.ts's own doc
 * comment for why it's root-relative at all. Nothing ever rewrites it
 * afterwards: movePage and renamePageSlug both change a page's relPath (the
 * form's own, the table's, or an ancestor directory's) with a plain
 * `fs.rename`, and neither one — nor collab.renamePageSlug's backlink sweep,
 * which only patches markdown `[[links]]` inside OTHER 'doc' pages' bodies —
 * ever touches a form's `table:` frontmatter. So the very first move or slug
 * rename touching either side of the pair leaves `form.table` pointing at a
 * path nothing lives at any more, and `getEntryIdByExactPath` 404s forever.
 *
 * Self-heals by falling back to the pair's actual TREE position, which
 * move/rename can desync from the stored path but can never itself corrupt:
 * ids are stable, and the "leaf page + same-named sibling directory =
 * children" convention (see getSubtree's own doc comment) is exactly the
 * shape createPage/createFormFromTable used to set the pair up in the first
 * place, in either direction (server/forms/service.test.ts pins both):
 *
 *  (a) "+ → Form": the table is the form's own CHILD (nested in
 *      `<formStem>/`) — covers a renamed/moved TABLE (or an ancestor of just
 *      the table) while the form itself stayed put, which is what a sidebar
 *      still showing the table as the form's child (this bug's own repro)
 *      implies happened.
 *  (b) "Create a form" on an existing table: the form is the table's own
 *      child instead — covers the same desync the other direction round.
 *
 * Returns the fresh entry (not just an id) so the caller can compare
 * `.relPath` against the stale stored value and decide whether to self-heal
 * the file.
 */
export async function resolvePairedTableEntry(formEntry: PageIndexEntry, tableRelPath: string): Promise<PageIndexEntry | undefined> {
  const byPathId = await getEntryIdByExactPath(formEntry.space, tableRelPath);
  if (byPathId) {
    const entry = await getEntry(byPathId);
    if (entry && entry.kind === 'table') return entry;
  }

  const entries = await listEntries(formEntry.space);

  // (a) the table nested as this form's own child directory.
  const formStem = relPathStem(formEntry.relPath, 'form');
  const childDir = formEntry.dirPath ? `${formEntry.dirPath}/${formStem}` : formStem;
  const childTable = entries.find((e) => e.kind === 'table' && e.dirPath === childDir);
  if (childTable) return childTable;

  // (b) this form nested as ITS OWN table's child directory (one level up).
  if (formEntry.dirPath) {
    const parentDir = posixParent(formEntry.dirPath);
    const parentStem = dirBasename(formEntry.dirPath);
    const parentTable = entries.find((e) => e.kind === 'table' && e.dirPath === parentDir && relPathStem(e.relPath, 'table') === parentStem);
    if (parentTable) return parentTable;
  }

  return undefined;
}

export async function listEntries(space?: string): Promise<PageIndexEntry[]> {
  const rows = space
    ? await query<PagesIndexRow>('SELECT * FROM pages_index WHERE space_slug = $1', [space])
    : await query<PagesIndexRow>('SELECT * FROM pages_index');
  return rows.map(rowToEntry);
}

export async function spaceExists(space: string): Promise<boolean> {
  if (!space || space.includes('/') || space.includes('\\')) return false;
  const row = await queryOne<{ exists: boolean }>('SELECT EXISTS(SELECT 1 FROM spaces WHERE slug = $1) AS exists', [space]);
  return row?.exists ?? false;
}

interface SpaceRow {
  slug: string;
  name: string;
  root_title: string | null;
  page_count: string;
  repo_url: string | null;
  branch: string;
  root_path: string;
  status: string;
  ahead: number | null;
  behind: number | null;
  last_sync_at: string | null;
  last_sync_by_name: string | null;
  last_sync_by_email: string | null;
  last_error: string | null;
  asset_mode: 'store' | 'repo';
  /** Round 27 (access and rights): 'private' (default) or 'instance' — see docs/spec-access.md §3. Not exercised by this module's own access checks (that's server/auth/session.ts's effectiveRole/membershipsFor); carried through purely so SpaceInfo can report it. */
  visibility: SpaceVisibility;
}

function rowToSpaceInfo(r: SpaceRow): SpaceInfo {
  return {
    slug: r.slug,
    // The space name is its own piece of metadata. A repository root page
    // may have a useful (and different) H1, but it must not silently rename
    // the space selected in the create/rename UI.
    name: r.name,
    pageCount: Number(r.page_count),
    assetMode: r.asset_mode,
    visibility: r.visibility,
    git: {
      repoUrl: r.repo_url,
      branch: r.branch,
      rootPath: r.root_path,
      status: r.status as SpaceGitStatus,
      ahead: r.ahead ?? 0,
      behind: r.behind ?? 0,
      lastSyncAt: r.last_sync_at ? new Date(r.last_sync_at).toISOString() : null,
      lastSyncByName: r.last_sync_by_name,
      lastSyncByEmail: r.last_sync_by_email,
      lastError: r.last_error,
    },
  };
}

const SPACE_SELECT_BASE = `SELECT s.slug, s.name, s.repo_url, s.branch, s.root_path, s.status, s.last_sync_at, s.last_sync_by_name, s.last_sync_by_email, s.last_error, s.asset_mode, s.visibility,
          (SELECT p.title FROM pages_index p WHERE p.space_slug = s.slug AND p.is_index AND p.path NOT LIKE '%/%') AS root_title,
          COUNT(p2.id) AS page_count
     FROM spaces s
     LEFT JOIN pages_index p2 ON p2.space_slug = s.slug`;
const SPACE_GROUP_BY = `GROUP BY s.slug, s.name, s.repo_url, s.branch, s.root_path, s.status, s.last_sync_at, s.last_sync_by_name, s.last_sync_by_email, s.last_error, s.asset_mode, s.visibility`;

export async function listSpaces(): Promise<SpaceInfo[]> {
  const rows = await query<SpaceRow>(`${SPACE_SELECT_BASE} ${SPACE_GROUP_BY} ORDER BY s.name`);
  return rows.map((r) => rowToSpaceInfo({ ...r, ahead: 0, behind: 0 }));
}

export async function getSpaceInfo(space: string): Promise<SpaceInfo | undefined> {
  const row = await queryOne<SpaceRow>(`${SPACE_SELECT_BASE} WHERE s.slug = $1 ${SPACE_GROUP_BY}`, [space]);
  return row ? rowToSpaceInfo({ ...row, ahead: 0, behind: 0 }) : undefined;
}

/**
 * `.agent/**` page counts (owner spec, 21.09.2026; widened 22.09.2026) — one
 * cheap grouped query for `SpaceInfo.agentRules`. Called with every space the
 * caller is a MEMBER of, not just ones they administer: routes.ts sends the
 * resulting `used`/`pages` to every member (so a viewer can tell rules exist
 * at all), and only gates the `path` link on admin-ness client-side — this
 * function itself returns a COUNT only, never anything from inside `.agent`
 * that a non-admin isn't already allowed to know. A slug with zero `.agent`
 * pages is simply absent from the returned map.
 */
export async function countAgentPages(spaces: readonly string[]): Promise<Map<string, number>> {
  if (spaces.length === 0) return new Map();
  const rows = await query<{ space_slug: string; count: string }>(
    `SELECT space_slug, COUNT(*) AS count FROM pages_index
      WHERE space_slug = ANY($1::text[]) AND (path = $2 OR path LIKE $3)
      GROUP BY space_slug`,
    [spaces, AGENT_FOLDER, `${AGENT_FOLDER}/%`],
  );
  return new Map(rows.map((r) => [r.space_slug, Number(r.count)]));
}

/**
 * Builds the space's page tree, mixing real pages (index.md/README.md self
 * nodes, same-named X.md + X/ parent pages, and leaves) with synthetic
 * 'folder' nodes only for directories that genuinely have no page of their
 * own. A same-named page claims the directory as its child container, so the
 * sidebar never renders X.md beside a misleading folder X.
 * `_templates/` is excluded (round 5 — reachable via listTemplates instead).
 */
export async function getTree(space: string, allowedPageIds?: ReadonlySet<string>): Promise<TreeNode[]> {
  if (!(await spaceExists(space))) throw notFound('space');
  const entries = (await listEntries(space)).filter((e) => !isUnderTemplates(e.relPath) && (!allowedPageIds || allowedPageIds.has(e.id)));

  const selfForDir = new Map<string, PageIndexEntry>();
  for (const e of entries) if (e.isIndex) selfForDir.set(e.dirPath, e);

  const neededDirs = new Set<string>(['']);
  function markNeeded(d: string): void {
    let cur = d;
    for (;;) {
      if (neededDirs.has(cur)) return;
      neededDirs.add(cur);
      if (cur === '') return;
      cur = posixParent(cur);
    }
  }
  // Every entry's OWN dirPath must exist as a node (a leaf needs its container to place
  // it under; an index entry's dirPath IS the directory it represents, so it also needs
  // to exist as a node — to appear as a child of ITS OWN parent). markNeeded walks the
  // whole ancestor chain, so this alone also synthesizes any in-between directory that
  // has no entry of its own (e.g. a folder two levels deep with nothing at level one).
  for (const e of entries) markNeeded(e.dirPath);

  const subdirsOf = new Map<string, string[]>();
  for (const d of neededDirs) {
    if (d === '') continue;
    const parent = posixParent(d);
    if (!subdirsOf.has(parent)) subdirsOf.set(parent, []);
    subdirsOf.get(parent)!.push(d);
  }
  const leavesOf = new Map<string, PageIndexEntry[]>();
  for (const e of entries) {
    if (e.isIndex) continue;
    if (!leavesOf.has(e.dirPath)) leavesOf.set(e.dirPath, []);
    leavesOf.get(e.dirPath)!.push(e);
  }

  // Form (b): a plain page X.md (or a board/table equivalent) next to X/ is
  // the page for that directory, just as X/index.md is in form (a). Only an
  // unambiguous single page may claim a directory; on an externally-created
  // name collision we keep the synthetic folder rather than hiding a page.
  const claimCandidates = new Map<string, PageIndexEntry[]>();
  for (const e of entries) {
    if (e.isIndex) continue;
    const stem = relPathStem(e.relPath, e.kind);
    const candidate = e.dirPath ? `${e.dirPath}/${stem}` : stem;
    if (!neededDirs.has(candidate) || selfForDir.has(candidate)) continue;
    const candidates = claimCandidates.get(candidate) ?? [];
    candidates.push(e);
    claimCandidates.set(candidate, candidates);
  }
  const claimedSelfForDir = new Map<string, PageIndexEntry>();
  for (const [dirPath, candidates] of claimCandidates) {
    if (candidates.length === 1) claimedSelfForDir.set(dirPath, candidates[0]);
  }
  const claimedPageIds = new Set(Array.from(claimedSelfForDir.values(), (e) => e.id));

  function buildDirNode(dirPath: string): TreeNode {
    const self = selfForDir.get(dirPath) ?? claimedSelfForDir.get(dirPath);
    const scored: Array<{ order: number; title: string; node: TreeNode }> = [];

    for (const leaf of leavesOf.get(dirPath) ?? []) {
      if (claimedPageIds.has(leaf.id)) continue;
      scored.push({ order: leaf.order, title: leaf.title, node: { ...toPageMeta(leaf), children: [] } });
    }
    for (const sub of subdirsOf.get(dirPath) ?? []) {
      const subSelf = selfForDir.get(sub) ?? claimedSelfForDir.get(sub);
      const node = buildDirNode(sub);
      scored.push({ order: subSelf ? subSelf.order : ORDER_SENTINEL, title: subSelf ? subSelf.title : node.title, node });
    }
    scored.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
    const children = scored.map((s) => s.node);

    if (self) return { ...toPageMeta(self), children };

    const updatedAt = children.length > 0 ? children.reduce((max, c) => (c.updatedAt > max ? c.updatedAt : max), children[0].updatedAt) : new Date().toISOString();
    return {
      id: `dir:${dirPath}`,
      space,
      path: dirPath,
      kind: 'folder',
      title: humanize(dirBasename(dirPath)),
      order: ORDER_SENTINEL,
      status: 'published',
      updatedAt,
      children,
    };
  }

  return [buildDirNode('')];
}

// ---------------------------------------------------------------------------
// One page's subtree (round 13's ::pagetree directive; server side landed in
// round 25 as a prod bug fix — web/src/markdown/PageTree.tsx has always
// fetched GET /api/pages/:id/subtree, and the route simply did not exist, so
// EVERY ::pagetree on the instance 404'd and degraded to "no child pages").
// ---------------------------------------------------------------------------

/**
 * A node of GET /api/pages/:id/subtree. Deliberately narrower than TreeNode:
 * every node here is a REAL, navigable page (the client links straight to
 * /s/:space/p/:id), so there is no synthetic `dir:` folder node in this
 * shape — see collectDirChildren below for what happens to a directory that
 * has no page of its own. A pending shared/contracts.ts addition.
 */
export interface SubtreeNode {
  id: string;
  space: string;
  path: string;
  title: string;
  icon?: string;
  children: SubtreeNode[];
}

export const SUBTREE_MIN_DEPTH = 1;
export const SUBTREE_MAX_DEPTH = 5;
export const SUBTREE_DEFAULT_DEPTH = 2;

/**
 * 1..5, default 2 — the same range and default the directive's own attribute
 * parser uses on the client (web/src/markdown/pagetreeSplit.ts's
 * parsePagetreeDepth), so a hand-typed `?depth=99` can never make the server
 * walk further than the directive itself ever asks for.
 */
export function clampSubtreeDepth(raw: string | number | null | undefined): number {
  if (raw === null || raw === undefined || raw === '') return SUBTREE_DEFAULT_DEPTH;
  const n = typeof raw === 'number' ? Math.trunc(raw) : Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return SUBTREE_DEFAULT_DEPTH;
  return Math.min(SUBTREE_MAX_DEPTH, Math.max(SUBTREE_MIN_DEPTH, n));
}

/** `notes/plan.md` -> `plan`, `notes/board.excalidraw.svg` -> `board`, `notes/weekly.table.md` -> `weekly`. */
/**
 * What a COPY of `entry` should be named after, before translit/uniquing. The
 * title for everything that has a real one — and the path stem for a file page
 * (pdf/docx/xlsx/pptx), whose title now carries the extension (titleFallback):
 * slugging that would give `offer-pptx.pptx`.
 */
function copyStemFor(entry: { title: string; relPath: string; kind: PageKind }): string {
  return entry.kind === 'pdf' || entry.kind === 'office' ? relPathStem(entry.relPath, entry.kind) : entry.title;
}

export function relPathStem(relPath: string, kind: PageKind): string {
  const base = dirBasename(relPath);
  if (kind === 'board') return base.slice(0, -'.excalidraw.svg'.length);
  // Same whole-suffix rule as titleFallback above: slicing only '.md' off a table
  // left a bogus '.table', so a table's child directory came out as `weekly.table`.
  if (kind === 'table') return base.slice(0, -'.table.md'.length);
  // Same whole-suffix rule, round FORMS.
  if (kind === 'form') return base.slice(0, -'.form.md'.length);
  // A pdf leaf has no sibling children directory in practice (nothing ever
  // creates one), but this must still return a sane stem — same rule as
  // every other kind — for the isDirectory() probe above to check the right
  // path instead of a mangled one.
  if (kind === 'pdf') return base.slice(0, -'.pdf'.length);
  // Round OFFICE: same "no real sibling children directory in practice, but
  // still return a sane stem" rule as pdf above.
  if (kind === 'office') {
    const fmt = officeFormat(relPath);
    return fmt ? base.slice(0, -(fmt.length + 1)) : base;
  }
  return base.slice(0, -'.md'.length);
}

/**
 * The children of one page, `depth` levels deep. Two page shapes have
 * children, and getTree models both of them as well:
 *
 *  (a) the page IS a directory's index (index.md, or README.md when there is
 *      no index.md) — its children are that directory's other entries. This
 *      is exactly getTree's model, scoped to one subtree.
 *
 *  (b) the page is a plain file `X.md` sitting NEXT TO a directory `X/`.
 *      `X/`'s contents are X.md's children, and `X/` is not also listed as a
 *      sibling of X.md (see claimedDirs) — it would otherwise appear twice.
 *
 * A directory with no page of its own (no index.md/README.md, and no
 * same-named sibling file claiming it) is TRANSPARENT: its contents are
 * hoisted into the level where it would have sat, keeping their own sort
 * order. It cannot be a node itself — this response shape has only navigable
 * pages in it — and dropping it would silently hide every real page beneath
 * it, which is the exact failure this endpoint exists to fix.
 */
export async function getSubtree(entry: PageIndexEntry, depth: number, allowedPageIds?: ReadonlySet<string>): Promise<SubtreeNode[]> {
  const entries = (await listEntries(entry.space)).filter((e) => !isUnderTemplates(e.relPath) && (!allowedPageIds || allowedPageIds.has(e.id)));

  const selfForDir = new Map<string, PageIndexEntry>();
  for (const e of entries) if (e.isIndex) selfForDir.set(e.dirPath, e);

  const leavesOf = new Map<string, PageIndexEntry[]>();
  for (const e of entries) {
    if (e.isIndex) continue;
    const list = leavesOf.get(e.dirPath) ?? [];
    list.push(e);
    leavesOf.set(e.dirPath, list);
  }

  // Every directory that exists at all, including in-between ones with no
  // entry of their own (same ancestor walk getTree does).
  const allDirs = new Set<string>(['']);
  for (const e of entries) {
    let cur = e.dirPath;
    for (;;) {
      if (allDirs.has(cur)) break;
      allDirs.add(cur);
      if (cur === '') break;
      cur = posixParent(cur);
    }
  }
  const subdirsOf = new Map<string, string[]>();
  for (const d of allDirs) {
    if (d === '') continue;
    const parent = posixParent(d);
    const list = subdirsOf.get(parent) ?? [];
    list.push(d);
    subdirsOf.set(parent, list);
  }

  /** The directory whose contents are this page's children, if any. */
  function childDirOf(e: PageIndexEntry): string | undefined {
    if (e.isIndex) return e.dirPath;
    const stem = relPathStem(e.relPath, e.kind);
    const candidate = e.dirPath ? `${e.dirPath}/${stem}` : stem;
    return allDirs.has(candidate) ? candidate : undefined;
  }

  const claimedDirs = new Set<string>();
  for (const e of entries) {
    if (e.isIndex) continue;
    const dir = childDirOf(e);
    if (dir !== undefined) claimedDirs.add(dir);
  }

  interface Scored {
    order: number;
    title: string;
    node: SubtreeNode;
  }

  function nodeFor(e: PageIndexEntry, remaining: number): SubtreeNode {
    const node: SubtreeNode = { id: e.id, space: e.space, path: e.relPath, title: e.title, children: [] };
    if (e.icon) node.icon = e.icon;
    const dir = childDirOf(e);
    if (dir !== undefined && remaining > 1) node.children = collectDirChildren(dir, remaining - 1).map((s) => s.node);
    return node;
  }

  // Recursion always descends (an index page's own directory only ever yields
  // its leaves and strictly deeper subdirectories; a leaf's claimed directory
  // is strictly deeper than the leaf) — no cycle is reachable, and `remaining`
  // bounds it regardless.
  function collectDirChildren(dir: string, remaining: number): Scored[] {
    const out: Scored[] = [];
    for (const leaf of leavesOf.get(dir) ?? []) {
      out.push({ order: leaf.order, title: leaf.title, node: nodeFor(leaf, remaining) });
    }
    for (const sub of subdirsOf.get(dir) ?? []) {
      if (claimedDirs.has(sub)) continue; // already nested under its same-named sibling file
      const self = selfForDir.get(sub);
      if (self) out.push({ order: self.order, title: self.title, node: nodeFor(self, remaining) });
      else out.push(...collectDirChildren(sub, remaining)); // transparent directory
    }
    out.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
    return out;
  }

  const rootDir = childDirOf(entry);
  if (rootDir === undefined) return [];
  return collectDirChildren(rootDir, depth).map((s) => s.node);
}

/** _templates/*.md — round 5's "create from template". viewer+ (checked by the route). */
export async function listTemplates(space: string): Promise<PageMeta[]> {
  if (!(await spaceExists(space))) throw notFound('space');
  const entries = await listEntries(space);
  return entries.filter((e) => isUnderTemplates(e.relPath) && e.kind === 'doc').map(toPageMeta);
}

// ---------------------------------------------------------------------------
// Write API
// ---------------------------------------------------------------------------

async function uniqueRelPath(space: string, parentPath: string, stem: string, ext: string): Promise<string> {
  let candidate = stem;
  let n = 2;
  for (;;) {
    const rel = parentPath ? `${parentPath}/${candidate}${ext}` : `${candidate}${ext}`;
    if (!(await pathExists(path.join(spaceDir(space), rel)))) return rel;
    candidate = `${stem}-${n++}`;
  }
}

/**
 * Initial content for `createPage` — what the CLIENT already wrote into its
 * local Y.Doc while offline (see `decodeClientState` in collab.ts, the only
 * producer). Only `kind: 'doc'` reads `docBody` and only `kind: 'board'` reads
 * `boardSvg`; both are ignored for every other kind, and both are optional so
 * a blank page still gets the ordinary starter file.
 */
export interface CreatePageInitial {
  /** The markdown BODY (no frontmatter) — becomes the file body instead of `# <title>`. */
  docBody?: string;
  /** A rendered `.excalidraw.svg` with the scene embedded — replaces the blank 1x1 starter. */
  boardSvg?: string;
}

/** `language` decides the language of the default names written INTO a new file (the first view of a data table, the first field of a form's table). */
export async function createPage(body: CreatePageBody, initial?: CreatePageInitial, language?: string): Promise<PageMeta> {
  let title = body.title.trim();
  if (!title) throw badRequest('title is required');
  // An OFFLINE-created doc names itself the way any doc does — by its H1 — and the
  // slug below follows that name, so a title the user retyped in the editor before
  // the page ever reached the server wins over the `title` the create form held.
  // Whitespace-only content counts as "nothing supplied": the starter (`# <title>`)
  // keeps the page findable by name, where an empty file would be titled by its slug.
  const docBody = body.kind === 'doc' && initial?.docBody?.trim() ? initial.docBody : undefined;
  if (docBody !== undefined) title = extractH1(docBody) ?? title;
  const boardSvg = body.kind === 'board' && initial?.boardSvg ? initial.boardSvg : undefined;
  // A pdf/office page only ever comes from an upload (POST /api/spaces/:space/pdf)
  // or a scan finding one already in the repo — never from this generic
  // "blank starter page" endpoint, which has no file bytes to create it with.
  if (body.kind === 'pdf' || body.kind === 'office') throw badRequest('pdf/office pages are created by uploading a file, not by this endpoint');
  if (!(await spaceExists(body.space))) throw notFound('space');

  return withSpaceLock(body.space, async () => {
    const parentPath = normalizeDirParam(body.parentPath);
    await fs.mkdir(path.join(spaceDir(body.space), parentPath), { recursive: true });

    // OFFLINE CREATION: the client minted the id (its URL and every link to the page
    // already use it). The route answers a replay of an id that is already taken
    // before it gets here; this re-check, under the space lock, only closes the race
    // of two concurrent creates with the same id — the loser gets a 409 (its retry
    // then finds the page and is answered as a replay) instead of a second file
    // stamped with the same id.
    const id = body.id ?? ulid();
    if (body.id && (await getEntry(body.id))) throw conflict('a page with this id already exists');
    let relPath: string;
    if (body.kind === 'board') {
      relPath = await uniqueRelPath(body.space, parentPath, translitSlug(title), '.excalidraw.svg');
      // QA-3: the header must carry the TITLE too, not just the id. A board has no
      // frontmatter and no H1, so `folio-title` is the only place its name can live;
      // without it scanSpace falls back to the file name and a board created as
      // "My release plan" typed in Cyrillic showed up in the tree as its transliterated file name. The mechanism
      // was already here and already used by setBoardTitle/writeBoardSvg — creation
      // just never called it. (The doc branch below does the equivalent by writing
      // `# ${title}` into the markdown.)
      const svg = withBoardHeader(
        boardSvg ?? '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 1 1"></svg>\n',
        id,
        undefined,
        title,
        undefined,
      );
      await fs.writeFile(path.join(spaceDir(body.space), relPath), svg, 'utf8');
    } else if (body.kind === 'table') {
      // Round 26 (DATA TABLES), spec §8: created via the SAME endpoint as a doc/board
      // (kind: 'table'), optionally with a `columns` template. Starter file is
      // empty-but-VALID — a single default view (named in the user's language, per spec §5: "The first
      // view is created automatically when the table is created") and zero rows — serialized
      // through the shared codec so it's byte-for-byte what a normal write would
      // produce, never a hand-rolled frontmatter block.
      relPath = await uniqueRelPath(body.space, parentPath, translitSlug(title), '.table.md');
      const doc: TableDoc = {
        meta: { id, version: 1, rowIds: 'column' },
        head: `# ${title}\n\n`,
        tail: '',
        columns: body.columns ?? [],
        views: [
          {
            id: 'all',
            name: serverText('table.defaultView', language),
            columns: { hidden: [], order: [], width: {} },
            sort: [],
            filter: { op: 'and', rules: [] },
            frozen: 0,
            rowHeight: 'short',
          } satisfies TableView,
        ],
        rows: [],
      };
      await fs.writeFile(path.join(spaceDir(body.space), relPath), serializeTableFile(doc), 'utf8');
    } else if (body.kind === 'form') {
      // Round FORMS: "+ → Form" creates the form AND its paired data table
      // in one shot (spec: "1:1 pair") — two direct-file writes, same
      // starter shape the 'table' branch above uses (a single default view,
      // no rows), sensible default schema: one text column. `id` (this
      // function's own top-level ulid) becomes the FORM's id, since that's
      // the page this call returns — the table gets its own, separate id.
      //
      // Nesting (owner decision, post-merge fix): the table is the FORM's
      // own CHILD page — it lives in the `<formSlug>/` directory next to
      // `<formSlug>.form.md`, the same "leaf page + same-named sibling
      // directory = children" convention every other kind already gets for
      // free (childDirOf/relPathStem, getTree/getSubtree) — not a special
      // case, just placing the table's file where an ordinary child page
      // of the form would go. The form's own relPath is minted FIRST
      // (before the table) because the child directory name is derived
      // from IT.
      relPath = await uniqueRelPath(body.space, parentPath, translitSlug(title), '.form.md');
      const formStem = relPathStem(relPath, 'form');
      const tableParentPath = parentPath ? `${parentPath}/${formStem}` : formStem;
      await fs.mkdir(path.join(spaceDir(body.space), tableParentPath), { recursive: true });

      const tableId = ulid();
      const tableRelPath = await uniqueRelPath(body.space, tableParentPath, translitSlug(title), '.table.md');
      const starterColumns: TableColumn[] = body.columns ?? [{ id: 'field_1', name: serverText('table.firstField', language), type: 'text' }];
      const tableDoc: TableDoc = {
        meta: { id: tableId, version: 1, rowIds: 'column' },
        head: `# ${title}\n\n`,
        tail: '',
        columns: starterColumns,
        views: [
          {
            id: 'all',
            name: serverText('table.defaultView', language),
            columns: { hidden: [], order: [], width: {} },
            sort: [],
            filter: { op: 'and', rules: [] },
            frozen: 0,
            rowHeight: 'short',
          } satisfies TableView,
        ],
        rows: [],
      };
      await fs.writeFile(path.join(spaceDir(body.space), tableRelPath), serializeTableFile(tableDoc), 'utf8');

      const formDoc: FormDoc = {
        meta: { id, version: 1 },
        table: tableRelPath,
        title,
        public: false,
        fields: deriveFieldsFromColumns(starterColumns),
        body: '',
      };
      await fs.writeFile(path.join(spaceDir(body.space), relPath), serializeFormFile(formDoc), 'utf8');
    } else {
      relPath = await uniqueRelPath(body.space, parentPath, translitSlug(title), '.md');
      await persistDocFrontmatter(path.join(spaceDir(body.space), relPath), { id }, docBody ?? `# ${title}\n`);
    }
    await scanSpace(body.space);
    const entry = await getEntry(id);
    if (!entry) throw new Error('internal: page created but not indexed');
    return toPageMeta(entry);
  });
}

/**
 * Uploads a pdf/office file as a new page: the bytes are written exactly as
 * received and the following scan indexes them (id resolved per "Binary page
 * files" above — for a brand-new path that is the deterministic path id).
 * Looked up by exact path afterwards rather than assumed. `ext` is the
 * lowercase extension including the dot (`.pdf`, `.docx`, `.xlsx`, `.pptx`) —
 * the route has already validated it against the filename and magic bytes.
 */
export async function uploadFilePage(space: string, parentPathRaw: string, originalFilename: string, ext: string, bytes: Buffer): Promise<PageMeta> {
  if (!(await spaceExists(space))) throw notFound('space');

  return withSpaceLock(space, async () => {
    const parentPath = normalizeDirParam(parentPathRaw);
    await fs.mkdir(path.join(spaceDir(space), parentPath), { recursive: true });

    const baseName = originalFilename.slice(0, originalFilename.length - ext.length);
    const stem = translitSlug(baseName) || 'document';
    const relPath = await uniqueRelPath(space, parentPath, stem, ext);
    const destAbs = path.join(spaceDir(space), relPath);

    await fs.writeFile(destAbs, bytes);

    await scanSpace(space);
    const entryId = await getEntryIdByExactPath(space, relPath);
    if (!entryId) throw new Error('internal: file uploaded but not indexed');
    return toPageMeta(await requireEntry(entryId));
  });
}

async function insertSpaceRow(slug: string, name: string, opts: { repoUrl?: string | null; branch?: string; rootPath?: string; status: string; createdBy: string | null }): Promise<void> {
  try {
    await query(
      `INSERT INTO spaces (slug, name, repo_url, branch, root_path, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [slug, name, opts.repoUrl ?? null, opts.branch ?? 'main', opts.rootPath ?? '', opts.status, opts.createdBy],
    );
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('a space with this slug already exists (try again)');
    throw err;
  }
  rootPathCache.set(slug, opts.rootPath ?? '');
}

async function uniqueSpaceSlug(name: string): Promise<string> {
  const base = translitSlug(name);
  let slug = base;
  let n = 2;
  while (await spaceExists(slug)) slug = `${base}-${n++}`;
  return slug;
}

// ---------------------------------------------------------------------------
// .folio metadata file (round 22): `<slug>.folio` at the REPO ROOT (`dir`,
// NOT the rootPath-adjusted content root — one shared repo can host multiple
// spaces at different rootPaths, each disambiguated by its own slug-named
// file living at that shared repo root rather than needing a spot inside
// each one's own content subtree). v1 shape: {"v":1,"name":"..."} —
// deliberately minimal, extensible later (export letterheads etc. per
// DEV-PLAN). Carries the space's human name across a repo move/re-clone.
// A newly connected space always writes its own exact slug-named file; it
// never adopts another `*.folio` from a shared repository.
// ---------------------------------------------------------------------------

const FOLIO_META_EXT = '.folio';

/**
 * Writes/overwrites this space's canonical `<slug>.folio` at the repo root.
 * No-ops silently on a blank name. Fire-and-forget-safe by design: this only
 * touches the filesystem — getting it committed is the caller's job, either
 * by riding an already-planned explicit commit (createSpace/
 * createSpaceFromRepo) or by relying on the standard debounced auto-commit
 * (noteSpaceNameChange below), exactly like any other content edit.
 */
async function writeFolioMeta(dir: string, slug: string, name: string): Promise<void> {
  const trimmedName = name.trim();
  if (!trimmedName) return;
  const body = `${JSON.stringify({ v: 1, name: trimmedName }, null, 2)}\n`;
  await fs.writeFile(path.join(dir, `${slug}${FOLIO_META_EXT}`), body, 'utf8');
}

/**
 * Called whenever the space's display name changes. Keeps the DB and the
 * canonical `<slug>.folio` metadata file in sync. Git write-back is the
 * caller's responsibility, just like for any other content edit.
 */
export async function noteSpaceNameChange(space: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  await query('UPDATE spaces SET name = $2 WHERE slug = $1', [space, trimmed]).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[folio-meta] failed to update spaces.name for ${space}:`, err);
  });
  await writeFolioMeta(repoDir(space), space, trimmed).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[folio-meta] failed to update ${space}.folio:`, err);
  });
}

/** Renames a space without changing its stable slug or its root page H1. */
export async function renameSpace(space: string, name: string): Promise<SpaceInfo> {
  const trimmed = name.trim();
  if (!trimmed) throw badRequest('space name is required');
  if (!(await spaceExists(space))) throw notFound('space');
  await noteSpaceNameChange(space, trimmed);
  const info = await getSpaceInfo(space);
  if (!info) throw notFound('space');
  return info;
}

/** Empty space (round 1/2 behavior, now git-initialized instead of a plain directory). */
export async function createSpace(name: string, createdBy: string | null): Promise<SpaceInfo> {
  const trimmed = name.trim();
  if (!trimmed) throw badRequest('space name is required');
  const slug = await uniqueSpaceSlug(trimmed);

  const dir = repoDir(slug);
  await fs.mkdir(dir, { recursive: true });
  await persistDocFrontmatter(path.join(dir, 'index.md'), { id: ulid() }, `# ${trimmed}\n`);
  await writeFolioMeta(dir, slug, trimmed); // rides the SAME initial commit as index.md, right below
  await git.initWithCommit(dir, 'init: create space');

  await insertSpaceRow(slug, trimmed, { status: 'local', createdBy });
  await scanSpace(slug);
  const info = await getSpaceInfo(slug);
  if (!info) throw new Error('internal: space created but not indexed');
  return info;
}

/** Space cloned from an existing git repo (round 3 "CREATE FROM REPO"). Clone happens OUTSIDE the space lock (the slug — and its lock key — doesn't exist yet); a failed clone leaves no space row and no directory. */
export async function createSpaceFromRepo(opts: {
  name: string;
  repoUrl: string;
  branch: string;
  rootPath: string;
  createdBy: string | null;
  /** Https token, if any. Stored under the final slug BEFORE cloning (the askpass helper looks it up by slug), removed again if the clone/validation fails. */
  token?: string;
  onProgress?: (progress: { phase?: 'cloning' | 'scanning' | 'finalizing'; percent?: number; processedFiles?: number; totalFiles?: number }) => void;
}): Promise<SpaceInfo> {
  const trimmed = opts.name.trim();
  if (!trimmed) throw badRequest('space name is required');
  const rootPath = normalizeDirParam(opts.rootPath ?? '');
  const slug = await uniqueSpaceSlug(trimmed);
  const dir = repoDir(slug);

  let askpassScript: string | undefined;
  if (opts.token) {
    await setSpaceToken(slug, opts.token);
    askpassScript = await ensureAskpassScript();
  }

  try {
    // A brand-new instance repo (e.g. this instance's default content repo before
    // its first space) clones fine but has no branches at all — a --branch-scoped
    // clone fails outright against that. Detect it first via ls-remote (cheap,
    // version-independent) and bootstrap main + a root README instead of failing.
    if (await git.isEmptyRemote(opts.repoUrl, askpassScript, slug)) {
      opts.onProgress?.({ phase: 'cloning', percent: 10 });
      await git.cloneEmptyAndBootstrap(opts.repoUrl, dir, opts.branch, '# Folio content repo\n', askpassScript, slug);
    } else {
      opts.onProgress?.({ phase: 'cloning', percent: 8 });
      await git.clone(opts.repoUrl, dir, opts.branch, askpassScript, slug, (percent) => {
        opts.onProgress?.({ phase: 'cloning', percent: 8 + Math.round(percent * 0.47) });
      });
    }
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    if (opts.token) await removeSpaceToken(slug).catch(() => {});
    throw badRequest(`could not clone repository: ${err instanceof Error ? err.message : String(err)}`);
  }

  const contentRoot = rootPath ? path.join(dir, rootPath) : dir;
  const rootPathExists = (await pathExists(contentRoot)) && (await fs.stat(contentRoot)).isDirectory();
  if (!rootPathExists) {
    // The folder doesn't exist yet in this repo (e.g. a fresh top-level folder
    // for a new space in the shared default content repo) — create it with a
    // starter index.md, commit, and push, rather than failing the whole create.
    try {
      await fs.mkdir(contentRoot, { recursive: true });
      await persistDocFrontmatter(path.join(contentRoot, 'index.md'), { id: ulid() }, `# ${trimmed}\n`);
      await git.commitAndPushIfRemote(dir, opts.branch, `docs(${slug}): init space`, askpassScript, slug);
    } catch (err) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      if (opts.token) await removeSpaceToken(slug).catch(() => {});
      throw badRequest(`could not initialize rootPath "${rootPath}" in the repository: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // The value submitted in the create dialog is authoritative. A shared
  // repository can contain several `*.folio` files for several root paths;
  // picking the first one made a newly-created space inherit an unrelated
  // previous space's name (for example `healthcheck` appeared as "BO Space").
  const effectiveName = trimmed;

  opts.onProgress?.({ phase: 'finalizing', percent: 56 });
  await insertSpaceRow(slug, effectiveName, { repoUrl: opts.repoUrl, branch: opts.branch, rootPath, status: 'clean', createdBy: opts.createdBy });
  try {
    return await finishSpaceFromRepo(slug, dir, effectiveName, opts, askpassScript);
  } catch (err) {
    // Anything that fails AFTER the row exists used to leave it behind: the
    // caller never reached setMembership, so the half-made space had no member
    // and was invisible to the person who tried to create it — and each retry
    // minted another one under `-2`, `-3` (exactly what prod showed, 15.09).
    // Undo the whole attempt instead: the row (pages_index/ydoc rows go with it
    // by ON DELETE CASCADE), the clone, the stored token.
    await query('DELETE FROM spaces WHERE slug = $1', [slug]).catch(() => {});
    rootPathCache.delete(slug);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    if (opts.token) await removeSpaceToken(slug).catch(() => {});
    throw err;
  }
}

async function finishSpaceFromRepo(
  slug: string,
  dir: string,
  effectiveName: string,
  opts: { branch: string; onProgress?: (progress: { phase?: 'cloning' | 'scanning' | 'finalizing'; percent?: number; processedFiles?: number; totalFiles?: number }) => void },
  askpassScript: string | undefined,
): Promise<SpaceInfo> {
  await writeFolioMeta(dir, slug, effectiveName);
  // Best-effort: the space is already created and usable without this file ever reaching
  // the remote (unlike the rootPath-bootstrap commit above, which is fatal if it fails —
  // without THAT commit the space would have no content at all). A failure here just means
  // the next manual/periodic sync commits it on a later pass instead.
  await git.commitAndPushIfRemote(dir, opts.branch, `docs(${slug}): space metadata`, askpassScript, slug).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[folio-meta] failed to commit/push ${slug}${FOLIO_META_EXT}:`, err);
  });

  opts.onProgress?.({ phase: 'scanning', percent: 60, processedFiles: 0, totalFiles: 0 });
  await scanSpace(slug, ({ processedFiles, totalFiles }) => {
    const ratio = totalFiles > 0 ? processedFiles / totalFiles : 1;
    opts.onProgress?.({ phase: 'scanning', percent: 60 + Math.round(ratio * 36), processedFiles, totalFiles });
  });
  opts.onProgress?.({ phase: 'finalizing', percent: 98 });
  const info = await getSpaceInfo(slug);
  if (!info) throw new Error('internal: space created but not indexed');
  return info;
}

/**
 * "Connect git" — connects an EXISTING local space (created via
 * createSpace above: `git init`'d, with its own content and its own commit
 * history, but no `origin`) to a real repository after the fact.
 *
 * The key decision this function encodes: a local space's working tree and
 * git history already exist and must never be silently discarded or merged
 * with a stranger's — so this only ever succeeds against a repository
 * `isEmptyRemote()` confirms has ZERO refs. Against an empty remote there is
 * no real "other history" to reconcile: `git remote add` + a plain push is
 * exactly as safe as `cloneEmptyAndBootstrap`'s own "push local into a
 * fresh repo" path, just with content that already existed instead of a
 * freshly-written README. Against a NON-empty remote this throws a 409
 * instead — silently merging two unrelated histories (or worse, force-
 * pushing over one) is not something to do without the user explicitly
 * choosing it, and DEV-PLAN's own guidance for this exact fork ("we create a
 * new space from this repository rather than try to glue them silently") already
 * has a first-class path: CreateSpaceDialog's existing "from a git repository"
 * tab, unchanged by this function. The local space's own content is never
 * touched on this path — the whole operation runs read-then-refuse before
 * a single write happens.
 *
 * Runs entirely under the space's own Redis lock (matching gitSync's
 * performSync precedent for a mutating git op with a network round trip) so
 * a concurrent manual/periodic sync can't interleave with the remote-add +
 * push. The "already connected" check is re-read from the DB INSIDE the
 * lock (not from the `SpaceInfo` the route handler might have looked at
 * moments earlier) specifically to close the TOCTOU window a racing double-
 * submit would otherwise open.
 */
export async function connectSpaceToRepo(
  space: string,
  opts: {
    repoUrl: string;
    branch: string;
    /** Https token, if any — stored under the space's slug BEFORE the emptiness check (the askpass helper looks it up by slug), removed again if the connect doesn't go through for ANY reason (already connected, non-empty remote, or a git failure). */
    token?: string;
  },
): Promise<SpaceInfo> {
  const repoUrl = opts.repoUrl.trim();
  if (!repoUrl) throw badRequest('repository URL is required');
  const branch = opts.branch.trim() || 'main';

  let askpassScript: string | undefined;
  if (opts.token) {
    await setSpaceToken(space, opts.token);
    askpassScript = await ensureAskpassScript();
  }

  let connected = false;
  try {
    const info = await withSpaceLock(space, async () => {
      const row = await queryOne<{ repo_url: string | null }>('SELECT repo_url FROM spaces WHERE slug = $1', [space]);
      if (!row) throw notFound('space');
      if (row.repo_url) throw conflict('space is already connected to a git repository');

      let empty: boolean;
      try {
        empty = await git.isEmptyRemote(repoUrl, askpassScript, space);
      } catch (err) {
        throw badRequest(`could not check the repository: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!empty) {
        // The core "two histories" fork (see doc comment above): refuse rather than
        // merge/overwrite, and point at the alternative that already exists.
        throw conflict(
          'repository is not empty: the space already has its own content and git history, so connecting it to a non-empty repository would mean two histories that cannot be merged automatically. Create a new space from that repository instead.',
        );
      }

      const dir = repoDir(space);
      try {
        await git.addRemote(dir, repoUrl);
        // A local space's content isn't necessarily committed yet — createPage/writeDocBody
        // etc. write straight to disk and rely on gitSync's own debounced auto-commit (or a
        // manual sync) to fold that into a commit; connecting must not push a HEAD that's
        // missing whatever's currently sitting uncommitted on disk. Same Folio system
        // identity as every other space-lifecycle commit (initWithCommit/
        // cloneEmptyAndBootstrap/the .folio-metadata commit above) — this one isn't
        // attributable to a single edit either. Always pushes after, regardless of whether
        // there WAS anything new to commit: a space with nothing pending (just its original
        // init commit) still needs that commit to actually reach the — until now genuinely
        // empty — remote.
        await git.commitAll(dir, `docs(${space}): connect to remote`, { name: 'Folio', email: 'folio@instance' });
        await git.push(dir, branch, askpassScript, space);
      } catch (err) {
        await git.removeRemote(dir, 'origin').catch(() => {});
        throw badRequest(`could not connect the repository: ${err instanceof Error ? err.message : String(err)}`);
      }

      await query(`UPDATE spaces SET repo_url = $2, branch = $3, status = 'clean', last_error = NULL WHERE slug = $1`, [
        space,
        repoUrl,
        branch,
      ]);

      await scanSpace(space);
      const updated = await getSpaceInfo(space);
      if (!updated) throw new Error('internal: space connected but not indexed');
      return updated;
    });
    connected = true;
    return info;
  } finally {
    if (!connected && opts.token) await removeSpaceToken(space).catch(() => {});
  }
}

/**
 * Patches title/body/updatedAt on the pages_index row for a content-only edit
 * (no directory rescan). Originally doc-only; round 26 (DATA TABLES) also
 * calls this from collab.ts's table persistence path (patching in the
 * denormalized plain-text after a live table edit — see collab.ts:~1604), so
 * the title fallback uses `entry.kind` (already on hand) rather than a
 * hardcoded 'doc' — for a doc entry this is exactly the same as before
 * (entry.kind IS 'doc'), and it now also does the right thing for a table
 * entry with no H1 in its (denormalized) text (titleFallback strips the
 * whole ".table.md" suffix, not just ".md" — see that function's own doc
 * comment for why getting this wrong is the easy way to misname a table).
 */
export async function patchEntryContent(entry: PageIndexEntry, newBody: string): Promise<PageMeta> {
  const title = extractH1(newBody) ?? titleFallback(entry.relPath, entry.kind);
  const updatedAt = new Date().toISOString();
  await query(
    `UPDATE pages_index SET
       title = $2, updated_at = $3, plain_text = $4,
       tsv = setweight(to_tsvector('simple', unaccent($2)), 'A') || setweight(to_tsvector('simple', unaccent(coalesce($4, ''))), 'B')
     WHERE id = $1`,
    [entry.id, title, updatedAt, newBody],
  );
  entry.body = newBody;
  entry.title = title;
  entry.updatedAt = updatedAt;
  await links.reindexPageLinks(entry.id, entry.space, entry.relPath, newBody).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[links] failed to index ${entry.space}/${entry.relPath}:`, err);
  });
  return toPageMeta(entry);
}

/** Direct (non-collab) write of a doc's body. Also used by collab.ts's debounced/flush write-back. `overrideIcon`/`overrideCover` come from a defensively-parsed frontmatter block in the submitted markdown (splitLeadingFrontmatter) — undefined means "keep whatever was already there". */
/**
 * Resolves a PUT's explicit icon/cover field against the current value:
 * undefined (field absent from the request body) -> preserve current;
 * null (field present, explicitly null) -> clear; string -> set. Exported
 * for collab.ts's applyMarkdownUpdate (live-doc PUT path), which needs the
 * identical three-way resolution before persisting via setDocIconCover.
 */
export function resolveIconCoverOverride(override: string | null | undefined, current: string | undefined): string | undefined {
  if (override === undefined) return current;
  return override ?? undefined; // null -> undefined (clear); string -> itself (set)
}

export async function writeDocBody(id: string, markdown: string, overrideIcon?: string | null, overrideCover?: string | null): Promise<PageMeta> {
  const entry = await requireEntry(id);
  if (entry.kind !== 'doc') throw badRequest('page is not a document');
  const icon = resolveIconCoverOverride(overrideIcon, entry.icon);
  const cover = resolveIconCoverOverride(overrideCover, entry.cover);
  await persistDocFrontmatter(entry.absPath, { id: entry.id, order: entry.explicitOrder, status: entry.explicitStatus, icon, cover }, markdown);
  if (icon !== entry.icon || cover !== entry.cover) {
    await query('UPDATE pages_index SET icon = $2, cover = $3 WHERE id = $1', [id, icon ?? null, cover ?? null]);
    entry.icon = icon;
    entry.cover = cover;
  }
  return patchEntryContent(entry, markdown);
}

/**
 * Immediately persists an icon/cover change to BOTH the file's frontmatter
 * and the pages_index row — used by collab.ts's applyMarkdownUpdate (a PUT
 * landing on an already-live doc, e.g. round 5's icon picker while the page
 * is open in the collaborative editor). That path can't just fold icon/cover
 * into the Yjs body update: the CRDT text never carries frontmatter, and the
 * normal debounced write-back only triggers off a Yjs *body* update — an
 * icon-only change (body text unchanged) wouldn't otherwise trigger one at
 * all, leaving the new icon sitting in the DB but never reaching the
 * git-tracked file. No-ops if icon/cover didn't actually change.
 */
export async function setDocIconCover(
  entry: PageIndexEntry,
  icon: string | undefined,
  cover: string | undefined,
  currentBody: string,
): Promise<void> {
  if (icon === entry.icon && cover === entry.cover) return;
  await persistDocFrontmatter(entry.absPath, { id: entry.id, order: entry.explicitOrder, status: entry.explicitStatus, icon, cover }, currentBody);
  await query('UPDATE pages_index SET icon = $2, cover = $3 WHERE id = $1', [entry.id, icon ?? null, cover ?? null]);
  entry.icon = icon;
  entry.cover = cover;
}

/**
 * Round 22 (SHELL's tree "Up/Down"): immediately persists an explicit
 * sibling order to BOTH the file's frontmatter and the pages_index row —
 * same "why immediately, not through the debounced write-back" reasoning as
 * setDocIconCover just above (order isn't part of the Yjs body either, so a
 * reorder with no accompanying text edit would never otherwise reach the
 * git-tracked file). Doc pages only — setBoardOrder/setTableOrder below are
 * the board/table twins, each persisting into whatever that kind of file
 * actually has room for.
 */
export async function setDocOrder(entry: PageIndexEntry, order: number, currentBody: string): Promise<void> {
  if (order === entry.explicitOrder) return;
  await persistDocFrontmatter(entry.absPath, { id: entry.id, order, status: entry.explicitStatus, icon: entry.icon, cover: entry.cover }, currentBody);
  await query('UPDATE pages_index SET sort_order = $2 WHERE id = $1', [entry.id, order]);
  entry.order = order;
  entry.explicitOrder = order;
}

/**
 * setDocOrder's BOARD twin. A `.excalidraw.svg` has no frontmatter, so the
 * order goes where the id already lives: a leading `<!-- folio-order: N -->`
 * comment (see splitBoardHeader). The file is re-read fresh and only its
 * comment block is rewritten — `rest` (the `<svg>` element and the base64
 * excalidraw scene embedded in its `<metadata>`) is copied through
 * unparsed, so an order-only write can never disturb the drawing itself.
 */
export async function setBoardOrder(entry: PageIndexEntry, order: number): Promise<void> {
  if (entry.kind !== 'board') throw badRequest('page is not a board');
  if (order === entry.explicitOrder) return;
  const raw = await fs.readFile(entry.absPath, 'utf8');
  // Read title/icon straight off the file's OWN current header — an order-only
  // write must never wipe either (same reasoning writeBoardSvg documents below).
  const { title, icon } = splitBoardHeader(raw);
  await fs.writeFile(entry.absPath, withBoardHeader(raw, entry.id, order, title, icon), 'utf8');
  await query('UPDATE pages_index SET sort_order = $2 WHERE id = $1', [entry.id, order]);
  entry.order = order;
  entry.explicitOrder = order;
}

/**
 * setDocIconCover's BOARD twin (this round). A board's icon rides the
 * `folio-icon` header comment (see splitBoardHeader/encodeBoardHeaderValue),
 * so — unlike a doc, whose icon lives in real frontmatter mutated via the
 * Yjs write-back path — it is always set immediately and directly, the same
 * shape setBoardOrder above already uses. `icon` is the RESOLVED value
 * (undefined = clear); callers thread the three-way PUT semantics (absent =
 * preserve, null = clear, string = set) through resolveIconCoverOverride
 * before calling this, same as a doc's icon/cover PUT does.
 */
export async function setBoardIcon(entry: PageIndexEntry, icon: string | undefined): Promise<void> {
  if (entry.kind !== 'board') throw badRequest('page is not a board');
  if (icon === entry.icon) return;
  const raw = await fs.readFile(entry.absPath, 'utf8');
  const { title } = splitBoardHeader(raw);
  await fs.writeFile(entry.absPath, withBoardHeader(raw, entry.id, entry.explicitOrder, title, icon), 'utf8');
  await query('UPDATE pages_index SET icon = $2 WHERE id = $1', [entry.id, icon ?? null]);
  entry.icon = icon;
}

/**
 * setDocOrder's TABLE twin (round 26 made `.table.md` a third orderable kind
 * in the very same tree). A table file DOES have frontmatter — but it's the
 * table's SCHEMA, owned by shared/tables/codec.ts, so `order` is set with
 * gray-matter on the leading block alone (body untouched, `lineWidth: -1` to
 * match the codec's own dump options) rather than by round-tripping the doc
 * through parse/serialize. See writeTableDoc for the other half: a normal
 * table write re-applies the order the codec knows nothing about.
 */
export async function setTableOrder(entry: PageIndexEntry, order: number): Promise<void> {
  if (entry.kind !== 'table') throw badRequest('page is not a data table');
  if (order === entry.explicitOrder) return;
  const raw = await fs.readFile(entry.absPath, 'utf8');
  await fs.writeFile(entry.absPath, withTablePageFields(raw, order, entry.icon), 'utf8');
  await query('UPDATE pages_index SET sort_order = $2 WHERE id = $1', [entry.id, order]);
  entry.order = order;
  entry.explicitOrder = order;
}

/** Persists a data-table page icon beside its schema without reserializing rows. */
export async function setTableIcon(entry: PageIndexEntry, icon: string | undefined): Promise<void> {
  if (entry.kind !== 'table') throw badRequest('page is not a data table');
  if (icon === entry.icon) return;
  const raw = await fs.readFile(entry.absPath, 'utf8');
  await fs.writeFile(entry.absPath, withTablePageFields(raw, entry.explicitOrder, icon), 'utf8');
  await query('UPDATE pages_index SET icon = $2 WHERE id = $1', [entry.id, icon ?? null]);
  entry.icon = icon;
}

/** setTableOrder's FORM twin — a form's frontmatter is its own definition (shared/forms/codec.ts owns it), same "gray-matter on the leading block alone" trick withTablePageFields already does for a table's schema. */
export async function setFormOrder(entry: PageIndexEntry, order: number): Promise<void> {
  if (entry.kind !== 'form') throw badRequest('page is not a form');
  if (order === entry.explicitOrder) return;
  const raw = await fs.readFile(entry.absPath, 'utf8');
  await fs.writeFile(entry.absPath, withTablePageFields(raw, order, entry.icon), 'utf8');
  await query('UPDATE pages_index SET sort_order = $2 WHERE id = $1', [entry.id, order]);
  entry.order = order;
  entry.explicitOrder = order;
}

/** setTableIcon's FORM twin. */
export async function setFormIcon(entry: PageIndexEntry, icon: string | undefined): Promise<void> {
  if (entry.kind !== 'form') throw badRequest('page is not a form');
  if (icon === entry.icon) return;
  const raw = await fs.readFile(entry.absPath, 'utf8');
  await fs.writeFile(entry.absPath, withTablePageFields(raw, entry.explicitOrder, icon), 'utf8');
  await query('UPDATE pages_index SET icon = $2 WHERE id = $1', [entry.id, icon ?? null]);
  entry.icon = icon;
}

/**
 * setDocOrder's pdf/office twin. Unlike a doc/board/table, a pdf/office page's
 * underlying file is the OWNER's own binary (see "Binary page files" above) —
 * Folio never writes into it, so there is nowhere inside it to park an order.
 * Trade-off, spelled out because it's the one place this differs from every
 * other kind: order lives ONLY in the derived pages_index row, not in git, so
 * it does not travel with the repo (a clone/fresh space starts unordered) and
 * a rebuilt index has to carry it forward itself — see indexBinaryFile's own
 * lookup-by-id, which is the other half of that: it re-reads this same column
 * on every scan so a rescan doesn't quietly reset what was set here.
 */
export async function setBinaryPageOrder(entry: PageIndexEntry, order: number): Promise<void> {
  if (entry.kind !== 'pdf' && entry.kind !== 'office') throw badRequest('page is not a pdf/office file');
  if (order === entry.explicitOrder) return;
  await query('UPDATE pages_index SET sort_order = $2 WHERE id = $1', [entry.id, order]);
  entry.order = order;
  entry.explicitOrder = order;
}

/** setBinaryPageOrder's icon twin — same "index-only, not in git" trade-off. */
export async function setBinaryPageIcon(entry: PageIndexEntry, icon: string | undefined): Promise<void> {
  if (entry.kind !== 'pdf' && entry.kind !== 'office') throw badRequest('page is not a pdf/office file');
  if (icon === entry.icon) return;
  await query('UPDATE pages_index SET icon = $2 WHERE id = $1', [entry.id, icon ?? null]);
  entry.icon = icon;
}

/**
 * `force` bypasses the blank-overwrite guard: a board PUT (direct edit or a
 * restore/:sha, which goes through this same function) whose new svg has NO
 * embedded excalidraw scene while the file ON DISK right now has one is
 * rejected as a likely blank-canvas-overwrite bug, not applied. Reading the
 * CURRENT file fresh (not `entry.body`, which boards don't populate) so a
 * fast double-save can't race past a check based on stale state — the same
 * read also supplies the title/icon this write must carry forward, since
 * excalidraw's own SVG export never includes the folio-* header at all.
 */
export async function writeBoardSvg(id: string, svg: string, force = false): Promise<PageMeta> {
  const entry = await requireEntry(id);
  if (entry.kind !== 'board') throw badRequest('page is not a board');

  const current = await fs.readFile(entry.absPath, 'utf8').catch(() => '');
  const currentElements = excalidrawLiveElementCount(current);
  const nextElements = excalidrawLiveElementCount(svg);
  if (
    !force &&
    ((currentElements !== null && currentElements > 0 && (nextElements === null || nextElements === 0)) ||
      (!hasExcalidrawScenePayload(svg) && hasExcalidrawScenePayload(current)))
  ) {
    throw badRequest('empty scene over a non-empty board; reload the board');
  }

  // Always force the canonical id, regardless of what the client's svg embeds
  // — and re-stamp the explicit order/title/icon, none of which excalidraw's
  // own export ever carries: without this, every ordinary board save would
  // silently drop the page's position in the tree and wipe its title/icon.
  const { title, icon } = splitBoardHeader(current);
  await fs.writeFile(entry.absPath, withBoardHeader(svg, entry.id, entry.explicitOrder, title, icon), 'utf8');
  const updatedAt = new Date().toISOString();
  await query('UPDATE pages_index SET updated_at = $2 WHERE id = $1', [id, updatedAt]);
  entry.updatedAt = updatedAt;
  return toPageMeta(entry);
}

export async function readFreshDocBody(id: string): Promise<string> {
  const entry = await requireEntry(id);
  if (entry.kind !== 'doc') throw badRequest('page is not a document');
  const raw = await fs.readFile(entry.absPath, 'utf8');
  return matter(raw).content;
}

export async function readBoardSvg(id: string): Promise<string> {
  const entry = await requireEntry(id);
  if (entry.kind !== 'board') throw badRequest('page is not a board');
  return fs.readFile(entry.absPath, 'utf8');
}

/**
 * Round 26 (DATA TABLES) — reads and PARSES a table page's current file.
 * Throws (not a TableParseError return) on a structurally invalid file: every
 * caller of this function is about to either display or MUTATE the table,
 * and both need a real, valid TableDoc to work with — scanSpace's own
 * indexTableFile is the one place a parse error is tolerated (best-effort
 * stub indexing, spec §1), not here.
 */
export async function readFreshTableDoc(id: string): Promise<TableDoc> {
  const entry = await requireEntry(id);
  if (entry.kind !== 'table') throw badRequest('page is not a data table');
  const raw = await fs.readFile(entry.absPath, 'utf8');
  const parsed = parseTableFile(raw);
  if (isTableParseError(parsed)) throw badRequest(`table file is invalid: ${parsed.message}`);
  return parsed;
}

/**
 * Direct (non-collab) write of a table's full structural doc — server/
 * tables/service.ts's write path uses this when no collab room is open for
 * the page (mirrors writeDocBody's role for plain docs). Serializes via the
 * shared codec (canonical spacing, GFM-safe), then patches the pages_index
 * row directly rather than a full rescan, same performance reasoning as
 * patchEntryContent.
 *
 * `order` and `icon` are re-applied on top: they're PAGE-tree concerns, not part of
 * TableDoc, so serializeTableFile rebuilds the frontmatter without it — and
 * without this step every ordinary table edit would silently drop the page's
 * position in the sidebar or its icon.
 */
export async function writeTableDoc(id: string, doc: TableDoc): Promise<PageMeta> {
  const entry = await requireEntry(id);
  if (entry.kind !== 'table') throw badRequest('page is not a data table');
  const serialized = serializeTableFile(doc);
  await fs.writeFile(entry.absPath, withTablePageFields(serialized, entry.explicitOrder, entry.icon), 'utf8');

  const title = extractH1(doc.head) ?? titleFallback(entry.relPath, 'table');
  const updatedAt = new Date().toISOString();
  const plainText = tableDocToPlainText(doc);
  await query(
    `UPDATE pages_index SET
       title = $2, updated_at = $3, plain_text = $4,
       tsv = setweight(to_tsvector('simple', unaccent($2)), 'A') || setweight(to_tsvector('simple', unaccent(coalesce($4, ''))), 'B')
     WHERE id = $1`,
    [id, title, updatedAt, plainText],
  );
  entry.title = title;
  entry.updatedAt = updatedAt;
  entry.body = plainText;
  return toPageMeta(entry);
}

export async function renameDocDirect(id: string, title: string): Promise<PageMeta> {
  const entry = await requireEntry(id);
  if (entry.kind !== 'doc') throw badRequest('page is not a document');
  const current = entry.body ?? (await readFreshDocBody(id));
  const updated = replaceFirstH1(current, title);
  await persistDocFrontmatter(entry.absPath, { id: entry.id, order: entry.explicitOrder, status: entry.explicitStatus, icon: entry.icon, cover: entry.cover }, updated);
  // round 22: renaming the SPACE ROOT's title is, today, the only existing way a space's
  // effective display name changes post-creation — see noteSpaceNameChange's doc comment.
  if (entry.isIndex && entry.dirPath === '') {
    await noteSpaceNameChange(entry.space, extractH1(updated) ?? title);
  }
  return patchEntryContent(entry, updated);
}

/**
 * Renames a board — this round's fix for the link-breaking bug the old
 * `renameBoardFile` had: that version translit'd the new title into a slug
 * and `fs.rename`d the file to match, so changing a board's TITLE silently
 * changed its URL and broke every existing link to it. A board is now
 * doc-shaped instead: the title lives in the `folio-title` header comment
 * (splitBoardHeader/renderBoardHeader), and the file — its slug — is never
 * touched here. To change a board's actual filename/slug on purpose, use the
 * dedicated POST /api/pages/:id/slug (storage.renamePageSlug), which already
 * handles boards (keeps `.excalidraw.svg`, rewrites incoming links) exactly
 * like it does docs and tables.
 */
export async function setBoardTitle(id: string, title: string): Promise<PageMeta> {
  const entry = await requireEntry(id);
  if (entry.kind !== 'board') throw badRequest('page is not a board');
  const clean = title.trim();
  const raw = await fs.readFile(entry.absPath, 'utf8');
  const { icon } = splitBoardHeader(raw);
  await fs.writeFile(entry.absPath, withBoardHeader(raw, entry.id, entry.explicitOrder, clean, icon), 'utf8');
  const updatedAt = new Date().toISOString();
  await query('UPDATE pages_index SET title = $2, updated_at = $3 WHERE id = $1', [id, clean, updatedAt]);
  entry.title = clean;
  entry.updatedAt = updatedAt;
  return toPageMeta(entry);
}

/**
 * Round 26 (DATA TABLES), spec §12b.6: unlike a board, a table's "title" is
 * an H1 living INSIDE the file (in `head`), not the filename — so renaming a
 * table is semantically a doc-shaped operation (rewrite the H1) — the same
 * shape a board's title now has too (see setBoardTitle's doc comment), even
 * though a board's title rides a header comment rather than a real H1. This
 * function exists at the same layer and follows the same "direct,
 * non-collab write" shape as writeTableDoc above, for any caller that needs
 * a plain filesystem-level table rename (e.g. MCP, or a fallback path) —
 * but note it is NOT wired into POST /api/pages/:id/rename (server/routes.ts
 * is out of this round's zone). A LIVE table's H1 would need collab.ts's
 * structural equivalent of applyH1Rename (a patch against the `head`
 * fragment of the live Y.Doc, per spec §6/§12b.3) — that's COLLAB-TABLES'
 * territory, not implemented here; this function only ever touches the file
 * directly, same caveat writeTableDoc already carries.
 */
export async function renameTableFile(id: string, title: string): Promise<PageMeta> {
  const doc = await readFreshTableDoc(id);
  return writeTableDoc(id, { ...doc, head: replaceFirstH1(doc.head, title) });
}

// ---------------------------------------------------------------------------
// Round FORMS — a form has no live collab room (no Y.Doc wiring in
// collab.ts): its OWN definition is small enough that a direct-file
// read/write, single-editor-at-a-time, is the whole story (owner brief:
// "keep it plain and small"). Row SUBMISSION is the part that has to go
// through the live document (server/forms/service.ts -> server/tables/
// service.ts#insertRows) — see that module for why.
// ---------------------------------------------------------------------------

/** The form's whole file, unparsed — GET /api/pages/:id's (and the share route's) `markdown` field, same role tables.readTableMarkdown plays for a table. The web side parses it with shared/forms/codec.ts. */
export async function readFreshFormRaw(id: string): Promise<string> {
  const entry = await requireEntry(id);
  if (entry.kind !== 'form') throw badRequest('page is not a form');
  return fs.readFile(entry.absPath, 'utf8');
}

/** Reads and PARSES a form page's current file. Throws (not a FormParseError return) — same "every caller needs a real doc" reasoning as readFreshTableDoc. */
export async function readFreshFormDoc(id: string): Promise<FormDoc> {
  const entry = await requireEntry(id);
  if (entry.kind !== 'form') throw badRequest('page is not a form');
  const raw = await fs.readFile(entry.absPath, 'utf8');
  const parsed = parseFormFile(raw);
  if (isFormParseError(parsed)) throw badRequest(`form file is invalid: ${parsed.message}`);
  return parsed;
}

/**
 * Direct (always — there is no collab room for a form) write of a form's
 * full definition. `id`/`table` are always re-stamped from the CURRENT
 * entry/file rather than trusted from `doc` — a PUT from a stale client
 * tab must never be able to repoint a form at a different table or forge
 * its id.
 */
export async function writeFormDoc(id: string, doc: Omit<FormDoc, 'meta' | 'table'>): Promise<PageMeta> {
  const entry = await requireEntry(id);
  if (entry.kind !== 'form') throw badRequest('page is not a form');
  const current = await readFreshFormDoc(id);
  const next: FormDoc = { ...doc, meta: current.meta, table: current.table };
  const serialized = serializeFormFile(next);
  await fs.writeFile(entry.absPath, withTablePageFields(serialized, entry.explicitOrder, entry.icon), 'utf8');

  const title = next.title || titleFallback(entry.relPath, 'form');
  const updatedAt = new Date().toISOString();
  const plainText = formDocToPlainText(next);
  await query(
    `UPDATE pages_index SET
       title = $2, updated_at = $3, plain_text = $4,
       tsv = setweight(to_tsvector('simple', unaccent($2)), 'A') || setweight(to_tsvector('simple', unaccent(coalesce($4, ''))), 'B')
     WHERE id = $1`,
    [id, title, updatedAt, plainText],
  );
  entry.title = title;
  entry.updatedAt = updatedAt;
  entry.body = plainText;
  return toPageMeta(entry);
}

/**
 * The ONE writer of `table:` after pairing — every other form write path
 * (writeFormDoc above) deliberately treats it as immutable, re-reading it
 * off disk rather than accepting whatever a caller passes. This exists
 * solely for resolvePairedTableEntry's stale-path self-heal: once the pair
 * has been found by its actual tree position, this re-stamps the form file
 * with that fresh path so the NEXT resolution takes the fast, exact-path
 * lookup again instead of walking the tree every time. Best-effort by
 * design — a write failure here must never fail resolution, since the
 * caller already has the table it needs regardless of whether this
 * persists; callers should swallow rather than propagate. Title/plain_text
 * in pages_index are untouched: `table` isn't indexed there.
 */
export async function healFormTablePath(id: string, freshTableRelPath: string): Promise<void> {
  const entry = await requireEntry(id);
  if (entry.kind !== 'form') return;
  const current = await readFreshFormDoc(id);
  if (current.table === freshTableRelPath) return;
  const next: FormDoc = { ...current, table: freshTableRelPath };
  await fs.writeFile(entry.absPath, withTablePageFields(serializeFormFile(next), entry.explicitOrder, entry.icon), 'utf8');
}

/** setBoardTitle/renameTableFile's FORM twin — a form's title is a frontmatter field, not an H1, so renaming it is a plain frontmatter rewrite. */
export async function renameFormDirect(id: string, title: string): Promise<PageMeta> {
  const doc = await readFreshFormDoc(id);
  return writeFormDoc(id, { ...doc, title: title.trim() });
}

/**
 * "Create a form" on an existing table page (spec: "From an existing table
 * page: an action that writes a `X.form.md` with fields derived from its
 * columns"). The table itself is never modified here — pairing is
 * one-directional at creation time; the two files only stay associated
 * through the form's own `table` frontmatter field afterwards.
 *
 * Nesting (owner decision, post-merge fix): opposite direction from
 * createPage's 'form' branch — here the TABLE already exists, so the NEW
 * form becomes the table's own CHILD page, living in the `<tableSlug>/`
 * directory next to the table file (same "same-named sibling directory"
 * convention, see that branch's own comment for the general shape).
 */
export async function createFormFromTable(tableId: string): Promise<PageMeta> {
  const tableEntry = await requireEntry(tableId);
  if (tableEntry.kind !== 'table') throw badRequest('page is not a data table');
  const table = await readFreshTableDoc(tableId);

  const id = ulid();
  const tableStem = relPathStem(tableEntry.relPath, 'table');
  const formParentPath = tableEntry.dirPath ? `${tableEntry.dirPath}/${tableStem}` : tableStem;
  await fs.mkdir(path.join(spaceDir(tableEntry.space), formParentPath), { recursive: true });
  const relPath = await uniqueRelPath(tableEntry.space, formParentPath, translitSlug(tableEntry.title), '.form.md');
  const doc: FormDoc = {
    meta: { id, version: 1 },
    table: tableEntry.relPath,
    title: tableEntry.title,
    public: false,
    fields: deriveFieldsFromColumns(table.columns),
    body: '',
  };
  await fs.writeFile(path.join(spaceDir(tableEntry.space), relPath), serializeFormFile(doc), 'utf8');
  await scanSpace(tableEntry.space);
  const entry = await getEntry(id);
  if (!entry) throw new Error('internal: form created but not indexed');
  return toPageMeta(entry);
}

export async function movePage(id: string, toParentPathRaw: string): Promise<PageMeta> {
  const entry = await requireEntry(id);
  if (entry.isIndex && entry.dirPath === '') throw badRequest('cannot move the space root');

  return withSpaceLock(entry.space, async () => {
    const toParentPath = normalizeDirParam(toParentPathRaw);
    const space = entry.space;
    const srcAbs = entry.isIndex ? path.dirname(entry.absPath) : entry.absPath;
    const basename = path.basename(srcAbs);
    const destDirAbs = path.join(spaceDir(space), toParentPath);
    const destAbs = path.join(destDirAbs, basename);

    // Shape (2): a leaf page (`X.md`) plus a same-named sibling children
    // directory (`X/`, see getSubtree's own doc comment) — the directory must
    // move along with the file, or every child is orphaned. Same stem rule
    // renamePageSlug's own non-index branch uses (relPathStem), so the two
    // never drift apart.
    let childDirSrcAbs: string | undefined;
    let childDirDestAbs: string | undefined;
    if (!entry.isIndex) {
      const stem = relPathStem(entry.relPath, entry.kind);
      const candidate = path.join(path.dirname(entry.absPath), stem);
      if (await isDirectory(candidate)) {
        childDirSrcAbs = candidate;
        childDirDestAbs = path.join(destDirAbs, stem);
      }
    }

    // Self-nesting guard: an index page's own directory obviously can't move
    // into its own subtree. A leaf page WITH a children directory has the
    // same problem (moving `plan.md` under `notes/plan/...` would nest its
    // own children directory inside itself), so the guard now covers that
    // subtree too, not just the isIndex directory.
    const subtreeAbs = entry.isIndex ? srcAbs : childDirSrcAbs;
    if (subtreeAbs) {
      const srcWithSep = subtreeAbs + path.sep;
      if (destDirAbs === subtreeAbs || destDirAbs.startsWith(srcWithSep)) {
        throw badRequest('cannot move a page into its own subtree');
      }
    }
    if (srcAbs === destAbs) return toPageMeta(entry);
    if (await pathExists(destAbs)) throw conflict('a page already exists at the destination');
    if (childDirDestAbs && (await pathExists(childDirDestAbs))) throw conflict('a page already exists at the destination');

    await fs.mkdir(destDirAbs, { recursive: true });
    if (entry.kind === 'pdf' || entry.kind === 'office') claimBinaryId(destAbs, entry.id);
    await fs.rename(srcAbs, destAbs);
    if (childDirSrcAbs && childDirDestAbs) {
      try {
        await fs.rename(childDirSrcAbs, childDirDestAbs);
      } catch (err) {
        // Two renames are not atomic — restore the file before rethrowing so
        // a partial move never lands on disk.
        await fs.rename(destAbs, srcAbs);
        throw err;
      }
    }
    await scanSpace(space);
    return toPageMeta(await requireEntry(id));
  });
}

/** `notes/board.excalidraw.svg` -> 'board', `notes/weekly.table.md` -> 'table', `notes/report.pdf` -> 'pdf', `notes/plan.docx` -> 'office', `notes/plan.md` -> 'doc'; a non-page file (asset, dotfile) -> undefined. Same suffix-priority rule as the scanSpace walk (`.table.md` before plain `.md`). */
function pageFileKind(name: string): PageKind | undefined {
  const lower = name.toLowerCase();
  if (lower.endsWith('.table.md')) return 'table';
  if (lower.endsWith('.form.md')) return 'form';
  if (lower.endsWith('.excalidraw.svg')) return 'board';
  if (lower.endsWith('.pdf')) return 'pdf';
  if (officeFormat(lower)) return 'office';
  if (lower.endsWith('.md')) return 'doc';
  return undefined;
}

async function isDirectory(abs: string): Promise<boolean> {
  try {
    return (await fs.stat(abs)).isDirectory();
  } catch {
    return false;
  }
}

/** Same self-nesting guard movePage uses, generalized to copy: `destParentDirAbs` may not be `srcDirAbs` itself nor anywhere inside it. */
function guardNoSelfNesting(srcDirAbs: string, destParentDirAbs: string): void {
  const srcWithSep = srcDirAbs + path.sep;
  if (destParentDirAbs === srcDirAbs || destParentDirAbs.startsWith(srcWithSep)) {
    throw badRequest('cannot copy a page into its own subtree');
  }
}

/**
 * Rewrites one ALREADY-COPIED page file in place with a fresh id, reading
 * its current on-disk content (or `overrideContent`, for the one root file a
 * caller may be copying live/unsaved content for) to preserve every other
 * piece of presentation metadata. `keepOrder` is false only for the single
 * root page of a copy (which intentionally lands wherever `uniqueRelPath`'s
 * position falls, exactly like the pre-existing single-file copy always
 * has) and true for every other file swept along in a subtree copy, so
 * siblings keep their relative order.
 */
async function rewritePageFileId(abs: string, kind: PageKind, newId: string, opts: { keepOrder: boolean; overrideContent?: string }): Promise<void> {
  if (kind === 'doc') {
    const raw = opts.overrideContent ?? (await fs.readFile(abs, 'utf8'));
    const parsed = matter(raw);
    const order = opts.keepOrder ? numericOrder(parsed.data.order) : undefined;
    const status = validStatus(parsed.data.status);
    const icon = validStringField(parsed.data.icon);
    const cover = validStringField(parsed.data.cover);
    await persistDocFrontmatter(abs, { id: newId, order, status, icon, cover }, parsed.content);
  } else if (kind === 'table') {
    const raw = opts.overrideContent ?? (await fs.readFile(abs, 'utf8'));
    const parsedFm = matter(raw);
    const order = opts.keepOrder ? numericOrder(parsedFm.data.order) : undefined;
    const icon = validStringField(parsedFm.data.icon);
    const parsedTable = parseTableFile(raw);
    if (isTableParseError(parsedTable)) throw badRequest(`cannot copy an invalid data table: ${parsedTable.message}`);
    await fs.writeFile(
      abs,
      withTablePageFields(serializeTableFile({ ...parsedTable, meta: { ...parsedTable.meta, id: newId } }), order, icon),
      'utf8',
    );
  } else if (kind === 'form') {
    // Round FORMS: re-stamp the id only, same shape as 'table' above — the
    // `table:` reference is left exactly as it was in the source file. That
    // is CORRECT for a same-space copy that keeps both files' relative
    // layout (the common case: copying a directory containing both), and
    // KNOWINGLY stale for the rarer case where the copy separates the form
    // from its table (e.g. a cross-space copy) — see the round report.
    const raw = opts.overrideContent ?? (await fs.readFile(abs, 'utf8'));
    const parsedFm = matter(raw);
    const order = opts.keepOrder ? numericOrder(parsedFm.data.order) : undefined;
    const icon = validStringField(parsedFm.data.icon);
    const parsedForm = parseFormFile(raw);
    if (isFormParseError(parsedForm)) throw badRequest(`cannot copy an invalid form: ${parsedForm.message}`);
    await fs.writeFile(
      abs,
      withTablePageFields(serializeFormFile({ ...parsedForm, meta: { ...parsedForm.meta, id: newId } }), order, icon),
      'utf8',
    );
  } else if (kind === 'pdf' || kind === 'office') {
    // Never rewritten (see "Binary page files"): the copied bytes stay as
    // they are and the fresh id rides a claim the following scan picks up.
    claimBinaryId(abs, newId);
  } else {
    const raw = await fs.readFile(abs, 'utf8');
    if (opts.keepOrder) {
      await fs.writeFile(abs, withBoardId(raw, newId), 'utf8');
    } else {
      const { title, icon } = splitBoardHeader(raw);
      await fs.writeFile(abs, withBoardHeader(raw, newId, undefined, title, icon), 'utf8');
    }
  }
}

/**
 * What a copy leaves behind for the person asking for it. A copy gets fresh
 * page ids, and page access (`page_access`) is keyed by page id: whatever lands
 * in a copy is open to the whole destination space unless the copy is told
 * otherwise. So a copy must never contain a page its maker cannot open, and a
 * copy of a restricted page must itself stay restricted.
 *
 * The rule (docs/spec-access.md §13):
 *  - a page the caller cannot open (`hiddenPageIds`: a private page they
 *    neither own nor hold a grant on, and `.agent/**` unless they administer
 *    the space) is not copied, and neither is anything below it — its file,
 *    its children folder, its subfolder, however open those children are by
 *    themselves. The same "nothing below a hidden page" rule as a subtree
 *    share link (export/shareScope.ts). Page access is per page, so the tree
 *    still shows such a child; a copy is stricter on purpose, because it moves
 *    the content to a place the caller can edit and strips the restriction;
 *  - files that belong only to hidden pages (`privateFiles`: referenced by
 *    them and by no page the caller can open — the same ownership rule as the
 *    raw-file route, fileAccess.ts) stay behind; a file shared with an open
 *    page, or used by nothing, is copied;
 *  - the content root's `.agent` folder stays behind as a whole for a caller
 *    who cannot administer the space (`skipAgentFolder`) — non-page files too;
 *  - dot entries (`.git`, `.github`, any dotfile) are never page content and
 *    never travel in a subtree copy, for anybody. The one exception is an
 *    admin's `.agent` folder, which a copy of the space root carries as before;
 *  - the copy of a page that has a `page_access` row is restricted to `actorId`
 *    alone: owner = whoever made the copy, no grants. Never wider than the
 *    original, and always something the maker can open and re-share on
 *    purpose. The original owner's and grantees' rights are NOT copied: they
 *    may not be members of the destination space at all, and a grant cannot
 *    outlive a membership (pageAccess.setAccess refuses it).
 *
 * `copyPage`/`duplicatePage` without a scope apply none of the access rules
 * above (no page is left out and no copy is restricted) — for a caller that
 * reads every page by construction (tests, tooling); every route passes one
 * (see server/copyScope.ts).
 */
export interface CopyScope {
  /** Who makes the copy: the sole owner of the copy of every restricted page. */
  actorId: string;
  /** Pages of the SOURCE space the caller cannot open. */
  hiddenPageIds: ReadonlySet<string>;
  /** Space-relative paths of the source space's non-page files that only hidden pages use. */
  privateFiles: ReadonlySet<string>;
  /** Leave the source space's `.agent` folder out entirely. */
  skipAgentFolder: boolean;
}

/**
 * The `fs.cp` filter of one subtree copy: true = copy, false = leave this file
 * or folder (and everything inside a folder) behind. `srcDirAbs` itself always
 * passes — it is the page being copied.
 */
function copyFilter(sourceSpace: string, srcDirAbs: string, sourceEntries: PageIndexEntry[], scope?: CopyScope): (src: string) => boolean {
  const left = new Set<string>(scope?.privateFiles);
  if (scope?.skipAgentFolder) left.add(AGENT_FOLDER);
  if (scope) {
    for (const entry of sourceEntries) {
      if (!scope.hiddenPageIds.has(entry.id)) continue;
      left.add(entry.relPath);
      if (entry.isIndex) {
        // A directory-index page IS its folder: everything in the folder is below it. (The space root's own index page cannot be hidden from someone who is copying it.)
        if (entry.dirPath !== '') left.add(entry.dirPath);
      } else {
        const stem = relPathStem(entry.relPath, entry.kind);
        left.add(entry.dirPath ? `${entry.dirPath}/${stem}` : stem);
      }
    }
  }
  const spaceRootAbs = spaceDir(sourceSpace);
  return (src) => {
    if (path.resolve(src) === path.resolve(srcDirAbs)) return true;
    const rel = path.relative(spaceRootAbs, src).split(path.sep).join('/');
    if (path.basename(src).startsWith('.') && !(rel === AGENT_FOLDER && scope?.skipAgentFolder === false)) return false;
    return !left.has(rel);
  };
}

/**
 * Gives every copied page that has a `page_access` row its own row in the
 * copy, owned by `actorId` and with no grants (see CopyScope). Run after the
 * destination has been scanned: the row references the copy's index row.
 */
async function restrictCopies(sourceEntries: PageIndexEntry[], copied: Array<{ sourceAbs: string; copyId: string }>, actorId: string): Promise<void> {
  const idByAbs = new Map(sourceEntries.map((e) => [e.absPath, e.id]));
  const sourceIds: string[] = [];
  const copyIds: string[] = [];
  for (const { sourceAbs, copyId } of copied) {
    const sourceId = idByAbs.get(sourceAbs);
    if (!sourceId) continue;
    sourceIds.push(sourceId);
    copyIds.push(copyId);
  }
  if (sourceIds.length === 0) return;
  await query(
    `INSERT INTO page_access (page_id, owner_id)
     SELECT m.copy_id, $3::uuid
       FROM unnest($1::text[], $2::text[]) AS m(source_id, copy_id)
       JOIN page_access a ON a.page_id = m.source_id
       JOIN pages_index c ON c.id = m.copy_id
     ON CONFLICT (page_id) DO NOTHING`,
    [sourceIds, copyIds, actorId],
  );
}

interface CopiedSubtree {
  /** The fresh id of the file named by `rootFileAbsInSrc`, or '' when none was. */
  rootId: string;
  /** Every page file the sweep gave a fresh id: where it came from, and the id it got. */
  copied: Array<{ sourceAbs: string; copyId: string }>;
}

/** Copies a whole page subdirectory (minus what `keep` refuses), then sweeps every page file underneath it (recursively) to a fresh id — assets and other non-page files ride along untouched. Used both for a directory-index page's whole subtree and for a leaf page's `X/` children directory. */
async function copySubtreeAssigningFreshIds(
  srcDirAbs: string,
  destDirAbs: string,
  keep: (src: string) => boolean,
  rootFileAbsInSrc?: string,
  rootOverrideContent?: string,
): Promise<CopiedSubtree> {
  await fs.cp(srcDirAbs, destDirAbs, { recursive: true, filter: keep });
  const rootRel = rootFileAbsInSrc ? path.relative(srcDirAbs, rootFileAbsInSrc) : undefined;
  let rootId = '';
  const copied: CopiedSubtree['copied'] = [];

  async function walk(dirAbs: string): Promise<void> {
    const items = await fs.readdir(dirAbs, { withFileTypes: true });
    for (const item of items) {
      const abs = path.join(dirAbs, item.name);
      if (item.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!item.isFile()) continue;
      const kind = pageFileKind(item.name);
      if (!kind) continue;
      const isRootFile = rootRel !== undefined && path.relative(destDirAbs, abs) === rootRel;
      const newId = ulid();
      if (isRootFile) rootId = newId;
      copied.push({ sourceAbs: path.join(srcDirAbs, path.relative(destDirAbs, abs)), copyId: newId });
      await rewritePageFileId(abs, kind, newId, { keepOrder: !isRootFile, overrideContent: isRootFile ? rootOverrideContent : undefined });
    }
  }
  await walk(destDirAbs);
  return { rootId, copied };
}

/**
 * Copies one page into another directory (possibly in another space).
 * Content and presentation metadata are preserved, while identity is
 * intentionally fresh so the derived global index never sees two files
 * with the same page id.
 *
 * `includeChildren` (default true, spec 03.09.2026): a directory-index page
 * (`entry.isIndex`) brings its ENTIRE containing directory along, recreated
 * under a freshly-chosen unique directory name; a leaf page `X.md` brings
 * its sibling children directory `X/` along too, if one exists (the same
 * file-claims-a-same-named-directory shape getTree/getSubtree already read
 * via their local `childDirOf`/claimedDirs — reimplemented here as a plain
 * on-disk directory-existence check, since this only needs to know whether
 * `X/` exists, not render a tree). Every copied page file gets its own
 * fresh id; `false` reproduces the old single-file-only behavior exactly.
 *
 * `scope` (see CopyScope) says what the person asking may not take along —
 * pages page access hides from them, files only those pages use, the `.agent`
 * folder — and who owns the restricted copies; leave it out only for a caller
 * that reads everything.
 */
export async function copyPage(
  id: string,
  toSpace: string,
  toParentPathRaw: string,
  liveContent?: string,
  includeChildren = true,
  scope?: CopyScope,
): Promise<PageMeta> {
  const source = await requireEntry(id);
  // The routes have refused a page the caller cannot open before they get here; this keeps the rule true for any other caller.
  if (scope?.hiddenPageIds.has(source.id)) throw forbidden('this page is not available to you');
  if (!(await spaceExists(toSpace))) throw notFound('space');
  const sourceEntries = scope ? await listEntries(source.space) : [];

  return withSpaceLock(toSpace, async () => {
    const toParentPath = normalizeDirParam(toParentPathRaw);
    const destParentDirAbs = path.join(spaceDir(toSpace), toParentPath);
    await fs.mkdir(destParentDirAbs, { recursive: true });

    // Directory-index page + includeChildren: copy the WHOLE directory as a
    // freshly-named subtree, index.md included (with liveContent, if given).
    if (source.isIndex && includeChildren) {
      const srcDirAbs = path.dirname(source.absPath);
      guardNoSelfNesting(srcDirAbs, destParentDirAbs);

      const stem = translitSlug(copyStemFor(source));
      const uniqueDirRel = await uniqueRelPath(toSpace, toParentPath, stem, '');
      const destDirAbs = path.join(spaceDir(toSpace), uniqueDirRel);

      const { rootId: copiedId, copied } = await copySubtreeAssigningFreshIds(
        srcDirAbs,
        destDirAbs,
        copyFilter(source.space, srcDirAbs, sourceEntries, scope),
        source.absPath,
        liveContent,
      );
      await scanSpace(toSpace);
      if (scope) await restrictCopies(sourceEntries, copied, scope.actorId);
      return toPageMeta(await requireEntry(copiedId));
    }

    // Single-file copy (previous behavior, unchanged for includeChildren=false
    // and for any source that isn't a directory-index page).
    const copiedId = ulid();
    const copied: CopiedSubtree['copied'] = [{ sourceAbs: source.absPath, copyId: copiedId }];
    const stem = translitSlug(copyStemFor(source));
    const ext =
      source.kind === 'board'
        ? '.excalidraw.svg'
        : source.kind === 'table'
          ? '.table.md'
          : source.kind === 'form'
            ? '.form.md'
            : source.kind === 'pdf'
              ? '.pdf'
              : source.kind === 'office'
                ? `.${officeFormat(source.relPath)}`
                : '.md';
    const relPath = await uniqueRelPath(toSpace, toParentPath, stem, ext);
    const destAbs = path.join(spaceDir(toSpace), relPath);

    if (source.kind === 'doc') {
      const body = liveContent ?? (await readFreshDocBody(id));
      await persistDocFrontmatter(
        destAbs,
        { id: copiedId, status: source.explicitStatus, icon: source.icon, cover: source.cover },
        body,
      );
    } else if (source.kind === 'table') {
      const raw = liveContent ?? (await fs.readFile(source.absPath, 'utf8'));
      const parsed = parseTableFile(raw);
      if (isTableParseError(parsed)) throw badRequest(`cannot copy an invalid data table: ${parsed.message}`);
      await fs.writeFile(
        destAbs,
        withTablePageFields(serializeTableFile({ ...parsed, meta: { ...parsed.meta, id: copiedId } }), undefined, source.icon),
        'utf8',
      );
    } else if (source.kind === 'form') {
      // Same "id re-stamped, `table:` reference left as-is" trade-off as the
      // subtree sweep's own 'form' branch (rewritePageFileId) — see its comment.
      const raw = liveContent ?? (await fs.readFile(source.absPath, 'utf8'));
      const parsed = parseFormFile(raw);
      if (isFormParseError(parsed)) throw badRequest(`cannot copy an invalid form: ${parsed.message}`);
      await fs.writeFile(
        destAbs,
        withTablePageFields(serializeFormFile({ ...parsed, meta: { ...parsed.meta, id: copiedId } }), undefined, source.icon),
        'utf8',
      );
    } else if (source.kind === 'pdf' || source.kind === 'office') {
      // Bytes copied as they are (see "Binary page files"); the fresh id rides a claim the scan below picks up.
      claimBinaryId(destAbs, copiedId);
      await fs.copyFile(source.absPath, destAbs);
    } else {
      const raw = await fs.readFile(source.absPath, 'utf8');
      await fs.writeFile(destAbs, withBoardHeader(raw, copiedId, undefined, source.title, source.icon), 'utf8');
    }

    // Leaf page + includeChildren: bring the sibling `X/` children directory
    // along too, if the source has one — same fresh-id sweep, order kept.
    if (includeChildren && !source.isIndex) {
      const childStem = relPathStem(source.relPath, source.kind);
      const childSrcDirAbs = path.join(path.dirname(source.absPath), childStem);
      if (await isDirectory(childSrcDirAbs)) {
        guardNoSelfNesting(childSrcDirAbs, destParentDirAbs);
        const destStem = relPathStem(relPath, source.kind);
        const destChildDirAbs = path.join(path.dirname(destAbs), destStem);
        const swept = await copySubtreeAssigningFreshIds(childSrcDirAbs, destChildDirAbs, copyFilter(source.space, childSrcDirAbs, sourceEntries, scope));
        copied.push(...swept.copied);
      }
    }

    await scanSpace(toSpace);
    if (scope) await restrictCopies(sourceEntries, copied, scope.actorId);
    return toPageMeta(await requireEntry(copiedId));
  });
}

/**
 * "Duplicate" (the owner, 01.10.2026): the page copied NEXT TO ITSELF, its
 * whole subtree along with it — `copyPage` with nothing left to choose. The
 * parent is the directory the page is listed in: its own directory for a leaf
 * `X.md`, the one above for a directory-index page (whose own directory IS the
 * page).
 *
 * `title`, when given, becomes the title of the copy's root page — two rows
 * with the same name side by side would be indistinguishable, so the caller
 * (who knows the reader's language) names it "X (copy)". Children keep their
 * titles. A file page (pdf/office) has no title apart from its filename, and
 * `copyPage` has already given that a unique name.
 */
/** The directory a duplicate of `entry` lands in — the one `entry` itself is listed in. */
export function duplicateParentPath(entry: PageIndexEntry): string {
  // The root page's directory is the space itself: there is no "next to it".
  if (entry.isIndex && entry.dirPath === '') throw badRequest('the space root cannot be duplicated');
  return entry.isIndex ? posixParent(entry.dirPath) : entry.dirPath;
}

export async function duplicatePage(id: string, liveContent?: string, title?: string, scope?: CopyScope): Promise<PageMeta> {
  const source = await requireEntry(id);
  const copied = await copyPage(id, source.space, duplicateParentPath(source), liveContent, true, scope);
  const clean = title?.trim();
  if (!clean || clean === copied.title) return copied;
  if (copied.kind === 'doc') return renameDocDirect(copied.id, clean);
  if (copied.kind === 'table') return renameTableFile(copied.id, clean);
  // The form alone: its `table:` reference still names the ORIGINAL's table
  // (see copyPage), which must not be renamed after a copy of its form.
  if (copied.kind === 'form') return renameFormDirect(copied.id, clean);
  if (copied.kind === 'board') return setBoardTitle(copied.id, clean);
  return copied;
}

// ---------------------------------------------------------------------------
// Slug rename (round 22): POST /api/pages/:id/slug. Purely the mechanical
// half — validate, `fs.rename` the file (or, for a directory-index page,
// its whole containing directory — every nested page moves with it, same as
// movePage already does for an index page), and reindex. Deliberately knows
// nothing about backlinks/Yjs/git commits: those need collab.ts's live-doc
// awareness (collab.renamePageSlug composes this with links.ts and gitSync,
// avoiding a storage.ts -> collab.ts import cycle).
// ---------------------------------------------------------------------------

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const MAX_SLUG_LENGTH = 64;

export interface SlugRenameMove {
  id: string;
  oldRelPath: string;
  newRelPath: string;
  /**
   * Every page that linked to THIS id before the rename touched anything —
   * captured before fs.rename/scanSpace run, not after. Necessary, not just
   * cautious: scanSpace's re-read of some OTHER, unrelated page whose cached
   * (mtime, size) happens to already be stale (e.g. a body write that never
   * itself triggered a rescan) can land, in the SAME scan pass, after this
   * page's own row has already been updated to its NEW path — at which
   * point classify() can no longer resolve the OLD path and would silently
   * reclassify that link 'broken' before anyone gets a chance to read it as
   * a backlink. Reading backlinks up front, before either rename or scan,
   * sidesteps that ordering race entirely.
   */
  backlinks: PageMeta[];
}
export interface SlugRenameResult {
  meta: PageMeta;
  /**
   * Every (old relPath -> new relPath) pair this rename actually produced —
   * just the one page for a leaf rename, or the index page PLUS every page
   * nested under it for a directory rename (its whole subtree moves
   * together). Empty when the requested slug was already the current one
   * (a no-op). Ids never change; only paths do — callers use this to find
   * and fix up every INCOMING link across the space.
   */
  moved: SlugRenameMove[];
}

/** Validates a slug in isolation — exported so the route's own zod schema and this function's authoritative check share one definition. */
export function validateSlug(rawSlug: string): string {
  const slug = rawSlug.trim();
  if (!SLUG_PATTERN.test(slug) || slug.length > MAX_SLUG_LENGTH) {
    throw badRequest(`slug must match ${SLUG_PATTERN.source} and be at most ${MAX_SLUG_LENGTH} characters`);
  }
  return slug;
}

export async function renamePageSlug(id: string, rawSlug: string): Promise<SlugRenameResult> {
  const slug = validateSlug(rawSlug);
  const entry = await requireEntry(id);
  if (entry.isIndex && entry.dirPath === '') throw badRequest('cannot change the slug of the space root');

  return withSpaceLock(entry.space, async () => {
    const space = entry.space;
    let srcAbs: string;
    let destAbs: string;
    let oldRelPath: string;
    let newRelPath: string;
    // Set for a directory-index rename, OR for a leaf rename whose page has a
    // shape-(2) same-named children directory (X.md + X/) — either way it
    // drives the "every nested page also moved" sweep below. undefined only
    // for a leaf rename with no children directory, which affects just the
    // one file.
    let oldDirForDescendants: string | undefined;
    let newDirForDescendants: string | undefined;
    // Set only for a leaf rename with a shape-(2) children directory — that
    // directory must be renamed along with the file so it stays same-named.
    let childDirSrcAbs: string | undefined;
    let childDirDestAbs: string | undefined;

    if (entry.isIndex) {
      const oldDirAbs = path.dirname(entry.absPath);
      const parentAbs = path.dirname(oldDirAbs);
      destAbs = path.join(parentAbs, slug);
      srcAbs = oldDirAbs;
      const basename = path.basename(entry.absPath); // "index.md" or "README.md"
      const parentRel = posixParent(entry.dirPath);
      const newDirRel = parentRel ? `${parentRel}/${slug}` : slug;
      oldRelPath = entry.relPath;
      newRelPath = `${newDirRel}/${basename}`;
      oldDirForDescendants = entry.dirPath;
      newDirForDescendants = newDirRel;
    } else {
      const ext =
        entry.kind === 'board'
          ? '.excalidraw.svg'
          : entry.kind === 'table'
            ? '.table.md'
            : entry.kind === 'form'
              ? '.form.md'
              : entry.kind === 'pdf'
                ? '.pdf'
                : entry.kind === 'office'
                  ? `.${officeFormat(entry.relPath)}`
                  : '.md';
      srcAbs = entry.absPath;
      destAbs = path.join(path.dirname(entry.absPath), `${slug}${ext}`);
      oldRelPath = entry.relPath;
      newRelPath = entry.dirPath ? `${entry.dirPath}/${slug}${ext}` : `${slug}${ext}`;

      // Shape (2): X.md + X/ — same stem rule movePage's own non-index branch
      // uses (relPathStem), so a rename never drifts the two out of sync.
      const stem = relPathStem(entry.relPath, entry.kind);
      const oldChildDirAbs = path.join(path.dirname(entry.absPath), stem);
      if (await isDirectory(oldChildDirAbs)) {
        childDirSrcAbs = oldChildDirAbs;
        childDirDestAbs = path.join(path.dirname(entry.absPath), slug);
        oldDirForDescendants = entry.dirPath ? `${entry.dirPath}/${stem}` : stem;
        newDirForDescendants = entry.dirPath ? `${entry.dirPath}/${slug}` : slug;
      }
    }

    if (srcAbs === destAbs) return { meta: toPageMeta(entry), moved: [] }; // renaming to the same slug: no-op
    if (await pathExists(destAbs)) throw conflict('a page already exists with this slug at this location');
    if (childDirDestAbs && (await pathExists(childDirDestAbs))) throw conflict('a page already exists with this slug at this location');

    // Snapshot every page nested under the directory BEFORE renaming it, so we know
    // every id+oldRelPath that's about to move once fs.rename relocates the whole subtree.
    const descendantsBefore =
      oldDirForDescendants !== undefined
        ? (await listEntries(space)).filter((e) => e.id !== id && (e.dirPath === oldDirForDescendants || e.dirPath.startsWith(`${oldDirForDescendants}/`)))
        : [];

    // Backlinks captured BEFORE fs.rename/scanSpace — see SlugRenameMove.backlinks's doc
    // comment for why doing this after would be a race, not just extra caution.
    const backlinksById = new Map<string, PageMeta[]>();
    backlinksById.set(id, await links.getBacklinks(id));
    for (const desc of descendantsBefore) backlinksById.set(desc.id, await links.getBacklinks(desc.id));

    await fs.mkdir(path.dirname(destAbs), { recursive: true });
    await fs.rename(srcAbs, destAbs);
    if (childDirSrcAbs && childDirDestAbs) {
      try {
        await fs.rename(childDirSrcAbs, childDirDestAbs);
      } catch (err) {
        // Two renames are not atomic — restore the file before rethrowing so
        // a partial rename never lands on disk.
        await fs.rename(destAbs, srcAbs);
        throw err;
      }
    }
    await scanSpace(space);

    const moved: SlugRenameMove[] = [{ id, oldRelPath, newRelPath, backlinks: backlinksById.get(id) ?? [] }];
    if (oldDirForDescendants !== undefined && newDirForDescendants !== undefined) {
      for (const desc of descendantsBefore) {
        const suffix = desc.relPath.slice(oldDirForDescendants.length); // keeps the leading '/'
        moved.push({ id: desc.id, oldRelPath: desc.relPath, newRelPath: `${newDirForDescendants}${suffix}`, backlinks: backlinksById.get(desc.id) ?? [] });
      }
    }

    const fresh = await requireEntry(id);
    return { meta: toPageMeta(fresh), moved };
  });
}

// ---------------------------------------------------------------------------
// Deletion -> trash (trash round): deletePage has always MOVED the target
// into data/.trash rather than destroying it; since this round it also
// records what it moved in `trash_items` (db/migrations/018) so the trash
// UI (server/trash/*) can list and restore it.
// ---------------------------------------------------------------------------

/** One page's page-level access rule: a `page_access` row and its `page_access_grants`. */
export interface PageAccessRule {
  ownerId: string;
  grants: Array<{ userId: string; role: 'viewer' | 'editor' }>;
}

/**
 * What a trash item remembers about one restricted page it carried away. The
 * rule lives in `page_access`, which hangs off the page's index row
 * (ON DELETE CASCADE) — deleting a page drops the row and the rule with it, so
 * the trash keeps the rule and puts it back when the page comes back.
 */
export interface TrashAccessEntry extends PageAccessRule {
  pageId: string;
  /** Space-relative path at deletion time: the fallback match for a file that cannot carry its own id (pdf/office), see RestoredAccess. */
  relPath: string;
}

/** trash_items.payload of every kind but 'space'; absent `access` = nothing in the item was restricted, or the item is older than this record. */
export interface TrashPagePayload {
  v: 1;
  access?: TrashAccessEntry[];
}

/** trash_items.payload for kind='space' — everything the `DELETE FROM spaces` cascade destroys that files alone can't bring back. Read back by server/trash/service.ts's space restore. */
export interface TrashSpaceSnapshot extends TrashPagePayload {
  name: string;
  repoUrl: string | null;
  branch: string;
  rootPath: string;
  visibility: string;
  assetMode: string;
  members: Array<{ userId: string; role: string }>;
  /** New admin-space deletion moves the complete repo (incl. .git), not only rootPath. */
  fullRepo?: boolean;
}

/**
 * The rules to put back while a restored trash item is indexed (scanSpace's
 * third argument), already checked against who may hold them now. Matched by
 * page id first; `byPath` (the new space-relative path) is the fallback for a
 * pdf/office file, whose id is not stored in the file and may come out
 * different after the move (see "Binary page files"). Each rule is applied
 * to one page at most.
 */
export interface RestoredAccess {
  byId: ReadonlyMap<string, PageAccessRule>;
  byPath: ReadonlyMap<string, PageAccessRule>;
}

/** Writes `rule` for `pageId` on `client`, unless the page already has a rule of its own (then that one stays — a restore never rewrites a live rule). */
async function insertPageAccess(client: PoolClient, pageId: string, rule: PageAccessRule): Promise<void> {
  const inserted = await client.query('INSERT INTO page_access (page_id, owner_id) VALUES ($1, $2) ON CONFLICT (page_id) DO NOTHING', [pageId, rule.ownerId]);
  if (!inserted.rowCount) return;
  for (const grant of rule.grants) {
    await client.query('INSERT INTO page_access_grants (page_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (page_id, user_id) DO NOTHING', [
      pageId,
      grant.userId,
      grant.role,
    ]);
  }
}

/** The rules scanSpace did not get to give while it indexed (the file was skipped as unchanged: somebody else's scan had already indexed it). Matches the index by id, then by path; a page that is not there is skipped. */
async function reconcileRestoredAccess(space: string, restored: RestoredAccess, applied: ReadonlySet<PageAccessRule>): Promise<void> {
  const keys = new Map<PageAccessRule, { ids: string[]; paths: string[] }>();
  const keyOf = (rule: PageAccessRule) => keys.get(rule) ?? keys.set(rule, { ids: [], paths: [] }).get(rule)!;
  for (const [id, rule] of restored.byId) if (!applied.has(rule)) keyOf(rule).ids.push(id);
  for (const [relPath, rule] of restored.byPath) if (!applied.has(rule)) keyOf(rule).paths.push(relPath);
  const taken = new Set<string>();
  for (const [rule, { ids, paths }] of keys) {
    const rows = await query<{ id: string }>('SELECT id FROM pages_index WHERE space_slug = $1 AND (id = ANY($2::text[]) OR path = ANY($3::text[]))', [space, ids, paths]);
    const row = rows.find((r) => !taken.has(r.id));
    if (!row) continue;
    taken.add(row.id);
    await withTransaction((client) => insertPageAccess(client, row.id, rule));
  }
}

/**
 * The access rules of the restricted pages a deletion is about to take away:
 * the page itself, plus (`dirPrefix`, with its trailing slash) every page
 * below it, or (`all`) every page of the space. Read BEFORE the files move and
 * the rescan drops the index rows — afterwards the rules are gone.
 */
async function snapshotPageAccess(space: string, scope: { all: boolean; pageId?: string; dirPrefix?: string }): Promise<TrashAccessEntry[]> {
  const rows = await query<{ id: string; path: string; owner_id: string; grants: Array<{ userId: string; role: 'viewer' | 'editor' }> }>(
    `SELECT p.id, p.path, a.owner_id,
            COALESCE((SELECT json_agg(json_build_object('userId', g.user_id, 'role', g.role) ORDER BY g.user_id)
                        FROM page_access_grants g WHERE g.page_id = a.page_id), '[]'::json) AS grants
       FROM page_access a
       JOIN pages_index p ON p.id = a.page_id
      WHERE p.space_slug = $1
        AND ($2::boolean OR p.id = $3 OR ($4::text IS NOT NULL AND substr(p.path, 1, length($4)) = $4))
      ORDER BY p.path`,
    [space, scope.all, scope.pageId ?? null, scope.dirPrefix ?? null],
  );
  return rows.map((row) => ({ pageId: row.id, relPath: row.path, ownerId: row.owner_id, grants: row.grants }));
}

interface TrashRecord {
  spaceSlug: string;
  pageId: string;
  kind: 'doc' | 'board' | 'table' | 'pdf' | 'office' | 'form' | 'folder' | 'space';
  origPath: string;
  title: string;
  trashPath: string;
  childrenCount: number;
  payload: TrashSpaceSnapshot | TrashPagePayload | null;
}

/**
 * How many OTHER pages ride along when `target` is moved to trash —
 * pages_index rows under the subtree. `dirPath` is a directory: for an index
 * entry (or the whole space, dirPath=null/'') that directory's own row
 * (`dirPath/index.md`) is among the matched rows and must be excluded
 * (`selfIncluded` true, the default). For a shape-(2) page's sibling
 * children directory the leaf page itself (`X.md`) never matches the
 * `dirPath/`-prefix filter in the first place — nothing to exclude, so the
 * caller passes `selfIncluded: false`.
 */
async function countTrashChildren(space: string, dirPath: string | null, selfIncluded = true): Promise<number> {
  const rows = await query<{ path: string }>('SELECT path FROM pages_index WHERE space_slug = $1', [space]);
  const inSubtree = dirPath === null || dirPath === '' ? rows.length : rows.filter((r) => r.path.startsWith(`${dirPath}/`)).length;
  return selfIncluded ? Math.max(0, inSubtree - 1) : inSubtree;
}

async function buildSpaceSnapshot(space: string): Promise<TrashSpaceSnapshot | null> {
  const row = await queryOne<{ name: string; repo_url: string | null; branch: string; root_path: string; visibility: string; asset_mode: string }>(
    'SELECT name, repo_url, branch, root_path, visibility, asset_mode FROM spaces WHERE slug = $1',
    [space],
  );
  if (!row) return null;
  const members = await query<{ user_id: string; role: string }>('SELECT user_id, role FROM space_members WHERE space_slug = $1', [space]);
  // The `DELETE FROM spaces` below cascades to pages_index and, through it, to every page-access rule of the space.
  const access = await snapshotPageAccess(space, { all: true });
  return {
    v: 1,
    ...(access.length > 0 ? { access } : {}),
    name: row.name,
    repoUrl: row.repo_url,
    branch: row.branch,
    rootPath: row.root_path ?? '',
    visibility: row.visibility ?? 'private',
    assetMode: row.asset_mode ?? 'store',
    members: members.map((m) => ({ userId: m.user_id, role: m.role })),
  };
}

/** The trash payload of a deleted page (or folder): the access rules of the restricted pages it takes along; null when none of them was restricted. */
async function pagePayload(space: string, pageId: string, dirPrefix: string | undefined): Promise<TrashPagePayload | null> {
  const access = await snapshotPageAccess(space, { all: false, pageId, dirPrefix });
  return access.length > 0 ? { v: 1, access } : null;
}

/**
 * Moves the page (or, for an index page, its whole directory; for the space
 * root, the whole content root) into data/.trash and records a `trash_items`
 * row — under the SAME space lock, so nothing else can mutate the space
 * between the move and the record.
 *
 * `deletedBy` (trash round) is the session user's id for the "who deleted it"
 * column; null (the default) matches the backfill's "unknown" and keeps
 * every pre-existing caller/test compiling unchanged.
 *
 * Crash-ordering decision, deliberate: RENAME FIRST, INSERT SECOND. A crash
 * between the two leaves files safely in data/.trash with no DB row — the
 * exact state every pre-round deletion left behind, and the boot-time
 * backfill (server/trash/backfill.ts) records it on the next start, so the
 * gap self-heals. The opposite order (insert, then rename) would, on a
 * crash in between, leave a trash row pointing at files that never moved —
 * the trash UI would list a "deleted" page that is still alive, restore
 * would fail, and permanent-delete would delete a lie. A missing row heals;
 * a lying row misleads. For the same reason an INSERT failure is tolerated
 * (logged, deletion proceeds): the rename already happened, and failing the
 * request now would strand the operation half-done with LESS recorded than
 * the backfill can reconstruct anyway.
 */
export async function deletePage(id: string, deletedBy: string | null = null): Promise<void> {
  const entry = await requireEntry(id);
  const space = entry.space;

  await withSpaceLock(space, async () => {
    const srcAbs = entry.isIndex ? path.dirname(entry.absPath) : entry.absPath;
    const relFromSpace = path.relative(spaceDir(space), srcAbs).split(path.sep).join('/');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destAbs = relFromSpace === '' ? path.join(TRASH_DIR, stamp, space) : path.join(TRASH_DIR, stamp, space, relFromSpace);

    // Shape (2): a leaf page (`X.md`) plus a same-named sibling children
    // directory (`X/`, see getSubtree's own doc comment) — same stem rule
    // movePage/renamePageSlug use (relPathStem), so the directory follows
    // the file into the trash instead of being left orphaned in the space.
    let childDirSrcAbs: string | undefined;
    let childDirDestAbs: string | undefined;
    let childDirRelPath: string | undefined;
    if (!entry.isIndex) {
      const stem = relPathStem(entry.relPath, entry.kind);
      const candidate = path.join(path.dirname(entry.absPath), stem);
      if (await isDirectory(candidate)) {
        childDirSrcAbs = candidate;
        childDirDestAbs = path.join(path.dirname(destAbs), stem);
        childDirRelPath = entry.dirPath ? `${entry.dirPath}/${stem}` : stem;
      }
    }

    // Snapshot everything the deletion is about to destroy BEFORE touching
    // disk or DB — the space snapshot in particular reads the very rows the
    // cascade below removes.
    const isSpaceDelete = relFromSpace === '';
    const record: TrashRecord = {
      spaceSlug: space,
      // Contract (shared/contracts.ts TrashItemInfo): for kind='space' the
      // page_id is the slug — the restore recreates the space under it.
      pageId: isSpaceDelete ? space : entry.id,
      kind: isSpaceDelete ? 'space' : entry.isIndex ? 'folder' : entry.kind,
      origPath: isSpaceDelete ? '' : entry.isIndex ? posixParent(entry.relPath) : entry.relPath,
      title: entry.title,
      trashPath: relFromSpace === '' ? `${stamp}/${space}` : `${stamp}/${space}/${relFromSpace}`,
      childrenCount: isSpaceDelete
        ? await countTrashChildren(space, null)
        : entry.isIndex
          ? await countTrashChildren(space, posixParent(entry.relPath))
          : childDirRelPath
            ? await countTrashChildren(space, childDirRelPath, false)
            : 0,
      payload: isSpaceDelete
        ? await buildSpaceSnapshot(space)
        : await pagePayload(space, entry.id, entry.isIndex ? `${posixParent(entry.relPath)}/` : childDirRelPath ? `${childDirRelPath}/` : undefined),
    };

    await fs.mkdir(path.dirname(destAbs), { recursive: true });
    await fs.rename(srcAbs, destAbs);
    if (childDirSrcAbs && childDirDestAbs) {
      try {
        await fs.rename(childDirSrcAbs, childDirDestAbs);
      } catch (err) {
        // Two renames are not atomic — restore the file before rethrowing so
        // a partial delete never lands on disk (same rollback shape as
        // movePage/renamePageSlug in 33cb9c3).
        await fs.rename(destAbs, srcAbs);
        throw err;
      }
    }

    // rename -> insert (see the doc comment above for why this order); a
    // failed insert must not fail the deletion — the backfill records the
    // moved files on the next boot instead.
    await query(
      `INSERT INTO trash_items (space_slug, page_id, kind, orig_path, title, deleted_by, trash_path, children_count, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [record.spaceSlug, record.pageId, record.kind, record.origPath, record.title, deletedBy, record.trashPath, record.childrenCount, record.payload],
    ).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[trash] failed to record ${record.trashPath} in trash_items (files are in data/.trash; the boot backfill will pick them up):`, err);
    });

    if (isSpaceDelete) {
      // Whole space deleted (its root index.md was targeted): dropping the spaces row
      // cascades to space_members, pages_index, and links (all FK ON DELETE CASCADE).
      await query('DELETE FROM spaces WHERE slug = $1', [space]);
      rootPathCache.delete(space);
    } else {
      await scanSpace(space);
    }
  });
}

/**
 * Deletes a space by slug even when it has no root index page (a common
 * shape for imported repositories). The complete cloned repository moves
 * to trash, so no orphan `.git` directory can be auto-registered on boot.
 */
export async function deleteSpace(space: string, deletedBy: string | null = null): Promise<void> {
  await withSpaceLock(space, async () => {
    const snapshot = await buildSpaceSnapshot(space);
    if (!snapshot) throw notFound('space');
    snapshot.fullRepo = true;

    const pages = await query<{ count: string }>('SELECT COUNT(*)::text AS count FROM pages_index WHERE space_slug = $1', [space]);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const trashPath = `${stamp}/${space}`;
    const destAbs = path.join(TRASH_DIR, trashPath);
    const record: TrashRecord = {
      spaceSlug: space,
      pageId: space,
      kind: 'space',
      origPath: '',
      title: snapshot.name,
      trashPath,
      childrenCount: Number(pages[0]?.count ?? 0),
      payload: snapshot,
    };

    await fs.mkdir(path.dirname(destAbs), { recursive: true });
    await fs.rename(repoDir(space), destAbs);
    await query(
      `INSERT INTO trash_items (space_slug, page_id, kind, orig_path, title, deleted_by, trash_path, children_count, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [record.spaceSlug, record.pageId, record.kind, record.origPath, record.title, deletedBy, record.trashPath, record.childrenCount, record.payload],
    ).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[trash] failed to record ${record.trashPath} in trash_items (files are in data/.trash; the boot backfill will pick them up):`, err);
    });
    await query('DELETE FROM spaces WHERE slug = $1', [space]);
    rootPathCache.delete(space);
  });
}

export async function resolve(space: string, rawPath: string): Promise<PageMeta> {
  if (!(await spaceExists(space))) throw notFound('space');
  const normalized = normalizeResolvePath(rawPath);
  const direct = await queryOne<PagesIndexRow>('SELECT * FROM pages_index WHERE space_slug = $1 AND path = $2', [space, normalized]);
  if (direct) return toPageMeta(rowToEntry(direct));
  const indexPath = normalized ? `${normalized}/index.md` : 'index.md';
  const asIndex = await queryOne<PagesIndexRow>('SELECT * FROM pages_index WHERE space_slug = $1 AND path = $2', [space, indexPath]);
  if (asIndex) return toPageMeta(rowToEntry(asIndex));
  const readmePath = normalized ? `${normalized}/README.md` : 'README.md';
  const asReadme = await queryOne<PagesIndexRow>('SELECT * FROM pages_index WHERE space_slug = $1 AND path = $2', [space, readmePath]);
  if (asReadme) return toPageMeta(rowToEntry(asReadme));
  // Same-named page parent: `X.md` + `X/`. getTree/getSubtree represent the
  // directory as X.md's children, so resolving the ancestor directory `X`
  // must lead back to that real page rather than a synthetic folder route.
  // Only an unambiguous match is accepted; externally-created collisions
  // keep the directory fallback instead of choosing an arbitrary page kind.
  const pairedPaths = [`${normalized}.md`, `${normalized}.table.md`, `${normalized}.form.md`, `${normalized}.excalidraw.svg`];
  const pairedRows = await query<PagesIndexRow>(
    'SELECT * FROM pages_index WHERE space_slug = $1 AND path = ANY($2::text[])',
    [space, pairedPaths],
  );
  if (pairedRows.length === 1) return toPageMeta(rowToEntry(pairedRows[0]));
  // QA-3: the same README fallback, but for a caller who asked for the INDEX of a
  // directory by name ("index.md", "docs/index.md"). Without this the two branches
  // above only ever looked for `index.md/README.md`, so every space created from an
  // ordinary git repository — README in the root, no index.md — answered 404 to the
  // one path its own space home asks for, and the UI concluded the SPACE was gone.
  if (normalized === 'index.md' || normalized.endsWith('/index.md')) {
    const dir = normalized.slice(0, -'index.md'.length);
    const siblingReadme = `${dir}README.md`;
    const asSiblingReadme = await queryOne<PagesIndexRow>(
      'SELECT * FROM pages_index WHERE space_slug = $1 AND path = $2',
      [space, siblingReadme],
    );
    if (asSiblingReadme) return toPageMeta(rowToEntry(asSiblingReadme));
  }
  throw notFound('page');
}

export async function saveAssetIntoRepo(space: string, originalName: string, data: Buffer): Promise<{ url: string }> {
  if (!(await spaceExists(space))) throw notFound('space');
  const assetsDir = path.join(spaceDir(space), 'assets');
  await fs.mkdir(assetsDir, { recursive: true });

  const safeName = sanitizeAssetFilename(originalName);
  const ext = path.extname(safeName);
  const stem = safeName.slice(0, safeName.length - ext.length) || 'asset';
  let finalName = safeName || `asset${ext}`;
  let n = 2;
  while (await pathExists(path.join(assetsDir, finalName))) finalName = `${stem}-${n++}${ext}`;

  await fs.writeFile(path.join(assetsDir, finalName), data);
  return { url: `/files/${space}/assets/${finalName}` };
}

// ---------------------------------------------------------------------------
// Small accessors for gitSync.ts / routes.ts
// ---------------------------------------------------------------------------

export function getRepoDir(space: string): string {
  return repoDir(space);
}
export function getSpaceDir(space: string): string {
  return spaceDir(space);
}
export function getRootPath(space: string): string {
  return rootPathCache.get(space) ?? '';
}
export async function setSpaceRootPathCache(space: string, rootPath: string): Promise<void> {
  rootPathCache.set(space, rootPath);
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
