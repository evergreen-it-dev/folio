import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import rehypeStringify from 'rehype-stringify';
import type { Element, Root, RootContent, Text } from 'hast';
import {
  groupLegacyMarkupSpans,
  highlightClass,
  isHighlightGroup,
  rehypeHighlight,
  resolveHighlightColor,
  splitHighlightMarkers,
  type HighlightItem,
  type HighlightTextAdapter,
} from './highlight.js';

const text = (value: string): Text => ({ type: 'text', value });

function render(children: RootContent[]): string {
  const tree: Root = { type: 'root', children };
  rehypeHighlight()(tree);
  return unified().use(rehypeStringify).stringify(tree) as unknown as string;
}

describe('resolveHighlightColor / highlightClass', () => {
  it('defaults to yellow with no token', () => {
    expect(resolveHighlightColor(undefined)).toBe('yellow');
    expect(resolveHighlightColor(null)).toBe('yellow');
    expect(highlightClass(undefined)).toBe('folio-hl folio-hl-yellow');
  });

  it('accepts every palette token', () => {
    expect(resolveHighlightColor('green')).toBe('green');
    expect(highlightClass('teal')).toBe('folio-hl folio-hl-teal');
  });

  it('falls back to yellow for an unrecognised token', () => {
    expect(resolveHighlightColor('neon')).toBe('yellow');
    expect(highlightClass('neon')).toBe('folio-hl folio-hl-yellow');
  });
});

describe('rehypeHighlight', () => {
  it('wraps a highlight fully inside one text node', () => {
    expect(render([text('a ==b== c')])).toBe('a <mark class="folio-hl folio-hl-yellow">b</mark> c');
  });

  it('wraps a highlight whose markers sit in different text nodes, carrying other inline markup between them', () => {
    const strong: Element = { type: 'element', tagName: 'strong', properties: {}, children: [text('bold')] };
    const html = render([text('=='), strong, text(' and plain==')]);
    expect(html).toBe('<mark class="folio-hl folio-hl-yellow"><strong>bold</strong> and plain</mark>');
  });

  it('applies a colour token and strips the {.token} annotation from the output', () => {
    expect(render([text('a ==b=={.green} c')])).toBe('a <mark class="folio-hl folio-hl-green">b</mark> c');
  });

  it('falls back to yellow for an unknown token, still dropping the {.token} text', () => {
    expect(render([text('a ==b=={.nope} c')])).toBe('a <mark class="folio-hl folio-hl-yellow">b</mark> c');
  });

  it('does not treat a run of three or more "=" as a marker', () => {
    expect(render([text('a ===b=== c')])).toBe('a ===b=== c');
    expect(render([text('a ====b==== c')])).toBe('a ====b==== c');
  });

  it('leaves content untouched inside code and pre', () => {
    const code: Element = { type: 'element', tagName: 'code', properties: {}, children: [text('==b==')] };
    expect(render([code])).toBe('<code>==b==</code>');
    const pre: Element = { type: 'element', tagName: 'pre', properties: {}, children: [text('a ==b== c')] };
    expect(render([pre])).toBe('<pre>a ==b== c</pre>');
  });

  it('leaves an existing <mark> element (legacy syntax) completely untouched, including any literal "==" inside it', () => {
    const mark: Element = { type: 'element', tagName: 'mark', properties: {}, children: [text('==legacy==')] };
    expect(render([mark])).toBe('<mark>==legacy==</mark>');
  });

  it('requires non-empty content that does not start or end with whitespace', () => {
    expect(render([text('a ==== c')])).toBe('a ==== c'); // empty content between adjacent markers
    expect(render([text('a == b== c')])).toBe('a == b== c'); // starts with whitespace
    expect(render([text('a ==b == c')])).toBe('a ==b == c'); // ends with whitespace
  });

  it('handles more than one highlight in the same text node', () => {
    expect(render([text('==a== and ==b=={.blue}')])).toBe(
      '<mark class="folio-hl folio-hl-yellow">a</mark> and <mark class="folio-hl folio-hl-blue">b</mark>',
    );
  });
});

/**
 * `server/export/docx.ts` never builds a hast tree (its processor stops at
 * mdast — see highlight.ts's own file doc comment) — it drives
 * `groupLegacyMarkupSpans` + `splitHighlightMarkers` directly over
 * mdast-shaped nodes instead. These use a tiny stand-in node type (plain
 * `{type, value?}` objects) rather than a real mdast tree, since the two
 * functions only ever need `.type` — exercising exactly what docx.ts's own
 * `mdastHighlightAdapter`/`markTag` do, without pulling in `remark-parse`.
 */
describe('groupLegacyMarkupSpans + splitHighlightMarkers (docx.ts\'s mdast path)', () => {
  interface Node {
    type: string;
    value?: string;
  }
  const t = (value: string): Node => ({ type: 'text', value });
  const html = (value: string): Node => ({ type: 'html', value });
  const adapter: HighlightTextAdapter<Node> = {
    getText: (n) => (n.type === 'text' ? n.value : undefined),
    makeText: (value) => ({ type: 'text', value }),
  };
  const markTag = (n: Node): 'open' | 'close' | undefined => {
    if (n.type !== 'html' || n.value === undefined) return undefined;
    if (/^<mark(?:\s[^>]*)?>$/i.test(n.value)) return 'open';
    if (/^<\/mark\s*>$/i.test(n.value)) return 'close';
    return undefined;
  };
  const resolve = (nodes: readonly Node[]): HighlightItem<Node>[] =>
    splitHighlightMarkers(groupLegacyMarkupSpans(nodes, markTag), adapter);

  it('pairs a legacy <mark>…</mark> written as separate html/text mdast siblings, always at the default colour', () => {
    const items = resolve([t('foo '), html('<mark>'), t('bar'), html('</mark>'), t(' baz')]);
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({ type: 'text', value: 'foo ' });
    const group = items[1];
    expect(isHighlightGroup(group)).toBe(true);
    if (isHighlightGroup(group)) {
      expect(group.token).toBe('yellow');
      expect(group.children).toEqual([{ type: 'text', value: 'bar' }]);
    }
    expect(items[2]).toEqual({ type: 'text', value: ' baz' });
  });

  it('leaves an unmatched opener\'s content plain, and silently drops a stray closer', () => {
    // splitHighlightMarkers merges adjacent plain-text output, so the two
    // surviving text nodes read back as one — content lost is zero either way.
    expect(resolve([t('a '), html('<mark>'), t('b')])).toEqual([{ type: 'text', value: 'a b' }]);
    expect(resolve([t('a '), html('</mark>'), t('b')])).toEqual([{ type: 'text', value: 'a b' }]);
  });

  it('still detects ==…== once the legacy pass has run, next to (not inside) a legacy span', () => {
    const items = resolve([html('<mark>'), t('old'), html('</mark>'), t(' and ==new=={.green}')]);
    expect(items).toHaveLength(3);
    const [legacy, between, fresh] = items;
    expect(isHighlightGroup(legacy) && legacy.token).toBe('yellow');
    expect(between).toEqual({ type: 'text', value: ' and ' });
    expect(isHighlightGroup(fresh) && fresh.token).toBe('green');
  });
});
