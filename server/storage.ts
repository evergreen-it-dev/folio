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
import type { CanvasDocument, CreatePageBody, FormDoc, PageKind, PageMeta, PageStatus, SpaceAssetMode, SpaceGitStatus, SpaceInfo, SpaceVisibility, TableColumn, TableDoc, TableView, TemplateListItem, TreeNode } from '../shared/contracts.js';
import { INDEX_META_VERSION, officeFormat, TEMPLATE_DESCRIPTION_KEY, WRITING_RULES_PATH } from '../shared/contracts.js';
import { compileScanIgnore } from './scanIgnore.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { translitSlug } from './translit.js';
import { query, queryOne, withTransaction } from './db/pool.js';
import { restrictionChainSql } from './access/roleSql.js';
import { withSpaceLock } from './db/redis.js';
import * as links from './links.js';
import * as pageIndex from './indexV2/store.js';
import * as git from './git.js';
import { setSpaceToken, removeSpaceToken, ensureAskpassScript } from './gitCredentials.js';
import { encodeCell, isTableParseError, parseTableFile, serializeTableFile } from '../shared/tables/index.js';
import { deriveFieldsFromColumns, isFormParseError, parseFormFile, serializeFormFile, systemColumns } from '../shared/forms/index.js';
import { decodeScenePayload, extractScenePayload } from './confluenceWhiteboard.js';
import { AGENT_FOLDER } from './agentPath.js';
import { serverText } from './serverText.js';
import { docIndexText, docIndexTextAsync } from './indexText.js';
import { CANVAS_MAX_BYTES, canvasSearchText, parseJsonCanvas } from '../shared/canvas/index.js';
import { inlineMarkdownToPlainText } from '../shared/inlineText.js';
import { docExtOf, isMdxPath, isStrongIndexName, stripDocExt } from '../shared/mdx.js';
import { computeVerification, hasVerificationProps, pickVerificationProps, type VerificationProps } from '../shared/verification.js';
import { carryFrontmatterKeys, mergeFrontmatter, writeFrontmatterKeys, type FolioFrontmatter, type FrontmatterKeyEdit } from './frontmatter.js';
import * as propsSidecar from './propsSidecar.js';
import { ownProperties, reservedKeysOf } from './reservedPropertyKeys.js';
import * as spaceFiles from './spaceFiles.js';
import { ARTIFACT_DIR_SUFFIX, artifactStem, isArtifactDirName, parseArtifactManifest } from './artifact/manifest.js';
import * as artifactBundle from './artifact/bundle.js';
import { starterTemplates, type StarterLanguage } from './starterTemplates.js';
import { substituteTemplate, todayDateStamp } from './templateVars.js';

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
  kind: 'doc' | 'board' | 'table' | 'pdf' | 'office' | 'form' | 'canvas' | 'base' | 'artifact';
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
  /**
   * A document's whole front matter as parsed — set only by indexDocFile during
   * a scan, for the page index (indexV2, `pages_index.frontmatter`). Never read
   * back from the database into an entry.
   */
  frontmatter?: Record<string, unknown>;
  /** A canvas page's parsed document — set only by indexCanvasFile during a scan, for the page index (its links and tags). */
  canvasDoc?: CanvasDocument;
  /** Owner / verified / review_by as the index row holds them - set by rowToEntry only, for toPageMeta's verification state. */
  verificationProps?: VerificationProps;
}

// ---------------------------------------------------------------------------
// Space content-root resolution: repo dir + rootPath. rootPath rarely changes
// (set at space creation), so a cache refreshed at scan/creation time avoids
// making the extremely-hot spaceDir() async everywhere it's used.
// ---------------------------------------------------------------------------

const rootPathCache = new Map<string, string>();
/** Slugs whose `spaces.light_footprint` is set (migration 041): a space whose content root is the repository root that is still "light" — an Obsidian vault. Kept beside rootPathCache, same lifecycle. */
const lightFootprintCache = new Set<string>();

function rememberSpaceCaches(space: string, rootPath: string, lightFootprint: boolean): void {
  rootPathCache.set(space, rootPath);
  if (lightFootprint) lightFootprintCache.add(space);
  else lightFootprintCache.delete(space);
}

function forgetSpaceCaches(space: string): void {
  rootPathCache.delete(space);
  lightFootprintCache.delete(space);
}

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

/**
 * "Light footprint" (docs-as-code, Obsidian vaults): a space bound to a
 * sub-folder of a repository (non-empty rootPath) is typically the `docs/` of a
 * product repo, and a space whose repository root IS a vault belongs to the
 * vault's owner, so Folio keeps out of the way there: it never ADDS an `id` to a
 * doc's front matter (the id lives in pages_index only, see "Index-only page
 * ids"; an id a file already carries is still used and kept), and its `.folio`
 * metadata is a dotfile inside the content root (folioMetaPath). A rootPath
 * space is light by construction; a rootPath '' space only when
 * `spaces.light_footprint` was set (an admin's choice, or by default on
 * creation from a repository whose files Folio did not create: a vault, a
 * notes repo, a wiki — createSpaceFromRepo). Native spaces are unchanged.
 */
export function isLightFootprintSpace(space: string): boolean {
  return (rootPathCache.get(space) ?? '') !== '' || lightFootprintCache.has(space);
}

/** The shape of an index-only doc id (pathIdFor('doc', ...)): never written into a file. */
const INDEX_ONLY_DOC_ID_RE = /^doc-[0-9a-f]{24}$/;

/**
 * The `id` handed to persistDocFrontmatter for a doc of `space`: undefined (the
 * file's own key, if any, is left alone) in a light-footprint space, and for a
 * page whose id lives in pages_index only — a file whose `id:` another page
 * already holds (fileIdIsOwn) keeps that foreign value instead of having it
 * overwritten.
 */
