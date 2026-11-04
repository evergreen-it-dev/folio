/**
 * Link target classification for the page index (index v2, Obsidian brief
 * wave 1b; files since wave 3) — pure functions, no database. The same rules
 * run at parse time with no pages and no files known (the provisional kind of
 * a freshly indexed link: never 'page') and in the resolution phase with the
 * space's pages and files (store.ts resolveLinks), so a link means the same
 * thing whichever phase looked at it.
 *
 * A Folio app URL (16.10.2026) comes first: `/s/<space>/p/<id>` (root-relative,
 * or absolute on the instance host — PUBLIC_URL's), `/s/<space>` and
 * `/s/<space>/d/<folder>` name a page by id or route, in this space or another
 * (parseAppLink / classifyAppLink below).
 *
 * A markdown-style link (md, image, html, reference) is resolved against the
 * source page's folder, like storage.ts resolve() opens it:
 *  - a URI scheme (`https:`, `mailto:`) or a root-relative `/x` -> 'external' —
 *    except an app-absolute `/files/<this space>/<path>` URL (a repo-mode
 *    upload), which means `<path>` of this space;
 *  - a path that climbs out of the space -> 'unresolved';
 *  - the path as written, `<dir>/index.md` for a directory-style link, then the
 *    tolerant spellings (percent-decoded, `.md` added) -> 'page';
 *  - otherwise, with the space's files known (phase 2): an indexed file at the
 *    path as written or percent-decoded -> 'asset' (target = the file's path);
 *    then the attachment rules Obsidian applies to a markdown link as much as to
 *    a wikilink (from the root, then by name, nearest folder first:
 *    `![](diagram.png)` in `notes/a.md` finds `Attachments/diagram.png`) —
 *    not for an app-absolute URL, which names its file exactly; a folder that
 *    holds indexed pages or files -> 'asset' (a folder link, as before);
 *    anything else -> 'unresolved' — a missing attachment is listed with the
 *    other unresolved links. Page links keep the folder-relative rules above
 *    (they open what storage.ts resolve() opens);
 *  - at parse time (no files known): a `.md` path is 'unresolved' and anything
 *    else 'asset', provisionally.
 * A wikilink / embed follows wikilinks.ts (Obsidian's "shortest path"): a hit
 * among the pages is 'page' (its target path becomes the page's path); then the
 * same rules over the space's files (relative, root, then the basename / nearest
 * folder rule Obsidian applies to attachments: `![[diagram.png]]` finds
 * `assets/diagram.png`) -> 'asset' with the file's path; a miss is 'unresolved',
 * recorded as the path as written when it names an attachment (`photo.png`),
 * else as the `.md` file it would create.
 */
import type { LinkKind, LinkSyntax } from '../../shared/contracts.js';
import { isAssetLinkPath, resolveWikilinkPath, type PagePathIndex } from '../wikilinks.js';

/**
 * Collapses `.` / `..` / empty segments of `href` against `baseDir`; null when
 * `..` climbs out of the space (same arithmetic as storage.ts's
 * normalizeResolvePath, but never throws).
 */
export function resolveRelative(baseDir: string, href: string): string | null {
  const segments = baseDir ? baseDir.split('/') : [];
  for (const seg of href.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(seg);
    }
  }
  return segments.join('/');
}

/**
 * The other spellings a page link may mean, tried after the path as written
 * (docs-as-code test, 14.10.2026): percent-decoded (`Getting%20Started.md`,
 * which is what `<Getting Started.md>` renders to), then with `.md` added
 * (`getting-started`, a site generator's habit), decoded too. `resolvedPath` is
 * already space-relative and normalized. storage.ts resolve() falls back the
 * same way, so a link that opens is never counted as unresolved here.
 */
export function tolerantLinkPaths(resolvedPath: string): string[] {
  const out: string[] = [];
  let decoded = resolvedPath;
  if (resolvedPath.includes('%')) {
    try {
      decoded = resolveRelative('', decodeURIComponent(resolvedPath)) ?? resolvedPath;
    } catch {
      /* a malformed escape: the path stays as written */
    }
  }
  if (decoded !== resolvedPath) out.push(decoded);
  for (const p of new Set([resolvedPath, decoded])) if (p && !/\.mdx?$/i.test(p)) out.push(`${p}.md`, `${p}.mdx`);
  return out;
}

