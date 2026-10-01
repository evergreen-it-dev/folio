import { describe, expect, it } from 'vitest';
import type { PageKind, TreeNode } from '@shared/contracts';
import {
  collectDirectories,
  dirname,
  excludeTemplatesFolder,
  childDirOf,
  findNode,
  findNodeByPath,
  findSpaceRootPage,
  getTemplatePages,
  getTopLevelNodes,
  isContainerNode,
  plusTargetDirFor,
  resolvePlusTargetDir,
  siblingsAtDir,
  treeNodeDisplayTitle,
} from './treeUtils';

function node(id: string, path: string, children: TreeNode[] = [], kind: PageKind = 'doc'): TreeNode {
  return { id, space: 'engineering', path, kind, title: id, order: 0, status: 'published', updatedAt: '', children };
}

describe('dirname', () => {
  it('mirrors markdown/resolvePath.dirOf', () => {
    expect(dirname('index.md')).toBe('');
    expect(dirname('architecture/index.md')).toBe('architecture');
  });
});

describe('treeNodeDisplayTitle', () => {
  it('uses distinct filenames when sibling files have the same internal H1', () => {
    const first = { ...node('one', 'approvepartners/first.md'), title: 'Client Health Check — ApprovePartners' };
    const second = { ...node('two', 'approvepartners/second.md'), title: 'Client Health Check — ApprovePartners' };
    expect(treeNodeDisplayTitle(first, [first, second])).toBe('first');
    expect(treeNodeDisplayTitle(second, [first, second])).toBe('second');
  });

  it('keeps unique titles and directory index titles unchanged', () => {
    const unique = { ...node('one', 'approvepartners/first.md'), title: 'Unique' };
    expect(treeNodeDisplayTitle(unique, [unique])).toBe('Unique');
    const index = { ...node('index', 'approvepartners/index.md'), title: 'Same' };
    const other = { ...node('other', 'approvepartners/other.md'), title: 'Same' };
    expect(treeNodeDisplayTitle(index, [index, other])).toBe('Same');
  });
});

describe('getTopLevelNodes', () => {
  it('unwraps the synthetic empty-path folder created for an imported repository root', () => {
    const root = node('dir:', '', [node('a', 'guide.md'), node('b', 'api', [], 'folder')], 'folder');
    expect(getTopLevelNodes({ tree: [root] })).toEqual(root.children);
  });

  it('unwraps a single root-index node into its children', () => {
    const root = node('root', 'index.md', [node('a', 'onboarding.md'), node('b', 'architecture/index.md')]);
    expect(getTopLevelNodes({ tree: [root] })).toEqual(root.children);
  });

  it('uses a flat tree as-is when there is no wrapping root node', () => {
    const a = node('a', 'onboarding.md');
    const b = node('b', 'architecture/index.md');
    expect(getTopLevelNodes({ tree: [a, b] })).toEqual([a, b]);
  });

  it('drops a stray literal index.md entry from a flat tree (home is shown separately)', () => {
    const home = node('root', 'index.md');
    const a = node('a', 'onboarding.md');
    expect(getTopLevelNodes({ tree: [home, a] })).toEqual([a]);
  });

  it('returns an empty list for a space with only an index page', () => {
    expect(getTopLevelNodes({ tree: [node('root', 'index.md')] })).toEqual([]);
  });
});

describe('findNode', () => {
  it('finds a nested node by id', () => {
    const tree = [node('a', 'a.md', [node('b', 'a/b.md', [node('c', 'a/b/c.md')])])];
    expect(findNode(tree, 'c')?.path).toBe('a/b/c.md');
    expect(findNode(tree, 'missing')).toBeUndefined();
  });
});

describe('findNodeByPath', () => {
  it('finds a nested node by path, including a synthetic folder node', () => {
    const tree = [
      node('a', 'docs', [node('dir:docs/api', 'docs/api', [], 'folder'), node('b', 'docs/intro.md')], 'folder'),
    ];
    expect(findNodeByPath(tree, 'docs/api')?.id).toBe('dir:docs/api');
    expect(findNodeByPath(tree, 'docs/intro.md')?.id).toBe('b');
    expect(findNodeByPath(tree, 'nope')).toBeUndefined();
  });
});

