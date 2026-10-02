/**
 * `GET /files/<space>/<path>` — raw files of a space's working tree: images
 * and attachments a page embeds or links by relative path (or, in repo asset
 * mode, by the app-absolute `/files/<space>/assets/...` URL an upload
 * returns), and the page files themselves (a board's SVG, a PDF or Office
 * page, the Markdown an agent fetches from a share link's `.md` export).
 *
 * Security review F-01: this used to check only the SPACE — a viewer could
 * read the file of a page that page access hides from them, and a guest
 * holding a link to ONE page could read any file of that page's space (a
 * documented round-8 compromise). The rule now, for both kinds of caller:
 *
 *  - a file that IS a page (any row in pages_index) passes exactly the check
 *    the page API applies to that page: `requirePageRole` for a session, and
 *    membership in the share's own page set (export/shareScope.ts — the same
 *    set the JSON payload, the Markdown link and the collab admission use)
 *    for a share token;
 *  - any other file BELONGS TO THE PAGES THAT REFERENCE IT: the pages whose
 *    source links to it or embeds it (see `referencedFiles`). Chosen over
 *    "the nearest page whose directory contains it" because in repo asset
 *    mode every upload lands in the space-wide `assets/` folder, and git
 *    repositories commonly keep images in a shared `img/` next to many pages
 *    — a directory rule would hand them all to whichever page owns that
 *    folder, and break the images of every other page. A reference is also
 *    exactly what the reader is shown: a page's own content is the list of
 *    files it hands to whoever can read it.
 *      * a session user may read such a file unless every page referencing it
 *        is hidden from them (a file nothing references belongs to the space
 *        as a whole, like before); the common "nothing in this space is
 *        hidden from you" case costs one query and no file reads;
 *      * a share guest may read it only when a page of the share references
 *        it. A board, PDF or Office PAGE embedded or linked by a shared page
 *        is served the same way, provided that page is itself open to the
 *        whole space; a Markdown/table/form page outside the share never is.
 *
 * Never served, to anyone: a dot segment (`.git/**`, `.agent/**`, any
 * dotfile, `..`), a `*.folio` metadata file, anything that is not a regular
 * file, and any path that crosses a symlink — the path that was authorized
 * must be byte-for-byte the file that is sent.
 *
 * What a served file IS to the browser (F-04): anyone who can commit a file to
 * a space chooses its bytes and its name, and this route serves it from the
 * application's own origin — an `.svg` or `.html` opened directly would run
 * its script with the visitor's session. So the response headers come from
 * the same byte-derived policy as the `/a/...` attachments (safeServe.ts):
 * verified rasters and PDF inline, SVG inline under a sandboxing CSP, the
 * rest a download, everything `nosniff`. A page's `<img>` of a repository
 * SVG is unaffected (a CSP on the image resource does not apply to the page
 * that embeds it).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import * as fastifyStaticModule from '@fastify/static';
import * as session from './auth/session.js';
import * as collab from './collab.js';
import { query } from './db/pool.js';
import { forbidden, notFound } from './errors.js';
import { resolveShareScope, type ShareScope } from './export/shareScope.js';
import * as pageAccess from './pageAccess.js';
import { serveHeadersForPath } from './safeServe.js';
import * as storage from './storage.js';
import type { PageIndexEntry } from './storage.js';
import { queryString } from './validate.js';

const fastifyStatic = fastifyStaticModule.default;

/**
 * The safe-serving headers the handler decided for the file it is about to
 * send, by request. Applied in the route's `onSend` hook, never before
 * `reply.sendFile`: @fastify/static sets Content-Type from the file
 * extension itself while it sends and would overwrite anything set earlier
 * (see safeServe.test.ts). A request that fails or is refused never gets an
 * entry, so no error response carries file headers.
 */
const pendingFileHeaders = new WeakMap<FastifyRequest, Record<string, string>>();

type PageKind = PageIndexEntry['kind'];

/** What reading a page's references needs — a full PageIndexEntry fits, and so does a light row. */
type PageSource = Pick<PageIndexEntry, 'id' | 'space' | 'relPath' | 'kind' | 'absPath'>;