/** Every path a markdown-style link to `resolvedPath` may open, in the order they are tried. */
export function markdownLinkCandidates(resolvedPath: string): string[] {
  const isMd = /\.mdx?$/i.test(resolvedPath);
  const out = isMd ? [resolvedPath] : [resolvedPath, resolvedPath ? `${resolvedPath}/index.md` : 'index.md', resolvedPath ? `${resolvedPath}/index.mdx` : 'index.mdx'];
  out.push(...tolerantLinkPaths(resolvedPath));
  return [...new Set(out.filter(Boolean))];
}

export function isExternalHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/');
}

export function isWikiSyntax(syntax: LinkSyntax): boolean {
  return syntax === 'wikilink' || syntax === 'embed';
}

/** The `.md` file an unresolved wikilink would create (`[[Not there]]` -> `Not there.md`). */
export function unresolvedWikiPath(linkPath: string): string {
  return /\.mdx?$/i.test(linkPath) ? linkPath : `${linkPath}.md`;
}

const EMPTY_PATH_INDEX: PagePathIndex = { paths: new Set(), byLower: new Map(), byBase: new Map() };

/** The non-page files of a space (`space_files`, wave 3) as the resolver sees them. */
export interface FileLookup {
  /** True when a file is indexed at exactly this path (case-sensitive). */
  has(path: string): boolean;
  /** The same files for the wikilink rules (case-insensitive, nearest folder). */
  wikiIndex: PagePathIndex;
  /** True when `path` is a folder holding at least one indexed page or file. */
  isFolder(path: string): boolean;
}

/**
 * Folio's own app URLs (16.10.2026, prod: a space of 35 pages linked the Folio way showed 0 links in the graph).
 * What the UI writes or a reader pastes: "Copy link" in the tree (`<origin>/s/<space>/p/<id>`), a pasted page URL,
 * the assistant's and MCP's `/s/<space>/p/<id>` — the forms App.tsx routes and web/src/markdown/folioLinks.ts
 * renders as in-app links:
 *   /s/<space>/p/<id>[/][?…][#fragment]   a page by id (in ANY space: the id decides, not the slug)
 *   /s/<space>[/]                          the space home (its root index.md / README.md)
 *   /s/<space>/d/<folder>[/]               a folder: its index page
 * root-relative, or absolute on the instance's own host (PUBLIC_URL's — the host chat link previews treat as
 * ours, server/integrations/chat/card.ts). Anything else on our host (`/share/<token>`, `/public/<slug>`, the
 * graph or settings routes) and every other host stays 'external'.
 */
export type AppLinkRef = { space: string; kind: 'page'; id: string } | { space: string; kind: 'dir'; dir: string };

const APP_PAGE_RE = /^\/s\/([^/]+)\/p\/([^/]+)\/?$/;
const APP_DIR_RE = /^\/s\/([^/]+)\/d\/(.+?)\/?$/;
const APP_SPACE_RE = /^\/s\/([^/]+)\/?$/;

