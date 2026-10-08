import { Text } from '@codemirror/state';
import { GFM, parser } from '@lezer/markdown';
import { FolioHighlight } from './highlight-syntax';
import { FolioUnderline } from './underline-syntax';
import { describe, expect, it } from 'vitest';
import {
  CALLOUT_TYPES,
  computeBlockSpecs,
  isSelfContainedHtmlBlock,
  parseDetailsOpen,
  parsePagetreeLine,
  computeInlineSpecs,
  mermaidFenceAt,
  tableRangeAt,
  taskToggleEdit,
  touches,
  type BlockSpec,
  type InlineSpec,
  type Span,
} from './live-decorations';

const md = parser.configure([GFM, FolioHighlight, FolioUnderline]);

/** Build the (doc, tree) snapshot the decoration computation works from. */
function snapshot(source: string, cursor: number | Span = 0) {
  const doc = Text.of(source.split('\n'));
  return {
    doc,
    tree: md.parse(source),
    selection: [typeof cursor === 'number' ? { from: cursor, to: cursor } : cursor],
    ranges: [{ from: 0, to: doc.length }],
  };
}

const inline = (source: string, cursor: number | Span = 0, live = true): InlineSpec[] =>
  computeInlineSpecs({ ...snapshot(source, cursor), live });

const blocks = (source: string, cursor: number | Span = 0, live = true): BlockSpec[] =>
  computeBlockSpecs({ ...snapshot(source, cursor), live });

/** The text each mark of class `cls` covers. */
const markedText = (specs: InlineSpec[], source: string, cls: string): string[] =>
  specs.flatMap((spec) => (spec.kind === 'mark' && spec.cls === cls ? [source.slice(spec.from, spec.to)] : []));

const hidden = (specs: InlineSpec[], source: string): string[] =>
  specs.filter((s) => s.kind === 'hide').map((s) => source.slice(s.from, s.to));

describe('touches', () => {
  it('counts abutting positions as touching', () => {
    expect(touches([{ from: 4, to: 4 }], 0, 4)).toBe(true);
    expect(touches([{ from: 4, to: 4 }], 4, 8)).toBe(true);
    expect(touches([{ from: 4, to: 4 }], 5, 8)).toBe(false);
  });
});

describe('list decorations (live)', () => {
  const bullets = (src: string, live = true) =>
    inline(src, 0, live).filter((s): s is Extract<InlineSpec, { kind: 'bullet' }> => s.kind === 'bullet');
  const lines = (src: string) =>
    inline(src).filter((s): s is Extract<InlineSpec, { kind: 'line' }> => s.kind === 'line' && /cm-md-li/.test(s.cls));

  it('replaces each bullet marker (with its indent and trailing space) by depth from the tree', () => {
    const src = '- a\n  - b\n    - c\n      - d\n- e\n';
    const found = bullets(src);
    expect(found.map((b) => b.level)).toEqual([0, 1, 2, 3, 0]);
    // The range covers the indentation, the marker and the space after it — and
    // never reaches the item's text.
    expect(found.map((b) => src.slice(b.from, b.to))).toEqual(['- ', '  - ', '    - ', '      - ', '- ']);
  });

  it('takes the depth from list nesting, not from the number of spaces', () => {
    // Two-space and three-space indents are both just "one level deeper".
    expect(bullets('- a\n  - b\n').map((b) => b.level)).toEqual([0, 1]);
    expect(bullets('- a\n   - b\n').map((b) => b.level)).toEqual([0, 1]);
    // An ordered list counts as a level for the bullets inside it.
    expect(bullets('1. a\n   - b\n').map((b) => b.level)).toEqual([1]);
  });

  it('treats -, * and + alike', () => {
    expect(bullets('- a\n\n* b\n\n+ c\n')).toHaveLength(3);
  });

  it('gives every item line a depth variable, and its wrapped source lines too', () => {
    const src = '- a\n  - b\n    more of b\n';
    expect(lines(src)).toEqual([
      { kind: 'line', pos: 0, cls: 'cm-md-li', style: '--cm-li-depth:1' },
      { kind: 'line', pos: 4, cls: 'cm-md-li', style: '--cm-li-depth:2' },
      { kind: 'line', pos: 10, cls: 'cm-md-li-cont', style: '--cm-li-depth:2' },
    ]);
    // The continuation line's own indentation is folded; the padding replaces it.
    expect(hidden(inline(src), src)).toEqual(['    ']);
  });

  it('keeps ordered numbers as text, only folding the indent and widening the marker', () => {
    const src = '1. a\n   1. b\n';
    const specs = inline(src);
    expect(specs.some((s) => s.kind === 'bullet')).toBe(false);
    expect(hidden(specs, src)).toEqual(['   ']);
    expect(specs).toContainEqual({ kind: 'mark', from: 8, to: 11, cls: 'cm-md-list-num' });
    expect(lines(src).map((l) => l.style)).toEqual(['--cm-li-depth:1', '--cm-li-depth:2']);
  });

  it('drops the marker of a task item (the checkbox is the marker) but keeps the checkbox', () => {
    const src = '- [ ] open\n  - [x] done\n';
    const specs = inline(src);
    expect(specs.some((s) => s.kind === 'bullet')).toBe(false);
    expect(hidden(specs, src)).toEqual(['- ', '  - ']);
    expect(specs.filter((s) => s.kind === 'task')).toHaveLength(2);
    expect(lines(src).map((l) => l.style)).toEqual(['--cm-li-depth:1', '--cm-li-depth:2']);
  });

  it('does not depend on where the caret is', () => {
    const src = '- a\n  - b\n';
    expect(inline(src, 0)).toEqual(inline(src, 7));
  });

  it('leaves source mode alone', () => {
    const specs = inline('- a\n  - b\n1. c\n', 0, false);
    expect(specs.some((s) => s.kind === 'bullet' || s.kind === 'hide')).toBe(false);
    expect(specs.some((s) => s.kind === 'line' && /cm-md-li/.test(s.cls))).toBe(false);
    expect(specs.some((s) => s.kind === 'mark' && s.cls === 'cm-md-list-num')).toBe(false);
  });

  it('does not indent lists that sit inside a quote', () => {
    const specs = inline('> - a\n');
    expect(specs.some((s) => s.kind === 'line' && /cm-md-li/.test(s.cls))).toBe(false);
  });

  it('shows an empty item as a bullet, and a lone dash under a paragraph as plain text', () => {
    expect(bullets('- a\n\n-\n')).toHaveLength(2);
    // No setext heading and no list: this dash is just a character.
    expect(bullets('para\n-\n')).toEqual([]);
  });
});

