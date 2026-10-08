// @vitest-environment jsdom
/**
 * link-guard.ts generalised beyond links: `**strong**`, `*em*`, `~~strike~~`,
 * `` `code` ``, `<ins>`/`<mark>` all fold their markers the same way a link
 * does, so a Backspace/Delete/Enter at the folded boundary has the same trap
 * — and the owner's screenshot (a Backspace that ate only the opening `**`,
 * stranding the closing one) is specifically about `**bold**`, not a link.
 * Same harness as link-guard.dom.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { syntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { livePreview, livePreviewConfig } from './live-preview';
import { markdownEditorExtensions } from './markdown-setup';

const views: EditorView[] = [];

function mount(doc: string, pos: number): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        markdownEditorExtensions(),
        livePreview,
        livePreviewConfig(true, { space: 'eng', pagePath: 'a.md', pageId: 'P1' }),
      ],
      selection: EditorSelection.single(pos),
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

function press(view: EditorView, key: string) {
  view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }));
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

// 24.09.2026: a Backspace at the folded edge eats ONE visible character on
// the far side of the marker (the owner: "the whole text was gone"), never half of
// the markup — and the pair goes only once nothing is left between it.
describe('Backspace right after a folded construct eats its last character, markup intact', () => {
  const cases: [string, string, string][] = [
    ['**bold**', '**bold**', '**bol**'],
    ['*em*', '*em*', '*e*'],
    ['~~strike~~', '~~strike~~', '~~strik~~'],
    ['`code`', '`code`', '`cod`'],
    ['++ins++', '++ins++', '++in++'],
    ['<ins>ins</ins>', '<ins>ins</ins>', '<ins>in</ins>'],
    ['<mark>mark</mark>', '<mark>mark</mark>', '<mark>mar</mark>'],
  ];

  for (const [label, markup, after] of cases) {
    it(`${label}: no orphaned opening marker left behind`, () => {
      const doc = `When to use it in sales.${markup}`;
      const view = mount(doc, doc.length);

      press(view, 'Backspace');

      // The whole construct is gone — not just its closing marker, which
      // would leave the opening one (and its content) stranded and visible.
      expect(view.state.doc.toString()).toBe(`When to use it in sales.${after}`);
    });
  }
});

describe('Delete right before a folded construct eats its first character, markup intact', () => {
  it('**bold**: no orphaned closing marker left behind', () => {
    const doc = '**bold**Architecture…';
    const view = mount(doc, 0);

    press(view, 'Delete');

    expect(view.state.doc.toString()).toBe('**old**Architecture…');
  });
});

describe('Enter at the folded boundary never splits the markup in half', () => {
  it('**bold** at the visual end of the line: splits after it, whole', () => {
    const doc = '- **bold**';
    const view = mount(doc, doc.length); // right after "bold", before the hidden "**"

    press(view, 'Enter');

    expect(view.state.doc.toString()).toContain('**bold**');
    expect(view.state.doc.line(1).text).toBe(doc);
  });
});

describe('Enter inside an underline closes and reopens it, like bold', () => {
  it('++ab++ with the caret between a and b becomes two complete pairs', () => {
    const view = mount('++ab++', 3);
    press(view, 'Enter');
    expect(view.state.doc.toString()).toBe('++a++\n++b++');
  });
});

describe('mid-text editing is untouched', () => {
  it('Backspace inside the visible text of a bold span deletes one character, not the whole thing', () => {
    const doc = 'x**bold**y';
    const mid = doc.indexOf('bold') + 2; // between "bo" and "ld"
    const view = mount(doc, mid);

    press(view, 'Backspace');

    expect(view.state.doc.toString()).toBe('x**bld**y');
  });
});

/**
 * The owner, 01.10.2026: the caret stood between `thing:` and a bold phrase,
 * one press of the space bar, and the line read `thing:** JSON path**` with
 * the asterisks showing. The caret had been resting AFTER the hidden opening
 * marker, and `** ` (marker, then a space) opens nothing.
 */