describe('excludeTemplatesFolder', () => {
  it('drops a top-level _templates node', () => {
    const a = node('a', 'onboarding.md');
    const templates = node('t', '_templates', [node('t1', '_templates/meeting.md')], 'folder');
    expect(excludeTemplatesFolder([a, templates])).toEqual([a]);
  });

  it('leaves the tree untouched when there is no _templates folder', () => {
    const a = node('a', 'onboarding.md');
    expect(excludeTemplatesFolder([a])).toEqual([a]);
  });

  it('does not touch a same-named page nested deeper (only matches at the top level)', () => {
    const nested = node('a', 'docs', [node('b', 'docs/_templates.md')], 'folder');
    expect(excludeTemplatesFolder([nested])).toEqual([nested]);
  });
});

describe('getTemplatePages', () => {
  it('returns the doc-kind direct children of the top-level _templates folder', () => {
    const meeting = node('t1', '_templates/meeting.md');
    const board = node('t2', '_templates/board.excalidraw', [], 'board');
    const templates = node('t', '_templates', [meeting, board], 'folder');
    expect(getTemplatePages([templates])).toEqual([meeting]);
  });

  it('returns an empty list when there is no _templates folder', () => {
    expect(getTemplatePages([node('a', 'onboarding.md')])).toEqual([]);
  });

  it('is not recursive — a nested sub-folder inside _templates is not scanned', () => {
    const nested = node('sub', '_templates/archived', [node('deep', '_templates/archived/old.md')], 'folder');
    const meeting = node('t1', '_templates/meeting.md');
    const templates = node('t', '_templates', [nested, meeting], 'folder');
    expect(getTemplatePages([templates])).toEqual([meeting]);
  });
});

describe('collectDirectories', () => {
  it('always includes the space root, plus every directory in use', () => {
    const tree = [node('a', 'onboarding.md'), node('b', 'architecture/index.md', [node('c', 'architecture/data-flow.md')])];
    expect(collectDirectories(tree)).toEqual(['', 'architecture']);
  });
});

describe('findSpaceRootPage', () => {
  it('finds a root index.md', () => {
    const root = node('root', 'index.md');
    expect(findSpaceRootPage({ tree: [root, node('a', 'onboarding.md')] })).toBe(root);
  });

  it("finds a root README.md — the shape of every space made from an ordinary git repo (QA-3 P1 #2)", () => {
    const readme = node('root', 'README.md', [node('a', 'sub/page.md')]);
    expect(findSpaceRootPage({ tree: [readme] })).toBe(readme);
  });

  it('prefers the separate `home` field when the server sends the tree that way', () => {
    const home = node('home', 'index.md');
    expect(findSpaceRootPage({ tree: [node('a', 'onboarding.md')], home })).toBe(home);
  });

  it('returns undefined when the root has no page of its own — SpaceHome then shows the synthetic listing', () => {
    expect(findSpaceRootPage({ tree: [node('d', 'docs', [], 'folder'), node('a', 'onboarding.md')] })).toBeUndefined();
  });

  it('ignores a README nested deeper — that one is its own directory\'s index, not the space\'s', () => {
    expect(findSpaceRootPage({ tree: [node('d', 'docs/README.md')] })).toBeUndefined();
  });

  it('never returns a folder pseudo-node, even one somehow pathed at the root index', () => {
    expect(findSpaceRootPage({ tree: [node('d', 'README.md', [], 'folder')] })).toBeUndefined();
  });
});

/**
 * QA-3 P2 #6 — where a page created from a row's "+" belongs. Mirrors
 * server/storage.ts's own childDirOf/relPathStem (getSubtree), which is what
 * makes the nesting real for ::pagetree, exports and the folder listing.
 */
describe('childDirOf', () => {
  it('a directory index is its directory — children are that directory\'s entries', () => {
    expect(childDirOf(node('a', 'index.md'))).toBe('');
    expect(childDirOf(node('a', 'docs/index.md'))).toBe('docs');
    expect(childDirOf(node('a', 'docs/README.md'))).toBe('docs');
  });

  it("a leaf page's children live in the same-named directory next to it (the bug: this returned the leaf's OWN directory)", () => {
    expect(childDirOf(node('a', 'alpha.md'))).toBe('alpha');
    expect(childDirOf(node('a', 'docs/alpha.md'))).toBe('docs/alpha');
  });

  it('a folder pseudo-node is its own directory', () => {
    expect(childDirOf(node('d', 'docs', [], 'folder'))).toBe('docs');
    expect(childDirOf(node('d', 'docs/nested', [], 'folder'))).toBe('docs/nested');
  });

  it('strips a board\'s whole .excalidraw.svg extension', () => {
    expect(childDirOf(node('b', 'docs/diagram.excalidraw.svg', [], 'board'))).toBe('docs/diagram');
  });

  it('keeps a table\'s .table stem, because the server\'s relPathStem does', () => {
    // titleFallback strips `.table.md` whole, relPathStem only `.md` — the
    // nesting is decided by the latter, so this matches the latter.
    expect(childDirOf(node('t', 'docs/weekly.table.md', [], 'table'))).toBe('docs/weekly');
  });

  it('never returns a path that would make a page its own parent', () => {
    for (const path of ['index.md', 'a.md', 'docs/index.md', 'docs/a.md']) {
      expect(childDirOf(node('x', path))).not.toBe(path);
    }
  });
});