describe('computeInlineSpecs', () => {
  it('folds emphasis markers away when the selection is elsewhere', () => {
    const src = 'a **bold** and *em* here';
    expect(hidden(inline(src, 0), src)).toEqual(['**', '**', '*', '*']);
  });

  it('keeps markers folded when the selection touches the node', () => {
    const src = 'a **bold** and *em* here';
    // cursor inside "bold"
    expect(hidden(inline(src, 6), src)).toEqual(['**', '**', '*', '*']);
  });

  it('folds inline code backticks but never fence markers', () => {
    const src = 'use `npm run build`\n\n```js\nlet x = 1\n```\n';
    expect(hidden(inline(src), src)).toEqual(['`', '`']);
  });

  it('folds the <ins>/<mark> pairs the toolbar writes and styles what is between', () => {
    const src = 'a <ins>u</ins> and <mark>h</mark> b';
    expect(hidden(inline(src), src)).toEqual(['<ins>', '</ins>', '<mark>', '</mark>']);
    const marks = inline(src).filter((spec) => spec.kind === 'mark');
    const styled = (cls: string) =>
      marks.filter((spec) => spec.cls === cls).map((spec) => src.slice(spec.from, spec.to));
    expect(styled('cm-md-ins')).toEqual(['u']);
    expect(styled('cm-md-mark')).toEqual(['h']);
  });

  it('folds ++underline++ marks like ** and underlines what is between', () => {
    const src = 'a ++u++ b';
    expect(hidden(inline(src), src)).toEqual(['++', '++']);
    expect(markedText(inline(src), src, 'cm-md-ins')).toEqual(['u']);
  });

  it('folds every marker of ++ nested with ** in either order', () => {
    for (const src of ['**++x++**', '++**x**++', '*++x++*', '~~++x++~~', '**a ++b++ c**']) {
      expect(hidden(inline(src), src).join('')).toMatch(/^[*~+]+$/);
      expect(markedText(inline(src), src, 'cm-md-ins')).toHaveLength(1);
    }
    const src = '**++x++**';
    expect(hidden(inline(src), src)).toEqual(['**', '++', '++', '**']);
  });

  it('leaves C++ and a lone plus as text', () => {
    for (const src of ['C++ and C++', 'a + b', 'i++ ; j++']) expect(hidden(inline(src), src)).toEqual([]);
  });

  it('keeps ++ markers visible (dimmed) in source mode', () => {
    const src = 'a ++u++ b';
    expect(hidden(inline(src, 0, false), src)).toEqual([]);
    expect(inline(src, 0, false).some((spec) => spec.kind === 'mark' && spec.cls === 'cm-md-ins')).toBe(true);
  });

  it('folds BOTH legacy tags and the ** markers of a crossed <ins>**x</ins>** (data written by the old toolbar)', () => {
    const src = '<ins>**Ongoing Goal #1</ins>** more';
    expect(hidden(inline(src), src).sort()).toEqual(['**', '**', '</ins>', '<ins>'].sort());
    expect(markedText(inline(src), src, 'cm-md-ins')).toEqual(['**Ongoing Goal #1']);
  });

  it('folds ==highlight== marks and colours the text by the {.token} attribute', () => {
    const src = 'a ==h== and ==g=={.green} b';
    expect(hidden(inline(src), src)).toEqual(['==', '==', '==', '==', '{.green}']);
    const marks = inline(src).filter((spec) => spec.kind === 'mark');
    const styled = (cls: string) =>
      marks.filter((spec) => spec.cls === cls).map((spec) => src.slice(spec.from, spec.to));
    expect(styled('cm-md-mark')).toEqual(['h']);
    expect(styled('cm-md-mark cm-md-mark--green')).toEqual(['g']);
  });

  it('keeps those tags folded when the selection is inside them', () => {
    const src = 'a <ins>u</ins> b';
    expect(hidden(inline(src, 8), src)).toEqual(['<ins>', '</ins>']);
  });

  it('leaves an unpaired or unknown tag as plain source', () => {
    expect(hidden(inline('a <mark>u b'), 'a <mark>u b')).toEqual([]);
    expect(hidden(inline('a <b>u</b> c'), 'a <b>u</b> c')).toEqual([]);
  });

  it('never folds them in source mode, where markers are only dimmed', () => {
    const src = 'a <ins>u</ins> b';
    expect(hidden(inline(src, 0, false), src)).toEqual([]);
    expect(inline(src, 0, false).some((spec) => spec.kind === 'mark' && spec.cls === 'cm-md-ins')).toBe(true);
  });

  it('folds the heading prefix together with its trailing space', () => {
    const src = '# Title\n\ntext';
    // cursor down in the body, outside the heading node
    const specs = inline(src, 10);
    expect(hidden(specs, src)).toEqual(['# ']);
    expect(specs).toContainEqual({ kind: 'line', pos: 0, cls: 'cm-md-h1' });
  });

  it('keeps heading line classes in source mode but folds nothing', () => {
    const src = '## Sub\n';
    const specs = inline(src, 0, false);
    expect(hidden(specs, src)).toEqual([]);
    expect(specs).toContainEqual({ kind: 'line', pos: 0, cls: 'cm-md-h2' });
    expect(specs.some((s) => s.kind === 'mark' && s.cls === 'cm-md-marker')).toBe(true);
  });

  it('hides link syntax and marks the label', () => {
    const src = 'see [the docs](https://example.com/x) now';
    const specs = inline(src);
    expect(hidden(specs, src)).toEqual(['[', '](https://example.com/x)']);
    expect(specs).toContainEqual({ kind: 'mark', from: 5, to: 13, cls: 'cm-md-link' });
  });

  it('keeps link syntax folded when the cursor is inside the link', () => {
    const src = 'see [the docs](https://example.com/x) now';
    expect(hidden(inline(src, 8), src)).toEqual(['[', '](https://example.com/x)']);
  });

  it('styles a bare autolink URL in an ordinary paragraph without hiding anything', () => {
    const src = 'see https://example.com/x now';
    const specs = inline(src);
    expect(specs).toContainEqual({ kind: 'mark', from: 4, to: 25, cls: 'cm-md-link' });
    expect(hidden(specs, src)).toEqual([]); // there's no markup around a bare URL to fold
  });

  it('refuses to fold a link whose destination wraps to the next line', () => {
    // CodeMirror throws on plugin decorations that replace a line break.
    const src = 'see [label](\nhttps://example.com) now\n';
    const specs = inline(src, 36);
    expect(hidden(specs, src)).toEqual(['[']);
  });

  it('styles blockquote and list markers without hiding them', () => {
    const src = '> quoted\n\n- item\n';
    const specs = inline(src);
    expect(hidden(specs, src)).toEqual([]);
    expect(specs).toContainEqual({ kind: 'mark', from: 0, to: 1, cls: 'cm-md-quote-mark' });
    expect(specs).toContainEqual({ kind: 'line', pos: 0, cls: 'cm-md-quote' });
    expect(specs.some((s) => s.kind === 'mark' && s.cls === 'cm-md-list-mark')).toBe(true);
  });

  it('turns task markers into checkbox specs', () => {
    const src = '- [ ] open\n- [x] done\n';
    const specs = inline(src);
    expect(specs.filter((s) => s.kind === 'task')).toEqual([
      { kind: 'task', from: 2, to: 5, checked: false },
      { kind: 'task', from: 13, to: 16, checked: true },
    ]);
  });

  it('keeps the checkbox widget while the cursor sits on it', () => {
    const src = '- [ ] open\n';
    expect(inline(src, 3).some((s) => s.kind === 'task')).toBe(true);
  });

  it('never folds anything in source mode', () => {
    const src = '# Title\n\n**bold** [x](y) `c`\n';
    const specs = inline(src, 0, false);
    expect(specs.some((s) => s.kind === 'hide' || s.kind === 'task')).toBe(false);
  });

  it('only scans the ranges it is given', () => {
    const src = '**a**\n\n**b**\n';
    const doc = Text.of(src.split('\n'));
    const specs = computeInlineSpecs({
      doc,
      tree: md.parse(src),
      selection: [{ from: 0, to: 0 }],
      ranges: [{ from: 7, to: doc.length }],
      live: true,
    });
    expect(hidden(specs, src)).toEqual(['**', '**']);
    expect(specs.every((s) => (s.kind === 'line' ? s.pos >= 7 : s.from >= 7))).toBe(true);
  });
});

