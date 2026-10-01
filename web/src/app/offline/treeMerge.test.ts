import { describe, expect, it } from 'vitest';
import type { TreeNode } from '@shared/contracts';
import type { LocalPage } from './localPages';
import { mergeLocalPages } from './treeMerge';

const node = (id: string, path: string, children: TreeNode[] = [], kind: TreeNode['kind'] = 'doc'): TreeNode => ({
  id,
  space: 's',
  path,
  kind,
  title: id,
  order: 0,
  status: 'published',
  updatedAt: '2026-09-29T00:00:00.000Z',
  children,
});

const local = (id: string, parentPath: string, path: string, extra: Partial<LocalPage> = {}): LocalPage => ({
  id,
  space: 's',
  kind: 'doc',
  title: id,
  parentPath,
  path,
  createdAt: `2026-09-29T00:00:0${id.length}.000Z`,
  state: 'pending',
  attempts: 0,
  ...extra,
});

const ids = (nodes: TreeNode[]): unknown[] => nodes.map((n) => (n.children.length ? [n.id, ids(n.children)] : n.id));

describe('mergeLocalPages', () => {
  const tree = { tree: [node('a', 'a.md', [node('a1', 'a/a1.md')]), node('b', 'b.md')] };

  it('returns the very same object when there is nothing local for this space', () => {
    expect(mergeLocalPages(tree, [], 's')).toBe(tree);
    expect(mergeLocalPages(tree, [local('x', '', 'x.md', { space: 'other' })], 's')).toBe(tree);
  });

  it('puts a root page last at the top level and a child last under its parent', () => {
    const merged = mergeLocalPages(tree, [local('x', '', 'x.md'), local('yy', 'a', 'a/yy.md')], 's');
    expect(ids(merged.tree)).toEqual([['a', ['a1', 'yy']], 'b', 'x']);
  });

  it('nests a local page under a local parent', () => {
    const merged = mergeLocalPages(tree, [local('x', '', 'x.md'), local('yy', 'x', 'x/yy.md', { parentId: 'x' })], 's');
    expect(ids(merged.tree)).toEqual([['a', ['a1']], 'b', ['x', ['yy']]]);
  });

  it('never mutates the cached tree', () => {
    const before = JSON.stringify(tree);
    mergeLocalPages(tree, [local('x', 'a', 'a/x.md')], 's');
    expect(JSON.stringify(tree)).toBe(before);
  });

  it('surfaces a page whose parent directory is gone at the top level rather than hiding it', () => {
    const merged = mergeLocalPages(tree, [local('x', 'deleted-elsewhere', 'deleted-elsewhere/x.md')], 's');
    expect(ids(merged.tree)).toEqual([['a', ['a1']], 'b', 'x']);
  });

  it('does not show a page twice once the server has it too', () => {
    const merged = mergeLocalPages(tree, [local('b', '', 'b-local.md')], 's');
    expect(ids(merged.tree)).toEqual([['a', ['a1']], 'b']);
  });

  it('appends inside the root wrapper when the server sends one', () => {
    const wrapped = { tree: [node('root', '', [node('a', 'a.md')], 'folder')] };
    expect(ids(mergeLocalPages(wrapped, [local('x', '', 'x.md')], 's').tree)).toEqual([['root', ['a', 'x']]]);
  });
});
