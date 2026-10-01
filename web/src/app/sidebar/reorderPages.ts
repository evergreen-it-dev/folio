import { officeFormat, type TreeNode } from '@shared/contracts';
import { dirname } from './treeUtils';

export type ReorderDirection = 'up' | 'down';

export interface ReorderPut {
  id: string;
  order: number;
}

const ORDER_STEP = 10;

/**
 * The wire value of "this node has no explicit order of its own". Two
 * different ones reach the client, both meaning the same thing:
 *
 *  - `0` — a real page the server has no stored order for. server/storage.ts's
 *    `toPageMeta` remaps its internal ORDER_SENTINEL down to 0 on the way out.
 *  - `Number.MAX_SAFE_INTEGER` — a SYNTHETIC folder node, which is built
 *    outside toPageMeta and so still carries the raw sentinel
 *    (server/storage.ts's buildDirNode).
 *
 * Everything the reorder code writes is a positive multiple of ORDER_STEP, so
 * "explicit" is exactly "strictly between the two".
 */
function hasExplicitOrder(node: TreeNode): boolean {
  return node.order > 0 && node.order < Number.MAX_SAFE_INTEGER;
}

/**
 * Visible, individually-orderable siblings within one directory: folder
 * pseudo-nodes (kind 'folder') are excluded — they're server-synthesized
 * listings with no real page id/order to persist (see TreeRow's own doc
 * comment on `isFolder`), and never show the "…" menu these actions live
 * in. Relative order among the remaining nodes is preserved exactly as the
 * caller's array has them, which `sortSiblings` below has already settled.
 */
function orderableSiblings(siblings: readonly TreeNode[]): TreeNode[] {
  return siblings.filter((n) => n.kind !== 'folder');
}

/**
 * The display order of ONE tree level, correcting the server's own sort.
 *
 * The server sorts each level by `(order, title)` with every unordered node
 * held at ORDER_SENTINEL, i.e. "after everything explicitly ordered". While
 * NOTHING at a level has an explicit order that degenerates to a plain
 * alphabetical sort, which is right. But the moment ONE page there is
 * reordered, every still-unordered sibling is flushed to the end of the
 * level — and a synthetic folder (a directory with no index.md) has no file
 * of its own to persist an order into, so it can never climb back out. QA-3
 * P1: moving a page one slot with "Down" teleported an untouched sibling
 * FOLDER from the top of the level to the bottom, permanently, with no
 * affordance anywhere in the UI to put it back.
 *
 * Fixing that where it is caused — assigning explicit orders to folders too —
 * is not possible for this shape: `PUT /api/pages/:id {order}` needs a real
 * page id and a real file, and a folder without index.md has neither (see
 * the server requirement noted in the QA report). So the client owns the
 * final say on display order instead, with the rule the server's sort was
 * already reaching for:
 *
 *   a node with no explicit order keeps the place its TITLE gives it,
 *   rather than being pushed behind every ordered sibling.
 *
 * Concretely: explicitly-ordered nodes keep the sequence the server sorted
 * them into (that IS the user's stored arrangement), and each unordered node
 * is spliced back in directly after whichever sibling precedes it
 * alphabetically — the same neighbour it sat behind before anything at the
 * level was ever reordered. Unordered nodes are placed in alphabetical order
 * themselves, so several of them sharing one anchor stay in a stable,
 * predictable sequence.
 *
 * Applied to every level as the tree is fetched (see api.getTree), so the
 * sibling arrays the reorder/drag math indexes into are the same arrays the
 * sidebar paints — the two must never disagree about what "one slot down"
 * means.
 */
export function sortSiblings(nodes: readonly TreeNode[]): TreeNode[] {
  const unordered = nodes.filter((n) => !hasExplicitOrder(n));
  // Nothing to re-anchor, or nothing to anchor AGAINST: in both cases the
  // server's own sort is already exactly this function's answer.
  if (unordered.length === 0 || unordered.length === nodes.length) return [...nodes];

  const byTitle = [...nodes].sort((a, b) => a.title.localeCompare(b.title));
  const result = nodes.filter(hasExplicitOrder);

  for (const node of byTitle.filter((n) => !hasExplicitOrder(n))) {
    // Nearest alphabetical predecessor that has already been placed — for
    // the first unordered node that is an ordered sibling; for later ones it
    // may be an earlier unordered node, which keeps runs of them together.
    let anchor = -1;
    for (let i = byTitle.indexOf(node) - 1; i >= 0; i--) {
      const at = result.findIndex((n) => n.id === byTitle[i]!.id);
      if (at !== -1) {
        anchor = at;
        break;
      }
    }
    result.splice(anchor + 1, 0, node);
  }
  return result;
}