describe('computeBlockSpecs', () => {
  it('replaces a closed mermaid fence with a diagram block', () => {
    const src = 'intro\n\n```mermaid\nflowchart TD\n  A --> B\n```\n\nafter\n';
    expect(blocks(src)).toEqual([
      { kind: 'mermaid', from: 7, to: 44, code: 'flowchart TD\n  A --> B' },
    ]);
  });

  it('shows nothing but the source while the caret is inside the fence', () => {
    // Round 21: no widget at all here. The preview that used to hang under an
    // opened fence is gone with the click-to-reveal path that led to it — a
    // click on the diagram opens the visual editor now, so the only way to be
    // standing in this source is to be writing it.
    const src = 'intro\n\n```mermaid\nflowchart TD\n```\n';
    expect(blocks(src, 20)).toEqual([]);
  });

  it('ignores non-mermaid and unterminated fences', () => {
    expect(blocks('```js\nlet a = 1\n```\n')).toEqual([]);
    expect(blocks('```mermaid\nflowchart TD\n')).toEqual([]);
    expect(blocks('```mermaid\nflowchart TD\n', 15)).toEqual([]);
  });

  it('renders an image that occupies a whole line', () => {
    const src = 'text\n\n![a diagram](img/flow.png)\n\nmore\n';
    expect(blocks(src)).toEqual([
      { kind: 'image', from: 6, to: 32, alt: 'a diagram', src: 'img/flow.png' },
    ]);
  });

  it('leaves images that sit inside a sentence as source', () => {
    expect(blocks('see ![a](b.png) here\n')).toEqual([]);
  });


  it('replaces a top-level GFM table with a grid widget', () => {
    const src = 'text\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nafter\n';
    expect(blocks(src)).toEqual([
      { kind: 'table', from: 6, to: 35, source: '| a | b |\n| - | - |\n| 1 | 2 |' },
    ]);
  });

  it('keeps a table as source while the selection is inside it', () => {
    const src = '| a | b |\n| - | - |\n| 1 | 2 |\n';
    expect(blocks(src, 3)).toEqual([]);
  });

  it('leaves tables nested in a blockquote as source', () => {
    const src = '> | a | b |\n> | - | - |\n> | 1 | 2 |\n';
    expect(blocks(src)).toEqual([]);
  });

  /**
   * Owner report: a pipe table right after a callout's own text, with no
   * blank line and no `>` prefix, is CommonMark lazy continuation — plain
   * text of the callout's paragraph, not a table (verified against
   * remark-gfm, see markdown/strayTable.ts). Reading mode already renders it
   * as text; live edit used to disagree and draw a grid widget there anyway.
   */
  it('does not widgetise a table that is a lazy continuation of a callout paragraph', () => {
    const src = '> [!NOTE]\n> ExpertHospital handed over to the WG\n| Key | Status |\n|---|---|\n| a | b |\n';
    expect(blocks(src)).toEqual([]);
  });

  it('still treats a table right after an ORDINARY paragraph, no blank line, as a real table', () => {
    // GFM lets a table interrupt a plain paragraph — unlike the callout case
    // above, there is no open blockquote for this to be a lazy continuation of.
    const src = 'ExpertHospital handed over to the WG\n| Key | Status |\n|---|---|\n| a | b |\n';
    const first = src.indexOf('| Key');
    expect(blocks(src)).toEqual([
      { kind: 'table', from: first, to: src.length - 1, source: src.slice(first, -1) },
    ]);
  });

  it('still leaves a table as source after a blank line inside the callout, `>` prefixes and all', () => {
    // A real table (the general blockquote-nesting limit above applies), and
    // in particular NOT caught by the lazy-continuation check: the blank line
    // properly closed the callout's paragraph before the table started.
    const src = '> [!NOTE]\n> ExpertHospital handed over to the WG\n>\n> | Key | Status |\n> |---|---|\n> | a | b |\n';
    expect(blocks(src)).toEqual([]);
  });

  it('renders a top-level raw HTML block', () => {
    const html = '<table class="confluenceTable">\n<tbody><tr><td>a</td></tr></tbody>\n</table>';
    const src = `text\n\n${html}\n\nafter\n`;
    expect(blocks(src)).toEqual([{ kind: 'html', from: 6, to: 6 + html.length, html }]);
  });

  it('keeps an HTML block as source while the selection is inside it', () => {
    const html = '<table><tr><td>a</td></tr></table>';
    expect(blocks(`${html}\n`, 5)).toEqual([]);
  });

  it('leaves HTML nested in a list or quote alone', () => {
    expect(blocks('- item\n  <div>nested</div>\n')).toEqual([]);
    expect(blocks('> <div>quoted</div>\n')).toEqual([]);
  });

  it('skips fragments that do not close what they opened', () => {
    // CommonMark splits `<details>` on a blank line; rendering half of it would
    // hand sanitisation broken markup.
    const src = '<details><summary>S</summary>\n\nbody\n\n</details>\n';
    expect(blocks(src)).toEqual([]);
  });

  it('replaces a standalone ::pagetree directive with a widget', () => {
    const src = 'text\n\n::pagetree{depth=3}\n\nafter\n';
    expect(blocks(src)).toEqual([{ kind: 'pagetree', from: 6, to: 25, depth: 3 }]);
  });

  it('defaults ::pagetree with no attributes to depth 2', () => {
    // cursor parked in the trailing line so it does not touch the directive
    const src = '::pagetree\n\nbody\n';
    expect(blocks(src, 13)).toEqual([{ kind: 'pagetree', from: 0, to: 10, depth: 2 }]);
  });

  it('keeps the ::pagetree source while the selection is on it', () => {
    expect(blocks('::pagetree{depth=2}\n', 4)).toEqual([]);
  });

  it('ignores ::pagetree that is not the whole line or is nested', () => {
    expect(blocks('see ::pagetree{depth=2} here\n')).toEqual([]);
    expect(blocks('- ::pagetree{depth=2}\n')).toEqual([]);
    expect(blocks('> ::pagetree{depth=2}\n')).toEqual([]);
  });

  it('emits nothing in source mode', () => {
    expect(blocks('```mermaid\nflowchart TD\n```\n', 0, false)).toEqual([]);
    expect(blocks('| a | b |\n| - | - |\n| 1 | 2 |\n', 0, false)).toEqual([]);
  });
});