/** Kinds whose source is text that can link to or embed other files. */
const REFERENCING_KINDS: ReadonlySet<PageKind> = new Set(['doc', 'table', 'form']);
/** Page kinds that are a file to look at, not a source to read — embeddable/linkable by another page. */
const FILE_LIKE_KINDS: ReadonlySet<PageKind> = new Set(['board', 'pdf', 'office']);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * The space-relative path a request names, or undefined when it must never
 * be served (see the module doc). Empty segments collapse; nothing else is
 * rewritten.
 */
export function normalizeFilePath(raw: string): string | undefined {
  if (raw.includes('\0') || raw.includes('\\')) return undefined;
  const segments = raw.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) return undefined;
  if (segments.some((segment) => segment.startsWith('.'))) return undefined;
  if (segments[segments.length - 1].toLowerCase().endsWith('.folio')) return undefined;
  return segments.join('/');
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** `href` as written in the page at `pagePath`, resolved to a space-relative file path — undefined for anything that is not a file of this space. */
function resolveReference(rawHref: string, pagePath: string, space: string): string | undefined {
  let href = rawHref.trim();
  if (href.startsWith('<') && href.endsWith('>')) href = href.slice(1, -1).trim();
  href = href.split('#')[0].split('?')[0];
  if (!href || href.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return undefined;

  let segments: string[];
  if (href.startsWith('/')) {
    const prefix = `/files/${space}/`;
    if (!href.startsWith(prefix) && !safeDecode(href).startsWith(prefix)) return undefined;
    segments = safeDecode(href.slice(href.indexOf('/', '/files/'.length) + 1)).split('/');
  } else {
    const dir = pagePath.includes('/') ? pagePath.slice(0, pagePath.lastIndexOf('/')).split('/') : [];
    segments = [...dir, ...safeDecode(href).split('/')];
  }
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return undefined; // escapes the space root
      out.pop();
    } else {
      out.push(segment);
    }
  }
  return normalizeFilePath(out.join('/'));
}

