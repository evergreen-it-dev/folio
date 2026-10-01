import { describe, expect, it } from 'vitest';
import type { PageKind, TreeNode } from '@shared/contracts';
import {
  canContain,
  canReorder,
  computeDropPlan,
  computeInsertOrders,
  computeMoveToIndex,
  computeReorder,
  dropZoneFor,
  sortSiblings,
  sortTreeSiblings,
} from './reorderPages';

function node(id: string, order: number, kind: PageKind = 'doc'): TreeNode {
  return { id, space: 'engineering', path: `${id}.md`, kind, title: id, order, status: 'published', updatedAt: '', children: [] };
}

describe('canReorder', () => {
  it('disables "up" for the first orderable sibling', () => {
    const siblings = [node('a', 10), node('b', 20), node('c', 30)];
    expect(canReorder(siblings, 'a', 'up')).toBe(false);
    expect(canReorder(siblings, 'a', 'down')).toBe(true);
  });

  it('disables "down" for the last orderable sibling', () => {
    const siblings = [node('a', 10), node('b', 20), node('c', 30)];
    expect(canReorder(siblings, 'c', 'down')).toBe(false);
    expect(canReorder(siblings, 'c', 'up')).toBe(true);
  });

  it('allows both directions for a middle sibling', () => {
    const siblings = [node('a', 10), node('b', 20), node('c', 30)];
    expect(canReorder(siblings, 'b', 'up')).toBe(true);
    expect(canReorder(siblings, 'b', 'down')).toBe(true);
  });

  it('disables both directions for a lone sibling', () => {
    const siblings = [node('a', 10)];
    expect(canReorder(siblings, 'a', 'up')).toBe(false);
    expect(canReorder(siblings, 'a', 'down')).toBe(false);
  });

  it('ignores folder pseudo-nodes when locating neighbors', () => {
    // "b" is the last ORDERABLE sibling even though a folder row visually follows it.
    const siblings = [node('a', 10), node('b', 20), node('dir:x', 30, 'folder')];
    expect(canReorder(siblings, 'b', 'down')).toBe(false);
  });

  it('returns false for an id not present among orderable siblings (e.g. a folder itself)', () => {
    const siblings = [node('a', 10), node('dir:x', 20, 'folder')];
    expect(canReorder(siblings, 'dir:x', 'down')).toBe(false);
    expect(canReorder(siblings, 'missing', 'down')).toBe(false);
  });
});