describe('multi-fragment <details>', () => {
  // Everything sits under a paragraph so the default caret at 0 is outside the
  // block — a caret touching it is a "show me the source" request.
  const doc = (body: string) => `intro\n\n<details><summary>Head</summary>\n\n${body}\n\n</details>\n\nafter\n`;
  const span = (src: string) => ({
    from: src.indexOf('<details'),
    to: src.lastIndexOf('</details>') + '</details>'.length,
  });

  it('joins opening fragment, markdown body and closing fragment into one widget', () => {
    const src = doc('body text');
    expect(blocks(src)).toEqual([
      { kind: 'details', ...span(src), summary: 'Head', body: 'body text', open: false },
    ]);
  });

  it('hands the body over as markdown — a list stays a list', () => {
    const src = doc('- one\n- two');
    expect(blocks(src)).toEqual([
      { kind: 'details', ...span(src), summary: 'Head', body: '- one\n- two', open: false },
    ]);
  });

  it('swallows a table in the body instead of letting it claim a block of its own', () => {
    const src = doc('| a | b |\n| - | - |\n| 1 | 2 |');
    // Exactly one spec: a second block replacement nested inside this range is
    // what takes CodeMirror down.
    expect(blocks(src)).toEqual([
      {
        kind: 'details',
        ...span(src),
        summary: 'Head',
        body: '| a | b |\n| - | - |\n| 1 | 2 |',
        open: false,
      },
    ]);
  });

  it('accepts an empty body', () => {
    const src = 'intro\n\n<details><summary>Head</summary>\n\n</details>\n';
    expect(blocks(src)).toEqual([
      { kind: 'details', ...span(src), summary: 'Head', body: '', open: false },
    ]);
  });

  it('reads a summary split onto its own line', () => {
    const src = 'intro\n\n<details>\n<summary>Head</summary>\n\nbody\n\n</details>\n';
    expect(blocks(src)).toEqual([
      { kind: 'details', ...span(src), summary: 'Head', body: 'body', open: false },
    ]);
  });

  it('tolerates a fragment with no summary at all', () => {
    const src = 'intro\n\n<details>\n\nbody\n\n</details>\n';
    expect(blocks(src)).toEqual([
      { kind: 'details', ...span(src), summary: '', body: 'body', open: false },
    ]);
  });

  it('starts expanded when the source says <details open>', () => {
    const src = 'intro\n\n<details open><summary>Head</summary>\n\nbody\n\n</details>\n';
    expect(blocks(src)[0]).toMatchObject({ kind: 'details', open: true, summary: 'Head' });
  });

  it('pairs across a nested disclosure rather than closing on the inner tag', () => {
    const src =
      'intro\n\n<details><summary>Out</summary>\n\n<details><summary>In</summary>\n\ninner\n\n</details>\n\n</details>\n';
    expect(blocks(src)).toEqual([
      {
        kind: 'details',
        ...span(src),
        summary: 'Out',
        body: '<details><summary>In</summary>\n\ninner\n\n</details>',
        open: false,
      },
    ]);
  });

  it('leaves a <details> with no closing fragment as source', () => {
    expect(blocks('intro\n\n<details><summary>Head</summary>\n\nbody\n')).toEqual([]);
  });

  it('leaves a closing fragment carrying more than the tag as source', () => {
    expect(blocks('intro\n\n<details><summary>H</summary>\n\nbody\n\n</details>\ntail\n')).toEqual([]);
  });

  it('leaves an opening fragment carrying markup the widget cannot show as source', () => {
    const src = 'intro\n\n<details><summary>H</summary><div>x</div>\n\nbody\n\n</details>\n';
    expect(blocks(src)).toEqual([]);
  });

  it('leaves the whole construct as source while the caret is inside it', () => {
    const src = doc('body text');
    expect(blocks(src, src.indexOf('body text'))).toEqual([]);
  });

  it('gives the body its own widgets back once the source is revealed', () => {
    const src = doc('| a | b |\n| - | - |\n| 1 | 2 |');
    // Caret on the opening tag: the disclosure steps aside, the table does not.
    expect(blocks(src, src.indexOf('<details')).map((spec) => spec.kind)).toEqual(['table']);
  });

  it('renders a single-fragment <details> as the compact Folio disclosure too', () => {
    const src = 'intro\n\n<details><summary>Head</summary>text</details>\n';
    expect(blocks(src)).toEqual([
      expect.objectContaining({ kind: 'details', summary: 'Head', body: 'text', open: false }),
    ]);
  });

  it('leaves a disclosure nested in a list alone', () => {
    expect(blocks('intro\n\n- <details>\n\n  body\n\n  </details>\n')).toEqual([]);
  });

  it('emits nothing in source mode', () => {
    expect(blocks(doc('body text'), 0, false)).toEqual([]);
  });

  it('never emits two block specs over the same text', () => {
    // The invariant behind all of the above: overlapping *block* decorations are
    // the one thing CodeMirror does not survive, and a disclosure body is full
    // of constructs that would each claim a block of their own.
    const src = [
      'intro',
      '',
      '<details><summary>Head</summary>',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      '![alt](img/a.png)',
      '',
      '```mermaid',
      'flowchart TD',
      '```',
      '',
      '::pagetree{depth=2}',
      '',
      '</details>',
      '',
      '| c | d |',
      '| - | - |',
      '| 3 | 4 |',
      '',
    ].join('\n');

    const specs = blocks(src).sort((a, b) => a.from - b.from);
    expect(specs.map((spec) => spec.kind)).toEqual(['details', 'table']);
    for (let i = 1; i < specs.length; i++) {
      expect(specs[i].from, 'block specs must not overlap').toBeGreaterThan(specs[i - 1].to);
    }
  });
});

