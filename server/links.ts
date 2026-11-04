/**
 * Links between pages: the rename/move REWRITERS and the internal backlink
 * reads that drive them. Indexing lives in server/indexV2 (index v2, Obsidian
 * brief wave 1b): one mdast parse per page writes typed rows into
 * `page_links` (md, wikilink, embed, image, html, reference — with fragment,
 * line and context), and a second, set-based phase per space resolves them
 * (indexV2/store.ts resolveLinks). The legacy `links` relation is a VIEW over
 * `page_links` (migration 042) kept for old readers; nothing writes it.
 *
 * The rewriters keep their `[text](href)` regex and wikilinks.ts's parser, but
 * take "what is code" from the same mdast parse as the index
 * (markdownAst.maskCode): a link inside a fenced, indented or inline code span
 * is neither indexed nor rewritten. Classification of a link target (page /
 * asset / external / unresolved) is indexV2/resolve.ts, shared by both phases.
 */
import type { PageMeta } from '../shared/contracts.js';
import { query } from './db/pool.js';
import { resolveRelative, tolerantLinkPaths } from './indexV2/resolve.js';
import { buildPagePathIndex, maskCode, rewriteWikilinks, type PagePathIndex } from './wikilinks.js';

export { tolerantLinkPaths };

const ORDER_SENTINEL = Number.MAX_SAFE_INTEGER;

interface BacklinkRow {
  id: string;
  space_slug: string;
  path: string;
  kind: 'doc' | 'board';
  title: string;
  sort_order: number | null;
  status: string | null;
  updated_at: string;
}

/**
 * Path of `toPath` written relative to a page whose OWN directory is
 * `fromDir` — the same relative-path arithmetic web/src/editor/paths.ts's
 * relativePath() uses client-side, reimplemented here (server/** can't
 * import from web/**) for round 22's slug-rename link rewriter. Pure,
 * segment-count-only arithmetic — deliberately doesn't know or care that a
 * rename happened; see rewriteRelativeLinks's doc comment for why that's
 * exactly what makes it correct for a directory rename's own descendants.
 */
function relativeHref(fromDir: string, toPath: string): string {
  const fromParts = fromDir ? fromDir.split('/').filter(Boolean) : [];
  const toParts = toPath.split('/').filter(Boolean);
  let common = 0;
  while (common < fromParts.length && common < toParts.length - 1 && fromParts[common] === toParts[common]) common++;
  const ups = fromParts.length - common;
  const downParts = toParts.slice(common);
  return [...Array(ups).fill('..'), ...downParts].join('/');
}

/**
 * A new href written the way the old one was: percent-encoded. Non-ASCII letters are escaped only when the old
 * href escaped them too (`%D0%9C…`); otherwise they stay readable, with just the characters that break a link escaped.
 */