/** `sortSiblings` applied to a whole tree, top level and every `children` array below it. */
export function sortTreeSiblings(nodes: readonly TreeNode[]): TreeNode[] {
  return sortSiblings(nodes).map((n) => (n.children.length > 0 ? { ...n, children: sortTreeSiblings(n.children) } : n));
}

/**
 * Assigns `order` values to `sequence` — the INTENDED final display order of
 * one directory's orderable siblings — and returns only the entries whose
 * value actually changes, so no caller ever PUTs a value a page already has.
 *
 * Fast path (the common case once a directory has been reordered before, or
 * was Confluence-imported — see server/confluenceImport.ts's own
 * `(index+1)*10` scheme): the group's existing `order` values are all
 * distinct, so they form a strictly increasing pool that can simply be
 * re-dealt onto the new arrangement. A pure permutation of values the group
 * already holds — for a one-slot move that is exactly a swap of two numbers,
 * and for a longer move it touches only the nodes actually stepped over.
 *
 * Renumber path: the pool isn't a usable set of slots to permute, either
 * because two values collide or because at least one of them is not an
 * explicit order at all (the server reports every unordered page as
 * `order: 0`; see `hasExplicitOrder` above). Re-dealing a pool of zeros
 * would be a silent no-op, and re-dealing a MIXED pool is worse: `0` is a
 * value in it, so the fast path would hand some page "unordered" and the
 * server would then sort that page to the end of the level — a page
 * teleporting away from the one being moved. The whole visible group is
 * renumbered to sequential multiples of `ORDER_STEP` instead, which both
 * breaks the tie and performs the move in one pass. Only the first reorder
 * in a never-fully-ordered directory pays for that.
 *
 * `movedId` only affects the ORDER OF THE RETURNED ARRAY on the fast path
 * (the moved page's own PUT is listed first) — every entry is an absolute
 * `{id, order}` assignment, so applying them in any sequence lands the same
 * final state.
 */
function assignOrders(sequence: readonly TreeNode[], movedId: string): ReorderPut[] {
  const currentOrderOf = new Map(sequence.map((n) => [n.id, n.order]));
  const pool = sequence.map((n) => n.order).sort((a, b) => a - b);
  const allDistinct = sequence.every(hasExplicitOrder) && pool.every((v, i) => i === 0 || v > pool[i - 1]!);

  if (!allDistinct) {
    return sequence
      .map((n, i) => ({ id: n.id, order: (i + 1) * ORDER_STEP }))
      .filter(({ id, order }) => currentOrderOf.get(id) !== order);
  }

  const puts = sequence.map((n, i) => ({ id: n.id, order: pool[i]! })).filter(({ id, order }) => currentOrderOf.get(id) !== order);
  return [...puts.filter((p) => p.id === movedId), ...puts.filter((p) => p.id !== movedId)];
}

/**
 * Moves `nodeId` to an arbitrary position among its orderable siblings —
 * the general operation the tree's drag-and-drop performs, and (via
 * `computeReorder` just below) the one the "…" menu's one-slot Up/Down
 * is a special case of.
 *
 * `toIndex` is the index the node should occupy in the list AFTER it has
 * been lifted out of its current slot (splice semantics), clamped into
 * range. Returns `[]` for a no-op, or when `nodeId` isn't among the
 * orderable siblings at all.
 */
export function computeMoveToIndex(siblings: readonly TreeNode[], nodeId: string, toIndex: number): ReorderPut[] {
  const list = orderableSiblings(siblings);
  const from = list.findIndex((n) => n.id === nodeId);
  if (from === -1) return [];
  const to = Math.min(Math.max(toIndex, 0), list.length - 1);
  if (to === from) return [];

  const sequence = [...list];
  const [moved] = sequence.splice(from, 1);
  sequence.splice(to, 0, moved!);
  return assignOrders(sequence, nodeId);
}

/**
 * Places a page ARRIVING from another directory at `insertIndex` among
 * `destSiblings` (which do not contain it yet) — the ordering half of a
 * drag that both reparents and positions.
 *
 * Always renumbers rather than re-dealing existing values the way
 * `assignOrders`' fast path does: the incoming page's own `order` was
 * meaningful only relative to the directory it came FROM, so there is no
 * coherent pool of n+1 values to permute. Entries already sitting on their
 * new number are still dropped, and a destination that ends up holding a
 * single page needs no explicit order at all.
 */