describe('parseDetailsOpen', () => {
  it('reads the summary and the open attribute', () => {
    expect(parseDetailsOpen('<details><summary>Head</summary>')).toEqual({ summary: 'Head', open: false });
    expect(parseDetailsOpen('<DETAILS OPEN><SUMMARY>Head</SUMMARY>')).toEqual({ summary: 'Head', open: true });
    expect(parseDetailsOpen('<details>')).toEqual({ summary: '', open: false });
  });

  it('does not mistake another attribute for `open`', () => {
    expect(parseDetailsOpen('<details data-open="1">')).toEqual({ summary: '', open: false });
  });

  it('rejects a fragment that closes itself — that one is a whole HTML block', () => {
    expect(parseDetailsOpen('<details><summary>H</summary>text</details>')).toBeNull();
  });

  it('rejects anything else in the fragment, and anything that is not a <details>', () => {
    expect(parseDetailsOpen('<details><summary>H</summary><div>x</div>')).toBeNull();
    expect(parseDetailsOpen('<div><summary>H</summary>')).toBeNull();
    expect(parseDetailsOpen('plain text')).toBeNull();
    expect(parseDetailsOpen('</details>')).toBeNull();
  });
});

describe('callouts', () => {
  const src = 'intro\n\n> [!NOTE]\n> remember this\n';
  const marker = src.indexOf('[!NOTE]');

  it('replaces the marker with the alert label and frames every line', () => {
    const specs = inline(src);
    expect(specs).toContainEqual({ kind: 'callout', from: marker, to: marker + 7, type: 'note' });
    expect(specs).toContainEqual({ kind: 'line', pos: 7, cls: 'cm-md-callout cm-md-callout-note' });
    expect(specs).toContainEqual({ kind: 'line', pos: 7, cls: 'cm-md-callout-first' });
    expect(specs).toContainEqual({ kind: 'line', pos: 17, cls: 'cm-md-callout cm-md-callout-note' });
    expect(specs).toContainEqual({ kind: 'line', pos: 17, cls: 'cm-md-callout-last' });
  });

  it('folds the quote prefixes away and leaves the plain-quote frame off', () => {
    const specs = inline(src);
    expect(hidden(specs, src)).toEqual(['> ', '> ']);
    expect(specs.some((spec) => spec.kind === 'line' && spec.cls === 'cm-md-quote')).toBe(false);
  });

  it('never lets the `[!NOTE]` link decoration fight the label for the same range', () => {
    expect(inline(src).some((spec) => spec.kind === 'mark' && spec.cls === 'cm-md-link')).toBe(false);
  });

  it('styles a bare URL pasted into the callout body the same as elsewhere', () => {
    const withUrl = 'intro\n\n> [!NOTE]\n> see https://example.com/x here\n';
    const from = withUrl.indexOf('https://');
    const specs = inline(withUrl);
    expect(specs).toContainEqual({ kind: 'mark', from, to: from + 'https://example.com/x'.length, cls: 'cm-md-link' });
  });

  it('recognises every alert type the reading view does', () => {
    for (const type of CALLOUT_TYPES) {
      const doc = `intro\n\n> [!${type.toUpperCase()}]\n> body\n`;
      expect(inline(doc).find((spec) => spec.kind === 'callout')).toMatchObject({ type });
    }
  });

  it('recognises what the /note … /warning templates insert', () => {
    // slash-menu.ts writes `> [!NOTE]\n> …` — the callout has to read as one
    // the moment the caret leaves it.
    for (const type of ['NOTE', 'TIP', 'IMPORTANT', 'WARNING']) {
      const doc = `intro\n\n> [!${type}]\n> text\n`;
      expect(inline(doc).find((spec) => spec.kind === 'callout')).toMatchObject({
        type: type.toLowerCase(),
      });
    }
  });

  it('leaves `> !NOTE` alone — a broken marker is a plain quote', () => {
    const broken = 'intro\n\n> !NOTE\n> body\n';
    const specs = inline(broken);
    expect(specs.some((spec) => spec.kind === 'callout')).toBe(false);
    expect(specs.some((spec) => spec.kind === 'line' && spec.cls.startsWith('cm-md-callout'))).toBe(false);
    expect(specs).toContainEqual({ kind: 'line', pos: 7, cls: 'cm-md-quote' });
    expect(hidden(specs, broken)).toEqual([]);
  });

  it('rejects a marker that is not alone, not uppercase or not a known type', () => {
    for (const line of ['> [!NOTE] heading', '> [!note]', '> [!NOPE]', '> NOTE', '>[!NOTE] x']) {
      expect(inline(`intro\n\n${line}\n> body\n`).some((spec) => spec.kind === 'callout')).toBe(false);
    }
  });

  it('ignores a marker nested in a list', () => {
    expect(inline('intro\n\n- > [!NOTE]\n  > body\n').some((spec) => spec.kind === 'callout')).toBe(false);
  });

  it('keeps the label and quote prefixes folded while the caret is inside', () => {
    const specs = inline(src, src.indexOf('remember'));
    expect(specs.some((spec) => spec.kind === 'callout')).toBe(true);
    expect(hidden(specs, src)).toEqual(['> ', '> ']);
    // The frame stays as well.
    expect(specs).toContainEqual({ kind: 'line', pos: 7, cls: 'cm-md-callout-first' });
  });

  it('keeps the frame in source mode but folds nothing', () => {
    const specs = inline('intro\n\n> [!TIP]\n> body\n', 0, false);
    expect(specs.some((spec) => spec.kind === 'callout')).toBe(false);
    expect(specs.some((spec) => spec.kind === 'hide')).toBe(false);
    expect(specs).toContainEqual({ kind: 'line', pos: 7, cls: 'cm-md-callout cm-md-callout-tip' });
  });
});

