/**
 * Local pages in the sidebar tree.
 *
 * The tree the server sends cannot contain a page it has never heard of, so
 * pages created offline are laid into it here, on the client, in the same
 * place the server will put them once they sync: under the node whose child
 * directory is the page's `parentPath`, last among its siblings. A parent
 * that is itself local is found the same way — it was laid in one step
 * earlier (pages are merged oldest first, and a parent always predates its
 * child).
 *
 * Pure, and it never mutates the tree it is given: that object is
 * react-query's cache entry.
 */
import type { TreeNode } from '@shared/contracts';
import type { TreeResponse } from '../api';
import { childDirOf } from '../sidebar/treeUtils';
import { localPageMeta, type LocalPage } from './localPages';

function toNode(page: LocalPage): TreeNode {
  return { ...localPageMeta(page), children: [] };
}

/** A copy of `nodes` with `child` appended under the node whose child directory is `dir`; `null` when no node owns that directory. */
function insertUnder(nodes: readonly TreeNode[], dir: string, child: TreeNode): TreeNode[] | null {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (childDirOf(node) === dir && (node.kind !== 'folder' || node.path === dir)) {
      const next = [...nodes];
      next[i] = { ...node, children: [...node.children, child] };
      return next;
    }
    const inner = insertUnder(node.children, dir, child);
    if (inner) {
      const next = [...nodes];
      next[i] = { ...node, children: inner };
      return next;
    }
  }
  return null;
}

/** Where top-level pages live in this response's shape — mirrors `getTopLevelNodes` (treeUtils.ts). */
function appendTopLevel(tree: readonly TreeNode[], child: TreeNode): TreeNode[] {
  const single = tree.length === 1 ? tree[0] : undefined;
  const wrapsRoot =
    single !== undefined &&
    ((single.kind === 'folder' && single.path === '') || (single.path === 'index.md' && single.children.length > 0));
  if (wrapsRoot) return [{ ...single, children: [...single.children, child] }];
  return [...tree, child];
}

export function mergeLocalPages(data: TreeResponse, locals: readonly LocalPage[], space: string): TreeResponse {
  const mine = locals.filter((page) => page.space === space);
  if (mine.length === 0) return data;
  let tree: TreeNode[] = [...data.tree];
  const present = new Set<string>();
  const collect = (nodes: readonly TreeNode[]) => {
    for (const node of nodes) {
      present.add(node.id);
      collect(node.children);
    }
  };
  collect(tree);
  for (const page of mine) {
    // Already in the server's tree: it synced, and the registry entry is a
    // moment away from being removed. Never show it twice.
    if (present.has(page.id)) continue;
    const node = toNode(page);
    const placed = page.parentPath === '' ? null : insertUnder(tree, page.parentPath, node);
    // A parent directory nobody owns (the parent was deleted elsewhere while
    // this device was offline): the page is still the author's work and
    // still has to be reachable — it surfaces at the top level.
    tree = placed ?? appendTopLevel(tree, node);
    present.add(page.id);
  }
  return { ...data, tree };
}