export function computeInsertOrders(destSiblings: readonly TreeNode[], node: TreeNode, insertIndex: number): ReorderPut[] {
  const list = orderableSiblings(destSiblings).filter((n) => n.id !== node.id);
  const at = Math.min(Math.max(insertIndex, 0), list.length);
  const sequence = [...list];
  sequence.splice(at, 0, node);
  if (sequence.length < 2) return [];
  return sequence.map((n, i) => ({ id: n.id, order: (i + 1) * ORDER_STEP })).filter(({ id, order }) => sequence.find((n) => n.id === id)!.order !== order);
}

/**
 * Whether `nodeId` can move one slot `direction` among its orderable
 * siblings — drives the Up/Down menu items' disabled state (DEV-PLAN Round
 * 22 SHELL-1: "The buttons are disabled at the edges").
 */
export function canReorder(siblings: readonly TreeNode[], nodeId: string, direction: ReorderDirection): boolean {
  const list = orderableSiblings(siblings);
  const i = list.findIndex((n) => n.id === nodeId);
  if (i === -1) return false;
  return direction === 'up' ? i > 0 : i < list.length - 1;
}

/**
 * The one-slot move behind the "…" menu's Up/Down — `computeMoveToIndex`
 * with a target index one step away, plus an explicit edge check so a move
 * past either end returns `[]` rather than being clamped back onto itself.
 * Callers should gate on `canReorder` first regardless (it also drives the
 * menu item's own disabled state).
 */
export function computeReorder(siblings: readonly TreeNode[], nodeId: string, direction: ReorderDirection): ReorderPut[] {
  const list = orderableSiblings(siblings);
  const i = list.findIndex((n) => n.id === nodeId);
  if (i === -1) return [];
  const j = direction === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= list.length) return [];
  return computeMoveToIndex(siblings, nodeId, j);
}

// ---------------------------------------------------------------------------
// Drag and drop
// ---------------------------------------------------------------------------

/** Where a dragged row would land relative to the row it is hovering over. */
export type DropZone = 'before' | 'after' | 'into';

/**
 * The row's top/bottom quarters mean "put it between rows here"; the middle
 * half means "put it inside this directory". A row that can't contain
 * anything (an ordinary leaf page, see `canContain`) splits 50/50 into
 * before/after instead, so its whole height stays a usable drop target.
 *
 * Split out of the event handler because it is the only part of the drag
 * that a mouse-less test can meaningfully exercise: jsdom reports a zero
 * rect for every element, which is also why the degenerate case has an
 * explicit answer rather than a NaN.
 */
export function dropZoneFor(rect: { top: number; height: number }, clientY: number, canDropInto: boolean): DropZone {
  if (!(rect.height > 0)) return canDropInto ? 'into' : 'before';
  const ratio = (clientY - rect.top) / rect.height;
  if (!canDropInto) return ratio < 0.5 ? 'before' : 'after';
  if (ratio < 0.25) return 'before';
  if (ratio > 0.75) return 'after';
  return 'into';
}

/**
 * Whether a row is a container other pages can be dropped INTO. In this
 * tree that means: a synthetic folder node, an index page, or any doc/board/
 * table leaf — even one with no children YET, since dropping into it just
 * creates its `X/` sibling directory on the spot (server/storage.ts's
 * movePage does a plain `mkdir -p` on the destination, so nothing has to
 * exist there beforehand). The one real exception is a pdf/office leaf: it
 * IS the owner's binary file (see storage.ts's "Binary page files"), so
 * there is no room next to it for a same-named child directory — it can be
 * dragged INTO another page, never contain one itself. Delegates to
 * `childContainerPath` below, which is the single source of truth for "what
 * directory would this drop actually land in".
 */
export function canContain(node: TreeNode): boolean {
  return childContainerPath(node) !== undefined;
}

function isIndexPath(path: string): boolean {
  return path === 'index.md' || path.endsWith('/index.md');
}

/** Filename stem using the same whole-suffix rules as server/storage.ts. */
function pageStem(node: TreeNode): string {
  const base = node.path.slice(node.path.lastIndexOf('/') + 1);
  if (node.kind === 'board') return base.slice(0, -'.excalidraw.svg'.length);
  if (node.kind === 'table') return base.slice(0, -'.table.md'.length);
  // Round FORMS (nesting fix): a form's paired table (or, symmetrically, a
  // table's paired form) is now that leaf's own CHILD page — see
  // server/storage.ts#createPage's 'form' branch / #createFormFromTable —
  // so a form must be drag-and-drop-container-capable too, same as
  // doc/board/table above it. Missing this left `canContain`/drop-into
  // silently wrong for a form (falling through to the generic `.md` strip
  // below, which only removes the extension, not the whole `.form.md`
  // suffix — the exact class of bug the whole-suffix comment on 'table'
  // above already exists to avoid).
  if (node.kind === 'form') return base.slice(0, -'.form.md'.length);
  if (node.kind === 'pdf') return base.slice(0, -'.pdf'.length);
  if (node.kind === 'office') {
    const fmt = officeFormat(base);
    if (fmt) return base.slice(0, -(fmt.length + 1));
  }
  return base.slice(0, -'.md'.length);
}

