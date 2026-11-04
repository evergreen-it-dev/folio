/**
 * Graph view (16.10.2026): the links of a space as nodes and edges, for
 * GET /api/spaces/:space/graph (the whole space), GET /api/pages/:id/graph
 * (the neighbourhood of one page, depth 1..3) and MCP get_graph.
 *
 * Built only from the page index (index v2): pages_index, page_links (resolved
 * kind page / asset / unresolved), page_tags. Every read is a fixed number of
 * set-based queries — no query per page — so a space of 5–10k pages answers
 * in well under a second.
 *
 * Access is accessSql.ts's visiblePagesSql, the same rules as search:
 *  - a node is a page the caller may open; `_templates/` and folder rows are
 *    never nodes;
 *  - a link to a page the caller may NOT open is left out entirely — no node,
 *    no ghost, no edge, not counted in a degree. (getPageLinks reports such a
 *    link as "unresolved" with the path as written; the graph shows nothing,
 *    so a ghost cannot hint that a closed page exists.) Only links the index
 *    itself found no target for become ghost nodes;
 *  - tags, files and ghosts hang off readable pages only, so a tag used only
 *    on closed pages is not a node.
 *
 * Across spaces (16.10.2026): a Folio app link (`/s/<space>/p/<id>`) may reach a
 * page of another space. Such a target is a node when the caller may open it —
 * marked with its `space` / `spaceName` — and is left out like any closed page
 * when they may not. The space graph shows the pages its pages link OUT to; the
 * local graph also the pages of other spaces that link IN, never walking on from
 * them (a neighbourhood stays around its own space).
 *
 * Tree structure (option `tree`): parent → child edges of the page tree
 * (`kind: 'tree'`), built the way storage.ts getTree nests pages — a folder's
 * index.md / README.md, or the same-named `X.md` next to `X/`, is the parent of
 * what lies in the folder; a folder with no page of its own hands its pages to
 * the nearest page above it; the space home (root index.md) is the parent of
 * the root pages. Computed over the pages the caller may read, like the tree.
 */
import type { GraphDirection, GraphEdge, GraphNode, GraphOptions, GraphResponse, PageKind, PageStatus } from '../shared/contracts.js';
import { GRAPH_PAGE_LIMIT } from '../shared/contracts.js';
import { query } from './db/pool.js';
import { sqlParam, visiblePagesSql, type PageViewer } from './accessSql.js';
import { relPathStem } from './storage.js';

export const DEFAULT_GRAPH_OPTIONS: GraphOptions = { tags: false, files: false, unresolved: false, orphans: true, tree: false };

export const GRAPH_MAX_DEPTH = 3;

/** `1`/`true`/`yes`/`on` → true, `0`/`false`/`no`/`off` → false, anything else → `fallback`. */
export function parseFlag(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw !== 'string') return fallback;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

/** The query string (or MCP arguments) → GraphOptions. */
export function parseGraphOptions(raw: Record<string, unknown> | null | undefined): GraphOptions {
  const q = raw ?? {};
  return {
    tags: parseFlag(q.tags, DEFAULT_GRAPH_OPTIONS.tags),
    files: parseFlag(q.files, DEFAULT_GRAPH_OPTIONS.files),
    unresolved: parseFlag(q.unresolved, DEFAULT_GRAPH_OPTIONS.unresolved),
    orphans: parseFlag(q.orphans, DEFAULT_GRAPH_OPTIONS.orphans),
    tree: parseFlag(q.tree, DEFAULT_GRAPH_OPTIONS.tree),
  };
}

/** `?depth=` → 1..3, default 1. */
export function clampDepth(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return 1;
  return Math.min(GRAPH_MAX_DEPTH, Math.max(1, Math.floor(n)));
}

/** `?direction=` → both | in | out, default both. */
export function parseDirection(raw: unknown): GraphDirection {
  return raw === 'in' || raw === 'out' ? raw : 'both';
}

/** A cap on pages per answer: 1..GRAPH_PAGE_LIMIT, default GRAPH_PAGE_LIMIT. */
export function clampGraphLimit(raw: unknown, fallback = GRAPH_PAGE_LIMIT): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(GRAPH_PAGE_LIMIT, Math.max(1, Math.floor(n)));
}

interface PageRow {
  id: string;
  title: string;
  kind: PageKind;
  path: string;
  status: PageStatus | null;
  updated_at: string | Date;
  space_slug: string;
  is_index: boolean;
}

const PAGE_COLUMNS = 'p.id, p.title, p.kind, p.path, p.status, p.updated_at, p.space_slug, p.is_index';