describe('taskToggleEdit', () => {
  it('checks an open task', () => {
    expect(taskToggleEdit('- [ ] write tests', 100)).toEqual({ from: 103, to: 104, insert: 'x' });
  });

  it('unchecks a done task, including uppercase markers', () => {
    expect(taskToggleEdit('- [x] write tests', 0)).toEqual({ from: 3, to: 4, insert: ' ' });
    expect(taskToggleEdit('- [X] write tests', 0)).toEqual({ from: 3, to: 4, insert: ' ' });
  });

  it('accounts for indentation and ordered list markers', () => {
    expect(taskToggleEdit('    - [ ] nested', 0)).toEqual({ from: 7, to: 8, insert: 'x' });
    expect(taskToggleEdit('12. [ ] numbered', 0)).toEqual({ from: 5, to: 6, insert: 'x' });
  });

  it('refuses lines that are not task items', () => {
    expect(taskToggleEdit('- just an item', 0)).toBeNull();
    expect(taskToggleEdit('[ ] not a list', 0)).toBeNull();
  });
});

describe('commit-time lookups', () => {
  const resolve = (source: string) => {
    const doc = Text.of(source.split('\n'));
    return { doc, tree: md.parse(source) };
  };

  it('re-resolves a mermaid fence from any position inside it', () => {
    const src = 'intro\n\n```mermaid\nflowchart TD\n```\n';
    const { doc, tree } = resolve(src);
    const expected = {
      from: 7,
      to: 34,
      open: '```mermaid',
      close: '```',
      code: 'flowchart TD',
    };
    // block start, inside the code, and the very end of the closing fence line
    for (const pos of [7, 20, 34]) {
      expect(mermaidFenceAt(doc, tree, pos)).toEqual(expected);
    }
  });

  it('returns null when the position is not in a mermaid fence', () => {
    const { doc, tree } = resolve('```js\nlet a = 1\n```\n');
    expect(mermaidFenceAt(doc, tree, 8)).toBeNull();
    const plain = resolve('just a paragraph\n');
    expect(mermaidFenceAt(plain.doc, plain.tree, 4)).toBeNull();
  });

  it('re-resolves a table as whole-line bounds', () => {
    const src = 'text\n\n| a | b |\n| - | - |\n| 1 | 2 |\n';
    const { doc, tree } = resolve(src);
    for (const pos of [6, 15, 35]) {
      expect(tableRangeAt(doc, tree, pos)).toEqual({ from: 6, to: 35 });
    }
    expect(tableRangeAt(doc, tree, 2)).toBeNull();
  });

  // Round 17: the metadata line above a table belongs to that table's block,
  // both when the widget is drawn and when an edit is written back. The
  // widget's own position IS that line's start, so resolving from there has to
  // find the table too.
  it('takes the folio-table metadata line in with the table', () => {
    const attr = '[//]: # (folio-table: bg=A1:yellow)';
    const src = `${attr}\n\n| a | b |\n| - | - |\n| 1 | 2 |\n`;
    const { doc, tree } = resolve(src);
    const range = { from: 0, to: src.length - 1 };
    expect(tableRangeAt(doc, tree, 0)).toEqual(range);
    expect(tableRangeAt(doc, tree, attr.length + 5)).toEqual(range);
  });

  it('leaves an unrelated link reference definition out of it', () => {
    const src = '[ref]: https://example.com\n\n| a | b |\n| - | - |\n| 1 | 2 |\n';
    const { doc, tree } = resolve(src);
    expect(tableRangeAt(doc, tree, 30)?.from).toBe(28);
    expect(tableRangeAt(doc, tree, 0)).toBeNull();
  });
});

