import { describe, expect, it } from 'vitest';
import type { Element, Root, Text } from 'hast';
import { findMentionTokens, rehypeMentions, splitMentionText } from './mentions';

/** Handles this "space" knows; everything else must stay ordinary text. */
const KNOWN: Record<string, string> = {
  ann: 'Ann Lee',
  'bob.smith': 'Bob Smith',
};
const lookup = (handle: string): string | undefined => KNOWN[handle];

describe('findMentionTokens', () => {
  it('finds a handle after a space', () => {
    expect(findMentionTokens('ping @ann please')).toEqual([{ from: 5, to: 9, handle: 'ann' }]);
  });

  it('finds one at the very start of the text', () => {
    expect(findMentionTokens('@ann hi')).toEqual([{ from: 0, to: 4, handle: 'ann' }]);
  });

  it('accepts ordinary punctuation (including non-Latin) in front', () => {
    expect(findMentionTokens('(@ann)').map((token) => token.handle)).toEqual(['ann']);
    expect(findMentionTokens('«@ann»').map((token) => token.handle)).toEqual(['ann']);
    expect(findMentionTokens('hello, @ann').map((token) => token.handle)).toEqual(['ann']);
  });

  it('never fires in the middle of a word', () => {
    expect(findMentionTokens('foo@ann')).toEqual([]);
    expect(findMentionTokens('café@ann')).toEqual([]);
  });

  it('leaves e-mail addresses alone', () => {
    expect(findMentionTokens('contact ann@example.com for help')).toEqual([]);
    expect(findMentionTokens('team.lead@folio.dev')).toEqual([]);
    expect(findMentionTokens('x-1@y')).toEqual([]);
  });

  it('treats a newline like a line start (a soft-wrapped hast text node)', () => {
    expect(findMentionTokens('hi\n@ann there').map((token) => token.handle)).toEqual(['ann']);
  });

  it('strips trailing sentence punctuation from the handle', () => {
    expect(findMentionTokens('ping @ann.')).toEqual([{ from: 5, to: 9, handle: 'ann' }]);
    expect(findMentionTokens('cc @ann, @bob-smith-')).toEqual([
      { from: 3, to: 7, handle: 'ann' },
      { from: 9, to: 19, handle: 'bob-smith' },
    ]);
  });

  it('keeps a dotted handle whole', () => {
    expect(findMentionTokens('@bob.smith')).toEqual([{ from: 0, to: 10, handle: 'bob.smith' }]);
  });

  it('rejects a handle shorter than MIN_HANDLE', () => {
    expect(findMentionTokens('@a')).toEqual([]);
  });

  it('is case-insensitive: the handle is lower-cased for lookup', () => {
    expect(findMentionTokens('@ANN')).toEqual([{ from: 0, to: 4, handle: 'ann' }]);
  });
});

describe('splitMentionText', () => {
  it('returns null when nothing in the text is a known handle', () => {
    expect(splitMentionText('just some text', lookup)).toBeNull();
    expect(splitMentionText('ping @ghost please', lookup)).toBeNull();
  });

  it('wraps a single known handle in a folio-mention span, keeping the surrounding text', () => {
    const parts = splitMentionText('ping @ann please', lookup);
    expect(parts).toEqual([
      { type: 'text', value: 'ping ' },
      {
        type: 'element',
        tagName: 'span',
        properties: { className: ['folio-mention'], title: 'Ann Lee' },
        children: [{ type: 'text', value: '@ann' }],
      },
      { type: 'text', value: ' please' },
    ]);
  });

  it('leaves an unknown handle as part of the surrounding plain text', () => {
    const parts = splitMentionText('@ghost, but @ann counts', lookup);
    expect(parts).toEqual([
      { type: 'text', value: '@ghost, but ' },
      {
        type: 'element',
        tagName: 'span',
        properties: { className: ['folio-mention'], title: 'Ann Lee' },
        children: [{ type: 'text', value: '@ann' }],
      },
      { type: 'text', value: ' counts' },
    ]);
  });

  it('wraps every known handle when there is more than one', () => {
    const parts = splitMentionText('@ann and @bob.smith', lookup);
    expect(parts?.map((n) => (n.type === 'text' ? 'text' : (n as Element).tagName))).toEqual(['span', 'text', 'span']);
    expect((parts?.[1] as Text).value).toBe(' and ');
  });

  it('does not split when the whole text is exactly one known handle (no empty text nodes)', () => {
    expect(splitMentionText('@ann', lookup)).toEqual([
      {
        type: 'element',
        tagName: 'span',
        properties: { className: ['folio-mention'], title: 'Ann Lee' },
        children: [{ type: 'text', value: '@ann' }],
      },
    ]);
  });
});

function text(value: string): Text {
  return { type: 'text', value };
}
function el(tagName: string, children: Element['children']): Element {
  return { type: 'element', tagName, properties: {}, children };
}
function root(children: Root['children']): Root {
  return { type: 'root', children };
}
const pillTitles = (tree: Root): string[] => {
  const out: string[] = [];
  const visit = (node: Root | Element): void => {
    for (const child of node.children) {
      if (child.type === 'element') {
        if (child.tagName === 'span' && Array.isArray(child.properties.className) && child.properties.className.includes('folio-mention')) {
          out.push(String(child.properties.title));
        }
        visit(child);
      }
    }
  };
  visit(tree);
  return out;
};

describe('rehypeMentions', () => {
  it('is a no-op when no lookup is given (list not loaded yet)', () => {
    const tree = root([el('p', [text('ping @ann')])]);
    rehypeMentions(undefined)(tree);
    expect(pillTitles(tree)).toEqual([]);
    expect((tree.children[0] as Element).children).toEqual([text('ping @ann')]);
  });

  it('wraps a known handle inside a paragraph', () => {
    const tree = root([el('p', [text('ping @ann please')])]);
    rehypeMentions(lookup)(tree);
    expect(pillTitles(tree)).toEqual(['Ann Lee']);
  });

  it('never lights up text inside <code>', () => {
    const tree = root([el('p', [el('code', [text('@ann')])])]);
    rehypeMentions(lookup)(tree);
    expect(pillTitles(tree)).toEqual([]);
  });

  it('never lights up text inside <pre>', () => {
    const tree = root([el('pre', [text('@ann')])]);
    rehypeMentions(lookup)(tree);
    expect(pillTitles(tree)).toEqual([]);
  });

  it('still lights up a sibling paragraph after skipping a code block', () => {
    const tree = root([el('pre', [text('@ann')]), el('p', [text('cc @ann')])]);
    rehypeMentions(lookup)(tree);
    expect(pillTitles(tree)).toEqual(['Ann Lee']);
  });

  it('recurses into nested elements (e.g. a table cell)', () => {
    const tree = root([el('table', [el('tbody', [el('tr', [el('td', [text('@ann')])])])])]);
    rehypeMentions(lookup)(tree);
    expect(pillTitles(tree)).toEqual(['Ann Lee']);
  });
});
