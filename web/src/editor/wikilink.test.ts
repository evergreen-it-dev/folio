import { describe, expect, it } from 'vitest';
import type { TreeNode } from '@shared/contracts';
import { flattenTree, type PageEntry } from './page-index';
import { fuzzyScore } from './fuzzy';
import {
  findWikilinkQuery,
  rankPages,
  wikilinkMarkdown,
  wikilinkRange,
} from './wikilink';

const page = (title: string, path: string, kind = 'doc'): PageEntry => ({
  id: path,
  title,
  path,
  kind,
});

describe('findWikilinkQuery', () => {
  it('finds an open pair and returns what was typed after it', () => {
    expect(findWikilinkQuery('see [[data', 10)).toEqual({ from: 6, query: 'data' });
  });

  it('reports an empty query right after the brackets', () => {
    expect(findWikilinkQuery('[[', 2)).toEqual({ from: 2, query: '' });
  });

  it('works mid-line and mid-word, not only at line start', () => {
    expect(findWikilinkQuery('text [[a]] more [[b', 19)).toEqual({ from: 18, query: 'b' });
  });

  it('stops once the pair is closed', () => {
    expect(findWikilinkQuery('[[done]] tail', 13)).toBeNull();
  });

  it('ignores a closing bracket typed inside the query', () => {
    expect(findWikilinkQuery('[[a]', 4)).toBeNull();
  });

  it('returns null without an opening pair', () => {
    expect(findWikilinkQuery('plain [text', 11)).toBeNull();
  });

  it('gives up on absurdly long queries rather than capturing the line', () => {
    expect(findWikilinkQuery(`[[${'x'.repeat(200)}`, 202)).toBeNull();
  });

  it('sees the cursor position, not the whole line', () => {
    // caret sits between the brackets that closeBrackets auto-inserted
    expect(findWikilinkQuery('[[data]]', 6)).toEqual({ from: 2, query: 'data' });
  });
});

describe('wikilinkRange', () => {
  it('swallows the auto-inserted closing brackets', () => {
    // "[[data]]" with the caret at 6: replace 0..8
    expect(wikilinkRange(']]', 2, 6)).toEqual({ from: 0, to: 8 });
  });

  it('handles a single stray closing bracket', () => {
    expect(wikilinkRange('] rest', 2, 6)).toEqual({ from: 0, to: 7 });
  });

  it('leaves surrounding text alone when nothing was auto-closed', () => {
    expect(wikilinkRange(' rest', 2, 6)).toEqual({ from: 0, to: 6 });
  });

  it('covers the brackets even for an empty query', () => {
    expect(wikilinkRange(']]', 2, 2)).toEqual({ from: 0, to: 4 });
  });
});

describe('fuzzyScore', () => {
  it('matches an empty query against everything', () => {
    expect(fuzzyScore('', 'Anything')).toBe(0);
  });

  it('rejects text that does not contain the query as a subsequence', () => {
    expect(fuzzyScore('zzz', 'Data flow')).toBeNull();
  });

  it('matches non-ASCII letters case-insensitively', () => {
    expect(fuzzyScore('éco', 'École et flux')).not.toBeNull();
    expect(fuzzyScore('ÉCO', 'école')).not.toBeNull();
  });

  it('scores a prefix above a mid-word hit', () => {
    const prefix = fuzzyScore('data', 'Data flow')!;
    const middle = fuzzyScore('data', 'Metadata sync')!;
    expect(prefix).toBeGreaterThan(middle);
  });

  it('scores a word start above an arbitrary position', () => {
    const wordStart = fuzzyScore('fl', 'Data flow')!;
    const inner = fuzzyScore('fl', 'Baffling')!;
    expect(wordStart).toBeGreaterThan(inner);
  });

  it('scores contiguous matches above scattered ones', () => {
    const contiguous = fuzzyScore('abc', 'abcdef')!;
    const scattered = fuzzyScore('abc', 'axbxcx')!;
    expect(contiguous).toBeGreaterThan(scattered);
  });

  it('treats spaces in the query as skippable', () => {
    expect(fuzzyScore('data flow', 'Dataflow')).not.toBeNull();
  });
});