function posixParent(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

/** A page as the tree sees it. */
export interface TreePage {
  id: string;
  path: string;
  kind: PageKind;
  is_index: boolean;
}

/**
 * Child id → parent id for `pages` (one space), nesting them like storage.ts getTree: the page of a folder is its
 * index page (index.md, or README.md when the scan made it the index) or, failing that, the one page `X.md` /
 * `X.table.md` / … whose stem names the folder `X/`; a page's parent is the page of the nearest folder above it
 * that has one (the root's is the space home). Pages without a parent (the home, or a space without one) are absent.
 */
export function treeParents(pages: readonly TreePage[]): Map<string, string> {
  const dirOf = (p: TreePage) => posixParent(p.path);
  const pageOfDir = new Map<string, string>();
  for (const p of pages) if (p.is_index) pageOfDir.set(dirOf(p), p.id);
  // Folders that hold something: only those can be claimed by a same-named page.
  const usedDirs = new Set<string>();
  for (const p of pages) {
    for (let d = dirOf(p); d !== '' && !usedDirs.has(d); d = posixParent(d)) usedDirs.add(d);
  }
  const claims = new Map<string, string[]>();
  for (const p of pages) {
    if (p.is_index) continue;
    const dir = dirOf(p);
    const stem = relPathStem(p.path, p.kind);
    const candidate = dir ? `${dir}/${stem}` : stem;
    if (!usedDirs.has(candidate) || pageOfDir.has(candidate)) continue;
    const list = claims.get(candidate) ?? [];
    list.push(p.id);
    claims.set(candidate, list);
  }
  for (const [dir, ids] of claims) if (ids.length === 1) pageOfDir.set(dir, ids[0]);

  const parents = new Map<string, string>();
  for (const p of pages) {
    // An index page stands for its folder: its parent is found from the folder above.
    if (p.is_index && dirOf(p) === '') continue;
    let d: string | null = p.is_index ? posixParent(dirOf(p)) : dirOf(p);
    while (d !== null) {
      const owner = pageOfDir.get(d);
      if (owner !== undefined && owner !== p.id) {
        parents.set(p.id, owner);
        break;
      }
      d = d === '' ? null : posixParent(d);
    }
  }
  return parents;
}

/** Tree edges among `ids` (parent → child), from a parent map. */
function treeEdges(parents: Map<string, string>, ids: ReadonlySet<string>): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const [child, parent] of parents) {
    if (ids.has(child) && ids.has(parent)) edges.push({ source: parent, target: child, count: 1, kind: 'tree' });
  }
  return edges;
}

/** The readable pages of `space` as the tree sees them (no templates, no folders) — for the tree option. */
async function readableTreePages(space: string, viewer: PageViewer): Promise<TreePage[]> {
  const params: unknown[] = [space];
  const visible = visiblePagesSql('p', viewer, params, { excludeTemplates: true });
  return query<TreePage>(`SELECT p.id, p.path, p.kind, p.is_index FROM pages_index p WHERE p.space_slug = $1 AND p.kind <> 'folder' AND ${visible}`, params);
}

/** Names of `slugs` (spaces of cross-space nodes). */
async function spaceNames(slugs: string[]): Promise<Map<string, string>> {
  if (slugs.length === 0) return new Map();
  const rows = await query<{ slug: string; name: string }>('SELECT slug, name FROM spaces WHERE slug = ANY($1::text[])', [slugs]);
  return new Map(rows.map((r) => [r.slug, r.name]));
}

/** The title of a node that is not a page: a file's name, an unresolved target's name without `.md`. */
function baseName(path: string, stripMd: boolean): string {
  const name = path.slice(path.lastIndexOf('/') + 1) || path;
  return stripMd ? name.replace(/\.mdx?$/i, '') : name;
}

/**
 * Nodes and edges for an already ACL-checked set of pages (`pages`, in the order the answer keeps): page→page
 * edges inside the set, the pages' tags, and — per `options` — tag, file and ghost nodes. Four queries at most.
 */