describe('a space typed at the folded edge of a format lands outside it', () => {
  /** What CodeMirror dispatches for a typed character: an insertion at the caret, tagged `input.type`. */
  function type(view: EditorView, text: string) {
    const at = view.state.selection.main.head;
    view.dispatch({ changes: { from: at, insert: text }, selection: EditorSelection.cursor(at + text.length), userEvent: 'input.type' });
  }

  // "It may not be only bold" (the owner, the same day): every format whose
  // markers are hidden. Underline and a coloured highlight are what the
  // formatting toolbar writes; a link is the label's own `[` … `](url)`.
  const formats: [string, string, string][] = [
    ['bold', '**', '**'],
    ['bold with underscores', '__', '__'],
    ['italic', '*', '*'],
    ['strikethrough', '~~', '~~'],
    ['highlight', '==', '=='],
    ['coloured highlight', '==', '=={.green}'],
    ['underline', '++', '++'],
    ['legacy underline', '<ins>', '</ins>'],
    ['legacy highlight', '<mark>', '</mark>'],
    ['link', '[', '](https://example.com)'],
  ];

  for (const [label, open, close] of formats) {
    it(`${label}: a space before the first visible character goes in front of the opening marker`, () => {
      const doc = `thing:${open}JSON path${close}, e.g.`;
      const view = mount(doc, 'thing:'.length + open.length); // after the hidden opening marker
      type(view, ' ');
      expect(view.state.doc.toString()).toBe(`thing: ${open}JSON path${close}, e.g.`);
      // The caret is after the space and before the format: what is typed next is plain.
      expect(view.state.selection.main.head).toBe('thing: '.length);
      type(view, 'x');
      expect(view.state.doc.toString()).toBe(`thing: x${open}JSON path${close}, e.g.`);
    });

    // `__bold__word` is not bold at all in CommonMark: an underscore inside a word marks nothing.
    it.skipIf(open === '__')(`${label}: a space after the last visible character, with a word right behind the format, goes after the closing marker`, () => {
      const doc = `a ${open}JSON${close}path`;
      const view = mount(doc, `a ${open}JSON`.length); // before the hidden closing marker
      type(view, ' ');
      expect(view.state.doc.toString()).toBe(`a ${open}JSON${close} path`);
      expect(view.state.selection.main.head).toBe(`a ${open}JSON${close} `.length);
    });
  }

  it('the format still renders: no raw asterisks appear after the space', () => {
    const doc = 'thing:**JSON path**, e.g.';
    const view = mount(doc, 'thing:**'.length);
    type(view, ' ');
    expect(view.contentDOM.textContent).toBe('thing: JSON path, e.g.');
    // …and it is still bold as far as the parser is concerned.
    const node = syntaxTree(view.state).resolveInner('thing: **J'.length, -1);
    const names: string[] = [];
    for (let n: typeof node | null = node; n; n = n.parent) names.push(n.name);
    expect(names).toContain('StrongEmphasis');
  });

  it('nested formats are stepped out of together', () => {
    const view = mount('a***both***b', 'a***'.length);
    type(view, ' ');
    expect(view.state.doc.toString()).toBe('a ***both***b');

    const end = mount('***both***b', '***both'.length);
    type(end, ' ');
    expect(end.state.doc.toString()).toBe('***both*** b');

    // `++` and `**` nest as two syntax nodes, in either order.
    const plus = mount('a ++**both**++', 'a ++**'.length);
    type(plus, ' ');
    expect(plus.state.doc.toString()).toBe('a  ++**both**++');
    const inner = mount('a **++both++**', 'a **++'.length);
    type(inner, ' ');
    expect(inner.state.doc.toString()).toBe('a  **++both++**');

    // A legacy underline around bold: one of them a syntax node, the other a tag pair.
    const mixed = mount('a<ins>**both**</ins>', 'a<ins>**'.length);
    type(mixed, ' ');
    expect(mixed.state.doc.toString()).toBe('a <ins>**both**</ins>');
  });

  it('at the end of a format with nothing behind it, the space stays inside — the bold phrase can go on', () => {
    const view = mount('**bold**', '**bold'.length);
    type(view, ' ');
    type(view, 'more');
    expect(view.state.doc.toString()).toBe('**bold more**');

    const beforeSpace = mount('**bold** next', '**bold'.length);
    type(beforeSpace, ' ');
    type(beforeSpace, 'more');
    expect(beforeSpace.state.doc.toString()).toBe('**bold more** next');

    // Writing a bold phrase in front of a full stop that is already there.
    const beforeStop = mount('It is **not**.', 'It is **not'.length);
    type(beforeStop, ' ');
    type(beforeStop, 'ready');
    expect(beforeStop.state.doc.toString()).toBe('It is **not ready**.');
  });

  it('a space in the middle of the visible text, or outside the format, is left exactly where it was typed', () => {
    const middle = mount('**JSON path**', '**JSON'.length);
    type(middle, ' ');
    expect(middle.state.doc.toString()).toBe('**JSON  path**');

    const outside = mount('thing:**JSON**', 'thing:'.length); // before the opening marker already
    type(outside, ' ');
    expect(outside.state.doc.toString()).toBe('thing: **JSON**');
  });

  it('a letter typed at the same edge still goes inside the format', () => {
    const view = mount('thing:**JSON**', 'thing:**'.length);
    type(view, 'x');
    expect(view.state.doc.toString()).toBe('thing:**xJSON**');
  });

  it('inline code takes the space as typed — there it is part of the code', () => {
    const code = mount('run`cmd`now', 'run`'.length);
    type(code, ' ');
    expect(code.state.doc.toString()).toBe('run` cmd`now');
  });

  it('source mode is left alone: the markers are visible there, the caret is where it looks', () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: 'thing:**JSON**',
        extensions: [markdownEditorExtensions(), livePreview, livePreviewConfig(false, { space: 'eng', pagePath: 'a.md', pageId: 'P1' })],
        selection: EditorSelection.single('thing:**'.length),
      }),
      parent: document.body,
    });
    views.push(view);
    type(view, ' ');
    expect(view.state.doc.toString()).toBe('thing:** JSON**');
  });
});