function escapeHrefLike(href: string, like: string): string {
  const full = /%[89a-f][0-9a-f]/i.test(like);
  return href
    .split('/')
    .map((seg) => (seg === '..' || seg === '.' ? seg : full ? encodeURIComponent(seg) : seg.replace(/[%\s()#?<>]/g, (c) => encodeURIComponent(c).replace(/\(/g, '%28').replace(/\)/g, '%29'))))
    .join('/');
}

const LINK_RE_CAPTURED = /(\[[^\]]*\])\(([^)]+)\)/gd;

/**
 * Applies `fn` to every markdown link `[text](href)` of `body` that is not
 * inside code, splicing the results back so every other byte of the file is
 * kept. `fn` receives the link as written and its two captured parts (also as
 * written, code spans in the text included) and returns the text to put in its
 * place — the same string to leave it. The SAME `body` string comes back when
 * nothing changed.
 */
function mapMarkdownLinks(body: string, fn: (full: string, bracketText: string, hrefRaw: string) => string): string {
  const masked = maskCode(body);
  const re = new RegExp(LINK_RE_CAPTURED);
  let out = '';
  let cursor = 0;
  let changed = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const full = body.slice(m.index, m.index + m[0].length);
    const replaced = fn(full, body.slice(m.indices![1][0], m.indices![1][1]), body.slice(m.indices![2][0], m.indices![2][1]));
    if (replaced === full) continue;
    out += body.slice(cursor, m.index) + replaced;
    cursor = m.index + m[0].length;
    changed = true;
  }
  return changed ? out + body.slice(cursor) : body;
}

/**
 * What the wikilink rewriters need beyond the body: the space's page paths
 * before and after the change (a wikilink's meaning depends on which other
 * pages exist — a bare name is resolved against the whole space). Without it
 * wikilinks are left alone and only markdown links are rewritten.
 */
export interface WikiMoveContext {
  oldIndex: PagePathIndex;
  newIndex: PagePathIndex;
  /** The folder the doc lived in before the change, when it moved along (a directory rename); omitted = it did not move. */
  sourceOldDir?: string;
}

/** The indexes for a change described by `movedFiles` (old path -> new path) and `movedDirs`: the current pages are the "after", the "before" is derived by undoing the moves. */
export async function loadWikiMoveContext(
  space: string,
  movedFiles: ReadonlyMap<string, string>,
  movedDirs: ReadonlyMap<string, string> = new Map(),
): Promise<WikiMoveContext & { oldPathOf: (newPath: string) => string }> {
  const rows = await query<{ path: string }>('SELECT path FROM pages_index WHERE space_slug = $1', [space]);
  const reverseFiles = new Map([...movedFiles].map(([from, to]) => [to, from] as const));
  const reverseDirs = new Map([...movedDirs].map(([from, to]) => [to, from] as const));
  const oldPathOf = (newPath: string) => mapMovedPath(newPath, reverseFiles, reverseDirs);
  const paths = rows.map((r) => r.path);
  return { newIndex: buildPagePathIndex(paths), oldIndex: buildPagePathIndex(paths.map(oldPathOf)), oldPathOf };
}

/**
 * Rewrites relative-markdown-link hrefs in `body` that resolve (from
 * `sourceDir`) to `oldTargetRelPath` so they instead resolve to
 * `newTargetRelPath` — used by collab.ts's slug-rename orchestration (round
 * 22) to keep every INCOMING link pointing at a renamed page/directory
 * working. Obsidian wikilinks (`[[old-name]]`, `[[folder/old-name|alias]]`,
 * `![[old-name]]`) are rewritten too when `wiki` is given — resolved the way
 * wikilinks.ts resolves them, and re-aimed in their own form with the
 * `#heading` / `#^block` / `|alias` tail kept. Folio itself never writes
 * `[[`; they come from files written elsewhere. Mirrors the index's own
 * resolution rules exactly, including its asymmetric "an implicit bare-
 * directory link only ever resolves to `<dir>/index.md`, never README.md"
 * rule — so a link this function leaves untouched is provably one the index
 * (indexV2/resolve.ts) would also never have counted as a 'page' link to this target in the
 * first place (and thus never surfaced via getBacklinks() at all).
 *
 * Correct even when `sourceDir` is itself one of a directory rename's own
 * descendants (so it moved too): a directory rename is a uniform prefix
 * substitution (only the renamed segment's NAME changes, never its depth or
 * position), so a relative link between two co-moved pages resolves to the
 * same target whether computed against their old or new directories — such
 * a link is correctly left alone (nothing to fix), while a link crossing the
 * moved/unmoved boundary is correctly caught and rewritten.
 *
 * External/absolute hrefs (scheme:, root-relative) are never touched. An
 * optional CommonMark `"title"` suffix and any `#fragment`/`?query` are
 * preserved verbatim. Returns the SAME string reference when nothing
 * changed, so callers can cheaply skip a no-op write.
 */
export function rewriteRelativeLinks(
  body: string,
  sourceDir: string,
  oldTargetRelPath: string,
  newTargetRelPath: string,
  wiki?: WikiMoveContext,
): string {
  const oldIsIndexMd = /(^|\/)index\.mdx?$/i.test(oldTargetRelPath);
  const oldDirForImplicit = oldIsIndexMd ? oldTargetRelPath.replace(/\/?index\.mdx?$/i, '') : null;
  const newDirForImplicit = oldIsIndexMd ? newTargetRelPath.replace(/\/?index\.mdx?$/i, '') : null;

  const rewritten = mapMarkdownLinks(body, (full: string, bracketText: string, hrefRaw: string) => {
    const trimmed = hrefRaw.trim();
    // `[x](<My file.canvas> "title")`: the angle brackets carry a space (CommonMark); otherwise the path ends at the first space.
    const angleClose = trimmed.startsWith('<') ? trimmed.indexOf('>') : -1;
    const angle = angleClose > 0;
    const spaceIdx = angle ? angleClose + 1 : trimmed.search(/\s/);
    const pathPart = angle ? trimmed.slice(1, angleClose) : spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
    const titleSuffix = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx); // leading space + any "title", kept as-is

    if (/^[a-z][a-z0-9+.-]*:/i.test(pathPart) || pathPart.startsWith('/')) return full; // external/absolute — never touched

    let p = pathPart;
    let hash = '';
    const hashIdx = p.indexOf('#');
    if (hashIdx !== -1) {
      hash = p.slice(hashIdx);
      p = p.slice(0, hashIdx);
    }
    let queryStr = '';
    const qIdx = p.indexOf('?');
    if (qIdx !== -1) {
      queryStr = p.slice(qIdx);
      p = p.slice(0, qIdx);
    }
    if (!p) return full; // pure #fragment link within the same page

    const hadTrailingSlash = p.endsWith('/');
    const resolved = resolveRelative(sourceDir, p);
    if (resolved === null) return full;
    // `My%20base.base`: the same file as `My base.base` (what the index resolves too).
    let escaped = false;
    let resolvedTarget = resolved;
    if (resolved !== oldTargetRelPath && p.includes('%')) {
      try {
        resolvedTarget = resolveRelative(sourceDir, decodeURIComponent(p)) ?? resolved;
        escaped = resolvedTarget === oldTargetRelPath;
      } catch {
        /* a malformed escape: the link stays as written */
      }
    }

    let newHrefPath: string | null = null;
    if (resolvedTarget === oldTargetRelPath) {
      newHrefPath = relativeHref(sourceDir, newTargetRelPath);
      if (escaped) newHrefPath = escapeHrefLike(newHrefPath, p);
      else if (angle) newHrefPath = `<${newHrefPath}>`;
      else if (/[\s()]/.test(newHrefPath)) newHrefPath = newHrefPath.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
    } else if (oldDirForImplicit !== null && newDirForImplicit !== null && resolved === oldDirForImplicit) {
      newHrefPath = relativeHref(sourceDir, newDirForImplicit) + (hadTrailingSlash ? '/' : '');
    }
    if (newHrefPath === null) return full;

    return `${bracketText}(${newHrefPath}${queryStr}${hash}${titleSuffix})`;
  });

  if (!wiki) return rewritten;
  return rewriteWikilinks(rewritten, {
    oldDir: wiki.sourceOldDir ?? sourceDir,
    newDir: sourceDir,
    oldIndex: wiki.oldIndex,
    newIndex: wiki.newIndex,
    mapTarget: (oldTarget) => (oldTarget === oldTargetRelPath ? newTargetRelPath : oldTarget),
    onlyTarget: oldTargetRelPath,
  });
}