async function buildGraph(
  pages: PageRow[],
  options: GraphOptions,
  home: { space: string; parents?: Map<string, string> },
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const ids = pages.map((p) => p.id);
  if (ids.length === 0) return { nodes: [], edges: [] };
  // Tags, files and ghosts belong to the graph's own space: a page of another space is a node, nothing hangs off it.
  const homeIds = pages.filter((p) => p.space_slug === home.space).map((p) => p.id);

  const linkRows = await query<{ s: string; t: string; n: number }>(
    `SELECT l.source_page_id AS s, l.target_page_id AS t, COUNT(*)::int AS n
       FROM page_links l
       JOIN unnest($1::text[]) AS vs(id) ON vs.id = l.source_page_id
       JOIN unnest($1::text[]) AS vt(id) ON vt.id = l.target_page_id
      WHERE l.kind = 'page' AND l.source_page_id <> l.target_page_id
      GROUP BY 1, 2`,
    [ids],
  );
  const tagRows = await query<{ page_id: string; tag: string }>(
    `SELECT DISTINCT t.page_id, t.tag FROM page_tags t JOIN unnest($1::text[]) AS v(id) ON v.id = t.page_id ORDER BY 1, 2`,
    [homeIds],
  );
  const extraKinds = [options.files ? 'asset' : null, options.unresolved ? 'unresolved' : null].filter((k): k is string => k !== null);
  const extraRows = extraKinds.length
    ? await query<{ s: string; kind: 'asset' | 'unresolved'; path: string; n: number }>(
        `SELECT l.source_page_id AS s, l.kind, l.target_path AS path, COUNT(*)::int AS n
           FROM page_links l
           JOIN unnest($1::text[]) AS v(id) ON v.id = l.source_page_id
          WHERE l.kind = ANY($2::text[]) AND l.target_path <> ''
          GROUP BY 1, 2, 3`,
        [homeIds, extraKinds],
      )
    : [];

  const tagsOf = new Map<string, string[]>();
  for (const r of tagRows) {
    const list = tagsOf.get(r.page_id);
    if (list) list.push(r.tag);
    else tagsOf.set(r.page_id, [r.tag]);
  }

  const names = await spaceNames([...new Set(pages.filter((p) => p.space_slug !== home.space).map((p) => p.space_slug))]);
  const nodes: GraphNode[] = pages.map((p) => ({
    id: p.id,
    title: p.title,
    kind: p.kind,
    path: p.path,
    tags: tagsOf.get(p.id) ?? [],
    status: (p.status ?? 'published') as PageStatus,
    degree: 0,
    updatedAt: new Date(p.updated_at).toISOString(),
    ...(p.space_slug !== home.space ? { space: p.space_slug, spaceName: names.get(p.space_slug) ?? p.space_slug } : {}),
  }));
  const edges: GraphEdge[] = linkRows.map((r) => ({ source: r.s, target: r.t, count: r.n }));
  if (options.tree && home.parents) edges.push(...treeEdges(home.parents, new Set(homeIds)));

  if (options.tags) {
    const seen = new Set<string>();
    for (const r of tagRows) {
      const id = `tag:${r.tag}`;
      if (!seen.has(id)) {
        seen.add(id);
        nodes.push({ id, title: `#${r.tag}`, kind: 'tag', degree: 0 });
      }
      edges.push({ source: r.page_id, target: id, count: 1 });
    }
  }
  const extraSeen = new Set<string>();
  for (const r of extraRows) {
    const id = `${r.kind === 'asset' ? 'file' : 'ghost'}:${r.path}`;
    if (!extraSeen.has(id)) {
      extraSeen.add(id);
      nodes.push({ id, title: baseName(r.path, r.kind === 'unresolved'), kind: r.kind === 'asset' ? 'file' : 'unresolved', path: r.path, degree: 0 });
    }
    edges.push({ source: r.s, target: id, count: r.n });
  }

  // Degree = distinct neighbours, both directions.
  const neighbours = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    let set = neighbours.get(a);
    if (!set) neighbours.set(a, (set = new Set()));
    set.add(b);
  };
  for (const e of edges) {
    link(e.source, e.target);
    link(e.target, e.source);
  }
  for (const n of nodes) n.degree = neighbours.get(n.id)?.size ?? 0;

  if (!options.orphans) return { nodes: nodes.filter((n) => n.degree > 0), edges };
  return { nodes, edges };
}

/** GET /api/spaces/:space/graph and MCP get_graph without a page: every page of the space the viewer may read. */
export async function getSpaceGraph(space: string, viewer: PageViewer, options: GraphOptions, limit = GRAPH_PAGE_LIMIT): Promise<GraphResponse> {
  const params: unknown[] = [space];
  const visible = visiblePagesSql('p', viewer, params, { excludeTemplates: true });
  const cap = sqlParam(params, limit);
  const rows = await query<PageRow & { total: number }>(
    `SELECT ${PAGE_COLUMNS}, COUNT(*) OVER ()::int AS total
       FROM pages_index p
      WHERE p.space_slug = $1 AND p.kind <> 'folder' AND ${visible}
      ORDER BY p.updated_at DESC, p.id
      LIMIT ${cap}`,
    params,
  );
  const totalPages = rows[0]?.total ?? 0;
  // Pages of other spaces these pages link to by app URL, when the viewer may open them.
  const crossParams: unknown[] = [rows.map((r) => r.id), space];
  const crossVisible = visiblePagesSql('p', viewer, crossParams, { excludeTemplates: true });
  const cross = rows.length
    ? await query<PageRow>(
        `SELECT DISTINCT ${PAGE_COLUMNS}
           FROM page_links l
           JOIN unnest($1::text[]) AS v(id) ON v.id = l.source_page_id
           JOIN pages_index p ON p.id = l.target_page_id
          WHERE l.kind = 'page' AND p.space_slug <> $2 AND p.kind <> 'folder' AND ${crossVisible}
          ORDER BY p.space_slug, p.path`,
        crossParams,
      )
    : [];
  const parents = options.tree ? treeParents(rows) : undefined;
  const graph = await buildGraph([...rows, ...cross], options, { space, parents });
  return { ...graph, totalPages, truncated: totalPages > rows.length, limit };
}

