/**
 * Backlinks (beyond the DEV-PLAN text — coordinator addendum for round 4).
 * Extracts markdown links from a doc's body and mirrors them into the
 * `links` table: delete+reinsert per source page, called from storage.ts's
 * scanSpace (boot/rescan) and patchEntryContent (every write-back/mutation).
 *
 * Link classification, resolved against the source page's own directory
 * (same relative-path semantics as storage.ts's resolve()):
 *  - absolute URI scheme (http:, https:, mailto:, ...) -> 'external'
 *  - root-relative ("/...") -> 'external' (not resolvable against a space tree)
 *  - relative, resolves to a known page (.md path, or "<dir>/index.md" for a
 *    directory-style link) -> 'page', target_page_id set
 *  - relative .md path that does NOT resolve to a known page -> 'broken'
 *  - any other relative path (image, asset, etc.) -> 'asset'
 *
 * Not a full CommonMark parser — a pragmatic `[text](href "title")` /
 * `![alt](src)` regex, matching the level of markdown handling already used
 * elsewhere in this codebase (see storage.ts's extractH1).
 */
import type { PageMeta } from '../shared/contracts.js';
import { query, queryOne, withTransaction } from './db/pool.js';

const LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g;
const ORDER_SENTINEL = Number.MAX_SAFE_INTEGER;

function posixParent(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

/**
 * Same ".." collapsing as storage.ts's normalizeResolvePath, but never
 * throws — a malformed/escaping link is classified 'broken' instead of
 * aborting the whole reindex.
 */
function resolveRelative(baseDir: string, href: string): string | null {
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

function extractHrefs(body: string): string[] {
  const hrefs: string[] = [];
  const re = new RegExp(LINK_RE);
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const raw = m[1].trim();
    const first = raw.split(/\s+/)[0]; // drop an optional CommonMark `"title"` suffix
    if (first) hrefs.push(first);
  }
  return hrefs;
}

interface ParsedLink {
  targetPath: string;
  kind: 'page' | 'asset' | 'external' | 'broken';
  targetPageId: string | null;
}

async function classify(space: string, sourceDir: string, hrefRaw: string): Promise<ParsedLink | null> {
  let href = hrefRaw;
  const hashIdx = href.indexOf('#');
  if (hashIdx !== -1) href = href.slice(0, hashIdx);
  const qIdx = href.indexOf('?');
  if (qIdx !== -1) href = href.slice(0, qIdx);
  if (!href) return null; // pure #fragment link within the same page: not backlink-worthy

  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return { targetPath: hrefRaw, kind: 'external', targetPageId: null };
  if (href.startsWith('/')) return { targetPath: hrefRaw, kind: 'external', targetPageId: null };

  const resolved = resolveRelative(sourceDir, href);
  if (resolved === null) return { targetPath: hrefRaw, kind: 'broken', targetPageId: null };

  const isMdPath = /\.md$/i.test(resolved);
  const candidates = isMdPath ? [resolved] : [resolved, resolved ? `${resolved}/index.md` : 'index.md'];
  for (const candidate of candidates) {
    const row = await queryOne<{ id: string }>('SELECT id FROM pages_index WHERE space_slug = $1 AND path = $2', [space, candidate]);
    if (row) return { targetPath: resolved, kind: 'page', targetPageId: row.id };
  }
  return { targetPath: resolved, kind: isMdPath ? 'broken' : 'asset', targetPageId: null };
}

export async function reindexPageLinks(sourcePageId: string, space: string, sourceRelPath: string, body: string): Promise<void> {
  const sourceDir = posixParent(sourceRelPath);
  const hrefs = extractHrefs(body);
  const parsed: ParsedLink[] = [];
  for (const href of hrefs) {
    const link = await classify(space, sourceDir, href);
    if (link) parsed.push(link);
  }

  await withTransaction(async (client) => {
    await client.query('DELETE FROM links WHERE source_page_id = $1', [sourcePageId]);
    for (const link of parsed) {
      await client.query('INSERT INTO links (source_page_id, target_page_id, target_path, kind) VALUES ($1, $2, $3, $4)', [
        sourcePageId,
        link.targetPageId,
        link.targetPath,
        link.kind,
      ]);
    }
  });
}

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

const LINK_RE_CAPTURED = /(\[[^\]]*\])\(([^)]+)\)/g;

/**
 * Rewrites relative-markdown-link hrefs in `body` that resolve (from
 * `sourceDir`) to `oldTargetRelPath` so they instead resolve to
 * `newTargetRelPath` — used by collab.ts's slug-rename orchestration (round
 * 22) to keep every INCOMING link pointing at a renamed page/directory
 * working. `[[`-picked links are NOT a separate syntax to handle here:
 * per web/src/editor/wikilink.ts, `[[` is only an editor input affordance —
 * picking an entry always writes an ordinary relative markdown link, so the
 * file on disk never contains literal `[[...]]`. Mirrors classify()'s own
 * resolution rules exactly, including its asymmetric "an implicit bare-
 * directory link only ever resolves to `<dir>/index.md`, never README.md"
 * rule — so a link this function leaves untouched is provably one classify()
 * would also never have counted as a 'page' link to this target in the
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
export function rewriteRelativeLinks(body: string, sourceDir: string, oldTargetRelPath: string, newTargetRelPath: string): string {
  const oldIsIndexMd = /(^|\/)index\.md$/i.test(oldTargetRelPath);
  const oldDirForImplicit = oldIsIndexMd ? oldTargetRelPath.slice(0, -'/index.md'.length) : null;
  const newDirForImplicit = oldIsIndexMd ? newTargetRelPath.slice(0, -'/index.md'.length) : null;

  let changed = false;
  const rewritten = body.replace(LINK_RE_CAPTURED, (full: string, bracketText: string, hrefRaw: string) => {
    const trimmed = hrefRaw.trim();
    const spaceIdx = trimmed.search(/\s/);
    const pathPart = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
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

    let newHrefPath: string | null = null;
    if (resolved === oldTargetRelPath) {
      newHrefPath = relativeHref(sourceDir, newTargetRelPath);
    } else if (oldDirForImplicit !== null && newDirForImplicit !== null && resolved === oldDirForImplicit) {
      newHrefPath = relativeHref(sourceDir, newDirForImplicit) + (hadTrailingSlash ? '/' : '');
    }
    if (newHrefPath === null) return full;

    changed = true;
    return `${bracketText}(${newHrefPath}${queryStr}${hash}${titleSuffix})`;
  });

  return changed ? rewritten : body;
}

/** Every page that links TO `targetPageId` (kind='page' links only). No visibility filtering here — callers (routes.ts) intersect with the caller's visible spaces. */
export async function getBacklinks(targetPageId: string): Promise<PageMeta[]> {
  const rows = await query<BacklinkRow>(
    `SELECT DISTINCT p.id, p.space_slug, p.path, p.kind, p.title, p.sort_order, p.status, p.updated_at
       FROM links l
       JOIN pages_index p ON p.id = l.source_page_id
      WHERE l.target_page_id = $1
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