describe('resolvePlusTargetDir — the top «+»\'s "which directory" rule', () => {
  // Owner spec (22.09.2026): "if I am at the root, the root's; if I am inside
  // something, that something's" — root when nothing/root is open, else the directory of
  // whatever IS open, or INSIDE it when that's itself a container.

  it('targets the space root when nothing is open', () => {
    const tree = [node('a', 'guide.md'), node('b', 'docs', [node('c', 'docs/nested.md')], 'folder')];
    expect(resolvePlusTargetDir(tree, undefined, undefined)).toBe('');
  });

  it('targets a leaf page\'s OWN directory, not a directory named after it', () => {
    const leaf = node('a', 'guide.md');
    const tree = [leaf, node('b', 'docs', [node('c', 'docs/nested.md')], 'folder')];
    expect(resolvePlusTargetDir(tree, 'a', undefined)).toBe('');

    const nestedLeaf = node('c', 'docs/nested.md');
    const nestedTree = [node('b', 'docs', [nestedLeaf], 'folder')];
    expect(resolvePlusTargetDir(nestedTree, 'c', undefined)).toBe('docs');
  });

  it('targets INSIDE a folder node (a container even when empty)', () => {
    const emptyFolder = node('b', 'docs', [], 'folder');
    expect(resolvePlusTargetDir([emptyFolder], undefined, 'docs')).toBe('docs');

    const nonEmptyFolder = node('b', 'docs', [node('c', 'docs/nested.md')], 'folder');
    expect(resolvePlusTargetDir([nonEmptyFolder], undefined, 'docs')).toBe('docs');
  });

  it('targets INSIDE an index page that already has children', () => {
    const index = node('i', 'docs/index.md', [node('c', 'docs/nested.md')]);
    expect(resolvePlusTargetDir([index], 'i', undefined)).toBe('docs');
  });

  it('an index page with no children yet still targets its own directory (nothing else makes sense)', () => {
    const index = node('i', 'docs/index.md', []);
    expect(resolvePlusTargetDir([index], 'i', undefined)).toBe('docs');
  });

  it('a README.md is treated as a directory index too, same as index.md', () => {
    const readme = node('r', 'docs/README.md', [node('c', 'docs/nested.md')]);
    expect(resolvePlusTargetDir([readme], 'r', undefined)).toBe('docs');
  });
});

describe('isContainerNode / plusTargetDirFor', () => {
  it('a folder is always a container, even empty', () => {
    expect(isContainerNode(node('b', 'docs', [], 'folder'))).toBe(true);
  });

  it('a leaf doc page is never a container', () => {
    expect(isContainerNode(node('a', 'guide.md'))).toBe(false);
  });

  it('undefined (space home) targets the root', () => {
    expect(plusTargetDirFor(undefined)).toBe('');
  });
});

describe('siblingsAtDir', () => {
  it('finds the sibling array a folder\'s own children live in', () => {
    const child = node('c', 'docs/nested.md');
    const folder = node('b', 'docs', [child], 'folder');
    expect(siblingsAtDir({ tree: [folder] }, 'docs')).toEqual([child]);
  });

  it('falls back to the unwrapped top-level nodes for the space root', () => {
    const a = node('a', 'guide.md');
    const b = node('b', 'onboarding.md');
    expect(siblingsAtDir({ tree: [a, b] }, '')).toEqual([a, b]);
  });

  it('unwraps a synthetic root folder for the space root, same as getTopLevelNodes', () => {
    const a = node('a', 'guide.md');
    const root = node('dir:', '', [a], 'folder');
    expect(siblingsAtDir({ tree: [root] }, '')).toEqual([a]);
  });
});