describe('computeBlockSpecs: round 17 tables', () => {
  const attr = '[//]: # (folio-table: bg=A1:yellow)';
  const src = `${attr}\n\n| a | b |\n| - | - |\n| 1 | 2 |\n`;

  it('draws one widget over the metadata line and the table together', () => {
    const [spec] = blocks(src, src.length);
    expect(spec).toMatchObject({ kind: 'table', from: 0 });
    expect(spec.kind === 'table' && spec.source.startsWith(attr)).toBe(true);
  });

  it('reveals the plain source when the caret is on the metadata line', () => {
    expect(blocks(src, 4)).toEqual([]);
  });
});

describe('isSelfContainedHtmlBlock', () => {
  it('accepts a block that closes the tag it opened', () => {
    expect(isSelfContainedHtmlBlock('<table><tr><td>a</td></tr></table>')).toBe(true);
    expect(isSelfContainedHtmlBlock('<table class="x">\n<tbody></tbody>\n</table>')).toBe(true);
    expect(isSelfContainedHtmlBlock('<details><summary>S</summary>text</details>')).toBe(true);
  });

  it('accepts a self-closing element', () => {
    expect(isSelfContainedHtmlBlock('<hr/>')).toBe(true);
    expect(isSelfContainedHtmlBlock('<img src="a.png"/>')).toBe(true);
  });

  it('rejects fragments and stray closing tags', () => {
    expect(isSelfContainedHtmlBlock('<details><summary>S</summary>')).toBe(false);
    expect(isSelfContainedHtmlBlock('</details>')).toBe(false);
    expect(isSelfContainedHtmlBlock('<table><tr><td>a')).toBe(false);
  });

  it('rejects anything that is not an element', () => {
    expect(isSelfContainedHtmlBlock('')).toBe(false);
    expect(isSelfContainedHtmlBlock('plain text')).toBe(false);
    expect(isSelfContainedHtmlBlock('<!-- comment -->')).toBe(false);
  });

  it('matches the tag case-insensitively', () => {
    expect(isSelfContainedHtmlBlock('<TABLE><tr></tr></TABLE>')).toBe(true);
  });
});