const INLINE_TARGET_RE = /\]\(\s*(<[^>]*>|[^()\s]*(?:\([^()]*\)[^()\s]*)*)/g;
const REF_DEF_RE = /^\s{0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/gm;
const HTML_ATTR_RE = /\b(?:src|href|poster|data)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const FILES_URL_RE = /\/files\/[^\s"'()<>[\]]+/g;

/**
 * Every file of `space` that the source `text` of the page at `pagePath`
 * links to or embeds: inline links and images, reference definitions, HTML
 * `src`/`href`, and any app-absolute `/files/<space>/...` URL anywhere in the
 * text (repo-mode uploads, a cover in frontmatter). Deliberately generous —
 * fenced code included — since it is the page's author who decides what a
 * page references; a link to another Markdown page lands here too, but a
 * reference never grants a page's source (see shareMayReadFile).
 */
export function referencedFiles(text: string, pagePath: string, space: string): Set<string> {
  const out = new Set<string>();
  const add = (href: string | undefined) => {
    if (!href) return;
    const resolved = resolveReference(href, pagePath, space);
    if (resolved) out.add(resolved);
  };
  for (const m of text.matchAll(INLINE_TARGET_RE)) add(m[1]);
  for (const m of text.matchAll(REF_DEF_RE)) add(m[1]);
  for (const m of text.matchAll(HTML_ATTR_RE)) add(m[1] ?? m[2]);
  for (const m of text.matchAll(FILES_URL_RE)) add(m[0]);
  return out;
}

/** pageId -> references parsed from its file, keyed by that file's mtime+size. */
const referenceCache = new Map<string, { key: string; refs: Set<string> }>();
const REFERENCE_CACHE_MAX = 5000;

/** The files a page references right now: its file on disk, plus the live collab text of a doc being edited (not flushed yet). */
async function pageReferences(page: PageSource): Promise<Set<string>> {
  if (!REFERENCING_KINDS.has(page.kind)) return new Set();
  let refs = new Set<string>();
  const stat = await fs.stat(page.absPath).catch(() => null);
  if (stat?.isFile()) {
    const key = `${page.absPath}\0${stat.mtimeMs}\0${stat.size}`;
    const cached = referenceCache.get(page.id);
    if (cached?.key === key) {
      refs = cached.refs;
    } else {
      refs = referencedFiles(await fs.readFile(page.absPath, 'utf8').catch(() => ''), page.relPath, page.space);
      referenceCache.delete(page.id);
      referenceCache.set(page.id, { key, refs });
      if (referenceCache.size > REFERENCE_CACHE_MAX) referenceCache.delete(referenceCache.keys().next().value!);
    }
  }
  const live = page.kind === 'doc' && collab.isDocLive(page.id) ? collab.getLiveText(page.id) : undefined;
  return live ? new Set([...refs, ...referencedFiles(live, page.relPath, page.space)]) : refs;
}

async function anyReferences(pages: Iterable<PageSource>, relPath: string): Promise<boolean> {
  for (const page of pages) if ((await pageReferences(page)).has(relPath)) return true;
  return false;
}

/**
 * The indexed page(s) stored at `relPath`. Case-insensitive on purpose: on a
 * case-insensitive filesystem `SECRET.md` opens `secret.md`, and must meet
 * that page's check rather than slip through as "not a page". An exact match
 * wins when there is one (a case-sensitive filesystem holding both).
 */
async function pagesAt(space: string, relPath: string): Promise<Array<{ id: string; path: string; kind: PageKind }>> {
  const rows = await query<{ id: string; path: string; kind: PageKind }>(
    'SELECT id, path, kind FROM pages_index WHERE space_slug = $1 AND lower(path) = lower($2)',
    [space, relPath],
  );
  const exact = rows.filter((row) => row.path === relPath);
  return exact.length > 0 ? exact : rows;
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

/** Share-token caller: the share's own pages, and what those pages reference (module doc). */
export async function shareMayReadFile(scope: ShareScope, space: string, relPath: string): Promise<boolean> {
  if (scope.root.space !== space) return false;
  const pages = await pagesAt(space, relPath);
  if (pages.length > 0 && pages.every((page) => scope.collected.ids.has(page.id))) return true;
  if (pages.length > 0) {
    if (!pages.every((page) => FILE_LIKE_KINDS.has(page.kind))) return false;
    const restricted = await pageAccess.restrictedPageIds(space);
    if (pages.some((page) => restricted.has(page.id))) return false;
  }

  if (await anyReferences(scope.collected.pages.map((p) => p.entry), relPath)) return true;
  // Past the 200-page export cap, `ids` keeps members `pages` no longer lists.
  if (scope.collected.ids.size > scope.collected.pages.length) {
    const listed = new Set(scope.collected.pages.map((p) => p.entry.id));
    const rest = (await storage.listEntries(space)).filter((e) => scope.collected.ids.has(e.id) && !listed.has(e.id));
    return anyReferences(rest, relPath);
  }
  return false;
}

/** Session caller: throws (401/403/404) unless the user may read this file (module doc). */
export async function requireSessionFileAccess(request: FastifyRequest, space: string, relPath: string): Promise<void> {
  await session.requireSpaceRole(request, space, 'viewer');
  const user = request.authUser!;

  const pages = await pagesAt(space, relPath);
  if (pages.length > 0) {
    for (const page of pages) await session.requirePageRole(request, page.id, 'viewer');
    return;
  }

  const hidden = await pageAccess.hiddenPages(user.id, space, await session.canAdministerSpace(user, space));
  if (hidden.length === 0) return;
  const root = storage.getSpaceDir(space);
  const hiddenSources = hidden.map((page) => ({ ...page, space, relPath: page.path, absPath: path.join(root, page.path) }));
  if (!(await anyReferences(hiddenSources, relPath))) return;

  // Also shown on a page this user CAN open? Then it is theirs as well.
  const hiddenIds = new Set(hidden.map((page) => page.id));
  const readable = (await storage.listEntries(space)).filter((e) => !hiddenIds.has(e.id));
  if (await anyReferences(readable, relPath)) return;
  throw forbidden('this file belongs to a page you cannot open');
}

/**
 * The non-page files of `space` that belong ONLY to the `hidden` pages — the
 * rule `requireSessionFileAccess` applies to one file, asked of all of them at
 * once: a file belongs to the pages that reference it, and is withheld when
 * every page referencing it is hidden. A file shared with a page that is not
 * hidden, or used by nothing, is not in the set. Used by a subtree copy
 * (server/copyScope.ts) to leave a hidden page's private attachments behind.
 */
export async function filesOfHiddenPagesOnly(space: string, hidden: ReadonlyArray<{ id: string; path: string; kind: PageKind }>): Promise<Set<string>> {
  const only = new Set<string>();
  if (hidden.length === 0) return only;
  const root = storage.getSpaceDir(space);
  for (const page of hidden) {
    const source: PageSource = { ...page, space, relPath: page.path, absPath: path.join(root, page.path) };
    for (const ref of await pageReferences(source)) only.add(ref);
  }
  if (only.size === 0) return only;

  const hiddenIds = new Set(hidden.map((page) => page.id));
  for (const entry of await storage.listEntries(space)) {
    if (hiddenIds.has(entry.id)) continue;
    for (const ref of await pageReferences(entry)) only.delete(ref);
    if (only.size === 0) break;
  }
  return only;
}

/** True when `relPath` under `root` is a regular file reached without crossing a symlink. */
async function isPlainFileInside(root: string, relPath: string): Promise<boolean> {
  try {
    const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(path.join(root, relPath))]);
    if (realFile !== path.join(realRoot, relPath)) return false;
    return (await fs.stat(realFile)).isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

/**
 * Registered by server/index.ts as its own Fastify scope, outside the
 * blanket requireSession hook: a share guest has no session, and this route
 * does its own share-token-or-session check (see index.ts's comment there).
 */
export async function registerFileRoutes(app: FastifyInstance): Promise<void> {
  await app.register(fastifyStatic, { root: storage.REPOS_DIR, serve: false });

  app.get(
    '/files/:space/*',
    {
      // Runs after @fastify/static has set its own headers, for 200, 206 and
      // 304 alike; an error status (4xx/5xx) is left exactly as it was.
      onSend: async (request, reply, payload) => {
        const headers = pendingFileHeaders.get(request);
        if (headers && reply.statusCode < 400) reply.headers(headers);
        return payload;
      },
    },
    async (request, reply) => {
      const { space, '*': rest } = request.params as { space: string; '*': string };
      const relPath = normalizeFilePath(rest);
      if (!relPath) throw notFound('file');

      const shareToken = queryString(request.query, 'share');
      if (shareToken) {
        const scope = await resolveShareScope(shareToken); // undefined for unknown OR revoked
        if (!scope) return reply.status(401).send({ error: 'invalid or revoked share token' });
        // Decided from the share's page set and its pages' own content alone,
        // before the filesystem is consulted: 403 here says nothing about
        // whether a file outside the grant exists.
        if (!(await shareMayReadFile(scope, space, relPath))) return reply.status(403).send({ error: 'share link does not grant access to this file' });
      } else {
        await session.requireSession(request, reply);
        if (reply.sent) return reply;
        await requireSessionFileAccess(request, space, relPath);
      }

      const root = storage.getSpaceDir(space);
      if (!(await isPlainFileInside(root, relPath))) throw notFound('file');
      // The headers describe the very file that is sent: `relPath` is what was
      // authorized and checked above, and sendFile opens `root` + `relPath`
      // (it encodeURI()s the path before @fastify/send decodes it again, so
      // nothing is decoded a second time — a test pins this).
      const headers = await serveHeadersForPath(path.join(root, relPath), path.basename(relPath));
      if (!headers) throw notFound('file'); // vanished since the check, or not a regular file any more
      pendingFileHeaders.set(request, headers);
      return reply.sendFile(relPath, root);
    },
  );
}