/** Cheap shape test (no host check): a root-relative or absolute http(s) URL whose path starts with `/s/<space>`. */
export const APP_LINK_SHAPE = /^(?:https?:\/\/[^/?#\s]+)?\/s\/[^/?#\s]+/i;

/** The `/s/…` route of `href` when it is one of ours (`host`: the instance host, lowercase; '' = absolute URLs are never ours). */
export function parseAppLink(href: string, host: string): AppLinkRef | null {
  const trimmed = href.trim();
  let pathname: string;
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    pathname = trimmed.split(/[?#]/)[0];
  } else if (/^https?:\/\//i.test(trimmed) && host) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    if (url.hostname.toLowerCase().replace(/\.$/, '') !== host) return null;
    pathname = url.pathname;
  } else {
    return null;
  }
  const decode = (s: string): string | null => {
    try {
      return decodeURIComponent(s);
    } catch {
      return null;
    }
  };
  let m = APP_PAGE_RE.exec(pathname);
  if (m) {
    const space = decode(m[1]);
    const id = decode(m[2]);
    return space && id ? { space, kind: 'page', id } : null;
  }
  m = APP_DIR_RE.exec(pathname);
  if (m) {
    const space = decode(m[1]);
    const parts = m[2].split('/').map(decode);
    if (!space || parts.some((p) => p === null)) return null;
    const dir = resolveRelative('', parts.join('/'));
    return dir === null ? null : { space, kind: 'dir', dir };
  }
  m = APP_SPACE_RE.exec(pathname);
  if (m) {
    const space = decode(m[1]);
    return space ? { space, kind: 'dir', dir: '' } : null;
  }
  return null;
}

/** The app route of `ref`, the way an unresolved (or cross-space) app link is recorded as its target_path. */
export function appLinkRoute(ref: AppLinkRef): string {
  const space = encodeURIComponent(ref.space);
  if (ref.kind === 'page') return `/s/${space}/p/${encodeURIComponent(ref.id)}`;
  return ref.dir ? `/s/${space}/d/${ref.dir.split('/').map(encodeURIComponent).join('/')}` : `/s/${space}`;
}

/** The page a folder route (or the space home, `dir` '') opens — storage.ts resolve()'s order: the path, its index.md / README.md, a same-named page. */
export function appDirCandidates(dir: string): string[] {
  if (!dir) return ['index.md', 'index.mdx', 'README.md', 'README.mdx'];
  return [dir, `${dir}/index.md`, `${dir}/index.mdx`, `${dir}/README.md`, `${dir}/README.mdx`, `${dir}.md`, `${dir}.mdx`, `${dir}.table.md`, `${dir}.form.md`, `${dir}.excalidraw.svg`];
}

/** Pages of ANY space an app link may name (resolution phase only). */
export interface AppPageLookup {
  /** The page with this id (not a folder row), wherever it lives. */
  byId(id: string): { space: string; path: string } | null;
  /** The page a folder route of `space` opens (appDirCandidates' first hit). */
  dirPage(space: string, dir: string): { id: string; path: string } | null;
}

/** The pages of a space as the resolver sees them. */
export interface PageLookup {
  /** Id of the page at exactly this path (case-sensitive), or null. */
  idAt(path: string): string | null;
  /** The same pages for the wikilink rules. */
  wikiIndex: PagePathIndex;
  /** The space's files — absent at parse time, when existence is not known yet. */
  files?: FileLookup;
  /** The space's slug: an app-absolute `/files/<space>/…` URL of THIS space is a path of the space, not an external link. */
  space?: string;
  /** The instance host (lowercase, no port): an absolute URL on it may be an app link. '' or absent: only root-relative `/s/…` is. */
  appHost?: string;
  /** Pages app links may name — absent at parse time, when an app link is provisionally 'unresolved'. */
  app?: AppPageLookup;
}

export const NO_PAGES: PageLookup = {
  idAt: () => null,
  wikiIndex: EMPTY_PATH_INDEX,
};

/** An empty file set (a space with no files), for callers that know the files and found none. */
export const NO_FILES: FileLookup = { has: () => false, wikiIndex: EMPTY_PATH_INDEX, isFolder: () => false };

function safeDecode(s: string): string {
  if (!s.includes('%')) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * `/files/<space>/<path>` (raw or percent-encoded, `?query`/`#fragment` dropped)
 * -> `<path>` normalized; null for anything else, another space's URL, or a
 * path that climbs out of the space.
 */
export function appFilesPath(linkPath: string, space: string): string | null {
  const prefix = `/files/${space}/`;
  const bare = linkPath.split('#')[0].split('?')[0];
  let rest: string | null = null;
  if (bare.startsWith(prefix)) rest = bare.slice(prefix.length);
  else if (safeDecode(bare).startsWith(prefix)) rest = safeDecode(bare).slice(prefix.length);
  if (rest === null) return null;
  const resolved = resolveRelative('', safeDecode(rest));
  return resolved ? resolved : null;
}

/** The paths a markdown-style link to the non-page `resolvedPath` may name among the files: as written, then percent-decoded. */
export function fileLinkCandidates(resolvedPath: string): string[] {
  const out = [resolvedPath];
  if (resolvedPath.includes('%')) {
    const decoded = resolveRelative('', safeDecode(resolvedPath));
    if (decoded && decoded !== resolvedPath) out.push(decoded);
  }
  return out;
}

/**
 * A canvas file card (syntax 'canvas'): JSON Canvas paths are from the vault
 * (space) root and Obsidian opens exactly that path — no relative rule, no
 * name lookup, so a card whose note moved outside Folio is unresolved (the
 * canvas file is not rewritten in a light-footprint space). The page at the
 * path -> 'page'; a file of the space there -> 'asset'; otherwise
 * 'unresolved'. At parse time (no files known) a non-`.md` path is 'asset',
 * provisionally, like a markdown link.
 */
function classifyCanvasPath(linkPath: string, pages: PageLookup): LinkTarget {
  const resolved = resolveRelative('', linkPath);
  if (!resolved) return { kind: 'unresolved', targetPath: linkPath, targetPageId: null };
  const id = pages.idAt(resolved);
  if (id) return { kind: 'page', targetPath: resolved, targetPageId: id };
  if (pages.files) return { kind: pages.files.has(resolved) ? 'asset' : 'unresolved', targetPath: resolved, targetPageId: null };
  return { kind: /\.mdx?$/i.test(resolved) ? 'unresolved' : 'asset', targetPath: resolved, targetPageId: null };
}

/**
 * An app link: a page by id, wherever it lives (another space's page is a 'page' too); a folder route / the space
 * home by appDirCandidates. A page of THIS space is recorded by its path like any page link; a page of another
 * space by its route (`/s/<its space>/p/<id>` — never a bare path, which would read as a path of this space). An id
 * or a home that does not exist is 'unresolved', recorded as the route.
 */
function classifyAppLink(ref: AppLinkRef, pages: PageLookup): LinkTarget {
  const route = appLinkRoute(ref);
  if (!pages.app) return { kind: 'unresolved', targetPath: route, targetPageId: null };
  if (ref.kind === 'page') {
    const hit = pages.app.byId(ref.id);
    if (!hit) return { kind: 'unresolved', targetPath: route, targetPageId: null };
    const targetPath = hit.space === pages.space ? hit.path : appLinkRoute({ space: hit.space, kind: 'page', id: ref.id });
    return { kind: 'page', targetPath, targetPageId: ref.id };
  }
  const hit = pages.app.dirPage(ref.space, ref.dir);
  if (!hit) return { kind: 'unresolved', targetPath: route, targetPageId: null };
  return { kind: 'page', targetPath: ref.space === pages.space ? hit.path : appLinkRoute({ space: ref.space, kind: 'page', id: hit.id }), targetPageId: hit.id };
}

export interface LinkTarget {
  kind: LinkKind;
  targetPath: string;
  targetPageId: string | null;
}

/** What the link `linkPath` (as written, no fragment) of a page in `sourceDir` points at among `pages`. */
export function classifyLinkTarget(syntax: LinkSyntax, linkPath: string, sourceDir: string, pages: PageLookup): LinkTarget {
  if (syntax === 'canvas') return classifyCanvasPath(linkPath, pages);
  if (!isWikiSyntax(syntax)) {
    const app = parseAppLink(linkPath, pages.appHost ?? '');
    if (app) return classifyAppLink(app, pages);
  }
  const appPath = pages.space !== undefined && linkPath.startsWith('/') ? appFilesPath(linkPath, pages.space) : null;
  if (appPath === null && isExternalHref(linkPath)) return { kind: 'external', targetPath: linkPath, targetPageId: null };
  const files = pages.files;
  if (isWikiSyntax(syntax) && appPath === null) {
    const hit = resolveWikilinkPath(pages.wikiIndex, sourceDir, linkPath);
    if (hit !== null) return { kind: 'page', targetPath: hit, targetPageId: pages.idAt(hit) };
    if (files) {
      const file = resolveWikilinkPath(files.wikiIndex, sourceDir, linkPath);
      if (file !== null) return { kind: 'asset', targetPath: file, targetPageId: null };
      return { kind: 'unresolved', targetPath: isAssetLinkPath(linkPath) ? linkPath : unresolvedWikiPath(linkPath), targetPageId: null };
    }
    if (isAssetLinkPath(linkPath)) return { kind: 'asset', targetPath: linkPath, targetPageId: null };
    return { kind: 'unresolved', targetPath: unresolvedWikiPath(linkPath), targetPageId: null };
  }
  const resolved = appPath ?? resolveRelative(sourceDir, linkPath);
  if (resolved === null) return { kind: 'unresolved', targetPath: linkPath, targetPageId: null };
  for (const candidate of markdownLinkCandidates(resolved)) {
    const id = pages.idAt(candidate);
    if (id) return { kind: 'page', targetPath: resolved, targetPageId: id };
  }
  if (files) {
    for (const candidate of fileLinkCandidates(resolved)) {
      if (files.has(candidate)) return { kind: 'asset', targetPath: candidate, targetPageId: null };
    }
    if (appPath === null) {
      const byName = resolveWikilinkPath(files.wikiIndex, sourceDir, linkPath);
      if (byName !== null) return { kind: 'asset', targetPath: byName, targetPageId: null };
    }
    for (const candidate of fileLinkCandidates(resolved)) {
      if (files.isFolder(candidate)) return { kind: 'asset', targetPath: resolved, targetPageId: null };
    }
    return { kind: 'unresolved', targetPath: resolved, targetPageId: null };
  }
  return { kind: /\.mdx?$/i.test(resolved) ? 'unresolved' : 'asset', targetPath: resolved, targetPageId: null };
}