/** Where a path ends up after a move: an exact file match, or anything under a moved directory (its prefix swapped). Unmoved paths come back as-is. */
function mapMovedPath(p: string, movedFiles: ReadonlyMap<string, string>, movedDirs: ReadonlyMap<string, string>): string {
  const file = movedFiles.get(p);
  if (file !== undefined) return file;
  for (const [from, to] of movedDirs) {
    if (p === from) return to;
    if (p.startsWith(`${from}/`)) return `${to}${p.slice(from.length)}`;
  }
  return p;
}

/**
 * Re-aims every relative link/image in `body` after the document and/or its
 * targets moved — the move counterpart of rewriteRelativeLinks (a slug rename
 * keeps depth, so it can use the narrower function; a move cannot). Each
 * relative href is resolved against `oldDir` (where the doc used to live),
 * the target is mapped through the move (`movedFiles`: exact old->new
 * relPaths; `movedDirs`: old->new directory prefixes, which also covers the
 * implicit `dir/` -> `dir/index.md` form and non-page files such as images
 * next to a moved index page), and the result is written relative to
 * `newDir`. A link that still resolves to the right place as written (e.g.
 * two co-moved pages linking each other) keeps its original text verbatim.
 * Handles a doc that moved, a doc that only links to something that moved
 * (`oldDir === newDir`), or both at once. Scheme:/root-relative/pure-#fragment
 * hrefs are untouched; `?query`, `#hash` and a `"title"` suffix are
 * preserved. Wikilinks follow when `wiki` is given (see rewriteRelativeLinks).
 * Returns the SAME string reference when nothing changed.
 */
export function rebaseRelativeLinks(
  body: string,
  oldDir: string,
  newDir: string,
  movedFiles: ReadonlyMap<string, string>,
  movedDirs: ReadonlyMap<string, string> = new Map(),
  wiki?: Pick<WikiMoveContext, 'oldIndex' | 'newIndex'>,
): string {
  const rewritten = mapMarkdownLinks(body, (full: string, bracketText: string, hrefRaw: string) => {
    const trimmed = hrefRaw.trim();
    const spaceIdx = trimmed.search(/\s/);
    const pathPart = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
    const titleSuffix = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx);

    if (/^[a-z][a-z0-9+.-]*:/i.test(pathPart) || pathPart.startsWith('/')) return full;

    let p = pathPart;
    let hash = '';
    const hashIdx = p.indexOf('#');
    if (hashIdx !== -1) {
      hash = p.slice(hashIdx);
      p = p.slice(0, hashIdx);
    }
    let queryStr = '';
    const qIdx = p.indexOf('?');
    if (qIdx !== -1) {
      queryStr = p.slice(qIdx);
      p = p.slice(0, qIdx);
    }
    if (!p) return full; // pure #fragment link within the same page

    const resolvedOld = resolveRelative(oldDir, p);
    if (resolvedOld === null) return full; // already escaped the space: broken before the move, leave it
    const target = mapMovedPath(resolvedOld, movedFiles, movedDirs);
    if (resolveRelative(newDir, p) === target) return full; // still resolves to the right place as written

    let newHref = relativeHref(newDir, target) || '.';
    if (p.endsWith('/') && !newHref.endsWith('/')) newHref += '/';
    return `${bracketText}(${newHref}${queryStr}${hash}${titleSuffix})`;
  });
  if (!wiki) return rewritten;
  // A wikilink needs no change when its text still resolves to the target's new place (a bare `[[page]]` after a move almost always does); a path-style one follows its target or its moving source.
  return rewriteWikilinks(rewritten, {
    oldDir,
    newDir,
    oldIndex: wiki.oldIndex,
    newIndex: wiki.newIndex,
    mapTarget: (oldTarget) => mapMovedPath(oldTarget, movedFiles, movedDirs),
  });
}