/**
 * The readable pages one hop from `frontier` in `direction` (excluding `known`), in any space (an app link reaches
 * across spaces); `space_slug` tells the caller which ones it may walk on from. One query: the ACL is applied only to
 * the far end of each link — the frontier is already known to be readable.
 */
async function neighboursOf(frontier: string[], direction: GraphDirection, viewer: PageViewer): Promise<Array<{ id: string; space_slug: string }>> {
  const parts: string[] = [];
  const params: unknown[] = [frontier];
  if (direction !== 'in') {
    const visible = visiblePagesSql('p', viewer, params, { excludeTemplates: true });
    parts.push(
      `SELECT l.target_page_id AS id, p.space_slug FROM page_links l JOIN pages_index p ON p.id = l.target_page_id
        WHERE l.kind = 'page' AND l.source_page_id = ANY($1::text[]) AND p.kind <> 'folder' AND ${visible}`,
    );
  }
  if (direction !== 'out') {
    const visible = visiblePagesSql('p', viewer, params, { excludeTemplates: true });
    parts.push(
      `SELECT l.source_page_id AS id, p.space_slug FROM page_links l JOIN pages_index p ON p.id = l.source_page_id
        WHERE l.kind = 'page' AND l.target_page_id = ANY($1::text[]) AND p.kind <> 'folder' AND ${visible}`,
    );
  }
  return query<{ id: string; space_slug: string }>(parts.join('\nUNION\n'), params);
}

/**
 * GET /api/pages/:id/graph and MCP get_graph with a page: the page (already checked by the caller) and the
 * readable pages within `depth` link hops of it, following links out of, into, or both ways from each page.
 * The edges are every link among those pages, not only the hops that found them.
 */
export async function getLocalGraph(
  center: { id: string; space: string },
  viewer: PageViewer,
  opts: { depth: number; direction: GraphDirection; options: GraphOptions; limit?: number },
): Promise<GraphResponse> {
  const limit = opts.limit ?? GRAPH_PAGE_LIMIT;
  const order: string[] = [center.id];
  const known = new Set(order);
  // The tree option: parent and children are neighbours too (the siblings a hop further, through the parent).
  const parents = opts.options.tree ? treeParents(await readableTreePages(center.space, viewer)) : undefined;
  const childrenOf = new Map<string, string[]>();
  if (parents) {
    for (const [child, parent] of parents) {
      const list = childrenOf.get(parent);
      if (list) list.push(child);
      else childrenOf.set(parent, [child]);
    }
  }
  let frontier = [center.id];
  for (let level = 0; level < opts.depth && frontier.length > 0 && known.size < limit + 1; level++) {
    const next: string[] = [];
    const found = await neighboursOf(frontier, opts.direction, viewer);
    if (parents) {
      for (const id of frontier) {
        const parent = parents.get(id);
        if (parent) found.push({ id: parent, space_slug: center.space });
        for (const child of childrenOf.get(id) ?? []) found.push({ id: child, space_slug: center.space });
      }
    }
    for (const { id, space_slug } of found) {
      if (known.has(id)) continue;
      known.add(id);
      order.push(id);
      // A page of another space is shown, never walked on from: the neighbourhood stays around this space.
      if (space_slug === center.space) next.push(id);
    }
    frontier = next;
  }
  const totalPages = order.length;
  const kept = order.slice(0, limit);

  // Re-read the kept pages with the ACL once more (the centre without the template rule: the caller opened it).
  const params: unknown[] = [kept];
  const visible = visiblePagesSql('p', viewer, params);
  const rows = await query<PageRow>(`SELECT ${PAGE_COLUMNS} FROM pages_index p WHERE p.id = ANY($1::text[]) AND p.kind <> 'folder' AND ${visible}`, params);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const pages = kept.map((id) => byId.get(id)).filter((r): r is PageRow => r !== undefined);
  const graph = await buildGraph(pages, { ...opts.options, orphans: true }, { space: center.space, parents });
  // A neighbourhood always keeps its centre; `orphans: false` drops only what hangs on nothing.
  const nodes = opts.options.orphans ? graph.nodes : graph.nodes.filter((n) => n.degree > 0 || n.id === center.id);
  return { nodes, edges: graph.edges, totalPages, truncated: totalPages > kept.length, limit, center: center.id };
}