describe('computeReorder', () => {
  it('swaps just the two distinct order values (fast path, minimal PUTs)', () => {
    const siblings = [node('a', 10), node('b', 20), node('c', 30)];
    expect(computeReorder(siblings, 'a', 'down')).toEqual([
      { id: 'a', order: 20 },
      { id: 'b', order: 10 },
    ]);
  });

  it('swap works moving up too', () => {
    const siblings = [node('a', 10), node('b', 20), node('c', 30)];
    expect(computeReorder(siblings, 'c', 'up')).toEqual([
      { id: 'c', order: 20 },
      { id: 'b', order: 30 },
    ]);
  });

  it('returns [] past either edge', () => {
    const siblings = [node('a', 10), node('b', 20)];
    expect(computeReorder(siblings, 'a', 'up')).toEqual([]);
    expect(computeReorder(siblings, 'b', 'down')).toEqual([]);
  });

  it('returns [] for an id not among orderable siblings', () => {
    const siblings = [node('a', 10), node('b', 20)];
    expect(computeReorder(siblings, 'missing', 'down')).toEqual([]);
  });

  it('normalizes every visible sibling to sequential values on a tie (e.g. everyone unordered at 0), swapping the moved pair', () => {
    const siblings = [node('a', 0), node('b', 0), node('c', 0)];
    // Moving "a" down past "b": final display order should read b, a, c ->
    // sequential values 10, 20, 30 assigned in THAT sequence.
    expect(computeReorder(siblings, 'a', 'down')).toEqual([
      { id: 'b', order: 10 },
      { id: 'a', order: 20 },
      { id: 'c', order: 30 },
    ]);
  });

  it('on a tie, drops entries whose freshly-assigned value already matches (minimality)', () => {
    // "a" and "b" tie at 0 (the pair actually being swapped); "c" already
    // sits at the exact value normalization would give it (30) — it must
    // not be re-sent.
    const siblings = [node('a', 0), node('b', 0), node('c', 30)];
    expect(computeReorder(siblings, 'a', 'down')).toEqual([
      { id: 'b', order: 10 },
      { id: 'a', order: 20 },
    ]);
  });

  it('on a tie, renumbers the WHOLE visible group (not just the swapped pair), preserving the relative position of an untouched sibling', () => {
    // "b" (order 5) sits after tied "a"/"c" (both 0). Moving "a" down past
    // "c" forces a full-group renormalization (per DEV-PLAN: "normalize
    // the visible siblings to consecutive values") — "b" keeps its LAST
    // relative slot (still ordered after both), even though its own
    // absolute number necessarily changes (5 was only ever meaningful
    // relative to a/c's old zeros, not to their new tens/twenties).
    const siblings = [node('a', 0), node('c', 0), node('b', 5)];
    const plan = computeReorder(siblings, 'a', 'down');
    expect(plan).toEqual([
      { id: 'c', order: 10 },
      { id: 'a', order: 20 },
      { id: 'b', order: 30 },
    ]);
  });

  it('excludes folder pseudo-nodes from the normalized sequence entirely', () => {
    const siblings = [node('a', 0), node('b', 0), node('dir:x', 0, 'folder')];
    const plan = computeReorder(siblings, 'a', 'down');
    expect(plan.find((p) => p.id === 'dir:x')).toBeUndefined();
    expect(plan).toEqual([
      { id: 'b', order: 10 },
      { id: 'a', order: 20 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Drag and drop (the "…" menu's one-slot move generalized to a real drop)
// ---------------------------------------------------------------------------

function at(id: string, path: string, order = 0, kind: PageKind = 'doc', children: TreeNode[] = []): TreeNode {
  return { id, space: 'engineering', path, kind, title: id, order, status: 'published', updatedAt: '', children };
}
function folderAt(path: string, children: TreeNode[] = []): TreeNode {
  return at(`dir:${path}`, path, 0, 'folder', children);
}

describe('computeMoveToIndex', () => {
  it('moves a node several slots and touches only the siblings actually stepped over', () => {
    const siblings = [node('a', 10), node('b', 20), node('c', 30), node('d', 40), node('e', 50)];
    // a -> index 2: b and c each shift up one; d and e keep their own values.
    expect(computeMoveToIndex(siblings, 'a', 2)).toEqual([
      { id: 'a', order: 30 },
      { id: 'b', order: 10 },
      { id: 'c', order: 20 },
    ]);
  });

  it('moves a node backwards the same way', () => {
    const siblings = [node('a', 10), node('b', 20), node('c', 30), node('d', 40)];
    expect(computeMoveToIndex(siblings, 'd', 1)).toEqual([
      { id: 'd', order: 20 },
      { id: 'b', order: 30 },
      { id: 'c', order: 40 },
    ]);
  });

  it('clamps an out-of-range index rather than dropping the move', () => {
    const siblings = [node('a', 10), node('b', 20), node('c', 30)];
    expect(computeMoveToIndex(siblings, 'a', 99)).toEqual(computeMoveToIndex(siblings, 'a', 2));
    expect(computeMoveToIndex(siblings, 'c', -5)).toEqual(computeMoveToIndex(siblings, 'c', 0));
  });

  it('returns [] for a move onto the node\'s own index, and for an unknown id', () => {
    const siblings = [node('a', 10), node('b', 20)];
    expect(computeMoveToIndex(siblings, 'a', 0)).toEqual([]);
    expect(computeMoveToIndex(siblings, 'missing', 1)).toEqual([]);
  });

  it('normalizes the whole group when the values tie, wherever the node lands', () => {
    const siblings = [node('a', 0), node('b', 0), node('c', 0), node('d', 0)];
    expect(computeMoveToIndex(siblings, 'd', 0)).toEqual([
      { id: 'd', order: 10 },
      { id: 'a', order: 20 },
      { id: 'b', order: 30 },
      { id: 'c', order: 40 },
    ]);
  });

  it('skips folder pseudo-nodes when counting positions', () => {
    const siblings = [node('a', 10), node('dir:x', 15, 'folder'), node('b', 20), node('c', 30)];
    expect(computeMoveToIndex(siblings, 'a', 2)).toEqual([
      { id: 'a', order: 30 },
      { id: 'b', order: 10 },
      { id: 'c', order: 20 },
    ]);
  });
});

describe('computeInsertOrders (a page arriving from another directory)', () => {
  it('renumbers the destination so the new page lands exactly where it was dropped', () => {
    const dest = [node('x', 10), node('y', 20)];
    expect(computeInsertOrders(dest, node('new', 999), 1)).toEqual([
      { id: 'new', order: 20 },
      { id: 'y', order: 30 },
    ]);
  });

  it('appends at the end when asked for a past-the-end index', () => {
    const dest = [node('x', 10), node('y', 20)];
    expect(computeInsertOrders(dest, node('new', 0), 99)).toEqual([{ id: 'new', order: 30 }]);
  });

  it('needs no order at all when the destination ends up holding a single page', () => {
    expect(computeInsertOrders([], node('new', 0), 0)).toEqual([]);
    expect(computeInsertOrders([node('dir:x', 0, 'folder')], node('new', 0), 0)).toEqual([]);
  });

  it('ignores folder pseudo-nodes in the destination, and the node itself if already listed', () => {
    const dest = [node('dir:x', 0, 'folder'), node('x', 10), node('new', 5)];
    expect(computeInsertOrders(dest, node('new', 5), 0)).toEqual([
      { id: 'new', order: 10 },
      { id: 'x', order: 20 },
    ]);
  });
});

describe('dropZoneFor', () => {
  const rect = { top: 100, height: 40 };

  it('splits a container row into before / into / after', () => {
    expect(dropZoneFor(rect, 105, true)).toBe('before'); // top quarter
    expect(dropZoneFor(rect, 120, true)).toBe('into'); // middle half
    expect(dropZoneFor(rect, 138, true)).toBe('after'); // bottom quarter
  });

  it('splits a row that cannot contain anything 50/50, so its whole height stays a target', () => {
    expect(dropZoneFor(rect, 105, false)).toBe('before');
    expect(dropZoneFor(rect, 119, false)).toBe('before');
    expect(dropZoneFor(rect, 121, false)).toBe('after');
    expect(dropZoneFor(rect, 138, false)).toBe('after');
  });

  it('answers a degenerate (zero-height) rect instead of producing NaN', () => {
    expect(dropZoneFor({ top: 0, height: 0 }, 0, true)).toBe('into');
    expect(dropZoneFor({ top: 0, height: 0 }, 0, false)).toBe('before');
  });
});

describe('canContain', () => {
  it('is true for a folder pseudo-node and for the index page that stands in for a directory', () => {
    expect(canContain(folderAt('guides'))).toBe(true);
    expect(canContain(at('g', 'guides/index.md'))).toBe(true);
    expect(canContain(at('root', 'index.md'))).toBe(true);
  });

  it('is true for an ordinary doc/board/table leaf even with no children yet — dropping into it creates its X/ folder on the spot', () => {
    expect(canContain(at('a', 'guides/intro.md'))).toBe(true);
    expect(canContain(at('b', 'guides/board.excalidraw.svg', 0, 'board'))).toBe(true);
    expect(canContain(at('c', 'guides/data.table.md', 0, 'table'))).toBe(true);
    // not fooled by a filename that merely ENDS in "index.md" — still an ordinary doc leaf
    expect(canContain(at('d', 'guides/reindex.md'))).toBe(true);
  });

  it('is false for a pdf/office leaf — the owner\'s binary file has no room for a same-named child directory', () => {
    expect(canContain(at('p', 'guides/report.pdf', 0, 'pdf'))).toBe(false);
    expect(canContain(at('o', 'guides/plan.docx', 0, 'office'))).toBe(false);
  });

  it('is true for a same-named page that already owns a child directory', () => {
    expect(canContain(at('parent', 'parent.md', 0, 'doc', [at('child', 'parent/child.md')]))).toBe(true);
    expect(canContain(at('table', 'weekly.table.md', 0, 'table', [at('row', 'weekly/row.md')]))).toBe(true);
  });
});

describe('computeDropPlan', () => {
  const a = at('a', 'a.md', 10);
  const b = at('b', 'b.md', 20);
  const c = at('c', 'c.md', 30);
  const root = [a, b, c];

  const plan = (over: Partial<Parameters<typeof computeDropPlan>[0]>) =>
    computeDropPlan({ dragged: a, draggedParentPath: '', target: c, targetParentPath: '', targetSiblings: root, zone: 'after', ...over });

  it('reorders within one directory with no move request at all', () => {
    expect(plan({})).toEqual({
      orders: [
        { id: 'a', order: 30 },
        { id: 'b', order: 10 },
        { id: 'c', order: 20 },
      ],
    });
  });

  it('accounts for the dragged row being lifted out from ABOVE the target', () => {
    // "after b" for a row that currently sits before b is a real one-slot
    // move, not a no-op — and must not overshoot past c.
    expect(plan({ target: b, zone: 'after' })).toEqual({
      orders: [
        { id: 'a', order: 20 },
        { id: 'b', order: 10 },
      ],
    });
  });

  it('refuses a drop that would not move anything', () => {
    expect(plan({ target: a, zone: 'before' })).toBeNull(); // onto itself
    expect(plan({ target: a, zone: 'after' })).toBeNull();
    expect(plan({ target: b, zone: 'before' })).toBeNull(); // already directly before b
  });

  it('refuses before/after on a folder pseudo-node (it has no persistable order of its own)', () => {
    const guides = folderAt('guides', []);
    expect(plan({ target: guides, targetSiblings: [a, b, guides], zone: 'before' })).toBeNull();
    expect(plan({ target: guides, targetSiblings: [a, b, guides], zone: 'after' })).toBeNull();
  });

  it('drops INTO a folder as a move to that directory, appended last', () => {
    const g1 = at('g1', 'guides/g1.md', 0);
    const g2 = at('g2', 'guides/g2.md', 0);
    const guides = folderAt('guides', [g1, g2]);
    expect(plan({ target: guides, targetSiblings: [a, b, guides], zone: 'into' })).toEqual({
      move: { id: 'a', toParentPath: 'guides' },
      orders: [
        { id: 'g1', order: 10 },
        { id: 'g2', order: 20 },
        { id: 'a', order: 30 },
      ],
    });
  });

  it('drops INTO an index page as a move to the directory that page stands for', () => {
    const child = at('g1', 'guides/g1.md', 10);
    const guides = at('guides', 'guides/index.md', 40, 'doc', [child]);
    expect(plan({ target: guides, targetSiblings: [a, b, guides], zone: 'into' })).toEqual({
      move: { id: 'a', toParentPath: 'guides' },
      orders: [{ id: 'a', order: 20 }],
    });
  });

  it('drops INTO an X.md + X/ parent page without recreating a folder row', () => {
    const child = at('child', 'parent/child.md', 10);
    const parent = at('parent', 'parent.md', 40, 'doc', [child]);
    expect(plan({ target: parent, targetSiblings: [a, b, parent], zone: 'into' })).toEqual({
      move: { id: 'a', toParentPath: 'parent' },
      orders: [{ id: 'a', order: 20 }],
    });
  });

  it('moves AND positions when dropping between rows at another level', () => {
    const g1 = at('g1', 'guides/g1.md', 0);
    const g2 = at('g2', 'guides/g2.md', 0);
    expect(plan({ target: g2, targetParentPath: 'guides', targetSiblings: [g1, g2], zone: 'before' })).toEqual({
      move: { id: 'a', toParentPath: 'guides' },
      orders: [
        { id: 'g1', order: 10 },
        { id: 'a', order: 20 },
        { id: 'g2', order: 30 },
      ],
    });
  });

  it('refuses to drop a page into its own subtree', () => {
    const nested = at('n', 'guides/sub/n.md', 0);
    const sub = folderAt('guides/sub', [nested]);
    const guides = at('guides', 'guides/index.md', 10, 'doc', [sub]);
    const dragged = { dragged: guides, draggedParentPath: '' };

    // onto itself, into its own directory, into a directory below it, and
    // between two rows that live inside it — all refused.
    expect(plan({ ...dragged, target: guides, targetSiblings: [guides], zone: 'into' })).toBeNull();
    expect(plan({ ...dragged, target: sub, targetSiblings: [sub], zone: 'into' })).toBeNull();
    expect(plan({ ...dragged, target: nested, targetParentPath: 'guides/sub', targetSiblings: [nested], zone: 'before' })).toBeNull();

    // ...but moving it OUT, next to a root-level sibling, is perfectly fine.
    expect(plan({ ...dragged, target: a, targetParentPath: '', targetSiblings: [a, b, guides], zone: 'before' })?.orders).toBeDefined();
  });

  it('refuses to drop INTO a directory the page already lives in', () => {
    const g1 = at('g1', 'guides/g1.md', 10);
    const guides = folderAt('guides', [g1]);
    expect(plan({ dragged: g1, draggedParentPath: 'guides', target: guides, targetSiblings: [guides], zone: 'into' })).toBeNull();
  });

  it('drops INTO an ordinary leaf page — the dragged page becomes its child, in a freshly-created X/ folder', () => {
    // "c" (c.md) owns no c/ directory yet; the drop plan still targets it —
    // storage.movePage's mkdir -p creates the folder the moment this PUT lands.
    expect(plan({ target: c, zone: 'into' })).toEqual({
      move: { id: 'a', toParentPath: 'c' },
      orders: [],
    });
  });

  it('refuses to drop INTO a pdf/office leaf — it can never own a child directory', () => {
    const report = at('report', 'report.pdf', 40, 'pdf');
    expect(plan({ target: report, targetSiblings: [a, b, report], zone: 'into' })).toBeNull();
    const deck = at('deck', 'deck.pptx', 40, 'office');
    expect(plan({ target: deck, targetSiblings: [a, b, deck], zone: 'into' })).toBeNull();
  });

  it('never drags a folder pseudo-node', () => {
    const guides = folderAt('guides', []);
    expect(plan({ dragged: guides, draggedParentPath: '', target: a, zone: 'before' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Display order of one level (QA-3 P1: a folder sibling teleporting to the
// end of its level, permanently, when an unrelated page was reordered)
// ---------------------------------------------------------------------------

/** How server/storage.ts's buildDirNode serializes a directory with no index.md of its own. */
const SENTINEL = Number.MAX_SAFE_INTEGER;

function titled(id: string, title: string, order: number, kind: PageKind = 'doc', children: TreeNode[] = []): TreeNode {
  return { id, space: 'engineering', path: `${id}.md`, kind, title, order, status: 'published', updatedAt: '', children };
}
function dirNode(title: string, children: TreeNode[] = []): TreeNode {
  return { id: `dir:${title}`, space: 'engineering', path: title, kind: 'folder', title, order: SENTINEL, status: 'published', updatedAt: '', children };
}

describe('sortSiblings', () => {
  it('keeps a still-unordered folder in its alphabetical place once its page siblings get explicit orders', () => {
    // The exact QA-3 repro: "Aaa Sub" sorts first while everything is
    // unordered; moving qa3-jx down gives the two PAGES orders 10/20, and
    // the server then reports the folder last (sentinel). It belongs first.
    const level = [titled('jy', 'qa3-jy', 10), titled('jx', 'qa3-jx', 20), dirNode('Aaa Sub')];
    expect(sortSiblings(level).map((n) => n.title)).toEqual(['Aaa Sub', 'qa3-jy', 'qa3-jx']);
  });

  it('leaves a level alone when nothing in it has an explicit order', () => {
    // All unordered: the server's own title sort IS the answer, and this
    // must not silently re-alphabetize what it already decided.
    const level = [dirNode('Aaa Sub'), titled('jx', 'qa3-jx', 0), titled('jy', 'qa3-jy', 0)];
    expect(sortSiblings(level).map((n) => n.title)).toEqual(['Aaa Sub', 'qa3-jx', 'qa3-jy']);
  });

  it('leaves a fully ordered level exactly as the server sorted it', () => {
    const level = [titled('c', 'c', 10), titled('a', 'a', 20), titled('b', 'b', 30)];
    expect(sortSiblings(level).map((n) => n.title)).toEqual(['c', 'a', 'b']);
  });

  it('anchors an unordered node after the sibling it alphabetically follows, not at the end', () => {
    // "Mid" sorts between "alpha" and "zeta"; the two pages have been
    // reordered into zeta-then-alpha. "Mid" still follows "alpha".
    const level = [titled('z', 'zeta', 10), titled('a', 'alpha', 20), dirNode('Mid')];
    expect(sortSiblings(level).map((n) => n.title)).toEqual(['zeta', 'alpha', 'Mid']);
  });

  it('keeps several unordered siblings together and alphabetical behind one anchor', () => {
    const level = [titled('a', 'alpha', 10), titled('b', 'beta', 20), dirNode('alpha-sub'), titled('n', 'alpha-new', 0)];
    expect(sortSiblings(level).map((n) => n.title)).toEqual(['alpha', 'alpha-new', 'alpha-sub', 'beta']);
  });

  it('puts an unordered node with no alphabetical predecessor first', () => {
    const level = [titled('b', 'beta', 10), titled('c', 'gamma', 20), titled('a', 'alpha', 0)];
    expect(sortSiblings(level).map((n) => n.title)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('treats a page reported at order 0 as unordered, exactly like a sentinel folder', () => {
    // server/storage.ts's toPageMeta remaps ORDER_SENTINEL to 0 on the wire.
    const level = [titled('b', 'beta', 10), dirNode('gamma'), titled('a', 'alpha', 0)];
    expect(sortSiblings(level).map((n) => n.title)).toEqual(['alpha', 'beta', 'gamma']);
  });
});

describe('sortTreeSiblings', () => {
  it('applies the same rule to every level of the tree, not just the top one', () => {
    const tree = [
      titled('root', 'root', 0, 'doc', [
        titled('jy', 'qa3-jy', 10),
        titled('jx', 'qa3-jx', 20),
        dirNode('Aaa Sub', [titled('i2', 'inner-b', 10), titled('i1', 'inner-a', 20), dirNode('Aaa Deep')]),
      ]),
    ];
    const sorted = sortTreeSiblings(tree);
    expect(sorted[0]!.children.map((n) => n.title)).toEqual(['Aaa Sub', 'qa3-jy', 'qa3-jx']);
    expect(sorted[0]!.children[0]!.children.map((n) => n.title)).toEqual(['Aaa Deep', 'inner-b', 'inner-a']);
  });

  it('does not mutate the response it was given', () => {
    const level = [titled('jy', 'qa3-jy', 10), titled('jx', 'qa3-jx', 20), dirNode('Aaa Sub')];
    const tree = [titled('root', 'root', 0, 'doc', level)];
    sortTreeSiblings(tree);
    expect(tree[0]!.children.map((n) => n.title)).toEqual(['qa3-jy', 'qa3-jx', 'Aaa Sub']);
  });
});

describe('a reorder never hands a page the "unordered" value 0', () => {
  it('renumbers the whole group when the pool mixes explicit orders with unordered zeros', () => {
    // Reordering two pages, then creating a third, is the ordinary way a
    // level ends up mixed. Re-dealing the pool [0, 10, 20] would have given
    // some page order 0 — i.e. "unordered" — and the server would then have
    // sorted THAT page to the end of the level instead of where it was put.
    const siblings = [node('a', 10), node('b', 20), node('fresh', 0)];
    const plan = computeReorder(siblings, 'a', 'down');
    expect(plan.every((p) => p.order > 0)).toBe(true);
    expect(plan).toEqual([
      { id: 'b', order: 10 },
      { id: 'a', order: 20 },
      { id: 'fresh', order: 30 },
    ]);
  });

  it('the resulting arrangement survives a tree rebuild (server re-sorts, client re-anchors)', () => {
    const folder = dirNode('Aaa Sub');
    const level = [folder, titled('jx', 'qa3-jx', 0), titled('jy', 'qa3-jy', 0)];
    const plan = computeReorder(level, 'jx', 'down');

    // Replay the PUTs, then rebuild the level the way the server would:
    // sort by (order, title) with every unordered node held at the sentinel.
    const applied = level.map((n) => {
      const put = plan.find((p) => p.id === n.id);
      return put ? { ...n, order: put.order } : n;
    });
    const fromServer = [...applied].sort(
      (a, b) => (a.order || SENTINEL) - (b.order || SENTINEL) || a.title.localeCompare(b.title),
    );
    expect(fromServer.map((n) => n.title)).toEqual(['qa3-jy', 'qa3-jx', 'Aaa Sub']); // what the server hands back

    // ...and what the sidebar actually paints: the move landed, the folder stayed put.
    expect(sortSiblings(fromServer).map((n) => n.title)).toEqual(['Aaa Sub', 'qa3-jy', 'qa3-jx']);
  });
});