/**
 * The directory a node's own children live in — or WOULD live in, for a
 * doc/board/table leaf that doesn't own one yet (see `canContain` above:
 * that directory need not already exist, only be creatable). `undefined`
 * for a node that can never be a container: a pdf/office leaf, the owner's
 * own binary file with no room beside it for a same-named child directory.
 */
function childContainerPath(node: TreeNode): string | undefined {
  if (node.kind === 'folder') return node.path;
  if (isIndexPath(node.path)) return dirname(node.path);
  if (node.kind === 'pdf' || node.kind === 'office') return undefined;
  const dir = dirname(node.path);
  const stem = pageStem(node);
  return dir ? `${dir}/${stem}` : stem;
}

/** The directory a node itself OWNS, i.e. whose subtree it must never be moved into. Leaf pages own none. */
function ownDirOf(node: TreeNode): string | undefined {
  return childContainerPath(node);
}

export interface DropPlan {
  /** POST /api/pages/:id/move — omitted when the drop stays in the same directory. */
  move?: { id: string; toParentPath: string };
  /** PUT /api/pages/:id {order}, applied in array order. May be empty (a pure reparent). */
  orders: ReorderPut[];
}

export interface DropRequest {
  dragged: TreeNode;
  /** Directory `dragged`'s own file lives in (the level it is rendered at). */
  draggedParentPath: string;
  target: TreeNode;
  /** Directory `target`'s own file lives in. */
  targetParentPath: string;
  /** The array `target` is rendered from — its own tree level, `dragged` included when they are siblings. */
  targetSiblings: readonly TreeNode[];
  zone: DropZone;
}

/**
 * Turns one drop into the requests that carry it out, or `null` when the
 * drop must be REFUSED rather than approximated: onto itself, into its own
 * subtree, onto a folder pseudo-node's before/after (folders have no
 * persistable order of their own — see `orderableSiblings`), or a no-op.
 *
 * A `null` here is also what the row's dragover handler uses to decide
 * whether to show a drop indicator at all, so an illegal drop reads as
 * "not a target" under the cursor rather than failing after the fact.
 */
export function computeDropPlan({ dragged, draggedParentPath, target, targetParentPath, targetSiblings, zone }: DropRequest): DropPlan | null {
  if (dragged.kind === 'folder') return null; // a folder row is not itself draggable
  if (dragged.id === target.id) return null;
  if (zone !== 'into' && target.kind === 'folder') return null;

  const destParent = zone === 'into' ? childContainerPath(target) : targetParentPath;
  if (destParent === undefined) return null;

  // Never into its own subtree — the same guard server/storage.ts's movePage
  // enforces, applied up front so the row simply refuses the drop.
  const ownDir = ownDirOf(dragged);
  if (ownDir !== undefined && (destParent === ownDir || destParent.startsWith(`${ownDir}/`))) return null;

  const move = destParent === draggedParentPath ? undefined : { id: dragged.id, toParentPath: destParent };

  if (zone === 'into') {
    if (!move) return null; // already sits in that directory
    // Appended last, so the page turns up where it was dropped rather than
    // wherever its old, now-meaningless order happens to land it.
    const siblingsThere = target.children;
    return { move, orders: computeInsertOrders(siblingsThere, dragged, siblingsThere.length) };
  }

  const list = orderableSiblings(targetSiblings);
  const targetIndex = list.findIndex((n) => n.id === target.id);
  if (targetIndex === -1) return null;
  const insertAt = zone === 'before' ? targetIndex : targetIndex + 1;

  if (move) {
    return { move, orders: computeInsertOrders(targetSiblings, dragged, insertAt) };
  }

  // Same directory: a pure reorder. `insertAt` indexes the list as it stands
  // NOW, so drop one slot when the dragged row is being lifted out from
  // above the target — computeMoveToIndex's `toIndex` is post-removal.
  const from = list.findIndex((n) => n.id === dragged.id);
  const orders = computeMoveToIndex(targetSiblings, dragged.id, from !== -1 && from < insertAt ? insertAt - 1 : insertAt);
  return orders.length === 0 ? null : { orders };
}
