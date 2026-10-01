/**
 * Round 23 (EXPORT) — "which pages are in this export / what does this share
 * token actually cover", R23 addendum 2 points 2 and 4.
 *
 * TWO NORMATIVE CONSTRAINTS, both load-bearing:
 *
 * 1. "Walk the subtree with THE SAME function as the new `/api/pages/:id/subtree`
 *    (do not breed a second algorithm)." So this module never walks `pages_index`
 *    itself: it calls `storage.getSubtree()`, the exact function that route
 *    handler calls, and only stitches its results together. That function
 *    caps itself at storage.SUBTREE_MAX_DEPTH (5), which is a bound on the
 *    DIRECTIVE's needs, not on an export's — so for a node that comes back
 *    at that cap we call the SAME function again rooted at that node rather
 *    than reimplementing a deeper walk. One traversal algorithm, one place.
 *
 * 2. "The check is strict: membership in the subtree by the index, not by a
 *    prefix of the path string (otherwise `foo-bar.md` slips under a share of `foo`)." Membership
 *    is therefore a `Set<pageId>` built from the traversal above — there is
 *    deliberately no string comparison of `relPath` anywhere in this file.
 *    `foo-bar.md` is a SIBLING of `foo.md` in the index, so it is simply not
 *    in the set, no matter how its path spells.
 *
 * Collation order is whatever getSubtree already sorts by (frontmatter
 * `order`, then title) walked depth-first, parent emitted before its
 * children — again, so that an export and the sidebar can never disagree.
 */
import type { PageIndexEntry } from '../storage.js';
import * as storage from '../storage.js';
import { MAX_EXPORT_PAGES, pagesTruncation, type ExportTruncation } from './limits.js';

export interface ExportPage {
  entry: PageIndexEntry;
  /** 0 for the export's root page; +1 per level. Drives heading demotion. */
  depth: number;
}

export interface CollectedSubtree {
  /** Depth-first, parent before children, root first. Always non-empty (the root itself). */
  pages: ExportPage[];
  /** Set of every collected page id — THE membership check (see the module doc). */
  ids: Set<string>;
  /** Non-null when the 200-page cap cut the walk short. */
  truncation: ExportTruncation | null;
}

/** Just the root page — what an export without `includeChildren` collates. */
export function singlePage(entry: PageIndexEntry): CollectedSubtree {
  return { pages: [{ entry, depth: 0 }], ids: new Set([entry.id]), truncation: null };
}

/**
 * `root` plus every descendant, in collation order, capped at
 * MAX_EXPORT_PAGES (the root counts toward the cap). When the cap bites, the
 * walk stops and `truncation` reports how many pages were left out —
 * counting them requires finishing the traversal, so the walk keeps
 * *counting* after it stops *collecting*.
 */
export async function collectSubtree(root: PageIndexEntry, maxPages: number = MAX_EXPORT_PAGES, allowedPageIds?: ReadonlySet<string>): Promise<CollectedSubtree> {
  const pages: ExportPage[] = [{ entry: root, depth: 0 }];
  const ids = new Set<string>([root.id]);
  let omitted = 0;

  const entriesById = new Map((await storage.listEntries(root.space)).filter((e) => !allowedPageIds || allowedPageIds.has(e.id)).map((e) => [e.id, e]));

  async function walk(nodes: storage.SubtreeNode[], depth: number): Promise<void> {
    for (const node of nodes) {
      if (ids.has(node.id)) continue; // defensive: a cycle is unreachable through getSubtree, but never loop on one
      const entry = entriesById.get(node.id);
      if (!entry) continue; // indexed a moment ago, gone now — skip rather than fail the whole export

      ids.add(node.id);
      if (pages.length >= maxPages) omitted++;
      else pages.push({ entry, depth });

      if (node.children.length > 0) {
        await walk(node.children, depth + 1);
      } else if (depth >= storage.SUBTREE_MAX_DEPTH) {
        // getSubtree stopped at its OWN depth cap, not at a real leaf. Continue
        // with the same function rooted here (see constraint 1 above).
        await walk(await storage.getSubtree(entry, storage.SUBTREE_MAX_DEPTH, allowedPageIds), depth + 1);
      }
    }
  }

  await walk(await storage.getSubtree(root, storage.SUBTREE_MAX_DEPTH, allowedPageIds), 1);

  return { pages, ids, truncation: omitted > 0 ? pagesTruncation(omitted) : null };
}

/**
 * `collectSubtree` when `includeChildren`, `singlePage` otherwise — the one
 * decision point. `maxPages` exists so the cap itself is testable without
 * building a 201-page fixture; production always takes the default.
 */
export async function collectForExport(root: PageIndexEntry, includeChildren: boolean, maxPages?: number, allowedPageIds?: ReadonlySet<string>): Promise<CollectedSubtree> {
  return includeChildren ? collectSubtree(root, maxPages, allowedPageIds) : singlePage(root);
}

/**
 * R23 tail (child navigation in the public share view) — the `children` field
 * of SharedPagePayload, reconstructed as a TREE from an already-collected
 * subtree's flat list.
 *
 * Deliberately NOT another storage.getSubtree() walk: resolveShareScope has
 * already traversed exactly the granted set (constraint 1 above — one
 * traversal algorithm, one place), and deriving the tree from that same list
 * means the navigation a guest sees and the membership check their child
 * fetches go through (`collected.ids`) can never disagree. The list is
 * depth-first with every parent emitted before its children (collectSubtree's
 * contract), so one stack of "last node seen at each depth" rebuilds the
 * shape; the root itself (depth 0) is skipped — in the payload it is `page`,
 * not a child.
 *
 * When the 200-page cap truncated the collection, the tree is missing the
 * omitted pages, same as the collated export is — the guest can still open
 * them by id if they have a link, since membership (`ids`) keeps counting
 * past the cap.
 */
export function subtreeFromCollected(collected: CollectedSubtree): storage.SubtreeNode[] {
  const rootChildren: storage.SubtreeNode[] = [];
  /** parents[d] = the most recent node seen at depth d+1. */
  const parents: storage.SubtreeNode[] = [];

  for (const { entry, depth } of collected.pages) {
    if (depth === 0) continue;
    const node: storage.SubtreeNode = { id: entry.id, space: entry.space, path: entry.relPath, title: entry.title, children: [] };
    if (entry.icon) node.icon = entry.icon;
    if (depth === 1) rootChildren.push(node);
    else parents[depth - 2]?.children.push(node); // parent always exists (DFS order); `?.` is pure defence
    parents[depth - 1] = node;
    parents.length = depth; // drop stale deeper entries so a later sibling can't attach under them
  }

  return rootChildren;
}