function docFileId(space: string, id: string): string | undefined {
  return isLightFootprintSpace(space) || INDEX_ONLY_DOC_ID_RE.test(id) ? undefined : id;
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
/** normalizeDirParam for the folder a page is written INTO: never inside an artifact bundle (nothing in one is a page). */
export function normalizePageParentDir(p: string): string {
  const dir = normalizeDirParam(p);
  if (artifactBundleOfRel(dir)) throw badRequest('a page cannot be placed inside an artifact');
  return dir;
}

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

export function humanize(slug: string): string {
  return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function isUnderTemplates(relPath: string): boolean {
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

// `\r?`: a CRLF file's lines keep their "\r" here (bodies are split on "\n"),
// and `# Title\r` read as no heading at all — the page was titled by its file
// name until an open normalized the text, and the "new" H1 then auto-renamed the file.
const H1_RE = /^#[ \t]+(.+?)[ \t]*#*[ \t]*\r?$/;
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

/**
 * The page title: the first H1, as plain text. The heading's markdown is
 * resolved (`# ==Q4=={.green} **goals**` is "Q4 goals", `:status[x]` is "x",
 * `[a](u)` is "a"; shared/inlineText.ts), so the tree, tabs, search and the
 * space name show words instead of syntax — the file itself keeps the markup
 * and `replaceFirstH1` still writes whatever title it is given. A title with
 * no markup character is returned untouched.
 */
export function extractH1(body: string): string | null {
  const lines = body.split('\n');
  const idx = findH1LineIndex(lines);
  return idx === -1 ? null : inlineMarkdownToPlainText(H1_RE.exec(lines[idx])![1].trim());
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
  // A canvas keeps its stem, like Obsidian's file list (the tree icon tells it apart from a note of the same name).
  if (kind === 'canvas') return base.slice(0, -'.canvas'.length);
  // An Obsidian base keeps its stem, as Obsidian names it.
  if (kind === 'base') return base.slice(0, -'.base'.length);
  // An artifact bundle `q3.artifact/` without a manifest title: its folder name without the suffix.
  if (kind === 'artifact') return artifactStem(base);
  return stripDocExt(base);
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


/**
 * A doc body in the form two bodies are compared in: a trailing newline
 * guaranteed. A collab room's Y.Text has no such guarantee (a user who typed at
 * the end of the page leaves it without one), and neither has a file — Folio
 * keeps a file's missing final newline (mergeFrontmatter) — so bindState
 * compares docFileBody(FILE) with docFileBody(Y.Text) when it decides whether
 * the file "moved on" while the room was away. Without it a page whose text
 * merely lacks the final "\n" looked changed on every resume and got its whole
 * body replaced (delete + reinsert), which a client holding edits on top of the
 * old text merges as a doubling.
 */
export function docFileBody(body: string): string {
  return body.endsWith('\n') ? body : `${body}\n`;
}

/** Same file text, as far as a reader can tell: line endings and the final newline aside. */
function sameDocText(a: string, b: string): boolean {
  const lf = (s: string) => (s.includes('\r') ? s.replace(/\r\n?/g, '\n') : s);
  return docFileBody(lf(a)) === docFileBody(lf(b));
}

/**
 * Writes body + Folio's front matter keys (id, order, status, icon, cover) to
 * `abs`, MERGED into the front matter the file already has: every key another
 * tool wrote (Docusaurus, MkDocs, Hugo, Jekyll...) stays as it was — see
 * server/frontmatter.ts. `base` overrides what to merge into (a copy merges
 * into its SOURCE file's block); by default it is the file at `abs` itself.
 */
async function persistDocFrontmatter(abs: string, data: FolioFrontmatter, body: string, base?: { raw: string | undefined }): Promise<void> {
  const baseRaw = base ? base.raw : await fs.readFile(abs, 'utf8').catch(() => undefined);
  await writeFileAtomic(abs, mergeFrontmatter(baseRaw, data, body));
}

/** The name writeFileAtomic gives its temp files: `.<file>.<pid>.<random>.tmp`. */
const ATOMIC_TEMP_RE = /^\..+\.\d+\.[0-9a-z]+\.tmp$/;
export function isAtomicTempName(name: string): boolean {
  return ATOMIC_TEMP_RE.test(name);
}

/** A temp file older than this cannot belong to a write still in progress. */
const ORPHAN_TEMP_AGE_MS = 60_000;

/** Removes an orphaned writeFileAtomic temp file — never one young enough to be a write in progress. Never throws. */
export async function removeOrphanTempFile(abs: string): Promise<void> {
  try {
    const stat = await fs.stat(abs);
    if (Date.now() - stat.mtimeMs < ORPHAN_TEMP_AGE_MS) return;
    await fs.rm(abs, { force: true });
  } catch {
    /* gone already, or unreadable — the next scan tries again */
  }
}

/**
 * Writes `content` to `abs` so that the file is either the old one or the new
 * one, never half of the new one: a full disk (ENOSPC) or a crash mid-write
 * used to leave the page's only on-disk copy truncated. The temp file sits in
 * the same directory (rename is atomic only within a filesystem), is dot-named
 * and not `.md`, so no scan indexes it, and is removed if anything fails.
 */
export async function writeFileAtomic(abs: string, content: string | Buffer): Promise<void> {
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`);
  // git.ts excludes this shape from every `git add -A` (ATOMIC_TEMP_PATHSPEC).
  try {
    // The replaced file keeps its mode: a doc committed as 100755 used to come
    // back 100644 from any write, a diff in git for nothing anyone did.
    const mode = await fs.stat(abs).then(
      (s) => s.mode & 0o7777,
      () => undefined,
    );
    if (typeof content === 'string') await fs.writeFile(tmp, content, 'utf8');
    else await fs.writeFile(tmp, content); // bytes of a pdf/office file: no encoding
    if (mode !== undefined) await fs.chmod(tmp, mode);
    await fs.rename(tmp, abs);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
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
export function withTablePageFields(raw: string, order: number | undefined, icon: string | undefined, carryFrom?: string): string {
  // Only these two keys are edited (writeFrontmatterKeys): every other key — the schema, and since 15.10.2026 the
  // page's own properties — keeps its bytes (a re-serialization used to turn `due: 2024-05-01` into a timestamp).
  const out = writeFrontmatterKeys(
    raw,
    new Map<string, FrontmatterKeyEdit>([
      ['order', order === undefined ? { remove: true } : { set: order }],
      ['icon', icon === undefined ? { remove: true } : { set: icon }],
    ]),
  );
  if (carryFrom === undefined) return out;
  // The page's own properties sit next to the reserved keys the codec rebuilt from: carried over from the file as
  // it was, byte for byte (reservedPropertyKeys.ts).
  let marker: unknown;
  try {
    marker = matter(out, {}).data.folio;
  } catch {
    marker = undefined;
  }
  const kind = marker === 'form' ? 'form' : 'table';
  const reserved = reservedKeysOf(kind)!;
  return carryFrontmatterKeys(out, carryFrom, (key) => !reserved.has(key));
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
  kind: 'doc' | 'board' | 'table' | 'pdf' | 'office' | 'form' | 'canvas' | 'base' | 'artifact';
  title: string;
  sort_order: number | null;
  status: PageStatus | null;
  icon: string | null;
  cover: string | null;
  updated_at: string;
  plain_text: string | null;
  is_index: boolean;
  frontmatter?: unknown;
}

function rowToEntry(row: PagesIndexRow): PageIndexEntry {
  const relPath = row.path;
  const verificationProps = pickVerificationProps(row.frontmatter);
  return {
    ...(hasVerificationProps(verificationProps) ? { verificationProps } : {}),
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
  // A document's `:status[Done]{color=green}` tags are indexed (and shown in
  // snippets) as their text: the attributes are not words anyone searches for;
  // a `%%comment%%` is not content at all (indexText.ts).
  // A canvas: its group labels, text cards, link URLs and edge labels (indexCanvasFile).
  const plainText =
    entry.kind === 'doc'
      ? await docIndexTextAsync(entry.body ?? '')
      : entry.kind === 'table' || entry.kind === 'form' || entry.kind === 'canvas' || entry.kind === 'artifact'
        ? (entry.body ?? '')
        : null;
  // The row of an id never silently moves to ANOTHER space ($16 false): two
  // connected folders whose files carry the same `id:` used to hand the row back
  // and forth on every scan, and a write through it landed in the other space's
  // file. Moving across spaces is allowed only once the holder's file is gone
  // (adoptAcrossSpaces below) — a file carried from one space to the other.
  const sql = `INSERT INTO pages_index (id, space_slug, path, kind, title, sort_order, status, icon, cover, updated_at, plain_text, is_index, file_mtime, file_size, tsv)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
       setweight(to_tsvector('simple', unaccent($5)), 'A') ||
       setweight(to_tsvector('simple', unaccent(coalesce($15, ''))), 'B'))
     ON CONFLICT (id) DO UPDATE SET
       space_slug = EXCLUDED.space_slug, path = EXCLUDED.path, kind = EXCLUDED.kind,
       title = EXCLUDED.title, sort_order = EXCLUDED.sort_order, status = EXCLUDED.status,
       icon = EXCLUDED.icon, cover = EXCLUDED.cover,
       updated_at = EXCLUDED.updated_at, plain_text = EXCLUDED.plain_text, is_index = EXCLUDED.is_index,
       file_mtime = EXCLUDED.file_mtime, file_size = EXCLUDED.file_size, tsv = EXCLUDED.tsv
     WHERE pages_index.space_slug = EXCLUDED.space_slug OR $16::boolean
     RETURNING id`;
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
    false,
  ];
  const upsert = async (exec: (values: unknown[]) => Promise<unknown[]>): Promise<void> => {
    if ((await exec(params)).length > 0) return;
    // Nothing written: the id belongs to a page of another space.
    if (!(await adoptAcrossSpaces(entry.id))) {
      throw new Error(`page id ${entry.id} is already used by a page of another space`);
    }
    params[15] = true;
    await exec(params);
  };
  if (!restoredRule) {
    await upsert((values) => query(sql, values));
    return;
  }
  // A page coming back from the trash gets its access rule in the SAME
  // transaction as its index row: the row is not visible to anybody before the
  // rule is, so there is no moment at which a restored private page is open.
  await withTransaction(async (client) => {
    await upsert(async (values) => (await client.query(sql, values)).rows);
    await insertPageAccess(client, entry.id, restoredRule);
  });
}

/** True when the page holding `id` (in whatever space) has no file on disk any more — its id may follow the file that carries it now. */
async function adoptAcrossSpaces(id: string): Promise<boolean> {
  const holder = await queryOne<{ space_slug: string; path: string }>('SELECT space_slug, path FROM pages_index WHERE id = $1', [id]);
  return !holder || !(await pathExists(path.join(spaceDir(holder.space_slug), holder.path)));
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
  for (const filename of ['index.md', 'index.mdx', 'README.md', 'README.mdx']) {
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
    // A folder dropped in with an `.obsidian/` inside is a vault: register it light, so the first scan writes nothing into it.
    const vault = await isObsidianVault(dir);
    await query(
      `INSERT INTO spaces (slug, name, repo_url, branch, root_path, status, light_footprint) VALUES ($1, $2, NULL, 'main', '', 'local', $3) ON CONFLICT (slug) DO NOTHING`,
      [slug, name, vault],
    );
    // eslint-disable-next-line no-console
    console.log(`[boot] registered pre-existing repo as space "${slug}"${vault ? ' (Obsidian vault: light footprint)' : ''}`);
  }
}

async function refreshRootPathCache(): Promise<void> {
  const rows = await query<{ slug: string; root_path: string; light_footprint: boolean }>('SELECT slug, root_path, light_footprint FROM spaces');
  rootPathCache.clear();
  lightFootprintCache.clear();
  for (const row of rows) rememberSpaceCaches(row.slug, row.root_path ?? '', row.light_footprint === true);
}

/** A native Folio space's metadata file (`<slug>.folio`, not the light dotfile `.<slug>.folio`) sits at `dirAbs`: the repository was a Folio space before. */
async function holdsNativeFolioMeta(dirAbs: string): Promise<boolean> {
  try {
    return (await fs.readdir(dirAbs, { withFileTypes: true })).some((e) => e.isFile() && !e.name.startsWith('.') && e.name.endsWith('.folio'));
  } catch {
    return false;
  }
}

/** An Obsidian vault keeps its settings in `.obsidian/` at its root. */
async function isObsidianVault(dirAbs: string): Promise<boolean> {
  try {
    return (await fs.stat(path.join(dirAbs, '.obsidian'))).isDirectory();
  } catch {
    return false;
  }
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

/**
 * Whether a doc file's own front matter `id` can be its page id. Another tool's
 * `id:` (Docusaurus/Jest `id: intro`) is unique neither across folders nor
 * across spaces: two connected docs folders carrying `id: intro` fought over one
 * pages_index row, each scan moving it (and every later write through it) to the
 * space scanned last — an edit in one space landed in the other space's file.
 * The file's id is NOT used when
 *  - another page whose file still exists already holds it (a copy, the same id
 *    in another folder or another space). A rename or move — Folio's or a `git
 *    mv` — leaves the old row pointing at a file that is gone, so the id follows
 *    the file exactly as before;
 *  - this path already has a row under a different id (given by an earlier
 *    collision): adopting the file's id now would collide with that row on
 *    (space_slug, path) and the file could never be indexed again.
 * Such a doc gets an index-only id (resolveIndexOnlyId), and its file is left
 * as it is (docFileId).
 */
async function fileIdIsOwn(fileId: string, space: string, relPath: string): Promise<boolean> {
  const atPath = await getEntryIdByExactPath(space, relPath);
  if (atPath) return atPath === fileId;
  return adoptAcrossSpaces(fileId);
}

async function indexDocFile(space: string, relPath: string, abs: string, mtime: Date, isIndex: boolean, size: number): Promise<PageIndexEntry | null> {
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
      // A Folio move claimed the id it had (claimIdsForMove): keep it rather than re-deriving from the new path.
      id: takeIdClaim(abs) ?? unparseableDocId(space, relPath),
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
      frontmatter: {},
    };
  }
  const fileId = typeof parsed.data.id === 'string' && parsed.data.id ? (parsed.data.id as string) : null;
  let id: string;
  const body = parsed.content;
  const explicitOrder = numericOrder(parsed.data.order);
  const explicitStatus = validStatus(parsed.data.status);
  const icon = validStringField(parsed.data.icon);
  const cover = validStringField(parsed.data.cover);
  if (fileId && (await fileIdIsOwn(fileId, space, relPath))) {
    // The file's own id wins; a claim for this path (if any) is spent anyway.
    takeIdClaim(abs);
    id = fileId;
  } else if (fileId || isLightFootprintSpace(space)) {
    // Light footprint: the id lives in pages_index only, never in the file.
    // So does the id of a file whose `id:` another page holds (fileIdIsOwn).
    id = await resolveIndexOnlyId('doc', space, relPath, abs, size);
  } else {
    // No id in the file: the Folio operation that put it here (a claim), else the page already indexed at this path
    // (its id was stripped from the file), else an id derived from space + path - never a random one, so a rebuilt
    // index or a second instance on the same files gives this page the same id (see "Stable page ids").
    id = takeIdClaim(abs) ?? (await getEntryIdByExactPath(space, relPath)) ?? (await freeStableId(space, relPath));
    await persistDocFrontmatter(abs, { id, order: explicitOrder, status: explicitStatus, icon, cover }, body, { raw });
  }
  return {
    id,
    space,
    relPath,
    absPath: abs,
    kind: 'doc',
    isIndex,
    dirPath: posixParent(relPath),
    title: extractH1(body) ?? validStringField(parsed.data.title) ?? titleFallback(relPath, 'doc'),
    order: explicitOrder ?? ORDER_SENTINEL,
    explicitOrder,
    status: explicitStatus ?? 'published',
    explicitStatus,
    icon,
    cover,
    updatedAt: mtime.toISOString(),
    body,
    frontmatter: parsed.data as Record<string, unknown>,
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
    id = (await getEntryIdByExactPath(space, relPath)) ?? (await freeStableId(space, relPath));
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
// Index-only page ids: binary page files (PDF, round PDF; DOCX/XLSX/PPTX,
// round OFFICE) and docs of a light-footprint space (isLightFootprintSpace)
//
// A pdf/office page is the owner's own binary file from their repository, so
// Folio NEVER writes into it. (A first version stamped a /FolioID into every
// PDF's catalog via a full re-serialize: the first scan would have rewritten
// every PDF in every repo, committed and pushed them, and broken signed
// documents.) A doc in a light-footprint space is someone's product
// documentation: stamping an `id` into every file would be a mass diff. For
// both, the id lives only in pages_index, resolved in this order:
//  1. a claim registered by the Folio operation that just put the file at
//     this path — create, move, copy, slug rename, trash restore (claimPageId);
//  2. the existing index row at the same path (the ordinary rescan);
//  3. an index row of the SAME kind and size whose file is gone from disk —
//     a rename/move Folio did not perform itself (`git mv` in a pull);
//  4. otherwise a deterministic id from space + path, so a rebuilt index
//     gets the same id back for a file that never moved.
// (A doc that already carries an `id` in its front matter keeps using it.)
const pageIdClaims = new Map<string, string>();
/** Per scan: orphaned rows already handed to a renamed file, so two same-size files of the same kind can't take one id. Reset at the start of scanSpace. */
const indexOnlyOrphanClaims = new Map<string, Set<string>>();

/** Pins the id the next scan gives the page file at `abs` when the file does not carry one itself — see "Index-only page ids" above. */
export function claimPageId(abs: string, id: string): void {
  pageIdClaims.set(path.resolve(abs), id);
}
/** The pdf/office name of claimPageId, kept for existing callers. */
export const claimBinaryId = claimPageId;

function takeIdClaim(abs: string): string | undefined {
  const key = path.resolve(abs);
  const claimed = pageIdClaims.get(key);
  if (claimed) pageIdClaims.delete(key);
  return claimed;
}

type IndexOnlyKind = 'doc' | 'pdf' | 'office' | 'canvas' | 'base' | 'artifact';

function pathIdFor(kind: IndexOnlyKind, space: string, relPath: string, attempt: number): string {
  const seed = attempt === 0 ? `${space}\0${relPath}` : `${space}\0${relPath}\0${attempt}`;
  return `${kind}-${createHash('sha1').update(seed).digest('hex').slice(0, 24)}`;
}

/** Step 4: the path's deterministic id — unless another page already holds it (a page created here and moved away since), then the next one in the same sequence. */
async function freePathId(kind: IndexOnlyKind, space: string, relPath: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const id = pathIdFor(kind, space, relPath, attempt);
    const holder = await queryOne<{ space_slug: string; path: string }>('SELECT space_slug, path FROM pages_index WHERE id = $1', [id]);
    if (!holder || (holder.space_slug === space && holder.path === relPath)) return id;
  }
}

// ---------------------------------------------------------------------------
// Stable page ids: the same page, the same id, after the instance is rebuilt
//
// A page's id is the whole of its URL (/s/<space>/p/<id>, /public/<slug>/p/<id>),
// so an id that changes kills every link ever sent. Where the id lives:
//  - docs: front matter `id` (native spaces), the board's header comment, a
//    table's / form's own front matter — written with the content, so a database
//    rebuilt from the repository (drop pages_index, rescan; a fresh instance
//    connected to the same repository) gives every page the same id back;
//  - light-footprint docs, PDFs, Office files, bases, artifacts: no id in the
//    file, so the id is derived from space + path (pathIdFor above);
//  - a file that arrives WITHOUT an id (hand-made, a copy from elsewhere, a
//    repository that was never opened in Folio): its id used to be a random ULID,
//    which exists only in this instance's copy until the next sync — a rebuild
//    before that, or a second instance on the same files, invented another one.
//    Now it is derived from space + path (stableUlid), after the index row at that
//    path (if any) has had its say.
//  - a page created through the API on an instance that is rebuilt from a script
//    (the public demo's daily reset): FOLIO_STABLE_IDS=1 makes the id of a NEW page
//    the same derived value, so the reset instance hands out the ids of the
//    previous one. Off by default: on an ordinary instance deleting a page and
//    creating another at its path must not resurrect the old id.
// ---------------------------------------------------------------------------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID-shaped (26 Crockford characters, valid for createPageBodySchema.id) id that is a pure function of space + path (+ attempt, for the rare collision). */
export function stableUlid(space: string, relPath: string, attempt = 0): string {
  const seed = `folio-stable-id\0${space}\0${relPath}${attempt === 0 ? '' : `\0${attempt}`}`;
  const digest = createHash('sha1').update(seed).digest();
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const byte of digest) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 26) {
      bits -= 5;
      out += CROCKFORD[(acc >> bits) & 31];
    }
    acc &= (1 << bits) - 1;
    if (out.length === 26) break;
  }
  // A real ULID's first character is 0-7 (48-bit timestamp); keep that so nothing that validates the shape objects.
  return `${CROCKFORD[CROCKFORD.indexOf(out[0]) & 7]}${out.slice(1)}`;
}

/** FOLIO_STABLE_IDS=1: pages CREATED through the API get stableUlid ids too (the demo's reset). */
export function stableIdsEnabled(): boolean {
  return ['1', 'true', 'yes', 'on'].includes((process.env.FOLIO_STABLE_IDS ?? '').trim().toLowerCase());
}

/** The path's stableUlid — unless another page already holds it (then the next one in the same sequence). */
async function freeStableId(space: string, relPath: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const id = stableUlid(space, relPath, attempt);
    const holder = await queryOne<{ space_slug: string; path: string }>('SELECT space_slug, path FROM pages_index WHERE id = $1', [id]);
    if (!holder || (holder.space_slug === space && holder.path === relPath)) return id;
  }
}

/** The id of a page about to be created at `relPath`: stable when FOLIO_STABLE_IDS is on, else a fresh ULID. */
async function newPageIdAt(space: string, relPath: string): Promise<string> {
  return stableIdsEnabled() ? freeStableId(space, relPath) : ulid();
}

/**
 * An id a link used before: the current page of `space` whose derived id (any of the path ids, or stableUlid) is
 * `oldId` — what the link meant when the page had no id in its file, or before the file gained one. Undefined when
 * no page matches. Only runs on a miss (a 404 on its way to a "moved or removed" screen), never on a hit.
 */
export async function findMovedPage(space: string, oldId: string): Promise<PageIndexEntry | undefined> {
  if (!/^(?:(?:doc|pdf|office|canvas|base|artifact)-[0-9a-f]{24}|[0-9A-HJKMNP-TV-Z]{26})$/.test(oldId)) return undefined;
  const now = Date.now();
  let cached = derivedIdCache.get(space);
  if (!cached || now - cached.at > DERIVED_ID_TTL_MS) {
    // One pass over the space, kept for a moment: a public 404 is anonymous, so a flood of well-shaped unknown ids must not each cost a pass.
    const rows = await query<{ id: string; path: string }>('SELECT id, path FROM pages_index WHERE space_slug = $1 LIMIT 50000', [space]);
    const map = new Map<string, string>();
    for (const row of rows) {
      map.set(stableUlid(space, row.path), row.id);
      for (const kind of ['doc', 'pdf', 'office', 'canvas', 'base', 'artifact'] as const) map.set(pathIdFor(kind, space, row.path, 0), row.id);
    }
    cached = { at: now, map };
    derivedIdCache.set(space, cached);
  }
  const id = cached.map.get(oldId);
  return id && id !== oldId ? getEntry(id) : undefined;
}

const DERIVED_ID_TTL_MS = 30_000;
const derivedIdCache = new Map<string, { at: number; map: Map<string, string> }>();

async function resolveIndexOnlyId(kind: IndexOnlyKind, space: string, relPath: string, abs: string, size: number): Promise<string> {
  const claimed = takeIdClaim(abs);
  if (claimed) return claimed;
  const byPath = await getEntryIdByExactPath(space, relPath);
  if (byPath) return byPath;

  const root = abs.slice(0, abs.length - relPath.length);
  const taken = indexOnlyOrphanClaims.get(space) ?? new Set<string>();
  indexOnlyOrphanClaims.set(space, taken);
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
  return freePathId(kind, space, relPath);
}

/**
 * Claims, for the files about to move from `srcAbs` (a page file or a whole
 * directory) to `destAbs`, the ids of the pages whose id is not in the file
 * (pdf/office; docs — the claim is simply spent when the doc carries its
 * own). Call BEFORE the rename: it reads the index rows of the old paths.
 */
async function claimIdsForMove(space: string, srcAbs: string, destAbs: string): Promise<void> {
  const srcRel = path.relative(spaceDir(space), srcAbs).split(path.sep).join('/');
  const rows = await query<{ id: string; path: string }>(
    `SELECT id, path FROM pages_index
      WHERE space_slug = $1 AND kind IN ('doc', 'pdf', 'office', 'canvas', 'base', 'artifact')
        AND (path = $2 OR substr(path, 1, length($3)) = $3)`,
    [space, srcRel, `${srcRel}/`],
  );
  for (const row of rows) {
    claimPageId(row.path === srcRel ? destAbs : path.join(destAbs, ...row.path.slice(srcRel.length + 1).split('/')), row.id);
  }
}

/** Shared by indexPdfFile, indexOfficeFile and indexBaseFile — same id resolution, same "never read the bytes" rule, same non-searchable stub shape. */
async function indexBinaryFile(kind: 'pdf' | 'office' | 'base', space: string, relPath: string, abs: string, mtime: Date): Promise<PageIndexEntry | null> {
  // stat only — the bytes are never read, let alone rewritten (see "Binary page files").
  let size: number;
  try {
    size = (await fs.stat(abs)).size;
  } catch {
    return null;
  }
  const id = await resolveIndexOnlyId(kind, space, relPath, abs, size);

  // A pdf/office page's order/icon live ONLY in this row (see setBinaryPageOrder's
  // doc comment for the trade-off) — nothing on disk carries them, so this scan
  // must inherit whatever the row already has under this SAME id or a rescan
  // (and a rename resolveIndexOnlyId just followed) would silently reset both back
  // to the defaults below. Looked up by id, not by relPath, precisely because
  // resolveIndexOnlyId may have just carried this id over from a different path.
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
 * A `.canvas` file (JSON Canvas 1.0, Obsidian) becomes a kind:'canvas' page.
 * Like a pdf the file is NEVER written — its id lives in pages_index only
 * (resolveIndexOnlyId), order and icon in the row. Unlike a pdf it is READ: the
 * search text is its group labels, text cards, link URLs and edge labels
 * (shared/canvas/text.ts canvasSearchText), and the parsed document travels on
 * the entry to the page index (file cards and the links / tags inside text
 * cards — indexCanvasMeta). A file over CANVAS_MAX_BYTES or one that is not
 * valid JSON is still a page (it opens on a readable error), searchable by title.
 */
async function indexCanvasFile(space: string, relPath: string, abs: string, mtime: Date): Promise<PageIndexEntry | null> {
  let size: number;
  try {
    size = (await fs.stat(abs)).size;
  } catch {
    return null;
  }
  const id = await resolveIndexOnlyId('canvas', space, relPath, abs, size);
  const existing = await queryOne<{ sort_order: number | null; icon: string | null }>('SELECT sort_order, icon FROM pages_index WHERE id = $1', [id]);
  const canvasDoc = size <= CANVAS_MAX_BYTES ? await readCanvasDocument(abs) : undefined;
  return {
    id,
    space,
    relPath,
    absPath: abs,
    kind: 'canvas',
    isIndex: false,
    dirPath: posixParent(relPath),
    title: titleFallback(relPath, 'canvas'),
    order: existing?.sort_order ?? ORDER_SENTINEL,
    explicitOrder: existing?.sort_order ?? undefined,
    status: 'published',
    icon: existing?.icon ?? undefined,
    updatedAt: mtime.toISOString(),
    body: canvasDoc ? canvasSearchText(canvasDoc) : '',
    canvasDoc: canvasDoc ?? { nodes: [], edges: [] },
  };
}

/** The parsed document of a `.canvas` file; undefined when it cannot be read or is not a JSON Canvas. */
async function readCanvasDocument(abs: string): Promise<CanvasDocument | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(abs, 'utf8');
  } catch {
    return undefined;
  }
  const parsed = parseJsonCanvas(raw);
  return parsed.ok ? parsed.document : undefined;
}

/** The raw text of a canvas page's file (never written by Folio) — capped: a larger file is refused with a readable message. */
export async function readCanvasRaw(id: string): Promise<{ text: string } | { error: string }> {
  const entry = await requireEntry(id);
  if (entry.kind !== 'canvas') throw badRequest('page is not a canvas');
  let size: number;
  try {
    size = (await fs.stat(entry.absPath)).size;
  } catch {
    throw notFound('page');
  }
  if (size > CANVAS_MAX_BYTES) {
    return { error: `The canvas file is too large to show (${Math.round(size / 1024 / 1024)} MB; the limit is ${CANVAS_MAX_BYTES / 1024 / 1024} MB).` };
  }
  return { text: await fs.readFile(entry.absPath, 'utf8') };
}

/**
 * The page index after a page's SIDECAR properties changed (a board, a file
 * page, a canvas): its tags and `prop:` values. A canvas is indexed from its
 * cards as well, so they are read again — indexing it from an empty body would
 * drop its links.
 */
export async function reindexSidecarProperties(entry: PageIndexEntry, data: Record<string, unknown>): Promise<void> {
  const ref = { id: entry.id, space: entry.space, relPath: entry.relPath };
  if (entry.kind === 'canvas') {
    const doc = (await readCanvasDocument(entry.absPath)) ?? { nodes: [], edges: [] };
    await pageIndex.reindexSavedCanvas(ref, doc, data);
    return;
  }
  await pageIndex.reindexSavedPage(ref, '', data);
}

/**
 * The ONE write a canvas file ever gets: `transform` of its text, when a page it
 * points at was renamed or moved through Folio, in any space — a vault
 * included, where notes' wikilinks are rewritten too (collab.ts
 * rewriteCanvasLinks — shared/canvas/rewrite.ts keeps every other byte).
 * Written atomically, then the page's row and index are refreshed at once so
 * the next scan sees nothing new. Returns true when the file changed.
 */
export async function rewriteCanvasFile(id: string, transform: (raw: string) => string): Promise<boolean> {
  const entry = await requireEntry(id);
  if (entry.kind !== 'canvas') throw badRequest('page is not a canvas');
  const raw = await fs.readFile(entry.absPath, 'utf8').catch(() => null);
  if (raw === null || raw.length > CANVAS_MAX_BYTES) return false;
  const next = transform(raw);
  if (next === raw) return false;
  await writeFileAtomic(entry.absPath, next);
  const stat = await fs.stat(entry.absPath);
  const fresh = await indexCanvasFile(entry.space, entry.relPath, entry.absPath, stat.mtime);
  if (fresh) {
    await upsertPagesIndexRow(fresh, stat.mtime, stat.size);
    const sidecar = await propsSidecar.readSidecarText(spaceDir(entry.space), entry.relPath).catch(() => null);
    await pageIndex.indexCanvasMeta({ id: fresh.id, space: fresh.space, relPath: fresh.relPath }, fresh.canvasDoc ?? { nodes: [], edges: [] }, propsSidecar.parseSidecar(sidecar).data);
  }
  return true;
}

/**
 * Obsidian Bases (16.10.2026): a `.base` file becomes a kind:'base' page — the
 * id machinery of a pdf (the file is Obsidian's YAML and carries no id; order
 * and icon live in the row), searchable by title. Its content is read when the
 * page is opened (server/bases/**), never at scan time.
 */
function indexBaseFile(space: string, relPath: string, abs: string, mtime: Date): Promise<PageIndexEntry | null> {
  return indexBinaryFile('base', space, relPath, abs, mtime);
}

/**
 * Artifacts (21.10.2026, docs/spec-artifacts.md): a `<slug>.artifact/` DIRECTORY is
 * one kind:'artifact' page — the first page kind that is a folder. The scan never
 * walks into it (nothing inside is a page or a file of the files index). The id
 * lives in pages_index only (resolveIndexOnlyId, like a pdf's; "size" there is the
 * bundle fingerprint), order in the row; title and icon come from artifact.yaml
 * (the folder name without the suffix when it has none), properties are the
 * manifest's non-reserved keys (the page index gets them as front matter).
 * Searchable by its title and the visible text of its entry page.
 */
async function indexArtifactDir(space: string, relPath: string, abs: string, fingerprint: { mtime: Date; size: number }): Promise<PageIndexEntry | null> {
  const st = await fs.lstat(abs).catch(() => null);
  if (!st?.isDirectory()) return null;
  const id = await resolveIndexOnlyId('artifact', space, relPath, abs, fingerprint.size);
  const existing = await queryOne<{ sort_order: number | null }>('SELECT sort_order FROM pages_index WHERE id = $1', [id]);
  const info = parseArtifactManifest(await artifactBundle.readManifestText(abs), path.basename(abs));
  return {
    id,
    space,
    relPath,
    absPath: abs,
    kind: 'artifact',
    isIndex: false,
    dirPath: posixParent(relPath),
    title: info.manifest.title ?? titleFallback(relPath, 'artifact'),
    order: existing?.sort_order ?? ORDER_SENTINEL,
    explicitOrder: existing?.sort_order ?? undefined,
    status: 'published',
    icon: info.manifest.icon,
    updatedAt: fingerprint.mtime.toISOString(),
    body: await artifactBundle.bundleSearchText(abs, info),
    frontmatter: info.properties,
  };
}

/** fs.cp filter of a bundle copy: no dot entries, no symlinks (the bundle root itself always passes). */
function bundleCopyFilter(rootAbs: string): (src: string) => Promise<boolean> {
  const root = path.resolve(rootAbs);
  return async (src) => {
    if (path.resolve(src) === root) return true;
    if (path.basename(src).startsWith('.')) return false;
    const st = await fs.lstat(src).catch(() => null);
    return !!st && !st.isSymbolicLink();
  };
}

/**
 * A new artifact page: `<stem>.artifact/` (unique under `parentPath`) written by
 * `write` (which gets the bundle's absolute path and writes the whole bundle —
 * artifact/bundle.ts writeBundleDir), then indexed. The deterministic path id, unless
 * `id` is given. Returns the page.
 */
export async function createArtifactPage(space: string, parentPathRaw: string, stem: string, write: (dirAbs: string) => Promise<void>): Promise<PageMeta> {
  if (!(await spaceExists(space))) throw notFound('space');
  const parentPath = normalizePageParentDir(parentPathRaw);
  return withSpaceLock(space, async () => {
    await fs.mkdir(path.join(spaceDir(space), parentPath), { recursive: true });
    const relPath = await uniqueRelPath(space, parentPath, stem || 'artifact', ARTIFACT_DIR_SUFFIX);
    const abs = path.join(spaceDir(space), relPath);
    claimPageId(abs, await freePathId('artifact', space, relPath));
    await write(abs);
    await scanPaths(space, { files: [relPath] });
    let id = await getEntryIdByExactPath(space, relPath);
    if (!id) {
      await scanSpace(space);
      id = await getEntryIdByExactPath(space, relPath);
    }
    if (!id) throw new Error('internal: artifact written but not indexed');
    return toPageMeta(await requireEntry(id));
  });
}

/**
 * Rewrites an existing artifact page under the space lock: `write` gets the bundle's
 * absolute path (and the entry as it is now) and replaces what it must — the whole
 * bundle, or only artifact.yaml. The id is pinned to the path, the page re-indexed at
 * once (title, icon, search text, properties).
 */
export async function rewriteArtifactPage<T>(id: string, write: (dirAbs: string, entry: PageIndexEntry) => Promise<T>): Promise<{ meta: PageMeta; result: T }> {
  const first = await requireEntry(id);
  if (first.kind !== 'artifact') throw badRequest('page is not an artifact');
  return withSpaceLock(first.space, async () => {
    const entry = await requireEntry(id);
    if (entry.kind !== 'artifact') throw badRequest('page is not an artifact');
    const result = await write(entry.absPath, entry);
    claimPageId(entry.absPath, id);
    await scanPaths(entry.space, { files: [entry.relPath] });
    return { meta: toPageMeta(await requireEntry(id)), result };
  });
}

/** `a/q3.artifact/x` -> `a/q3.artifact`; undefined outside a bundle. A folder named `x.artifact` IS a bundle too. */
function artifactBundleOfRel(relDir: string): string | undefined {
  if (!relDir) return undefined;
  const parts = relDir.split('/');
  for (let i = 0; i < parts.length; i++) if (isArtifactDirName(parts[i])) return parts.slice(0, i + 1).join('/');
  return undefined;
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
  // The page's own properties (15.10.2026): the block without the keys that ARE the table — for the page index.
  let own: Record<string, unknown> | undefined;
  try {
    const data = matter(raw, {}).data;
    explicitOrder = numericOrder(data?.order);
    explicitIcon = validStringField(data?.icon);
    own = data && typeof data === 'object' ? ownProperties('table', structuredClone(data) as Record<string, unknown>) : undefined;
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
      frontmatter: own,
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
    frontmatter: own,
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
  // The page's own properties (15.10.2026): the block without the keys that ARE the form — for the page index.
  let own: Record<string, unknown> | undefined;
  try {
    const data = matter(raw, {}).data;
    explicitOrder = numericOrder(data?.order);
    explicitIcon = validStringField(data?.icon);
    own = data && typeof data === 'object' ? ownProperties('form', structuredClone(data) as Record<string, unknown>) : undefined;
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
      frontmatter: own,
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
    frontmatter: own,
    body: formDocToPlainText(parsed),
  };
}

export interface ScanStats {
  filesRead: number;
  filesSkipped: number;
  /**
   * Markdown-like files Folio does not index (`.markdown`). A Docusaurus `docs/`
   * written in MDX once connected as a space of zero pages with no word about
   * why (docs-as-code test, 14.10.2026); `.mdx` has opened as a page since then,
   * and the scan logs how many of the other dialect it passed over.
   */
  skippedUnsupported: number;
  /** Non-page files the space holds after the scan (`space_files`, wave 3: `assets/`, attachments, any other file). */
  indexedFiles: number;
  durationMs: number;
}

/** Markdown dialects a folder may hold that Folio does not open as pages — counted, never indexed. */
function isUnsupportedMarkdown(lowerName: string): boolean {
  return lowerName.endsWith('.markdown');
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

/** Two values as jsonb would hold them (dates as ISO text, object keys in any order). */
function sameJson(a: unknown, b: unknown): boolean {
  const canonical = (v: unknown): string =>
    JSON.stringify(JSON.parse(JSON.stringify(v ?? null)), (_k, x: unknown) =>
      x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x as Record<string, unknown>).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x,
    );
  try {
    return canonical(a) === canonical(b);
  } catch {
    return false;
  }
}

/**
 * What a scoped scan (scanPaths) looks at: folders walked whole and single page files, as POSIX paths relative
 * to the content root. Nothing outside them is read, and nothing is deleted from the index.
 */
export interface ScanScope {
  dirs?: readonly string[];
  files?: readonly string[];
}

/** A scope the scan would not walk the same way a whole-space scan does (a dot folder, an `assets/` folder, an ignored top-level entry, a path that is not tidy). */
class ScanScopeRefused extends Error {
  constructor() {
    super('scan scope is not walkable');
  }
}

function scopeIsWalkable(scope: ScanScope, ignoredAtRoot: (name: string, isDir: boolean) => boolean): boolean {
  const paths = [...(scope.dirs ?? []), ...(scope.files ?? [])];
  return paths.every((p) => {
    const segments = p.split('/');
    if (segments.some((seg) => seg === '' || seg === '.' || seg === '..' || seg.startsWith('.') || seg === 'assets')) return false;
    return !ignoredAtRoot(segments[0], segments.length > 1 || (scope.dirs ?? []).includes(p));
  });
}

/**
 * scanSpace for a KNOWN set of new or changed paths — what the page writes (create, copy, duplicate, make
 * template, from template, upload) have just put on disk. Reads and indexes only those files (and the
 * attachments of those folders), so the cost does not grow with the space: no walk of the whole tree, no
 * mirror of the whole index. The same rows come out as from a full scan, because it is the same per-file
 * code. It removes nothing — a write that DELETES or MOVES pages still needs the full scan — and it falls back
 * to one whenever the scope is not one it can walk faithfully, or the scoped pass fails.
 */
export async function scanPaths(space: string, scope: ScanScope): Promise<ScanStats> {
  try {
    return await scanSpaceImpl(space, undefined, undefined, scope);
  } catch (err) {
    if (err instanceof ScanScopeRefused) return scanSpace(space);
    if (isConnectionFailure(err)) throw err;
    // eslint-disable-next-line no-console
    console.error(`[scan] ${space}: scoped scan failed, scanning the whole space:`, err);
    return scanSpace(space);
  }
}

export function scanSpace(space: string, onProgress?: (progress: ScanProgress) => void, restoredAccess?: RestoredAccess): Promise<ScanStats> {
  return scanSpaceImpl(space, onProgress, restoredAccess);
}

/** The scan itself; with a `scope` it only visits those paths (see scanPaths) and skips every whole-space step: the stale-row cleanup, the files-index mirror, the sidecar comparison. */
async function scanSpaceImpl(space: string, onProgress?: (progress: ScanProgress) => void, restoredAccess?: RestoredAccess, scope?: ScanScope): Promise<ScanStats> {
  const startedAt = Date.now();
  const appliedRules = new Set<PageAccessRule>();
  const root = spaceDir(space);
  indexOnlyOrphanClaims.delete(space);
  // The space's own ignore list (+ the defaults), read per scan so a PATCH on any instance is honoured by the next one.
  const scanIgnoreRow = await queryOne<{ scan_ignore: string[] | null }>('SELECT scan_ignore FROM spaces WHERE slug = $1', [space]);
  const ignoredAtRoot = compileScanIgnore(scanIgnoreRow?.scan_ignore);
  if (scope && !scopeIsWalkable(scope, ignoredAtRoot)) throw new ScanScopeRefused();

  const existingRows = await query<{ path: string; file_mtime: string | null; file_size: string | null; kind: string; title: string; meta_version: number }>(
    scope
      ? `SELECT path, file_mtime, file_size, kind, title, meta_version FROM pages_index p
          WHERE space_slug = $1
            AND (path = ANY($2::text[])
                 OR EXISTS (SELECT 1 FROM unnest($3::text[]) d WHERE p.path COLLATE "C" >= d || '/' AND p.path COLLATE "C" < d || '0'))`
      : 'SELECT path, file_mtime, file_size, kind, title, meta_version FROM pages_index WHERE space_slug = $1',
    scope ? [space, [...(scope.files ?? [])], [...(scope.dirs ?? [])]] : [space],
  );
  const existingByPath = new Map(existingRows.map((r) => [r.path, r]));
  const stillPresent = new Set<string>();
  // Docs whose page index (indexV2: headings, blocks, tags, links) is rebuilt once the walk is done — after the
  // stale rows are gone, so the resolution phase below sees the space as it is now.
  // A canvas carries its parsed document instead of a body (its links and tags are read from the cards).
  const pendingMeta: Array<{ id: string; relPath: string; body: string; frontmatter: Record<string, unknown> | undefined; canvas?: CanvasDocument }> = [];
  // Paths whose page appeared, changed or was re-read (any kind): links that could mean them are re-resolved.
  const readPaths: string[] = [];
  let filesRead = 0;
  let filesSkipped = 0;
  let skippedUnsupported = 0;
  let failedFiles = 0;
  let lastFailure: unknown = null;
  let processedFiles = 0;
  let totalFiles = 0;
  // Property sidecars of boards / PDFs / Office pages (propsSidecar.ts): read once per scan — they are few and
  // small — so a sidecar changed by git is indexed even when its page file did not change.
  // A scoped scan reads just the sidecars of the pages it indexes.
  const sidecars = scope ? new Map<string, string>() : await propsSidecar.listSidecars(root).catch(() => new Map<string, string>());
  const sidecarTextOf = async (relPath: string): Promise<string | null> =>
    scope ? await propsSidecar.readSidecarText(root, relPath).catch(() => null) : (sidecars.get(relPath) ?? null);
  // Wave 3: every non-page file the walk meets, for the files index (spaceFiles.ts) — mirrored after the walk.
  const scannedFiles: spaceFiles.ScannedFile[] = [];
  const noteFile = async (abs: string, relPath: string): Promise<void> => {
    if (spaceFiles.isUnlistedFilePath(relPath)) return;
    const st = await fs.lstat(abs).catch(() => null);
    if (st?.isFile()) scannedFiles.push({ path: relPath, size: st.size, mtime: st.mtime });
  };

  if (onProgress && !scope) {
    async function count(absDir: string, isRoot: boolean): Promise<void> {
      const dirents = await fs.readdir(absDir, { withFileTypes: true }).catch(() => []);
      for (const dirent of dirents) {
        // `.agent/` at the space's CONTENT ROOT is the one dotfile exception
        // (owner spec, 21.09.2026) — see the matching comment in walk() below.
        const isAgentRoot = isRoot && dirent.name === AGENT_FOLDER;
        if (!isAgentRoot && (dirent.name.startsWith('.') || dirent.name === 'assets')) continue;
        if (isRoot && ignoredAtRoot(dirent.name, dirent.isDirectory())) continue;
        const abs = path.join(absDir, dirent.name);
        if (dirent.isDirectory() && isArtifactDirName(dirent.name)) totalFiles++; // a bundle is one page, never walked
        else if (dirent.isDirectory()) await count(abs, false);
        else if (dirent.isFile()) {
          const lower = dirent.name.toLowerCase();
          if (lower.endsWith('.md') || lower.endsWith('.mdx') || lower.endsWith('.excalidraw.svg') || lower.endsWith('.pdf') || officeFormat(lower) || lower.endsWith('.canvas') || lower.endsWith('.base')) totalFiles++; // `.form.md` is also `.md`, already counted
        }
      }
    }
    await count(root, true);
    onProgress({ processedFiles, totalFiles });
  }

  /** One candidate page file met by the walk (or named by a scoped scan): indexed unless its bytes are unchanged. */
  async function visitPageFile(abs: string, relPath: string, name: string, hasIndexMd: boolean, mode: 'pages' | 'files' | 'agent'): Promise<void> {
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
    // `.mdx` (Astro/Nimbus/Starlight/Docusaurus docs) is a document like `.md`: the file stays what it is, only the suffix differs.
    const isMd = !isTable && !isForm && (lower.endsWith('.md') || lower.endsWith('.mdx'));
    const isBoard = lower.endsWith('.excalidraw.svg');
    // Round PDF: case-insensitive, same as every other extension check here
    // (a repo checked out on a case-preserving filesystem can hold `.PDF`).
    const isPdf = lower.endsWith('.pdf');
    // Round OFFICE: same case-insensitive rule; officeFormat is the one
    // source of truth for which of the three extensions this is.
    const isOffice = officeFormat(lower) !== undefined;
    // Obsidian canvas (16.10.2026): a JSON Canvas file, read-only — never written (indexCanvasFile).
    const isCanvas = lower.endsWith('.canvas');
    // Obsidian Bases (16.10.2026): a `.base` file is a view over pages (indexBaseFile).
    const isBase = lower.endsWith('.base');
    // Anything else — including a `.folio` metadata file (round 22) — is never a page:
    // skipped here, so it can never enter pages_index/the tree/search in the first place.
    if (!isMd && !isBoard && !isTable && !isForm && !isPdf && !isOffice && !isCanvas && !isBase) {
      if (isUnsupportedMarkdown(lower)) skippedUnsupported++;
      // Not a page: a file of the space (wave 3) — never one under `.agent/`, never a `*.folio` metadata file.
      if (mode === 'pages') await noteFile(abs, relPath);
      return;
    }

    const reportProcessed = () => {
      processedFiles++;
      onProgress?.({ processedFiles, totalFiles });
    };

    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) return;
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
    const derivedTitle = isPdf || isOffice || isCanvas ? titleFallback(relPath, isPdf ? 'pdf' : isOffice ? 'office' : 'canvas') : isBase ? titleFallback(relPath, 'base') : undefined;
    // Index v2: a page indexed by an older parser (meta_version below INDEX_META_VERSION — every row right
    // after migration 042) is read again even though its bytes did not change, so new metadata reaches old rows.
    // Every kind has metadata now: a document's headings / tags / links, a table's or form's own properties
    // (front matter), a board's / file's sidecar properties — a table that kept its fast path would never get its tags.
    const metaStale = existing !== undefined && Number(existing.meta_version) < INDEX_META_VERSION;
    const unchanged =
      existing &&
      existing.file_mtime &&
      existing.file_size !== null &&
      new Date(existing.file_mtime).getTime() === stat.mtime.getTime() &&
      Number(existing.file_size) === stat.size &&
      (derivedTitle === undefined || existing.title === derivedTitle) &&
      !metaStale;
    if (unchanged) {
      filesSkipped++;
      reportProcessed();
      return;
    }
    filesRead++;

    // README.md is the directory's index only when this directory has no index.md.
    const isIndex = isMd && (isStrongIndexName(name) || (/^README\.mdx?$/.test(name) && !hasIndexMd));
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
            ? await indexDocFile(space, relPath, abs, stat.mtime, isIndex, stat.size)
            : isPdf
              ? await indexPdfFile(space, relPath, abs, stat.mtime)
              : isOffice
                ? await indexOfficeFile(space, relPath, abs, stat.mtime)
                : isCanvas
                  ? await indexCanvasFile(space, relPath, abs, stat.mtime)
                : isBase
                  ? await indexBaseFile(space, relPath, abs, stat.mtime)
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
      return;
    }
    if (!entry) return;
    readPaths.push(entry.relPath);
    if (entry.kind === 'doc') pendingMeta.push({ id: entry.id, relPath: entry.relPath, body: entry.body ?? '', frontmatter: entry.frontmatter });
    // A table's / form's own properties, a board's / file's sidecar: tags and `prop:` of the page (no body to parse).
    else if (entry.kind === 'table' || entry.kind === 'form') pendingMeta.push({ id: entry.id, relPath: entry.relPath, body: '', frontmatter: entry.frontmatter ?? {} });
    else if (propsSidecar.usesSidecar(entry.kind)) {
      pendingMeta.push({
        id: entry.id,
        relPath: entry.relPath,
        body: '',
        frontmatter: propsSidecar.parseSidecar(await sidecarTextOf(entry.relPath)).data,
        canvas: entry.canvasDoc,
      });
    }
    reportProcessed();
  }

  /**
   * One artifact bundle (`<slug>.artifact/`) met by the walk or named by a scoped scan: indexed as ONE page
   * unless its fingerprint (newest mtime + total size of everything inside) is unchanged. Never walked into.
   */
  async function visitArtifactDir(abs: string, relPath: string): Promise<void> {
    const st = await fs.lstat(abs).catch(() => null);
    if (!st?.isDirectory()) return;
    const fingerprint = await artifactBundle.bundleFingerprint(abs);
    stillPresent.add(relPath);
    const existing = existingByPath.get(relPath);
    const metaStale = existing !== undefined && Number(existing.meta_version) < INDEX_META_VERSION;
    if (
      existing &&
      existing.kind === 'artifact' &&
      existing.file_mtime &&
      existing.file_size !== null &&
      new Date(existing.file_mtime).getTime() === fingerprint.mtime.getTime() &&
      Number(existing.file_size) === fingerprint.size &&
      !metaStale
    ) {
      filesSkipped++;
      processedFiles++;
      onProgress?.({ processedFiles, totalFiles });
      return;
    }
    filesRead++;
    let entry: PageIndexEntry | null;
    try {
      entry = await indexArtifactDir(space, relPath, abs, fingerprint);
      if (entry) {
        const rule = restoredAccess ? (restoredAccess.byId.get(entry.id) ?? restoredAccess.byPath.get(entry.relPath)) : undefined;
        const give = rule && !appliedRules.has(rule) ? rule : undefined;
        await upsertPagesIndexRow(entry, fingerprint.mtime, fingerprint.size, give);
        if (give) appliedRules.add(give);
      }
    } catch (err) {
      failedFiles++;
      lastFailure = err;
      // eslint-disable-next-line no-console
      console.warn(`[scan] ${space}/${relPath}: skipped, could not index:`, err instanceof Error ? err.message.split('\n')[0] : err);
      processedFiles++;
      onProgress?.({ processedFiles, totalFiles });
      return;
    }
    processedFiles++;
    onProgress?.({ processedFiles, totalFiles });
    if (!entry) return;
    readPaths.push(entry.relPath);
    // The manifest's own keys are the page's properties: tags and `prop:` of the page (no body to parse for links).
    pendingMeta.push({ id: entry.id, relPath: entry.relPath, body: '', frontmatter: entry.frontmatter ?? {} });
  }

  /**
   * `mode`: 'pages' — the usual walk (pages indexed, every other file noted for
   * the files index); 'files' — inside an `assets/` folder: nothing is a page
   * there (as before), every file is a file; 'agent' — inside `.agent/`: pages
   * only, nothing under a dot folder is ever listed as a file.
   */
  async function walk(absDir: string, relDir: string, mode: 'pages' | 'files' | 'agent' = 'pages'): Promise<void> {
    let dirents;
    try {
      dirents = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    const names = new Set(dirents.map((d) => d.name));
    const hasIndexMd = names.has('index.md') || names.has('index.mdx');

    for (const dirent of dirents) {
      const name = dirent.name;
      // Dotfiles are never pages (nor files of the files index) — EXCEPT
      // `.agent/` at the space's own content root (relDir === '', i.e. this
      // walk call is rooted at `root` itself): admin-only rules pages for the
      // AI assistant (owner spec, 21.09.2026), indexed like any other page. A
      // NESTED `.agent` (someone's `notes/.agent/x.md`) is not this folder and
      // stays skipped, same as every other dotfile.
      const isAgentRoot = relDir === '' && name === AGENT_FOLDER;
      if (dirent.isFile() && isAtomicTempName(name)) {
        // A writeFileAtomic temp file its process never renamed (crash, kill).
        await removeOrphanTempFile(path.join(absDir, name));
        continue;
      }
      if (dirent.isDirectory() && artifactBundle.isTempBundleName(name)) {
        // The temp sibling of an artifact bundle write its process never swapped in (crash, kill) — old ones only.
        await artifactBundle.removeOrphanTempBundle(path.join(absDir, name));
        continue;
      }
      if (!isAgentRoot && name.startsWith('.')) continue;
      // The space's scan-ignore list (default `.obsidian/ .trash/ .git/`, which the dot rule above already covers) names TOP-LEVEL entries only.
      if (relDir === '' && ignoredAtRoot(name, dirent.isDirectory())) continue;
      const abs = path.join(absDir, name);
      const relPath = relDir ? `${relDir}/${name}` : name;
      if (dirent.isDirectory() && mode === 'pages' && isArtifactDirName(name)) {
        // An artifact bundle is ONE page: indexed as such, never walked (nothing inside is a page or a file of the index).
        await visitArtifactDir(abs, relPath);
        continue;
      }
      if (dirent.isDirectory()) {
        // "assets/" (any depth) holds uploaded attachments, not pages: walked for the files index only (wave 3) —
        // except under `.agent/`, where nothing is a file of the index and `assets/` holds no pages either.
        if (name === 'assets' && mode === 'agent') continue;
        const childMode = mode === 'agent' || isAgentRoot ? 'agent' : mode === 'files' || name === 'assets' ? 'files' : 'pages';
        await walk(abs, relPath, childMode);
        continue;
      }
      if (!dirent.isFile()) continue;
      if (mode === 'files' || (mode === 'pages' && name === 'assets')) {
        await noteFile(abs, relPath);
        continue;
      }
      await visitPageFile(abs, relPath, name, hasIndexMd, mode);
    }
  }

  if (scope) {
    for (const dir of scope.dirs ?? []) {
      // A copied bundle named as a folder of the scope is still one page.
      if (isArtifactDirName(path.posix.basename(dir))) await visitArtifactDir(path.join(root, ...dir.split('/')), dir);
      else await walk(path.join(root, ...dir.split('/')), dir);
    }
    for (const rel of scope.files ?? []) {
      const abs = path.join(root, ...rel.split('/'));
      if (isArtifactDirName(path.posix.basename(rel))) {
        await visitArtifactDir(abs, rel);
        continue;
      }
      const dirNames = await fs.readdir(path.dirname(abs)).catch(() => [] as string[]);
      await visitPageFile(abs, rel, path.basename(rel), dirNames.includes('index.md') || dirNames.includes('index.mdx'), 'pages');
    }
  } else {
    await walk(root, '');
  }

  // Tolerating individual files must not hide a SYSTEMIC failure — but the
  // first version of this guard decided "systemic" by counting ("every file we
  // tried failed"), and that is precisely what took prod down on 15.09: on a
  // rescan only the one changed file is read, so one bad file is "every file",
  // the scan threw, and the old boot order turned that into a dead process on
  // every restart. Only a genuine loss of the database connection is systemic.
  if (failedFiles > 0 && isConnectionFailure(lastFailure)) throw lastFailure;

  // A restored page whose file the loop above skipped as unchanged (somebody else's scan indexed it first) still gets its rule.
  if (restoredAccess) await reconcileRestoredAccess(space, restoredAccess, appliedRules);

  // Paths whose page went away (or moved: its row now carries the new path): links that meant them are re-resolved.
  // (A scoped scan has not seen the rest of the space, so it removes nothing.)
  const removedPaths = scope ? [] : existingRows.map((r) => r.path).filter((p) => !stillPresent.has(p));
  if (scope) {
    // nothing to clean up
  } else if (stillPresent.size > 0) {
    await query('DELETE FROM pages_index WHERE space_slug = $1 AND NOT (path = ANY($2::text[]))', [space, [...stillPresent]]);
  } else {
    await query('DELETE FROM pages_index WHERE space_slug = $1', [space]);
  }

  // The files index (wave 3), before the resolution below: a file that appeared resolves the links waiting for it,
  // one that went away turns its links unresolved.
  let filePaths: string[] = [];
  let indexedFiles = 0;
  try {
    if (scope) {
      // Only the files the scoped walk met (a copied folder's attachments): written, never mirrored against the whole space.
      if (scannedFiles.length > 0) filePaths = (await spaceFiles.addScannedFiles(space, scannedFiles)).added;
      indexedFiles = scannedFiles.length;
    } else {
      const synced = await spaceFiles.syncScannedFiles(space, scannedFiles);
      filePaths = [...synced.added, ...synced.removed];
      indexedFiles = synced.total;
    }
  } catch (err) {
    if (isConnectionFailure(err)) throw err;
    // eslint-disable-next-line no-console
    console.error(`[scan] ${space}: could not update the files index:`, err);
  }

  // A sidecar that changed (or went away) while its page file did not: the page's properties are indexed again.
  // (A scoped scan indexes the sidecars of its own pages and compares nothing else.)
  if (!scope) {
    try {
      const queued = new Set(pendingMeta.map((p) => p.id));
      const rows = await query<{ id: string; path: string; kind: string; frontmatter: Record<string, unknown> | null }>(
        `SELECT id, path, kind, frontmatter FROM pages_index WHERE space_slug = $1 AND kind = ANY($2::text[])`,
        [space, ['board', 'pdf', 'office', 'canvas', 'base']],
      );
      for (const row of rows) {
        if (queued.has(row.id)) continue;
        const data = propsSidecar.parseSidecar(sidecars.get(row.path) ?? null).data;
        if (sameJson(data, row.frontmatter ?? {})) continue;
        // A canvas is indexed from its cards as well: re-read them, or the property change would wipe its links.
        const canvas = row.kind === 'canvas' ? ((await readCanvasDocument(path.join(root, row.path))) ?? { nodes: [], edges: [] }) : undefined;
        pendingMeta.push({ id: row.id, relPath: row.path, body: '', frontmatter: data, canvas });
      }
    } catch (err) {
      if (isConnectionFailure(err)) throw err;
      // eslint-disable-next-line no-console
      console.error(`[scan] ${space}: could not compare the property sidecars:`, err);
    }
  }

  // Index v2, phase 1: the documents read in this scan (their links raw, unresolved).
  // Cooperative (15.10.2026: a big document held the event loop for 339 s on prod): a big body is parsed in chunks
  // with a yield between them (indexV2/parse.ts parsePageMetaAsync), and each body is let go once indexed.
  if (scope) {
    // A handful of pages (a copy): written together, a few statements instead of a dozen round trips each.
    await pageIndex.indexPagesMeta(
      pendingMeta.map((p) => ({ page: { id: p.id, space, relPath: p.relPath }, body: p.body, frontmatter: p.frontmatter, canvas: p.canvas })),
      (page, err) => {
        // eslint-disable-next-line no-console
        console.error(`[index] failed to index ${space}/${page.relPath}:`, err);
      },
    );
  } else {
    for (const p of pendingMeta) {
      const page = { id: p.id, space, relPath: p.relPath };
      await (p.canvas ? pageIndex.indexCanvasMeta(page, p.canvas, p.frontmatter) : pageIndex.indexPageMeta(page, p.body, p.frontmatter)).catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[index] failed to index ${space}/${p.relPath}:`, err);
      });
      p.body = '';
    }
  }
  // Phase 2: resolve against the pages as they are now. Only when something changed, so an idle rescan stays free;
  // a small change resolves just the links it can affect, a big one (a first scan, a pull) the whole space.
  if (readPaths.length > 0 || removedPaths.length > 0 || filePaths.length > 0) {
    const changedPaths = [...readPaths, ...removedPaths, ...filePaths];
    const resolveScope: pageIndex.ResolveScope =
      changedPaths.length > pageIndex.SCOPED_RESOLVE_MAX_PATHS
        ? 'all'
        : { sourceIds: pendingMeta.map((p) => p.id), changedPaths, targetIds: pendingMeta.map((p) => p.id) };
    await pageIndex.resolveLinks(space, resolveScope).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[index] failed to resolve the links of ${space}:`, err);
    });
  }

  const stats: ScanStats = { filesRead, filesSkipped, skippedUnsupported, indexedFiles, durationMs: Date.now() - startedAt };
  // eslint-disable-next-line no-console
  console.log(`[scan] ${space}: ${filesRead} read, ${filesSkipped} unchanged, ${stats.durationMs}ms`);
  if (skippedUnsupported > 0) {
    // eslint-disable-next-line no-console
    console.warn(`[scan] ${space}: ${skippedUnsupported} .markdown file(s) skipped — only .md and .mdx files become pages`);
  }
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
  const verification = e.verificationProps ? computeVerification(e.verificationProps, e.updatedAt) : null;
  if (verification) meta.verification = verification;
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
  asset_mode: SpaceAssetMode;
  /** Round 27 (access and rights): 'private' (default) or 'instance' — see docs/spec-access.md §3. Not exercised by this module's own access checks (that's server/auth/session.ts's effectiveRole/membershipsFor); carried through purely so SpaceInfo can report it. */
  visibility: SpaceVisibility;
  /** Migration 041: the space's own extra scan-ignore entries, and the explicit light-footprint flag. */
  scan_ignore: string[] | null;
  light_footprint: boolean;
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
    ...(r.light_footprint || r.root_path !== '' ? { lightFootprint: true as const } : {}),
    scanIgnore: r.scan_ignore ?? [],
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

const SPACE_SELECT_BASE = `SELECT s.slug, s.name, s.repo_url, s.branch, s.root_path, s.status, s.last_sync_at, s.last_sync_by_name, s.last_sync_by_email, s.last_error, s.asset_mode, s.visibility, s.scan_ignore, s.light_footprint,
          (SELECT p.title FROM pages_index p WHERE p.space_slug = s.slug AND p.is_index AND p.path NOT LIKE '%/%') AS root_title,
          COUNT(p2.id) AS page_count
     FROM spaces s
     LEFT JOIN pages_index p2 ON p2.space_slug = s.slug`;
const SPACE_GROUP_BY = `GROUP BY s.slug, s.name, s.repo_url, s.branch, s.root_path, s.status, s.last_sync_at, s.last_sync_by_name, s.last_sync_by_email, s.last_error, s.asset_mode, s.visibility, s.scan_ignore, s.light_footprint`;

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
 * The slugs among `spaces` whose `.agent` folder holds the writing-rules page (shared/contracts.ts
 * WRITING_RULES_PATH) — one grouped query, a boolean per space like countAgentPages (`SpaceInfo.agentRules
 * .writingRules`: the client shows "Check against writing rules" only where it is true).
 */
export async function spacesWithWritingRules(spaces: readonly string[]): Promise<Set<string>> {
  if (spaces.length === 0) return new Set();
  const rows = await query<{ space_slug: string }>(
    `SELECT DISTINCT space_slug FROM pages_index WHERE space_slug = ANY($1::text[]) AND path = $2 AND kind = 'doc'`,
    [spaces, WRITING_RULES_PATH],
  );
  return new Set(rows.map((r) => r.space_slug));
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
  return buildTreeFromEntries(space, entries);
}

/**
 * The subtree of the space's `_templates/` folder, in the node shape getTree
 * returns (children nested) — the template picker's tree. `[]` when the space
 * has no such folder. Page access is applied like getTree does.
 */
export async function getTemplatesTree(space: string, allowedPageIds?: ReadonlySet<string>): Promise<TreeNode[]> {
  if (!(await spaceExists(space))) throw notFound('space');
  const entries = (await listEntries(space)).filter((e) => isUnderTemplates(e.relPath) && (!allowedPageIds || allowedPageIds.has(e.id)));
  if (entries.length === 0) return [];
  const root = buildTreeFromEntries(space, entries)[0];
  return root.children.find((n) => n.path === TEMPLATES_DIR_NAME)?.children ?? [];
}

function buildTreeFromEntries(space: string, entries: PageIndexEntry[]): TreeNode[] {

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
  if (kind === 'canvas') return base.slice(0, -'.canvas'.length);
  if (kind === 'base') return base.slice(0, -'.base'.length);
  if (kind === 'artifact') return artifactStem(base);
  // Round OFFICE: same "no real sibling children directory in practice, but
  // still return a sane stem" rule as pdf above.
  if (kind === 'office') {
    const fmt = officeFormat(relPath);
    return fmt ? base.slice(0, -(fmt.length + 1)) : base;
  }
  return stripDocExt(base);
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

/**
 * The space's templates: what is listed directly in `_templates/` — a leaf
 * page of any kind or a directory-index page `_templates/X/index.md`. A
 * template's own subpages are not templates, and neither is anything inside a
 * folder that has no page of its own. Sorted like the tree. viewer+ (checked
 * by the route).
 */
export async function listTemplates(space: string): Promise<TemplateListItem[]> {
  if (!(await spaceExists(space))) throw notFound('space');
  const entries = await listEntries(space);
  const top = entries
    .filter((e) => (e.isIndex ? posixParent(e.dirPath) === TEMPLATES_DIR_NAME : e.dirPath === TEMPLATES_DIR_NAME))
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  if (top.length === 0) return [];
  // Descriptions ride the page index (`pages_index.frontmatter` holds a page's own properties): one query, no file reads.
  const rows = await query<{ id: string; description: string | null }>(
    `SELECT id, frontmatter->>'${TEMPLATE_DESCRIPTION_KEY}' AS description FROM pages_index WHERE space_slug = $1 AND id = ANY($2::text[])`,
    [space, top.map((e) => e.id)],
  );
  const descriptions = new Map(rows.filter((r) => r.description && r.description.trim()).map((r) => [r.id, r.description!.trim()]));
  return top.map((e) => {
    const meta: TemplateListItem = toPageMeta(e);
    const description = descriptions.get(e.id);
    if (description) meta.description = description;
    return meta;
  });
}

// ---------------------------------------------------------------------------
// Write API
// ---------------------------------------------------------------------------

async function uniqueRelPath(space: string, parentPath: string, stem: string, ext: string): Promise<string> {
  let candidate = stem;
  let n = 2;
  // `intro.md` and `intro.mdx` are one name to a reader (and to a link): either one occupies the stem.
  const exts = ext === '.md' || ext === '.mdx' ? ['.md', '.mdx'] : [ext];
  for (;;) {
    const taken = await Promise.all(
      exts.map((e) => pathExists(path.join(spaceDir(space), parentPath ? `${parentPath}/${candidate}${e}` : `${candidate}${e}`))),
    );
    if (!taken.some(Boolean)) return parentPath ? `${parentPath}/${candidate}${ext}` : `${candidate}${ext}`;
    candidate = `${stem}-${n++}`;
  }
}

/**
 * The suffix a NEW document gets in `parentPath`: `.md`, except in a folder of `.mdx` pages. The nearest folder
 * (this one, then each parent up to the content root) that holds any document decides: only `.mdx` documents
 * there (Nimbus/Starlight/Astro docs written entirely in MDX) -> `.mdx`; any `.md`, or no document anywhere
 * (a fresh space) -> `.md`. So a mixed folder and every ordinary space keep `.md`, and a page created next to
 * `index.mdx` is MDX like its neighbours instead of a stray `.md` the site generator reads differently.
 */
async function defaultDocExt(space: string, parentPath: string): Promise<'.md' | '.mdx'> {
  const root = spaceDir(space);
  let dir = parentPath;
  for (;;) {
    const names = await fs.readdir(path.join(root, dir)).catch(() => [] as string[]);
    let mdx = 0;
    let md = 0;
    for (const name of names) {
      const lower = name.toLowerCase();
      if (lower.endsWith('.mdx')) mdx++;
      else if (lower.endsWith('.md') && !lower.endsWith('.table.md') && !lower.endsWith('.form.md')) md++;
    }
    if (mdx + md > 0) return mdx > 0 && md === 0 ? '.mdx' : '.md';
    if (!dir) return '.md';
    dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
  }
}

/** Characters a wikilink target (or a file name inside one) cannot carry: path separators, `#` `|` `^` (link syntax), `:`, `[` `]`, `%` and control characters. */
const FILE_STEM_FORBIDDEN_RE = /[/\\#|^:[\]%\u0000-\u001f\u007f]/;
/** Longest file name (bytes) most filesystems take is 255; room is left for `-12` and `.md`. */
const FILE_STEM_MAX_BYTES = 240;

/**
 * `fileStem` of POST /api/pages (wave 2, Obsidian): the exact file name of a new doc without `.md`, so that
 * `[[Note]]` resolves to the file "Create page “Note”" just made. Trimmed, a trailing `.md` dropped; refused
 * when it is empty, starts with a dot, holds a character a link cannot carry, or would make the scan take the
 * file for a data table / form (`x.table.md`, `x.form.md`).
 */
export function normalizeFileStem(raw: string): string {
  let stem = raw.trim();
  if (!stem) throw badRequest('fileStem must not be empty');
  if (stem.startsWith('.')) throw badRequest('fileStem must not start with a dot');
  stem = stem.replace(/\.mdx?$/i, '').trim();
  if (!stem) throw badRequest('fileStem must not be empty');
  if (FILE_STEM_FORBIDDEN_RE.test(stem)) throw badRequest('fileStem must not contain / \\ # | ^ : [ ] % or control characters');
  if (/\.(table|form)$/i.test(stem)) throw badRequest('fileStem must not end with .table or .form');
  if (Buffer.byteLength(stem, 'utf8') > FILE_STEM_MAX_BYTES) throw badRequest('fileStem is too long');
  return stem;
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
  /** kind 'base': the `.base` YAML (already validated by the caller) instead of the starter view. */
  baseSource?: string;
}

/** A new base's file name: the title as Obsidian would name it (letters of any script kept), else its slug. */
function baseFileStem(title: string): string {
  try {
    const stem = normalizeFileStem(title);
    return /\.base$/i.test(stem) ? stem.slice(0, -'.base'.length) || translitSlug(title) : stem;
  } catch {
    return translitSlug(title);
  }
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
  // A canvas is an Obsidian file Folio reads, never writes: there is nothing to create here (a board is Folio's own canvas).
  if (body.kind === 'canvas') throw badRequest('canvas pages are read from .canvas files; create a board instead');
  if (body.kind === 'artifact') throw badRequest('artifacts are created through POST /api/spaces/:space/artifacts (or MCP publish_artifact)');
  // Wave 2: an explicit file name for a DOC (ignored for every other kind); refused before anything is created.
  const fileStem = body.kind === 'doc' && body.fileStem !== undefined ? normalizeFileStem(body.fileStem) : undefined;
  if (!(await spaceExists(body.space))) throw notFound('space');

  return withSpaceLock(body.space, async () => {
    const parentPath = normalizePageParentDir(body.parentPath);
    await fs.mkdir(path.join(spaceDir(body.space), parentPath), { recursive: true });

    // OFFLINE CREATION: the client minted the id (its URL and every link to the page
    // already use it). The route answers a replay of an id that is already taken
    // before it gets here; this re-check, under the space lock, only closes the race
    // of two concurrent creates with the same id — the loser gets a 409 (its retry
    // then finds the page and is answered as a replay) instead of a second file
    // stamped with the same id.
    let id = body.id ?? ulid();
    if (body.id && (await getEntry(body.id))) throw conflict('a page with this id already exists');
    // FOLIO_STABLE_IDS: a page the client did not name itself gets the id of its path (see "Stable page ids").
    const idAtPath = async (rel: string): Promise<void> => {
      if (!body.id) id = await newPageIdAt(body.space, rel);
    };
    let relPath: string;
    // Every page file this call writes, for the scoped scan below (a form brings its table).
    const writtenFiles: string[] = [];
    if (body.kind === 'board') {
      relPath = await uniqueRelPath(body.space, parentPath, translitSlug(title), '.excalidraw.svg');
      await idAtPath(relPath);
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
      await idAtPath(relPath);
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
      await idAtPath(relPath);
      const formStem = relPathStem(relPath, 'form');
      const tableParentPath = parentPath ? `${parentPath}/${formStem}` : formStem;
      await fs.mkdir(path.join(spaceDir(body.space), tableParentPath), { recursive: true });

      const tableRelPath = await uniqueRelPath(body.space, tableParentPath, translitSlug(title), '.table.md');
      const tableId = await newPageIdAt(body.space, tableRelPath);
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
      writtenFiles.push(tableRelPath);

      const formDoc: FormDoc = {
        meta: { id, version: 1 },
        table: tableRelPath,
        title,
        public: false,
        fields: deriveFieldsFromColumns(starterColumns),
        body: '',
      };
      await fs.writeFile(path.join(spaceDir(body.space), relPath), serializeFormFile(formDoc), 'utf8');
    } else if (body.kind === 'base') {
      // Obsidian Bases: the file is Obsidian's YAML and carries no id — the id rides a claim, the path's own
      // deterministic id unless the client minted one (as a light-footprint doc's does). The starter is one
      // table view of the pages in the folder the base is created in (the whole space at the root).
      relPath = await uniqueRelPath(body.space, parentPath, baseFileStem(title), '.base');
      const abs = path.join(spaceDir(body.space), relPath);
      if (!body.id) id = await freePathId('base', body.space, relPath);
      claimPageId(abs, id);
      const starter =
        (parentPath ? `filters:\n  and:\n    - file.inFolder(${JSON.stringify(parentPath)})\n` : '') +
        'views:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - file.folder\n      - file.tags\n      - file.mtime\n    sort:\n      - property: file.mtime\n        direction: DESC\n';
      await fs.writeFile(abs, initial?.baseSource ?? starter, 'utf8');
    } else {
      relPath = await uniqueRelPath(body.space, parentPath, fileStem ?? translitSlug(title), await defaultDocExt(body.space, parentPath));
      const abs = path.join(spaceDir(body.space), relPath);
      await idAtPath(relPath);
      if (isLightFootprintSpace(body.space)) {
        // No Folio front matter at all: the id rides a claim into the scan below — the
        // path's own deterministic id unless the client minted one (offline create).
        if (!body.id) id = await freePathId('doc', body.space, relPath);
        claimPageId(abs, id);
        // A new `.mdx` page in a docs folder of a site generator gets what that generator asks of every page: a
        // `title` in the front matter (Nimbus and Starlight refuse to build a page without one, and say "do not
        // repeat the title in the body"). A `.md` page keeps its `# Title`.
        if (isMdxPath(relPath) && docBody === undefined) await persistDocFrontmatter(abs, {}, '', { raw: `---\ntitle: ${JSON.stringify(title)}\n---\n` });
        else await persistDocFrontmatter(abs, {}, docBody ?? `# ${title}\n`);
      } else {
        await persistDocFrontmatter(abs, { id }, docBody ?? `# ${title}\n`);
      }
    }
    await scanPathsOrAll(body.space, { files: [relPath, ...writtenFiles] }, id);
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
    const parentPath = normalizePageParentDir(parentPathRaw);
    await fs.mkdir(path.join(spaceDir(space), parentPath), { recursive: true });

    const baseName = originalFilename.slice(0, originalFilename.length - ext.length);
    const stem = translitSlug(baseName) || 'document';
    const relPath = await uniqueRelPath(space, parentPath, stem, ext);
    const destAbs = path.join(spaceDir(space), relPath);

    await fs.writeFile(destAbs, bytes);

    await scanPaths(space, { files: [relPath] });
    let entryId = await getEntryIdByExactPath(space, relPath);
    if (!entryId) {
      await scanSpace(space);
      entryId = await getEntryIdByExactPath(space, relPath);
    }
    if (!entryId) throw new Error('internal: file uploaded but not indexed');
    return toPageMeta(await requireEntry(entryId));
  });
}

/** The text of a base page's `.base` file (Obsidian Bases, 16.10.2026). */
export async function readBaseRaw(id: string): Promise<{ entry: PageIndexEntry; text: string }> {
  const entry = await requireEntry(id);
  if (entry.kind !== 'base') throw badRequest('page is not a base');
  const text = await fs.readFile(entry.absPath, 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') throw notFound('page');
    throw err;
  });
  return { entry, text };
}

/**
 * Rewrites a base page's file: `transform` gets the current text (under the
 * space lock) and returns the new one, or null for "nothing to write". The
 * index row's size / mtime / updated_at follow at once (like writeFilePageBytes)
 * so the next scan sees nothing new. The commit is the debounced auto-commit
 * the route nudges, attributed to the caller (gitSync.recordEditor).
 */
export async function writeBaseRaw(id: string, transform: (current: string, entry: PageIndexEntry) => string | null | Promise<string | null>): Promise<{ entry: PageIndexEntry; text: string; written: boolean }> {
  const first = await requireEntry(id);
  if (first.kind !== 'base') throw badRequest('page is not a base');
  return withSpaceLock(first.space, async () => {
    const entry = await requireEntry(id);
    const current = await fs.readFile(entry.absPath, 'utf8');
    const next = await transform(current, entry);
    if (next === null || next === current) return { entry, text: current, written: false };
    await writeFileAtomic(entry.absPath, next);
    const stat = await fs.stat(entry.absPath);
    await query('UPDATE pages_index SET file_mtime = $2, file_size = $3, updated_at = $4 WHERE id = $1', [id, stat.mtime, stat.size, stat.mtime.toISOString()]);
    return { entry: await requireEntry(id), text: next, written: true };
  });
}

/**
 * Replaces the bytes of an existing pdf/office page in place. The page keeps its
 * id, path, order, icon and everything keyed by the id (access rules, shares,
 * stars): only the file's content and the index row's size / mtime /
 * updated_at change. The row is updated directly instead of through a rescan,
 * because a rescan skips a file whose (mtime, size) look unchanged — two
 * same-sized versions written within one clock tick would otherwise go
 * unnoticed. File pages carry no extracted text (search is by title only,
 * see "Binary page files"), so there is no text to reindex.
 */
export async function writeFilePageBytes(id: string, bytes: Buffer): Promise<PageMeta> {
  const entry = await requireEntry(id);
  if (entry.kind !== 'pdf' && entry.kind !== 'office') throw badRequest('page is not a pdf/office file');
  return withSpaceLock(entry.space, async () => {
    await writeFileAtomic(entry.absPath, bytes);
    const stat = await fs.stat(entry.absPath);
    const updatedAt = stat.mtime.toISOString();
    await query('UPDATE pages_index SET file_mtime = $2, file_size = $3, updated_at = $4 WHERE id = $1', [id, stat.mtime, stat.size, updatedAt]);
    return toPageMeta(await requireEntry(id));
  });
}

/**
 * Gives a pdf/office page a different extension (deck.pptx -> deck.pdf), keeping
 * its id: the file is renamed in place and the id rides a claim into the next
 * scan (the kind can change too, pdf <-> office, which the scan's "same kind"
 * orphan matching would not follow). Like a slug rename, the path changes, so
 * the result lists the move for the caller to rewrite incoming links with.
 * A change of letter case only (.PDF -> .pdf) is not a change.
 */
export async function changeFilePageExtension(id: string, newExt: string): Promise<SlugRenameResult> {
  const entry = await requireEntry(id);
  if (entry.kind !== 'pdf' && entry.kind !== 'office') throw badRequest('page is not a pdf/office file');
  return withSpaceLock(entry.space, async () => {
    const stem = relPathStem(entry.relPath, entry.kind);
    const currentExt = path.posix.extname(entry.relPath);
    if (currentExt.toLowerCase() === newExt.toLowerCase()) return { meta: toPageMeta(entry), moved: [] };

    const destAbs = path.join(path.dirname(entry.absPath), `${stem}${newExt}`);
    const newRelPath = entry.dirPath ? `${entry.dirPath}/${stem}${newExt}` : `${stem}${newExt}`;
    if (await pathExists(destAbs)) throw conflict(`a page already exists at ${newRelPath}`);

    // Captured before the rename and the rescan, same reason as renamePageSlug.
    const backlinks = await links.getBacklinks(id);
    claimBinaryId(destAbs, id);
    await fs.rename(entry.absPath, destAbs);
    await followSidecars(entry.space, [[entry.relPath, newRelPath, false]]);
    await scanSpace(entry.space);
    return { meta: toPageMeta(await requireEntry(id)), moved: [{ id, oldRelPath: entry.relPath, newRelPath, backlinks }] };
  });
}

async function insertSpaceRow(
  slug: string,
  name: string,
  opts: { repoUrl?: string | null; branch?: string; rootPath?: string; status: string; createdBy: string | null; lightFootprint?: boolean },
): Promise<void> {
  try {
    await query(
      `INSERT INTO spaces (slug, name, repo_url, branch, root_path, status, created_by, light_footprint) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [slug, name, opts.repoUrl ?? null, opts.branch ?? 'main', opts.rootPath ?? '', opts.status, opts.createdBy, opts.lightFootprint === true],
    );
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('a space with this slug already exists (try again)');
    throw err;
  }
  rememberSpaceCaches(slug, opts.rootPath ?? '', opts.lightFootprint === true);
  // The personal "Undo" history (page_change_history) is keyed by slug and has no
  // foreign key, on purpose. Deleting a space leaves its rows alone — the space sits
  // in the trash and a restore puts it back under the same slug, where they are valid
  // again — so the one moment they can be wrong is HERE: a brand-new space taking a
  // slug that an older, deleted space used. Its first list of changes must be empty.
  // (Also cleans rows that deletions made before this fix left behind.)
  await query('DELETE FROM page_change_history WHERE space_slug = $1', [slug]).catch((error) => {
    // eslint-disable-next-line no-console
    console.error(`[changes] could not clear stale history for new space "${slug}":`, error);
  });
  // The same for assistant analytics: runs and unanswered reports remember the
  // space by slug, and space admins see only their spaces' slugs. A new space
  // taking an old slug must not inherit the old space's conversations — they stay
  // visible to instance admins, without a space.
  await query('UPDATE ai_runs SET space = NULL WHERE space = $1', [slug]).catch((error) => {
    // eslint-disable-next-line no-console
    console.error(`[assistant] could not detach old runs from new space "${slug}":`, error);
  });
  await query('UPDATE ai_unanswered_questions SET space = NULL WHERE space = $1', [slug]).catch((error) => {
    // eslint-disable-next-line no-console
    console.error(`[assistant] could not detach old reports from new space "${slug}":`, error);
  });
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
//
// Light footprint (isLightFootprintSpace): a space with a rootPath — the
// `docs/` of somebody's product repo — keeps the file INSIDE its content root
// as a dotfile, `<rootPath>/.<slug>.folio`, instead of adding a foreign file
// to the product's root (dotfiles are skipped by Docusaurus/MkDocs/Jekyll, by
// scanSpace and by fileAccess.ts). A legacy `<slug>.folio` that already sits
// at the repo root keeps being read and written where it is (no migration).
// A vault space (rootPath '' plus the light_footprint flag) gets the same
// dotfile, `.<slug>.folio` at the repository root, so Obsidian's file list and
// the vault owner's `git status` stay clean.
// folioMetaPath is the one place that decides; every reader goes through it.
// ---------------------------------------------------------------------------

const FOLIO_META_EXT = '.folio';

/** Where `slug`'s `.folio` lives in the repository at `repoDirAbs` with content root `rootPath` — see the section comment above. */
export async function resolveFolioMetaPath(repoDirAbs: string, slug: string, rootPath: string, lightFootprint = false): Promise<string> {
  const legacy = path.join(repoDirAbs, `${slug}${FOLIO_META_EXT}`);
  if ((!rootPath && !lightFootprint) || (await pathExists(legacy))) return legacy;
  return path.join(repoDirAbs, rootPath, `.${slug}${FOLIO_META_EXT}`);
}

/** The absolute path of this space's `.folio` metadata file (it may not exist yet). */
export function folioMetaPath(space: string): Promise<string> {
  return resolveFolioMetaPath(repoDir(space), space, rootPathCache.get(space) ?? '', lightFootprintCache.has(space));
}

/**
 * Sets `v` and `name` in the space's canonical `.folio` at `file`
 * (folioMetaPath), keeping every other key — the `export` section written by
 * export/spaceSettings.ts above all: a rename used to rewrite the file as
 * `{v, name}` and silently drop the space's PDF/DOCX header and footer.
 * A file that exists but is not a JSON object is left alone (same rule as
 * writeSpaceExportSettings: never be the thing that destroys it).
 * No-ops silently on a blank name. Fire-and-forget-safe by design: this only
 * touches the filesystem — getting it committed is the caller's job, either
 * by riding an already-planned explicit commit (createSpace/
 * createSpaceFromRepo) or by relying on the standard debounced auto-commit
 * (noteSpaceNameChange below), exactly like any other content edit.
 */
async function writeFolioMeta(file: string, name: string): Promise<void> {
  const trimmedName = name.trim();
  if (!trimmedName) return;
  let existing: Record<string, unknown> = {};
  const raw = await fs.readFile(file, 'utf8').catch(() => undefined);
  if (raw !== undefined) {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      value = undefined;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      // eslint-disable-next-line no-console
      console.warn(`[folio-meta] ${file} is not a JSON object; left unchanged`);
      return;
    }
    existing = value as Record<string, unknown>;
  }
  const body = `${JSON.stringify({ ...existing, v: 1, name: trimmedName }, null, 2)}\n`;
  if (body === raw) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, 'utf8');
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
  await writeFolioMeta(await folioMetaPath(space), trimmed).catch((err) => {
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
export async function createSpace(name: string, createdBy: string | null, opts: { starterTemplates?: boolean; language?: StarterLanguage } = {}): Promise<SpaceInfo> {
  const trimmed = name.trim();
  if (!trimmed) throw badRequest('space name is required');
  const slug = await uniqueSpaceSlug(trimmed);

  const dir = repoDir(slug);
  await fs.mkdir(dir, { recursive: true });
  await persistDocFrontmatter(path.join(dir, 'index.md'), { id: await newPageIdAt(slug, 'index.md') }, `# ${trimmed}\n`);
  if (opts.starterTemplates) {
    // Written before the initial commit, so they ride `init: create space`.
    const templatesDir = path.join(dir, TEMPLATES_DIR_NAME);
    await fs.mkdir(templatesDir, { recursive: true });
    for (const t of starterTemplates(opts.language)) {
      // The description rides as a key of its own (template-description), merged in next to Folio's.
      const described = `---\n${TEMPLATE_DESCRIPTION_KEY}: ${JSON.stringify(t.description)}\n---\n`;
      await persistDocFrontmatter(path.join(templatesDir, `${t.stem}.md`), { id: await newPageIdAt(slug, `${TEMPLATES_DIR_NAME}/${t.stem}.md`), icon: t.icon }, t.markdown, { raw: described });
    }
  }
  await writeFolioMeta(path.join(dir, `${slug}${FOLIO_META_EXT}`), trimmed); // rides the SAME initial commit as index.md, right below
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
  /** Light footprint (no ids in files) for a rootPath '' space. Undefined = on unless the repository was empty or already is a Folio space (a `<slug>.folio` at its root); a vault is always light by default. A non-empty rootPath is light whatever this says. */
  lightFootprint?: boolean;
  onProgress?: (progress: { phase?: 'cloning' | 'scanning' | 'finalizing'; percent?: number; processedFiles?: number; totalFiles?: number }) => void;
}): Promise<SpaceInfo & { vaultDetected?: boolean }> {
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

  let emptyRemote = false;
  try {
    // A brand-new instance repo (e.g. this instance's default content repo before
    // its first space) clones fine but has no branches at all — a --branch-scoped
    // clone fails outright against that. Detect it first via ls-remote (cheap,
    // version-independent) and bootstrap main + a root README instead of failing.
    emptyRemote = await git.isEmptyRemote(opts.repoUrl, askpassScript, slug);
    if (emptyRemote) {
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
      // Only reachable with a non-empty rootPath (the repo root always exists),
      // i.e. a light-footprint space: no id in the file, the scan gives it one.
      await persistDocFrontmatter(path.join(contentRoot, 'index.md'), {}, `# ${trimmed}\n`);
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

  // An Obsidian vault is recognised by its `.obsidian/` folder — at the content root, or at the repository root when the space is a folder inside it.
  const vaultDetected = (await isObsidianVault(contentRoot)) || (rootPath !== '' && (await isObsidianVault(dir)));
  // Light by default whenever the repository brings files Folio did not create: a vault, but just as well a
  // vault whose `.obsidian/` is gitignored, a plain notes repo or a GitHub Wiki — the scan below must not add
  // an `id` to any of them (the ids live in pages_index, see "Index-only page ids"). Native footprint stays
  // for a repository that was empty (Folio bootstraps it and creates every page) and for one that already is
  // a Folio space (a `<slug>.folio` at its root: its files carry Folio's ids already).
  const lightFootprint = opts.lightFootprint ?? (vaultDetected || (!emptyRemote && !(await holdsNativeFolioMeta(contentRoot))));

  opts.onProgress?.({ phase: 'finalizing', percent: 56 });
  await insertSpaceRow(slug, effectiveName, { repoUrl: opts.repoUrl, branch: opts.branch, rootPath, status: 'clean', createdBy: opts.createdBy, lightFootprint });
  try {
    const info = await finishSpaceFromRepo(slug, dir, effectiveName, opts, askpassScript);
    return vaultDetected ? { ...info, vaultDetected: true } : info;
  } catch (err) {
    // Anything that fails AFTER the row exists used to leave it behind: the
    // caller never reached setMembership, so the half-made space had no member
    // and was invisible to the person who tried to create it — and each retry
    // minted another one under `-2`, `-3` (exactly what prod showed, 15.09).
    // Undo the whole attempt instead: the row (pages_index/ydoc rows go with it
    // by ON DELETE CASCADE), the clone, the stored token.
    await query('DELETE FROM spaces WHERE slug = $1', [slug]).catch(() => {});
    forgetSpaceCaches(slug);
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
  await writeFolioMeta(await folioMetaPath(slug), effectiveName);
  // Best-effort: the space is already created and usable without this file ever reaching
  // the remote (unlike the rootPath-bootstrap commit above, which is fatal if it fails —
  // without THAT commit the space would have no content at all). A failure here just means
  // the next manual/periodic sync commits it on a later pass instead.
  await git.commitAndPushIfRemote(dir, opts.branch, `docs(${slug}): space metadata`, askpassScript, slug).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[folio-meta] failed to commit/push the .folio metadata of ${slug}:`, err);
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
): Promise<SpaceInfo & { vaultDetected?: boolean }> {
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
      // Informational only: connecting changes nothing about the footprint (a vault registered from data/repos is already light).
      return (await isObsidianVault(spaceDir(space))) ? { ...updated, vaultDetected: true } : updated;
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
  // A doc's front matter lives in the file only (never in the body or the CRDT): read once, for the title
  // fallback and for the page index.
  const frontmatter = entry.kind === 'doc' ? await readFrontmatterData(entry.absPath) : undefined;
  const title = extractH1(newBody) ?? validStringField(frontmatter?.title) ?? titleFallback(entry.relPath, entry.kind);
  const updatedAt = new Date().toISOString();
  await query(
    `UPDATE pages_index SET
       title = $2, updated_at = $3, plain_text = $4,
       tsv = setweight(to_tsvector('simple', unaccent($2)), 'A') || setweight(to_tsvector('simple', unaccent(coalesce($4, ''))), 'B')
     WHERE id = $1`,
    [entry.id, title, updatedAt, entry.kind === 'doc' ? docIndexText(newBody) : newBody],
  );
  entry.body = newBody;
  entry.title = title;
  entry.updatedAt = updatedAt;
  // Index v2: headings, blocks, tags and links of a document, its own links resolved (tables/forms carry none).
  if (entry.kind === 'doc') await pageIndex.reindexSavedPage({ id: entry.id, space: entry.space, relPath: entry.relPath }, newBody, frontmatter);
  return toPageMeta(entry);
}

/**
 * A doc file's front matter data — its `title:` is the title when the body has
 * no H1 (Hugo, Jest/Docusaurus and Jekyll keep the title there; indexDocFile
 * reads it the same way), and the whole block feeds the page index. Never
 * throws: an unreadable file or block just has none ({}).
 */
async function readFrontmatterData(abs: string): Promise<Record<string, unknown>> {
  try {
    return matter(await fs.readFile(abs, 'utf8')).data as Record<string, unknown>;
  } catch {
    return {};
  }
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
  return (await writeDocBodyIfChanged(id, markdown, overrideIcon, overrideCover)).meta;
}

/** Tail of the queue of file writers per document id (withDocFileLock). */
const docFileLocks = new Map<string, Promise<void>>();

/**
 * Runs `fn` while no other read-modify-write of the same document's FILE runs
 * in this process. A collab write-back (writeDocBodyIfChanged), an icon/cover
 * or order change (setDocIconCover, setDocOrder), a title rename
 * (renameDocDirect) and a properties save (rewriteDocFrontmatter) each read the
 * file, merge, and write it back: interleaved, the later write put back the
 * block — or the body — the earlier one had just replaced. Collab rooms and the
 * REST API live in the same process, so an in-process queue per page is the
 * whole guarantee (withSpaceLock is best effort and not re-entrant: a git sync
 * holding it flushes rooms). Not re-entrant either — never call one of the
 * functions above from inside another.
 */
export async function withDocFileLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const previous = docFileLocks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.then(() => mine);
  docFileLocks.set(id, tail);
  try {
    await previous;
    return await fn();
  } finally {
    release();
    if (docFileLocks.get(id) === tail) docFileLocks.delete(id);
  }
}

/**
 * The front matter block of a document, outside the collaborative body
 * (PUT /api/pages/:id/properties, server/properties.ts). Under
 * withDocFileLock: `rewrite` gets the file as it is on disk NOW and returns
 * the new file text, or null to write nothing (it may throw, e.g. a 409 —
 * nothing is written then). It changes only the block; the body bytes are
 * its business to keep.
 *
 * After a write the index row follows the file — Folio's keys (order, status,
 * icon, cover) by the same validation a scan applies, so a foreign
 * `status: deprecated` leaves the row without a status exactly as indexDocFile
 * would; the title (`title:` counts when the body has no H1); search text; the
 * page index (tags from `tags:`/`labels:`, `pages_index.frontmatter`). That row
 * is what the next collab write-back merges into the block it finds on disk
 * (writeDocBodyIfChanged), so an open room's flush keeps every key written
 * here: foreign keys are never touched by that merge, and Folio's keys come
 * back exactly as this left them. Not committed here: the caller nudges the
 * debounced auto-commit, like a page save.
 */
export async function rewriteDocFrontmatter(
  id: string,
  rewrite: (raw: string, entry: PageIndexEntry) => string | null | Promise<string | null>,
): Promise<{ entry: PageIndexEntry; written: boolean }> {
  return withDocFileLock(id, async () => {
    const entry = await requireEntry(id);
    if (entry.kind !== 'doc') throw badRequest('page is not a document');
    const raw = await fs.readFile(entry.absPath, 'utf8');
    const next = await rewrite(raw, entry);
    if (next === null || next === raw) return { entry, written: false };
    await writeFileAtomic(entry.absPath, next);
    // Options bypass gray-matter's per-input cache (and its half-parsed entry when YAML throws).
    const parsed = matter(next, {});
    const data = parsed.data as Record<string, unknown>;
    const order = numericOrder(data.order);
    const status = validStatus(data.status);
    const icon = validStringField(data.icon);
    const cover = validStringField(data.cover);
    await query('UPDATE pages_index SET sort_order = $2, status = $3, icon = $4, cover = $5 WHERE id = $1', [id, order ?? null, status ?? null, icon ?? null, cover ?? null]);
    entry.explicitOrder = order;
    entry.order = order ?? ORDER_SENTINEL;
    entry.explicitStatus = status;
    entry.status = status ?? 'published';
    entry.icon = icon;
    entry.cover = cover;
    await patchEntryContent(entry, parsed.content);
    return { entry, written: true };
  });
}

/**
 * rewriteDocFrontmatter's twin for a data table / form (15.10.2026, the
 * properties panel): `rewrite` gets the file as it is on disk NOW (under the
 * same per-page file lock writeTableDoc / writeFormDoc take, so a table save
 * and a properties save never interleave) and returns the new text, or null
 * to leave it. Only the page's own keys may change — the caller
 * (properties.ts) edits them with writeFrontmatterKeys, every reserved byte
 * kept. The page's index row is stamped; its properties are re-indexed by the caller.
 */
export async function rewriteTableFormFrontmatter(
  id: string,
  rewrite: (raw: string, entry: PageIndexEntry) => string | null | Promise<string | null>,
): Promise<{ entry: PageIndexEntry; written: boolean }> {
  return withDocFileLock(id, async () => {
    const entry = await requireEntry(id);
    if (entry.kind !== 'table' && entry.kind !== 'form') throw badRequest('page is not a data table or a form');
    const raw = await fs.readFile(entry.absPath, 'utf8');
    const next = await rewrite(raw, entry);
    if (next === null || next === raw) return { entry, written: false };
    await writeFileAtomic(entry.absPath, next);
    const updatedAt = new Date().toISOString();
    await query('UPDATE pages_index SET updated_at = $2 WHERE id = $1', [id, updatedAt]);
    entry.updatedAt = updatedAt;
    return { entry, written: true };
  });
}

/**
 * writeDocBody, telling whether the file was written. A body that is already
 * what the file says (line endings and the final newline aside) with no Folio
 * key to change writes nothing at all — and leaves the index row as it is.
 * That is every collab room closing on a page nobody edited: y-websocket
 * flushes the room's writer when its last tab leaves (collab.ts writeState),
 * and merely opening a page used to rewrite its file and commit it.
 */
export async function writeDocBodyIfChanged(
  id: string,
  markdown: string,
  overrideIcon?: string | null,
  overrideCover?: string | null,
): Promise<{ meta: PageMeta; written: boolean }> {
  // The entry is read INSIDE the lock: Folio's keys merged below are the row as the last writer of this file left it.
  return withDocFileLock(id, async () => {
    const entry = await requireEntry(id);
    if (entry.kind !== 'doc') throw badRequest('page is not a document');
    const icon = resolveIconCoverOverride(overrideIcon, entry.icon);
    const cover = resolveIconCoverOverride(overrideCover, entry.cover);
    const raw = await fs.readFile(entry.absPath, 'utf8').catch(() => undefined);
    const next = mergeFrontmatter(raw, { id: docFileId(entry.space, entry.id), order: entry.explicitOrder, status: entry.explicitStatus, icon, cover }, markdown);
    if (raw !== undefined && sameDocText(next, raw)) return { meta: toPageMeta(entry), written: false };
    await writeFileAtomic(entry.absPath, next);
    if (icon !== entry.icon || cover !== entry.cover) {
      await query('UPDATE pages_index SET icon = $2, cover = $3 WHERE id = $1', [id, icon ?? null, cover ?? null]);
      entry.icon = icon;
      entry.cover = cover;
    }
    return { meta: await patchEntryContent(entry, markdown), written: true };
  });
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
  await withDocFileLock(entry.id, async () => {
    // Order/status as the row says NOW (a properties save may have changed them since the caller read `entry`).
    const fresh = (await getEntry(entry.id)) ?? entry;
    if (icon === fresh.icon && cover === fresh.cover) return;
    await persistDocFrontmatter(fresh.absPath, { id: docFileId(fresh.space, fresh.id), order: fresh.explicitOrder, status: fresh.explicitStatus, icon, cover }, currentBody);
    await query('UPDATE pages_index SET icon = $2, cover = $3 WHERE id = $1', [entry.id, icon ?? null, cover ?? null]);
  });
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
  await withDocFileLock(entry.id, async () => {
    // Status/icon/cover as the row says NOW (see setDocIconCover).
    const fresh = (await getEntry(entry.id)) ?? entry;
    if (order === fresh.explicitOrder) return;
    await persistDocFrontmatter(fresh.absPath, { id: docFileId(fresh.space, fresh.id), order, status: fresh.explicitStatus, icon: fresh.icon, cover: fresh.cover }, currentBody);
    await query('UPDATE pages_index SET sort_order = $2 WHERE id = $1', [entry.id, order]);
  });
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
  await withDocFileLock(entry.id, async () => {
    const raw = await fs.readFile(entry.absPath, 'utf8');
    await fs.writeFile(entry.absPath, withTablePageFields(raw, order, entry.icon), 'utf8');
  });
  await query('UPDATE pages_index SET sort_order = $2 WHERE id = $1', [entry.id, order]);
  entry.order = order;
  entry.explicitOrder = order;
}

/** Persists a data-table page icon beside its schema without reserializing rows. */
export async function setTableIcon(entry: PageIndexEntry, icon: string | undefined): Promise<void> {
  if (entry.kind !== 'table') throw badRequest('page is not a data table');
  if (icon === entry.icon) return;
  await withDocFileLock(entry.id, async () => {
    const raw = await fs.readFile(entry.absPath, 'utf8');
    await fs.writeFile(entry.absPath, withTablePageFields(raw, entry.explicitOrder, icon), 'utf8');
  });
  await query('UPDATE pages_index SET icon = $2 WHERE id = $1', [entry.id, icon ?? null]);
  entry.icon = icon;
}

/** setTableOrder's FORM twin — a form's frontmatter is its own definition (shared/forms/codec.ts owns it), same "gray-matter on the leading block alone" trick withTablePageFields already does for a table's schema. */
export async function setFormOrder(entry: PageIndexEntry, order: number): Promise<void> {
  if (entry.kind !== 'form') throw badRequest('page is not a form');
  if (order === entry.explicitOrder) return;
  await withDocFileLock(entry.id, async () => {
    const raw = await fs.readFile(entry.absPath, 'utf8');
    await fs.writeFile(entry.absPath, withTablePageFields(raw, order, entry.icon), 'utf8');
  });
  await query('UPDATE pages_index SET sort_order = $2 WHERE id = $1', [entry.id, order]);
  entry.order = order;
  entry.explicitOrder = order;
}

/** setTableIcon's FORM twin. */
export async function setFormIcon(entry: PageIndexEntry, icon: string | undefined): Promise<void> {
  if (entry.kind !== 'form') throw badRequest('page is not a form');
  if (icon === entry.icon) return;
  await withDocFileLock(entry.id, async () => {
    const raw = await fs.readFile(entry.absPath, 'utf8');
    await fs.writeFile(entry.absPath, withTablePageFields(raw, entry.explicitOrder, icon), 'utf8');
  });
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
  // An artifact's order lives in the row too (its icon and title are in its manifest: setArtifactManifestFields).
  if (entry.kind !== 'pdf' && entry.kind !== 'office' && entry.kind !== 'canvas' && entry.kind !== 'base' && entry.kind !== 'artifact') throw badRequest('page is not a pdf/office file or a canvas or a base');
  if (order === entry.explicitOrder) return;
  await query('UPDATE pages_index SET sort_order = $2 WHERE id = $1', [entry.id, order]);
  entry.order = order;
  entry.explicitOrder = order;
}

/** setBinaryPageOrder's icon twin — same "index-only, not in git" trade-off. */
export async function setBinaryPageIcon(entry: PageIndexEntry, icon: string | undefined): Promise<void> {
  if (entry.kind !== 'pdf' && entry.kind !== 'office' && entry.kind !== 'canvas' && entry.kind !== 'base') throw badRequest('page is not a pdf/office file or a canvas or a base');
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
/** The whole `.table.md` text for `doc`: the codec's block, the page's `order`/`icon`, and its own properties carried from `prev` (the file as it is). */
export function composeTableFile(doc: TableDoc, entry: Pick<PageIndexEntry, 'explicitOrder' | 'icon'>, prev: string | undefined): string {
  return withTablePageFields(serializeTableFile(doc), entry.explicitOrder, entry.icon, prev);
}

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
  // Under the page's file lock: a properties save (rewriteTableFormFrontmatter) between the read and the write would be lost.
  await withDocFileLock(id, async () => {
    const prev = await fs.readFile(entry.absPath, 'utf8').catch(() => undefined);
    await fs.writeFile(entry.absPath, composeTableFile(doc, entry, prev), 'utf8');
  });

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
  const { entry, updated } = await withDocFileLock(id, async () => {
    const entry = await requireEntry(id);
    if (entry.kind !== 'doc') throw badRequest('page is not a document');
    const current = entry.body ?? (await readFreshDocBody(id));
    const updated = replaceFirstH1(current, title);
    await persistDocFrontmatter(entry.absPath, { id: docFileId(entry.space, entry.id), order: entry.explicitOrder, status: entry.explicitStatus, icon: entry.icon, cover: entry.cover }, updated);
    return { entry, updated };
  });
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
export async function writeFormDoc(
  id: string,
  doc: Omit<FormDoc, 'meta' | 'table'>,
  opts: {
    /** Runs under the file lock with the file as it is on disk now, before anything is written; throwing refuses the write (an etag check: forms/service.ts). */
    beforeWrite?: (currentRaw: string) => void;
  } = {},
): Promise<PageMeta> {
  const entry = await requireEntry(id);
  if (entry.kind !== 'form') throw badRequest('page is not a form');
  const next = await withDocFileLock(id, async () => {
    const prev = await fs.readFile(entry.absPath, 'utf8');
    opts.beforeWrite?.(prev);
    const current = parseFormFile(prev);
    if (isFormParseError(current)) throw badRequest(`form file is invalid: ${current.message}`);
    const merged: FormDoc = { ...doc, meta: current.meta, table: current.table };
    await fs.writeFile(entry.absPath, withTablePageFields(serializeFormFile(merged), entry.explicitOrder, entry.icon, prev), 'utf8');
    return merged;
  });

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
  await withDocFileLock(id, async () => {
    const prev = await fs.readFile(entry.absPath, 'utf8');
    const current = parseFormFile(prev);
    if (isFormParseError(current) || current.table === freshTableRelPath) return;
    const next: FormDoc = { ...current, table: freshTableRelPath };
    await fs.writeFile(entry.absPath, withTablePageFields(serializeFormFile(next), entry.explicitOrder, entry.icon, prev), 'utf8');
  });
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

  const tableStem = relPathStem(tableEntry.relPath, 'table');
  const formParentPath = tableEntry.dirPath ? `${tableEntry.dirPath}/${tableStem}` : tableStem;
  await fs.mkdir(path.join(spaceDir(tableEntry.space), formParentPath), { recursive: true });
  const relPath = await uniqueRelPath(tableEntry.space, formParentPath, translitSlug(tableEntry.title), '.form.md');
  const id = await newPageIdAt(tableEntry.space, relPath);
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

/** What a move produced — the rename result plus the directories that moved wholesale (for rebasing links into non-page files inside them) and the pages holding asset links into them. */
export interface PageMoveResult extends SlugRenameResult {
  movedDirs: Array<{ from: string; to: string }>;
  /** Ids of docs whose non-page links (images, files) point INTO a moved directory, captured before the move like `SlugRenameMove.backlinks`. May include moved docs themselves. */
  assetLinkSources: string[];
}

export async function movePage(id: string, toParentPathRaw: string): Promise<PageMeta> {
  return (await movePageTracked(id, toParentPathRaw)).meta;
}

/** movePage plus the bookkeeping collab.movePage needs to fix links (see PageMoveResult); `moved` is empty when the page is already at the destination. */
export async function movePageTracked(id: string, toParentPathRaw: string): Promise<PageMoveResult> {
  const entry = await requireEntry(id);
  if (entry.isIndex && entry.dirPath === '') throw badRequest('cannot move the space root');

  return withSpaceLock(entry.space, async () => {
    const toParentPath = normalizePageParentDir(toParentPathRaw);
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
    if (srcAbs === destAbs) return { meta: toPageMeta(entry), moved: [], movedDirs: [], assetLinkSources: [] };
    if (await pathExists(destAbs)) throw conflict('a page already exists at the destination');
    if (childDirDestAbs && (await pathExists(childDirDestAbs))) throw conflict('a page already exists at the destination');

    // Snapshot the pages that move along (an index page's whole directory, a
    // leaf page's children directory) and every page linking to any of them
    // BEFORE the rename/rescan — same ordering reason as renamePageSlug.
    const spaceAbs = spaceDir(space);
    const toRel = (abs: string) => path.relative(spaceAbs, abs).split(path.sep).join('/');
    const movedDir = entry.isIndex ? { from: entry.dirPath, to: toRel(destAbs) } : childDirSrcAbs && childDirDestAbs ? { from: toRel(childDirSrcAbs), to: toRel(childDirDestAbs) } : undefined;
    const descendantsBefore = movedDir
      ? (await listEntries(space)).filter((e) => e.id !== id && (e.dirPath === movedDir.from || e.dirPath.startsWith(`${movedDir.from}/`)))
      : [];
    const newPrimaryRelPath = toRel(entry.isIndex ? path.join(destAbs, path.basename(entry.absPath)) : destAbs);
    const moved: SlugRenameMove[] = [{ id, oldRelPath: entry.relPath, newRelPath: newPrimaryRelPath, backlinks: await links.getBacklinks(id) }];
    if (movedDir) {
      for (const desc of descendantsBefore) {
        moved.push({ id: desc.id, oldRelPath: desc.relPath, newRelPath: `${movedDir.to}${desc.relPath.slice(movedDir.from.length)}`, backlinks: await links.getBacklinks(desc.id) });
      }
    }
    const assetLinkSources = movedDir ? await links.getAssetLinkSources(space, movedDir.from) : [];

    await fs.mkdir(destDirAbs, { recursive: true });
    await claimIdsForMove(space, srcAbs, destAbs);
    if (childDirSrcAbs && childDirDestAbs) await claimIdsForMove(space, childDirSrcAbs, childDirDestAbs);
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
    await followSidecars(space, [
      [toRel(srcAbs), toRel(destAbs), entry.isIndex],
      ...(childDirSrcAbs && childDirDestAbs ? [[toRel(childDirSrcAbs), toRel(childDirDestAbs), true] as [string, string, boolean]] : []),
    ]);
    await scanSpace(space);
    return { meta: toPageMeta(await requireEntry(id)), moved, movedDirs: movedDir ? [movedDir] : [], assetLinkSources };
  });
}

/**
 * The property sidecars (propsSidecar.ts) follow pages that moved on disk:
 * `pairs` are [from, to, isDir] content-root-relative paths of what was
 * renamed (a page file, an index page's folder, a leaf page's children
 * folder). Runs inside the operation's space lock, before its rescan, so the
 * sidecars ride the same commit as the move. Never fails the move.
 */
async function followSidecars(space: string, pairs: Array<[string, string, boolean]>): Promise<void> {
  const root = spaceDir(space);
  for (const [from, to, dir] of pairs) {
    await propsSidecar.moveSidecars(root, from, to, dir).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[props] ${space}: could not move the property sidecars of ${from}:`, err);
    });
  }
}

/** `notes/board.excalidraw.svg` -> 'board', `notes/weekly.table.md` -> 'table', `notes/report.pdf` -> 'pdf', `notes/plan.docx` -> 'office', `notes/plan.md` -> 'doc'; a non-page file (asset, dotfile) -> undefined. Same suffix-priority rule as the scanSpace walk (`.table.md` before plain `.md`). */
function pageFileKind(name: string): PageKind | undefined {
  const lower = name.toLowerCase();
  if (lower.endsWith('.table.md')) return 'table';
  if (lower.endsWith('.form.md')) return 'form';
  if (lower.endsWith('.excalidraw.svg')) return 'board';
  if (lower.endsWith('.pdf')) return 'pdf';
  if (officeFormat(lower)) return 'office';
  if (lower.endsWith('.canvas')) return 'canvas';
  if (lower.endsWith('.base')) return 'base';
  if (lower.endsWith('.md') || lower.endsWith('.mdx')) return 'doc';
  return undefined;
}

/** True when both paths are one file (the same inode) — a case-only rename on a case-insensitive filesystem. */
async function isSameFile(a: string, b: string): Promise<boolean> {
  try {
    const [sa, sb] = await Promise.all([fs.stat(a), fs.stat(b)]);
    return sa.ino === sb.ino && sa.dev === sb.dev;
  } catch {
    return false;
  }
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
async function rewritePageFileId(space: string, abs: string, kind: PageKind, newId: string, opts: { keepOrder: boolean; overrideContent?: string }): Promise<void> {
  if (kind === 'doc') {
    const raw = opts.overrideContent ?? (await fs.readFile(abs, 'utf8'));
    const parsed = matter(raw);
    const order = opts.keepOrder ? numericOrder(parsed.data.order) : undefined;
    const status = validStatus(parsed.data.status);
    const icon = validStringField(parsed.data.icon);
    const cover = validStringField(parsed.data.cover);
    // Light footprint: the copy's id rides a claim, and an id the source file
    // carried is dropped from the copy (two files must never share one).
    const light = isLightFootprintSpace(space);
    if (light) claimPageId(abs, newId);
    await persistDocFrontmatter(abs, { id: light ? null : newId, order, status, icon, cover }, parsed.content);
  } else if (kind === 'table') {
    const raw = opts.overrideContent ?? (await fs.readFile(abs, 'utf8'));
    const parsedFm = matter(raw);
    const order = opts.keepOrder ? numericOrder(parsedFm.data.order) : undefined;
    const icon = validStringField(parsedFm.data.icon);
    const parsedTable = parseTableFile(raw);
    if (isTableParseError(parsedTable)) throw badRequest(`cannot copy an invalid data table: ${parsedTable.message}`);
    await fs.writeFile(
      abs,
      withTablePageFields(serializeTableFile({ ...parsedTable, meta: { ...parsedTable.meta, id: newId } }), order, icon, raw),
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
      withTablePageFields(serializeFormFile({ ...parsedForm, meta: { ...parsedForm.meta, id: newId } }), order, icon, raw),
      'utf8',
    );
  } else if (kind === 'pdf' || kind === 'office' || kind === 'canvas' || kind === 'base' || kind === 'artifact') {
    // Never rewritten (see "Binary page files"; a canvas is never written either; an artifact bundle carries no id):
    // the copied bytes stay as they are and the fresh id rides a claim the following scan picks up.
    claimPageId(abs, newId);
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
 *    its children folder, its subfolder. Since restrictions are inherited
 *    (stage 7) such children are hidden from the caller as well
 *    (`hiddenPageIds` holds them), and the folder cut keeps non-page files
 *    of the hidden subtree behind too;
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
 *    Restrictions are inherited (stage 7), so the same holds for the copy's
 *    ROOT when the page copied is restricted through an ancestor that does
 *    not travel with it and the copy does not land under that ancestor too:
 *    the root copy gets its own row (owner = the maker), and everything
 *    copied below it inherits that. A copy out of a restricted subtree never
 *    lands open; a duplicate next to the original stays under the same
 *    parents and gets no extra row.
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
async function restrictCopies(
  sourceEntries: PageIndexEntry[],
  copied: Array<{ sourceAbs: string; copyId: string }>,
  actorId: string,
  root: { sourceId: string; copyId: string },
): Promise<void> {
  // Restricted through an ancestor the copy is not under (a duplicate next to the original keeps its parents and
  // needs nothing): the copy's root takes the restriction along (see CopyScope).
  await query(
    `INSERT INTO page_access (page_id, owner_id)
     SELECT c.id, $2::uuid FROM pages_index c
      WHERE c.id = $1
        AND EXISTS (SELECT 1 FROM (${restrictionChainSql('$3')}) r
                     WHERE r.page_id <> $3 AND r.page_id NOT IN (SELECT k.page_id FROM (${restrictionChainSql('$1')}) k))
     ON CONFLICT (page_id) DO NOTHING`,
    [root.copyId, actorId, root.sourceId],
  );
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
/** The property sidecars of the pages a subtree copy took (`copied`), copied next to the copies. */
async function copySubtreeSidecars(fromSpace: string, srcDirAbs: string, toSpace: string, destDirAbs: string, copied: CopiedSubtree['copied']): Promise<void> {
  const fromRoot = spaceDir(fromSpace);
  const toRoot = spaceDir(toSpace);
  const rel = (root: string, abs: string) => path.relative(root, abs).split(path.sep).join('/');
  for (const item of copied) {
    if (!pageFileKind(path.basename(item.sourceAbs)) || !propsSidecar.usesSidecar(pageFileKind(path.basename(item.sourceAbs))!)) continue;
    const inside = path.relative(srcDirAbs, item.sourceAbs);
    await propsSidecar.copySidecar(fromRoot, rel(fromRoot, item.sourceAbs), toRoot, rel(toRoot, path.join(destDirAbs, inside)));
  }
}

async function copySubtreeAssigningFreshIds(
  toSpace: string,
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
      if (item.isDirectory() && isArtifactDirName(item.name)) {
        // An artifact bundle is ONE page: a fresh id by claim, nothing inside it is a page.
        const newId = ulid();
        copied.push({ sourceAbs: path.join(srcDirAbs, path.relative(destDirAbs, abs)), copyId: newId });
        claimPageId(abs, newId);
        continue;
      }
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
      await rewritePageFileId(toSpace, abs, kind, newId, { keepOrder: !isRootFile, overrideContent: isRootFile ? rootOverrideContent : undefined });
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
  return (await copyPageInternal(id, toSpace, toParentPathRaw, liveContent, includeChildren, scope)).meta;
}

/** copyPage, also saying which ids it gave out (the root's and every page of the subtree), and taking the name the copy's file/directory is built from (`stemTitle`, default: the source's title). */
async function copyPageInternal(
  id: string,
  toSpace: string,
  toParentPathRaw: string,
  liveContent?: string,
  includeChildren = true,
  scope?: CopyScope,
  stemTitle?: string,
): Promise<{ meta: PageMeta; copiedIds: string[] }> {
  const source = await requireEntry(id);
  // The routes have refused a page the caller cannot open before they get here; this keeps the rule true for any other caller.
  if (scope?.hiddenPageIds.has(source.id)) throw forbidden('this page is not available to you');
  if (!(await spaceExists(toSpace))) throw notFound('space');
  const sourceEntries = scope ? await listEntries(source.space) : [];

  return withSpaceLock(toSpace, async () => {
    const toParentPath = normalizePageParentDir(toParentPathRaw);
    const destParentDirAbs = path.join(spaceDir(toSpace), toParentPath);
    await fs.mkdir(destParentDirAbs, { recursive: true });

    // Directory-index page + includeChildren: copy the WHOLE directory as a
    // freshly-named subtree, index.md included (with liveContent, if given).
    if (source.isIndex && includeChildren) {
      const srcDirAbs = path.dirname(source.absPath);
      guardNoSelfNesting(srcDirAbs, destParentDirAbs);

      const stem = translitSlug(stemTitle && source.kind !== 'pdf' && source.kind !== 'office' ? stemTitle : copyStemFor(source));
      const uniqueDirRel = await uniqueRelPath(toSpace, toParentPath, stem, '');
      const destDirAbs = path.join(spaceDir(toSpace), uniqueDirRel);

      const { rootId: copiedId, copied } = await copySubtreeAssigningFreshIds(
        toSpace,
        srcDirAbs,
        destDirAbs,
        copyFilter(source.space, srcDirAbs, sourceEntries, scope),
        source.absPath,
        liveContent,
      );
      await copySubtreeSidecars(source.space, srcDirAbs, toSpace, destDirAbs, copied);
      await scanPathsOrAll(toSpace, { dirs: [uniqueDirRel] }, copiedId);
      if (scope) await restrictCopies(sourceEntries, copied, scope.actorId, { sourceId: source.id, copyId: copiedId });
      return { meta: toPageMeta(await requireEntry(copiedId)), copiedIds: copied.map((c) => c.copyId) };
    }

    // Single-file copy (previous behavior, unchanged for includeChildren=false
    // and for any source that isn't a directory-index page).
    const copiedId = ulid();
    const copied: CopiedSubtree['copied'] = [{ sourceAbs: source.absPath, copyId: copiedId }];
    const stem = translitSlug(stemTitle && source.kind !== 'pdf' && source.kind !== 'office' ? stemTitle : copyStemFor(source));
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
                : source.kind === 'canvas'
                  ? '.canvas'
                : source.kind === 'base'
                  ? '.base'
                : source.kind === 'artifact'
                  ? ARTIFACT_DIR_SUFFIX
                  : docExtOf(source.relPath) || '.md'; // a copy of an `.mdx` page is an `.mdx` page
    const relPath = await uniqueRelPath(toSpace, toParentPath, stem, ext);
    const destAbs = path.join(spaceDir(toSpace), relPath);

    if (source.kind === 'doc') {
      const body = liveContent ?? (await readFreshDocBody(id));
      // Merged into the SOURCE file's block, so another tool's keys travel with the copy.
      const sourceRaw = await fs.readFile(source.absPath, 'utf8').catch(() => undefined);
      const light = isLightFootprintSpace(toSpace);
      if (light) claimPageId(destAbs, copiedId);
      await persistDocFrontmatter(
        destAbs,
        { id: light ? null : copiedId, status: source.explicitStatus, icon: source.icon, cover: source.cover },
        body,
        { raw: sourceRaw },
      );
    } else if (source.kind === 'table') {
      const raw = liveContent ?? (await fs.readFile(source.absPath, 'utf8'));
      const parsed = parseTableFile(raw);
      if (isTableParseError(parsed)) throw badRequest(`cannot copy an invalid data table: ${parsed.message}`);
      await fs.writeFile(
        destAbs,
        withTablePageFields(serializeTableFile({ ...parsed, meta: { ...parsed.meta, id: copiedId } }), undefined, source.icon, raw),
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
        withTablePageFields(serializeFormFile({ ...parsed, meta: { ...parsed.meta, id: copiedId } }), undefined, source.icon, raw),
        'utf8',
      );
    } else if (source.kind === 'pdf' || source.kind === 'office' || source.kind === 'canvas' || source.kind === 'base') {
      // Bytes copied as they are (see "Binary page files"; a canvas is never written either); the fresh id rides a claim the scan below picks up.
      claimPageId(destAbs, copiedId);
      await fs.copyFile(source.absPath, destAbs);
    } else if (source.kind === 'artifact') {
      // The whole bundle folder, as it is (no symlinks, no dot entries); the id rides a claim like a pdf's.
      claimPageId(destAbs, copiedId);
      await fs.cp(source.absPath, destAbs, { recursive: true, filter: bundleCopyFilter(source.absPath) });
    } else {
      const raw = await fs.readFile(source.absPath, 'utf8');
      await fs.writeFile(destAbs, withBoardHeader(raw, copiedId, undefined, source.title, source.icon), 'utf8');
    }

    // A board's / file's properties (its sidecar) travel with the copy.
    if (propsSidecar.usesSidecar(source.kind)) await propsSidecar.copySidecar(spaceDir(source.space), source.relPath, spaceDir(toSpace), relPath);

    // Leaf page + includeChildren: bring the sibling `X/` children directory
    // along too, if the source has one — same fresh-id sweep, order kept.
    let copiedChildDirRel: string | undefined;
    if (includeChildren && !source.isIndex) {
      const childStem = relPathStem(source.relPath, source.kind);
      const childSrcDirAbs = path.join(path.dirname(source.absPath), childStem);
      if (await isDirectory(childSrcDirAbs)) {
        guardNoSelfNesting(childSrcDirAbs, destParentDirAbs);
        const destStem = relPathStem(relPath, source.kind);
        const destChildDirAbs = path.join(path.dirname(destAbs), destStem);
        const swept = await copySubtreeAssigningFreshIds(toSpace, childSrcDirAbs, destChildDirAbs, copyFilter(source.space, childSrcDirAbs, sourceEntries, scope));
        await copySubtreeSidecars(source.space, childSrcDirAbs, toSpace, destChildDirAbs, swept.copied);
        copied.push(...swept.copied);
        copiedChildDirRel = path.relative(spaceDir(toSpace), destChildDirAbs).split(path.sep).join('/');
      }
    }

    await scanPathsOrAll(toSpace, { files: [relPath], dirs: copiedChildDirRel ? [copiedChildDirRel] : [] }, copiedId);
    if (scope) await restrictCopies(sourceEntries, copied, scope.actorId, { sourceId: source.id, copyId: copiedId });
    return { meta: toPageMeta(await requireEntry(copiedId)), copiedIds: copied.map((c) => c.copyId) };
  });
}

/** scanPaths for a write that created the page `expectId`; when the scoped pass left it out of the index, the whole space is scanned after all. */
async function scanPathsOrAll(space: string, scope: ScanScope, expectId: string): Promise<void> {
  await scanPaths(space, scope);
  if (!(await getEntry(expectId))) await scanSpace(space);
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
  return retitleCopy(copied, title);
}

/** Gives a fresh copy's root page the title `title` (when it has one and differs); a file page (pdf/office/canvas/base) is named by its file. */
async function retitleCopy(copied: PageMeta, title?: string): Promise<PageMeta> {
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

/**
 * "New page from a template": the template (any kind, its subpages along)
 * copied under `parentPath`, then {{date}}/{{author}}/{{title}} filled in
 * every copied document. {{title}} is the new root's title — `title`, or the
 * template's own. The copy's file name is built from that title too. The copies
 * have no live editing room yet, so their files are rewritten directly.
 */
export async function createFromTemplate(
  templateId: string,
  space: string,
  parentPath: string,
  opts: { title?: string; author: string; liveContent?: string; scope?: CopyScope },
): Promise<PageMeta> {
  const template = await requireEntry(templateId);
  if (template.space !== space || !isUnderTemplates(template.relPath)) throw badRequest('not a template of this space');
  if (isUnderTemplates(normalizeDirParam(parentPath))) throw badRequest('a page cannot be created inside the templates folder');
  const finalTitle = opts.title?.trim() || template.title;
  const { meta, copiedIds } = await copyPageInternal(templateId, space, parentPath, opts.liveContent, true, opts.scope, finalTitle);

  const vars = { date: todayDateStamp(), author: opts.author, title: finalTitle };
  for (const copyId of copiedIds) {
    const entry = await getEntry(copyId);
    if (!entry || entry.kind !== 'doc') continue;
    const body = await readFreshDocBody(copyId);
    const filled = substituteTemplate(body, vars);
    if (filled === body) continue;
    await withDocFileLock(copyId, async () => {
      await persistDocFrontmatter(entry.absPath, { id: docFileId(entry.space, entry.id), order: entry.explicitOrder, status: entry.explicitStatus, icon: entry.icon, cover: entry.cover }, filled);
    });
    await patchEntryContent(entry, filled);
  }
  return retitleCopy(toPageMeta(await requireEntry(meta.id)), finalTitle);
}

/**
 * "Use as template": the page copied into the space's `_templates/` folder,
 * keeping its title (and, with `includeChildren`, its subpages). The space's
 * root page cannot be one, and a template is not made a template twice.
 */
export async function makeTemplate(id: string, opts: { includeChildren?: boolean; liveContent?: string; scope?: CopyScope; title?: string } = {}): Promise<PageMeta> {
  const source = await requireEntry(id);
  if (isUnderTemplates(source.relPath)) throw badRequest('this page is already a template');
  if (source.isIndex && source.dirPath === '') throw badRequest('the space root cannot be a template');
  const title = opts.title?.trim() || undefined;
  const { meta } = await copyPageInternal(id, source.space, TEMPLATES_DIR_NAME, opts.liveContent, opts.includeChildren ?? true, opts.scope, title);
  return retitleCopy(meta, title);
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
   * point the link resolution (indexV2) can no longer resolve the OLD path and would
   * mark that link 'unresolved' before anyone gets a chance to read it as
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

/**
 * Kinds whose title IS the file name, as in Obsidian (owner, 16.10.2026): an
 * Obsidian canvas / base is renamed to any valid file name ("My tasks", non-Latin letters too), not
 * to a lowercase-ASCII slug. The extension stays.
 */
export function isFreeNameKind(kind: PageKind): boolean {
  return kind === 'canvas' || kind === 'base';
}

/** What no file name may hold (Obsidian's own rule for a file name) plus control characters. */
const FILE_NAME_FORBIDDEN_RE = /[/\\:*?"<>|\u0000-\u001f\u007f]/;
/** The longest name (bytes, extension excluded) accepted — most filesystems stop at 255 for the whole name. */
export const FILE_NAME_MAX_BYTES = 200;

/**
 * The file stem a canvas / base is renamed to: Unicode and spaces kept (NFC),
 * trimmed, the extension it already has dropped when typed. Refused (400) when
 * empty, starting with a dot, ending with a dot, holding `/ \ : * ? " < > |` or
 * a control character, or too long.
 */
export function normalizeFreeFileName(raw: string, ext: string): string {
  let stem = raw.normalize('NFC').trim();
  if (stem.toLowerCase().endsWith(ext.toLowerCase())) stem = stem.slice(0, -ext.length).trim();
  if (!stem) throw badRequest('the name must not be empty');
  if (stem.startsWith('.')) throw badRequest('the name must not start with a dot');
  if (stem.endsWith('.')) throw badRequest('the name must not end with a dot');
  if (FILE_NAME_FORBIDDEN_RE.test(stem)) throw badRequest('the name must not contain / \\ : * ? " < > | or control characters');
  if (Buffer.byteLength(stem, 'utf8') > FILE_NAME_MAX_BYTES) throw badRequest(`the name is too long (at most ${FILE_NAME_MAX_BYTES} bytes)`);
  return stem;
}

export async function renamePageSlug(id: string, rawSlug: string): Promise<SlugRenameResult> {
  const entry = await requireEntry(id);
  const free = isFreeNameKind(entry.kind);
  const slug = free ? normalizeFreeFileName(rawSlug, entry.kind === 'canvas' ? '.canvas' : '.base') : validateSlug(rawSlug);
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
                  : entry.kind === 'canvas'
                  ? '.canvas'
                  : entry.kind === 'base'
                    ? '.base'
                    : entry.kind === 'artifact'
                      ? ARTIFACT_DIR_SUFFIX
                      : docExtOf(entry.relPath) || '.md'; // a renamed `.mdx` page stays `.mdx`
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
    // A change of letter case only ("tasks" -> "Tasks") on a case-insensitive filesystem: the destination IS the source.
    const sameFile = srcAbs.toLowerCase() === destAbs.toLowerCase() && (await isSameFile(srcAbs, destAbs));
    if (!sameFile && (await pathExists(destAbs))) {
      throw conflict(free ? `a file named "${path.basename(destAbs)}" already exists in this folder` : 'a page already exists with this slug at this location');
    }
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
    await claimIdsForMove(space, srcAbs, destAbs);
    if (childDirSrcAbs && childDirDestAbs) await claimIdsForMove(space, childDirSrcAbs, childDirDestAbs);
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
    {
      const spaceAbs = spaceDir(space);
      const rel = (abs: string) => path.relative(spaceAbs, abs).split(path.sep).join('/');
      await followSidecars(space, [
        [rel(srcAbs), rel(destAbs), entry.isIndex],
        ...(childDirSrcAbs && childDirDestAbs ? [[rel(childDirSrcAbs), rel(childDirDestAbs), true] as [string, string, boolean]] : []),
      ]);
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
  /** Grants to groups (migration 053); absent in records made before it. */
  groupGrants?: Array<{ groupId: string; role: 'viewer' | 'editor' }>;
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
  /**
   * Stage 7 (inherited restrictions): set on the entry that records what the
   * deleted ROOT page inherited from restricted ancestors that stay behind —
   * their ids, and as owner/grants the intersection of their rules
   * (intersectAccessRules). A restore applies it only when the page does not
   * land under all of those ancestors again (trash/access.ts).
   */
  inheritedFrom?: string[];
}

/**
 * One rule that lets in nobody the given `levels` (rules that all apply at
 * once) would not: a person keeps a grant only when every level lets them in
 * by name (as its owner or with a grant), a group only when every level has a
 * grant for it, each with the LOWEST role. The owner is the first level owner,
 * from the last level back (the nearest), who every level lets in by name;
 * when there is none, the nearest level's owner (a rule needs one).
 */
export function intersectAccessRules(levels: readonly PageAccessRule[]): PageAccessRule {
  const rank = (role: 'viewer' | 'editor') => (role === 'editor' ? 1 : 0);
  const userRole = (rule: PageAccessRule, userId: string): 'viewer' | 'editor' | undefined =>
    rule.ownerId === userId ? 'editor' : rule.grants.find((grant) => grant.userId === userId)?.role;
  const lowest = (roles: Array<'viewer' | 'editor' | undefined>): 'viewer' | 'editor' | undefined =>
    roles.some((role) => role === undefined) ? undefined : roles.reduce((a, b) => (rank(b!) < rank(a!) ? b : a));
  const people = new Set(levels.flatMap((rule) => [rule.ownerId, ...rule.grants.map((grant) => grant.userId)]));
  const passing = new Map<string, 'viewer' | 'editor'>();
  for (const userId of people) {
    const role = lowest(levels.map((rule) => userRole(rule, userId)));
    if (role) passing.set(userId, role);
  }
  const ownerId = [...levels].reverse().map((rule) => rule.ownerId).find((id) => passing.has(id)) ?? levels[levels.length - 1].ownerId;
  const groups = new Set(levels.flatMap((rule) => (rule.groupGrants ?? []).map((grant) => grant.groupId)));
  const groupGrants: NonNullable<PageAccessRule['groupGrants']> = [];
  for (const groupId of groups) {
    const role = lowest(levels.map((rule) => rule.groupGrants?.find((grant) => grant.groupId === groupId)?.role));
    if (role) groupGrants.push({ groupId, role });
  }
  return {
    ownerId,
    grants: [...passing].filter(([userId]) => userId !== ownerId).map(([userId, role]) => ({ userId, role })),
    ...(groupGrants.length > 0 ? { groupGrants } : {}),
  };
}

/** trash_items.payload of every kind but 'space'; absent `access` = nothing in the item was restricted, or the item is older than this record. */
export interface TrashPagePayload {
  v: 1;
  access?: TrashAccessEntry[];
  /** Light-footprint spaces: the pages the item took along whose id lives only in pages_index (see "Index-only page ids") — claimed back at their restored paths. */
  ids?: TrashIdEntry[];
  /** The property sidecars (propsSidecar.ts) of the boards / files the item took along: page path at deletion time + the file's text — written back at the restored paths. */
  props?: Array<{ path: string; content: string }>;
}

/** One page of a trash item whose id is not stored in its file, with its space-relative path at deletion time. */
export interface TrashIdEntry {
  pageId: string;
  relPath: string;
}

/** trash_items.payload for kind='space' — everything the `DELETE FROM spaces` cascade destroys that files alone can't bring back. Read back by server/trash/service.ts's space restore. */
export interface TrashSpaceSnapshot extends TrashPagePayload {
  name: string;
  repoUrl: string | null;
  branch: string;
  rootPath: string;
  visibility: string;
  assetMode: string;
  /** Migration 041; absent in snapshots taken before it. */
  scanIgnore?: string[];
  lightFootprint?: boolean;
  /** Public-site publish settings (migration 038; indexing/primaryHost: migration 040); absent in snapshots taken before it. */
  publicSettings?: {
    subdomain: string | null;
    domain: string | null;
    allowDownload: boolean;
    allowAssistant: boolean;
    indexing?: boolean;
    primaryHost?: string;
  };
  members: Array<{ userId: string; role: string }>;
  /** Roles of groups in the space (migration 053); absent in snapshots taken before it. */
  groupRoles?: Array<{ groupId: string; role: string }>;
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
  for (const grant of rule.groupGrants ?? []) {
    await client.query('INSERT INTO page_access_grants (page_id, group_id, role) VALUES ($1, $2, $3) ON CONFLICT (page_id, group_id) DO NOTHING', [
      pageId,
      grant.groupId,
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
  const rows = await query<{
    id: string;
    path: string;
    owner_id: string;
    grants: Array<{ userId: string; role: 'viewer' | 'editor' }>;
    group_grants: Array<{ groupId: string; role: 'viewer' | 'editor' }>;
  }>(
    `SELECT p.id, p.path, a.owner_id,
            COALESCE((SELECT json_agg(json_build_object('userId', g.user_id, 'role', g.role) ORDER BY g.user_id)
                        FROM page_access_grants g WHERE g.page_id = a.page_id AND g.user_id IS NOT NULL), '[]'::json) AS grants,
            COALESCE((SELECT json_agg(json_build_object('groupId', g.group_id, 'role', g.role) ORDER BY g.group_id)
                        FROM page_access_grants g WHERE g.page_id = a.page_id AND g.group_id IS NOT NULL), '[]'::json) AS group_grants
       FROM page_access a
       JOIN pages_index p ON p.id = a.page_id
      WHERE p.space_slug = $1
        AND ($2::boolean OR p.id = $3 OR ($4::text IS NOT NULL AND substr(p.path, 1, length($4)) = $4))
      ORDER BY p.path`,
    [space, scope.all, scope.pageId ?? null, scope.dirPrefix ?? null],
  );
  const entries: TrashAccessEntry[] = rows.map((row) => ({
    pageId: row.id,
    relPath: row.path,
    ownerId: row.owner_id,
    grants: row.grants,
    ...(row.group_grants.length > 0 ? { groupGrants: row.group_grants } : {}),
  }));
  if (!scope.all && scope.pageId) {
    // What the deleted page inherits from restricted ancestors that are not deleted with it (stage 7).
    const ancestors = await query<{
      page_id: string;
      owner_id: string;
      grants: Array<{ userId: string; role: 'viewer' | 'editor' }>;
      group_grants: Array<{ groupId: string; role: 'viewer' | 'editor' }>;
    }>(
      `SELECT c.page_id, c.owner_id,
              COALESCE((SELECT json_agg(json_build_object('userId', g.user_id, 'role', g.role) ORDER BY g.user_id)
                          FROM page_access_grants g WHERE g.page_id = c.page_id AND g.user_id IS NOT NULL), '[]'::json) AS grants,
              COALESCE((SELECT json_agg(json_build_object('groupId', g.group_id, 'role', g.role) ORDER BY g.group_id)
                          FROM page_access_grants g WHERE g.page_id = c.page_id AND g.group_id IS NOT NULL), '[]'::json) AS group_grants
         FROM (${restrictionChainSql('$1')}) c
        WHERE c.page_id <> $1
        ORDER BY length(c.path), c.path`,
      [scope.pageId],
    );
    const root = await getEntry(scope.pageId);
    if (ancestors.length > 0 && root) {
      const levels: PageAccessRule[] = ancestors.map((row) => ({
        ownerId: row.owner_id,
        grants: row.grants,
        ...(row.group_grants.length > 0 ? { groupGrants: row.group_grants } : {}),
      }));
      entries.push({ pageId: root.id, relPath: root.relPath, ...intersectAccessRules(levels), inheritedFrom: ancestors.map((row) => row.page_id) });
    }
  }
  return entries;
}

interface TrashRecord {
  spaceSlug: string;
  pageId: string;
  kind: 'doc' | 'board' | 'table' | 'pdf' | 'office' | 'form' | 'canvas' | 'base' | 'artifact' | 'folder' | 'space';
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

/**
 * Light footprint: the doc/pdf/office pages a deletion takes away, with their
 * paths — their ids are not in the files, so the restore claims them back
 * (snapshotted, like access, before the rescan drops the rows). Other spaces:
 * nothing (a doc carries its id; pdf/office keep their single-page claim).
 */
async function snapshotIndexOnlyIds(space: string, scope: { all: boolean; pageId?: string; dirPrefix?: string }): Promise<TrashIdEntry[]> {
  if (!isLightFootprintSpace(space)) return [];
  const rows = await query<{ id: string; path: string }>(
    `SELECT id, path FROM pages_index
      WHERE space_slug = $1 AND kind IN ('doc', 'pdf', 'office', 'canvas', 'base', 'artifact')
        AND ($2::boolean OR id = $3 OR ($4::text IS NOT NULL AND substr(path, 1, length($4)) = $4))
      ORDER BY path`,
    [space, scope.all, scope.pageId ?? null, scope.dirPrefix ?? null],
  );
  return rows.map((row) => ({ pageId: row.id, relPath: row.path }));
}

async function buildSpaceSnapshot(space: string): Promise<TrashSpaceSnapshot | null> {
  const row = await queryOne<{
    name: string;
    repo_url: string | null;
    branch: string;
    root_path: string;
    visibility: string;
    asset_mode: string;
    scan_ignore: string[] | null;
    light_footprint: boolean;
    public_subdomain: string | null;
    public_domain: string | null;
    public_allow_download: boolean;
    public_allow_assistant: boolean;
    public_indexing: boolean;
    public_primary_host: string;
  }>(
    'SELECT name, repo_url, branch, root_path, visibility, asset_mode, scan_ignore, light_footprint, public_subdomain, public_domain, public_allow_download, public_allow_assistant, public_indexing, public_primary_host FROM spaces WHERE slug = $1',
    [space],
  );
  if (!row) return null;
  const members = await query<{ user_id: string; role: string }>('SELECT user_id, role FROM space_members WHERE space_slug = $1', [space]);
  const groupRoles = await query<{ group_id: string; role: string }>('SELECT group_id, role FROM space_group_roles WHERE space_slug = $1', [space]);
  // The `DELETE FROM spaces` below cascades to pages_index and, through it, to every page-access rule of the space.
  const access = await snapshotPageAccess(space, { all: true });
  const ids = await snapshotIndexOnlyIds(space, { all: true });
  return {
    v: 1,
    ...(access.length > 0 ? { access } : {}),
    ...(ids.length > 0 ? { ids } : {}),
    name: row.name,
    repoUrl: row.repo_url,
    branch: row.branch,
    rootPath: row.root_path ?? '',
    visibility: row.visibility ?? 'private',
    assetMode: row.asset_mode ?? 'store',
    scanIgnore: row.scan_ignore ?? [],
    lightFootprint: row.light_footprint === true,
    publicSettings: {
      subdomain: row.public_subdomain,
      domain: row.public_domain,
      allowDownload: row.public_allow_download,
      allowAssistant: row.public_allow_assistant,
      indexing: row.public_indexing,
      primaryHost: row.public_primary_host,
    },
    members: members.map((m) => ({ userId: m.user_id, role: m.role })),
    ...(groupRoles.length > 0 ? { groupRoles: groupRoles.map((r) => ({ groupId: r.group_id, role: r.role })) } : {}),
  };
}

/** The trash payload of a deleted page (or folder): the access rules of the restricted pages it takes along, and (light footprint) the ids its files do not carry; null when there is neither. */
async function pagePayload(space: string, pageId: string, dirPrefix: string | undefined): Promise<TrashPagePayload | null> {
  const access = await snapshotPageAccess(space, { all: false, pageId, dirPrefix });
  const ids = await snapshotIndexOnlyIds(space, { all: false, pageId, dirPrefix });
  if (access.length === 0 && ids.length === 0) return null;
  return { v: 1, ...(access.length > 0 ? { access } : {}), ...(ids.length > 0 ? { ids } : {}) };
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

    // The property sidecars of what went to the trash: removed from `.folio/` (the same commit as the deletion)
    // and kept in the trash item, so a restore brings them back.
    if (!isSpaceDelete) {
      const root = spaceDir(space);
      const removed = [
        ...(await propsSidecar.removeSidecars(root, relFromSpace, entry.isIndex).catch(() => [])),
        ...(childDirRelPath ? await propsSidecar.removeSidecars(root, childDirRelPath, true).catch(() => []) : []),
      ];
      if (removed.length > 0) record.payload = { ...((record.payload as TrashPagePayload | null) ?? { v: 1 }), props: removed };
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
      forgetSpaceCaches(space);
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
    forgetSpaceCaches(space);
  });
}

export async function resolve(space: string, rawPath: string): Promise<PageMeta> {
  if (!(await spaceExists(space))) throw notFound('space');
  const normalized = normalizeResolvePath(rawPath);
  const found = await resolveNormalized(space, normalized);
  if (found) return found;
  // Tolerant fallbacks for links written for a git host or a site generator
  // (docs-as-code test, 14.10.2026): a percent-encoded path
  // (`Getting%20Started.md`, what `<Getting Started.md>` renders to) and a
  // link without the extension (`getting-started`).
  for (const candidate of links.tolerantLinkPaths(normalized)) {
    const hit = await resolveNormalized(space, candidate);
    if (hit) return hit;
  }
  throw notFound('page');
}

async function resolveNormalized(space: string, normalized: string): Promise<PageMeta | undefined> {
  const direct = await queryOne<PagesIndexRow>('SELECT * FROM pages_index WHERE space_slug = $1 AND path = $2', [space, normalized]);
  if (direct) return toPageMeta(rowToEntry(direct));
  const indexPath = normalized ? `${normalized}/index.md` : 'index.md';
  const asIndex = await queryOne<PagesIndexRow>('SELECT * FROM pages_index WHERE space_slug = $1 AND path = $2', [space, indexPath]);
  if (asIndex) return toPageMeta(rowToEntry(asIndex));
  const mdxIndexPath = normalized ? `${normalized}/index.mdx` : 'index.mdx';
  const asMdxIndex = await queryOne<PagesIndexRow>('SELECT * FROM pages_index WHERE space_slug = $1 AND path = $2', [space, mdxIndexPath]);
  if (asMdxIndex) return toPageMeta(rowToEntry(asMdxIndex));
  const readmePath = normalized ? `${normalized}/README.md` : 'README.md';
  const asReadme = await queryOne<PagesIndexRow>('SELECT * FROM pages_index WHERE space_slug = $1 AND path = $2', [space, readmePath]);
  if (asReadme) return toPageMeta(rowToEntry(asReadme));
  const mdxReadmePath = normalized ? `${normalized}/README.mdx` : 'README.mdx';
  const asMdxReadme = await queryOne<PagesIndexRow>('SELECT * FROM pages_index WHERE space_slug = $1 AND path = $2', [space, mdxReadmePath]);
  if (asMdxReadme) return toPageMeta(rowToEntry(asMdxReadme));
  // Same-named page parent: `X.md` + `X/`. getTree/getSubtree represent the
  // directory as X.md's children, so resolving the ancestor directory `X`
  // must lead back to that real page rather than a synthetic folder route.
  // Only an unambiguous match is accepted; externally-created collisions
  // keep the directory fallback instead of choosing an arbitrary page kind.
  const pairedPaths = [`${normalized}.md`, `${normalized}.mdx`, `${normalized}.table.md`, `${normalized}.form.md`, `${normalized}.excalidraw.svg`];
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
    // The directory's own page may be `index.mdx` / `README.md` / `README.mdx` (an MDX docs folder, a plain repo).
    const asSibling = await queryOne<PagesIndexRow>(
      'SELECT * FROM pages_index WHERE space_slug = $1 AND path = ANY($2::text[]) ORDER BY array_position($2::text[], path) LIMIT 1',
      [space, [`${dir}index.mdx`, `${dir}README.md`, `${dir}README.mdx`]],
    );
    if (asSibling) return toPageMeta(rowToEntry(asSibling));
  }
  return undefined;
}

/**
 * Repo-mode image upload: writes `<content root>/assets/<name>` (the content root
 * honours the space's `rootPath`, so a docs-as-code space keeps its images in
 * `docs/assets/`). Returns the Folio URL AND `path`, the file's path relative to
 * the content root — the editor turns the latter into a page-relative Markdown
 * link (`../assets/x.png`) so the image renders on the git host too. scanSpace
 * never indexes anything under `assets` as a page; the file is indexed as a
 * FILE (space_files, wave 3) here and by every scan.
 */
export async function saveAssetIntoRepo(space: string, originalName: string, data: Buffer): Promise<{ url: string; path: string }> {
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
  // Indexed as a file right away (wave 3): the embed the editor inserts next resolves to it without waiting for a scan.
  await spaceFiles.recordFile(space, `assets/${finalName}`, path.join(assetsDir, finalName));
  return { url: `/files/${space}/assets/${finalName}`, path: `assets/${finalName}` };
}

/** Space-admin setting "store images in the repository" (`spaces.asset_mode`). */
export async function setSpaceAssetMode(space: string, assetMode: SpaceAssetMode): Promise<void> {
  const rows = await query<{ slug: string }>('UPDATE spaces SET asset_mode = $2 WHERE slug = $1 RETURNING slug', [space, assetMode]);
  if (rows.length === 0) throw notFound('space');
}

/**
 * Space-admin scan settings (migration 041): the extra ignore list and the
 * explicit light-footprint flag. A changed ignore list rescans the space under
 * its lock, so the index matches the new list when this returns: pages under a
 * newly ignored top-level entry leave it, pages under a released one enter it
 * (ids of released pages are assigned like any scanned file — none are written
 * into a light-footprint space). Files on disk are never touched.
 */
export async function setSpaceScanSettings(space: string, change: { scanIgnore?: string[]; lightFootprint?: boolean }): Promise<SpaceInfo> {
  return withSpaceLock(space, async () => {
    const before = await queryOne<{ scan_ignore: string[] | null; light_footprint: boolean; root_path: string }>(
      'SELECT scan_ignore, light_footprint, root_path FROM spaces WHERE slug = $1',
      [space],
    );
    if (!before) throw notFound('space');
    const scanIgnore = change.scanIgnore ?? before.scan_ignore ?? [];
    const lightFootprint = change.lightFootprint ?? before.light_footprint;
    await query('UPDATE spaces SET scan_ignore = $2, light_footprint = $3 WHERE slug = $1', [space, scanIgnore, lightFootprint]);
    rememberSpaceCaches(space, before.root_path ?? '', lightFootprint);
    const listChanged = JSON.stringify(scanIgnore) !== JSON.stringify(before.scan_ignore ?? []);
    if (listChanged) await scanSpace(space);
    const info = await getSpaceInfo(space);
    if (!info) throw notFound('space');
    return info;
  });
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
export async function setSpaceRootPathCache(space: string, rootPath: string, lightFootprint = false): Promise<void> {
  rememberSpaceCaches(space, rootPath, lightFootprint);
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