describe('rankPages', () => {
  const pages = [
    page('Data flow', 'architecture/data-flow.md'),
    page('Onboarding', 'onboarding.md'),
    page('Architecture', 'architecture/index.md'),
    page('Metadata', 'meta.md'),
  ];

  it('returns everything for an empty query', () => {
    expect(rankPages('', pages)).toHaveLength(4);
  });

  it('drops entries that match neither title nor path', () => {
    expect(rankPages('qqqq', pages)).toEqual([]);
  });

  it('puts the best title match first', () => {
    expect(rankPages('data', pages)[0].title).toBe('Data flow');
    expect(rankPages('onb', [page('Onboarding', 'onboarding.md'), ...pages])[0].title).toBe(
      'Onboarding',
    );
  });

  it('falls back to the path but ranks it below any title match', () => {
    const ranked = rankPages('arch', pages);
    expect(ranked.map((entry) => entry.title)).toContain('Architecture');
    // "Architecture" matches by title, so it must beat the path-only hit
    expect(ranked[0].title).toBe('Architecture');
  });

  it('finds pages by path fragment when the title cannot match', () => {
    const ranked = rankPages('meta.md', pages);
    expect(ranked[0].path).toBe('meta.md');
  });

  it('honours the limit', () => {
    expect(rankPages('', pages, 2)).toHaveLength(2);
  });
});

describe('wikilinkMarkdown', () => {
  it('writes a plain relative markdown link, never wiki syntax', () => {
    expect(wikilinkMarkdown('architecture/data-flow.md', page('Onboarding', 'onboarding.md'))).toBe(
      '[Onboarding](../onboarding.md)',
    );
  });

  it('links down into a folder from the space root', () => {
    expect(wikilinkMarkdown('index.md', page('Data flow', 'architecture/data-flow.md'))).toBe(
      '[Data flow](architecture/data-flow.md)',
    );
  });

  it('wraps destinations that contain spaces', () => {
    expect(wikilinkMarkdown('index.md', page('New board', 'New board.md'))).toBe(
      '[New board](<New board.md>)',
    );
  });

  it('strips brackets from the title so the link stays parseable', () => {
    expect(wikilinkMarkdown('index.md', page('A [draft] page', 'a.md'))).toBe(
      '[A draft page](a.md)',
    );
  });
});

describe('flattenTree', () => {
  const node = (over: Partial<TreeNode>): TreeNode =>
    ({
      id: 'x',
      space: 'eng',
      path: 'x.md',
      kind: 'doc',
      title: 'X',
      order: 0,
      status: 'published',
      updatedAt: '',
      children: [],
      ...over,
    }) as TreeNode;

  it('walks the whole tree depth-first', () => {
    const tree = [
      node({ id: '1', path: 'index.md', title: 'Root' }),
      node({
        id: '2',
        path: 'architecture/index.md',
        title: 'Architecture',
        children: [node({ id: '3', path: 'architecture/data-flow.md', title: 'Data flow' })],
      }),
    ];
    expect(flattenTree(tree).map((entry) => entry.id)).toEqual(['1', '2', '3']);
  });

  it('skips synthetic folder nodes but keeps their children', () => {
    const tree = [
      node({
        id: 'f',
        kind: 'folder' as TreeNode['kind'],
        path: 'group',
        title: 'Group',
        children: [node({ id: 'c', path: 'group/page.md', title: 'Page' })],
      }),
    ];
    expect(flattenTree(tree).map((entry) => entry.id)).toEqual(['c']);
  });

  it('keeps boards, which are real pages', () => {
    const tree = [node({ id: 'b', kind: 'board', path: 'board.excalidraw.svg', title: 'Board' })];
    expect(flattenTree(tree)).toHaveLength(1);
  });

  it('survives an empty tree', () => {
    expect(flattenTree([])).toEqual([]);
  });
});