/**
 * Belt-and-braces candidate sources for a move/rename: every doc in `space`
 * whose indexed text mentions the file name (or, for an index page, the
 * directory name) of any of `relPaths`, plus the base names of `dirs`. The link
 * index can lag behind the files (a source whose save is still debounced), so
 * the backlink list alone may miss a source; the rewriters are no-ops on a doc
 * where nothing resolves to a moved path, so over-selecting is harmless.
 */
export async function findDocsMentioning(space: string, relPaths: string[], dirs: string[] = []): Promise<string[]> {
  const names = new Set<string>(dirs.map((d) => d.split('/').pop() ?? '').filter(Boolean));
  // A wikilink names a page without its extension (`[[Old name]]`): candidates for those must also hold a `[[`, so a short stem does not drag in the whole space.
  const stems = new Set<string>();
  for (const rel of relPaths) {
    const parts = rel.split('/');
    const file = parts[parts.length - 1];
    if (file) names.add(file);
    if (/^(index|readme)\.mdx?$/i.test(file) && parts.length > 1) names.add(parts[parts.length - 2]);
    else if (/\.mdx?$/i.test(file) && file.length > '.md'.length) stems.add(file.replace(/\.mdx?$/i, ''));
  }
  if (names.size === 0 && stems.size === 0) return [];
  const like = (n: string) => `%${n.replace(/[\\%_]/g, '\\$&')}%`;
  const rows = await query<{ id: string }>(
    `SELECT id FROM pages_index
      WHERE space_slug = $1 AND kind = 'doc'
        AND (plain_text ILIKE ANY($2::text[]) OR (plain_text LIKE '%[[%' AND plain_text ILIKE ANY($3::text[])))`,
    [space, [...names].map(like), [...stems].map(like)],
  );
  return rows.map((r) => r.id);
}

/** Ids of docs in `space` with a non-page (asset) link resolving to `dir` or anything under it — the sources a directory move leaves dangling beyond the page backlinks. Read before the move: the index is stale-by-design after it. */
export async function getAssetLinkSources(space: string, dir: string): Promise<string[]> {
  if (!dir) return [];
  const rows = await query<{ id: string }>(
    `SELECT DISTINCT p.id
       FROM page_links l
       JOIN pages_index p ON p.id = l.source_page_id
      WHERE p.space_slug = $1 AND l.kind = 'asset'
        AND (l.target_path = $2 OR left(l.target_path, length($2) + 1) = $2 || '/')`,
    [space, dir],
  );
  return rows.map((r) => r.id);
}

/**
 * Every page OF THE TARGET'S SPACE that links TO `targetPageId` (resolved page
 * links only), one entry per page. INTERNAL: no visibility filtering — the
 * rename/move orchestration uses it to pick the documents whose relative links
 * it rewrites against that space's paths. A page of another space can link here
 * only by app URL (`/s/<space>/p/<id>`, which a move never breaks) and must not
 * be rewritten with this space's paths. Anything shown to a caller goes through
 * indexV2/read.ts getVisibleBacklinks (the SQL ACL fragment).
 */
export async function getBacklinks(targetPageId: string): Promise<PageMeta[]> {
  const rows = await query<BacklinkRow>(
    `SELECT DISTINCT p.id, p.space_slug, p.path, p.kind, p.title, p.sort_order, p.status, p.updated_at
       FROM page_links l
       JOIN pages_index p ON p.id = l.source_page_id
       JOIN pages_index t ON t.id = l.target_page_id
      WHERE l.target_page_id = $1 AND l.kind = 'page' AND p.space_slug = t.space_slug
      ORDER BY p.title`,
    [targetPageId],
  );
  return rows.map((r) => ({
    id: r.id,
    space: r.space_slug,
    path: r.path,
    kind: r.kind,
    title: r.title,
    order: r.sort_order ?? ORDER_SENTINEL,
    status: (r.status ?? 'published') as PageMeta['status'],
    updatedAt: new Date(r.updated_at).toISOString(),
  }));
}