describe('parsePagetreeLine', () => {
  it('parses the bare directive at the default depth', () => {
    expect(parsePagetreeLine('::pagetree')).toEqual({ depth: 2 });
    expect(parsePagetreeLine('::pagetree{}')).toEqual({ depth: 2 });
  });

  it('reads an explicit depth', () => {
    expect(parsePagetreeLine('::pagetree{depth=1}')).toEqual({ depth: 1 });
    expect(parsePagetreeLine('::pagetree{depth=3}')).toEqual({ depth: 3 });
    expect(parsePagetreeLine('::pagetree{depth=5}')).toEqual({ depth: 5 });
  });

  it('clamps depth into 1..5', () => {
    expect(parsePagetreeLine('::pagetree{depth=0}')).toEqual({ depth: 1 });
    expect(parsePagetreeLine('::pagetree{depth=9}')).toEqual({ depth: 5 });
    expect(parsePagetreeLine('::pagetree{depth=99}')).toEqual({ depth: 5 });
  });

  it('tolerates whitespace and quotes around the value', () => {
    expect(parsePagetreeLine('  ::pagetree{depth=3}  ')).toEqual({ depth: 3 });
    expect(parsePagetreeLine('::pagetree{ depth = 4 }')).toEqual({ depth: 4 });
    expect(parsePagetreeLine('::pagetree{depth="2"}')).toEqual({ depth: 2 });
  });

  it('ignores unrelated attributes but keeps the depth', () => {
    expect(parsePagetreeLine('::pagetree{class=foo depth=3}')).toEqual({ depth: 3 });
  });

  it('rejects anything that is not exactly the directive', () => {
    expect(parsePagetreeLine('::pagetreex')).toBeNull();
    expect(parsePagetreeLine('::page')).toBeNull();
    expect(parsePagetreeLine('text ::pagetree{depth=2}')).toBeNull();
    expect(parsePagetreeLine('::pagetree{depth=2} trailing')).toBeNull();
    expect(parsePagetreeLine(':::pagetree')).toBeNull();
    expect(parsePagetreeLine('')).toBeNull();
  });
});
