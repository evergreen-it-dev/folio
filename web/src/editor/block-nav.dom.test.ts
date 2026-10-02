// @vitest-environment jsdom
/**
 * Arrow-key/click travel around live-mode block widgets — real EditorView,
 * real document, real events, the same harness link-guard.dom.test.ts uses.
 *
 * Only Left/Right and click are exercised end-to-end here: `view.moveByChar`
 * (which backs Left/Right, same as CodeMirror's own default keymap) works
 * fine without real layout, but `view.moveVertically` needs `getClientRects`,
 * which jsdom does not implement — so Up/Down's decision logic is covered in
 * block-nav.test.ts instead, against the pure `verticalTarget` function.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { livePreview, livePreviewConfig } from './live-preview';
import { markdownEditorExtensions } from './markdown-setup';

const views: EditorView[] = [];

function mount(doc: string, pos: number, live = true): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        markdownEditorExtensions(),
        livePreview,
        livePreviewConfig(live, { space: 'eng', pagePath: 'a.md', pageId: 'P1' }),
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

const TABLE = ['| a | b |', '| --- | --- |', '| 1 | 2 |', '| 3 | 4 |'].join('\n');

describe('ArrowRight near a table', () => {
  it('never reveals the raw pipe markdown, steps clean over the whole block', () => {
    const doc = ['end', TABLE, '', 'after'].join('\n');
    const view = mount(doc, 'end'.length);
    const tableLastLine = doc.split('\n').findIndex((line) => line === '| 3 | 4 |') + 1;

    press(view, 'ArrowRight');

    expect(view.dom.textContent).not.toContain('| --- | --- |');
    // Past the whole table (never mind exactly which line beyond it: table,
    // then a blank line, then "after" — any of those is "past").
    const landedLine = view.state.doc.lineAt(view.state.selection.main.head).number;
    expect(landedLine).toBeGreaterThan(tableLastLine);
  });

  it('ArrowLeft from just past a table steps clean back over it too', () => {
    const doc = ['end', TABLE, '', 'after'].join('\n');
    // Right at the table's own closing edge (the blank line's start, one
    // character past the table's last row) — the position a single ArrowLeft
    // from "after" would first reach, one line at a time.
    const rightAfterTable = doc.indexOf('\n\nafter') + 1;
    const view = mount(doc, rightAfterTable);
    const tableFirstLine = doc.split('\n').findIndex((line) => line === '| a | b |') + 1;

    press(view, 'ArrowLeft');

    expect(view.dom.textContent).not.toContain('| --- | --- |');
    const landedLine = view.state.doc.lineAt(view.state.selection.main.head).number;
    expect(landedLine).toBeLessThan(tableFirstLine);
  });
});

describe('click while the caret sits elsewhere', () => {
  it('a click on a table cell opens it for editing even with the caret on a heading', () => {
    const doc = ['# Heading', '', TABLE].join('\n');
    const view = mount(doc, 3); // caret on the heading line

    const cell = view.dom.querySelector<HTMLElement>('[data-row="0"][data-col="0"]');
    expect(cell).not.toBeNull();
    cell!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));

    expect(view.dom.querySelector('.cm-md-cellinput')).not.toBeNull();
  });
});

/**
 * The owner, 24.09 and 29.09.2026: "I click somewhere near a table, and it
 * turns into source mode". CodeMirror resolves a click in the margin around
 * the widget to the table's own boundary position.
 */
describe('a pointer caret never rests on a folded table', () => {
  const TABLE = ['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n');
  const DOC = `# T\n\nabove\n\n${TABLE}\n\nbelow`;
  const from = DOC.indexOf(TABLE);
  const to = from + TABLE.length;
  const folded = (view: EditorView) => view.dom.querySelector('.cm-md-table-widget') !== null;
  const point = (view: EditorView, pos: number) =>
    view.dispatch({ selection: EditorSelection.cursor(pos), userEvent: 'select.pointer' });

  it('a click resolved to the table start lands on the line above, table still folded', () => {
    const view = mount(DOC, 0);
    expect(folded(view)).toBe(true);
    point(view, from);
    expect(view.state.selection.main.head).toBe(from - 1);
    expect(folded(view)).toBe(true);
  });

  it('a click resolved to the table end lands on the line below', () => {
    const view = mount(DOC, 0);
    point(view, to);
    expect(view.state.selection.main.head).toBe(to + 1);
    expect(folded(view)).toBe(true);
  });

  it('below a table that ends the page, a line is made to write on', () => {
    const doc = `# T\n\n${TABLE}`;
    const view = mount(doc, 0);
    point(view, doc.length);
    expect(view.state.doc.toString()).toBe(`${doc}\n`);
    expect(view.state.selection.main.head).toBe(doc.length + 1);
    expect(folded(view)).toBe(true);
  });

  // Found on production right after the first fix went out: the owner's
  // table has colours, so the block starts at its metadata line — which is
  // not part of the Table node, and the guard looked for that node alone.
  it('a table with a metadata line above it stays folded too', () => {
    const block = `[//]: # (folio-table: bg=A1:yellow)\n\n${TABLE}`;
    const doc = `# T\n\nabove\n\n${block}\n\nbelow`;
    const start = doc.indexOf(block);
    const view = mount(doc, 0);
    expect(folded(view)).toBe(true);

    point(view, start);
    expect(view.state.selection.main.head).toBe(start - 1);
    expect(folded(view)).toBe(true);

    // The blank line between the metadata and the first row belongs to the block as well.
    point(view, start + block.indexOf('\n\n') + 1);
    expect(folded(view)).toBe(true);

    point(view, start + block.length);
    expect(view.state.selection.main.head).toBe(start + block.length + 1);
    expect(folded(view)).toBe(true);
  });

  it('the keyboard passes the table in the direction it was moving', () => {
    const down = mount(DOC, 0);
    down.dispatch({ selection: EditorSelection.cursor(from), userEvent: 'select' });
    expect(down.state.selection.main.head).toBe(to + 1);
    expect(folded(down)).toBe(true);

    const up = mount(DOC, DOC.length);
    up.dispatch({ selection: EditorSelection.cursor(to), userEvent: 'select' });
    expect(up.state.selection.main.head).toBe(from - 1);
    expect(folded(up)).toBe(true);
  });

  it('leaves the Source button alone: a plain selection still reveals the markdown', () => {
    const view = mount(DOC, 0);
    view.dispatch({ selection: EditorSelection.cursor(from + 1) });
    expect(view.state.selection.main.head).toBe(from + 1);
    expect(folded(view)).toBe(false);
  });

  it('inside source that is already revealed, a click places the caret like in any text', () => {
    const view = mount(DOC, from + 1);
    expect(folded(view)).toBe(false);
    point(view, from + 5);
    expect(view.state.selection.main.head).toBe(from + 5);
  });
});

/**
 * The owner, 02.10.2026: "I insert an emoji into a table and it breaks at
 * once" — the table stopped being a grid and showed its `[//]: #
 * (folio-table: …)` line and pipe rows. A click under a table parks the caret
 * on the blank line right below it (`tablePointerGuard`), and whatever is
 * typed there — an emoji from the OS picker, the `((` picker, a letter — lands
 * on the line directly after the last row. GFM reads such a line as one more
 * ROW of the table, so the table swallowed it, the caret was inside the table
 * and the grid unfolded.
 */
describe('text typed on the line right under a folded table', () => {
  const TABLE = ['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n');
  const BLOCK = `[//]: # (folio-table: display=medium; bg=A9:blue; w=1:43%,2:57%)\n\n${TABLE}`;
  const DOC = `# T\n\nabove\n\n${BLOCK}\n\nbelow`;
  /** The blank line between the last row and "below". */
  const gap = DOC.indexOf(BLOCK) + BLOCK.length + 1;
  const folded = (view: EditorView) => view.dom.querySelector('.cm-md-table-widget') !== null;
  const typeAt = (view: EditorView, at: number, text: string, userEvent = 'input.type') =>
    view.dispatch({
      changes: { from: at, insert: text },
      selection: EditorSelection.cursor(at + text.length),
      userEvent,
    });

  it.each([
    ['a letter', 'x'],
    ['an emoji outside the BMP', '😀'],
    ['an emoji with a variation selector', '❤️'],
  ])('%s keeps the table folded and a blank line between them', (_name, text) => {
    const view = mount(DOC, gap);
    expect(folded(view)).toBe(true);
    expect(view.state.doc.lineAt(gap).text).toBe('');

    typeAt(view, gap, text);

    expect(view.state.doc.toString()).toBe(`# T\n\nabove\n\n${BLOCK}\n\n${text}\nbelow`);
    expect(view.state.sliceDoc(view.state.selection.main.head - text.length, view.state.selection.main.head)).toBe(text);
    expect(folded(view)).toBe(true);
    expect(view.dom.textContent).not.toContain('folio-table');
  });

  describe('through an IME composition', () => {
    // The OS emoji panel, a dead key, a phone keyboard. The browser writes the
    // composed text into the caret's line and loses the composition if that
    // text is moved afterwards, so the guard makes the room when it STARTS.
    const compositionStart = (view: EditorView) =>
      view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));

    it('makes the line to write on before the first character, so the table stays folded', () => {
      const view = mount(DOC, gap);

      compositionStart(view);

      expect(view.state.doc.toString()).toBe(`# T\n\nabove\n\n${BLOCK}\n\n\nbelow`);
      expect(view.state.selection.main.head).toBe(gap + 1);
      expect(folded(view)).toBe(true);

      // The browser then writes the composition (`input.type.compose`, never moved).
      typeAt(view, gap + 1, '😀', 'input.type.compose');
      expect(view.state.doc.toString()).toBe(`# T\n\nabove\n\n${BLOCK}\n\n😀\nbelow`);
      expect(view.state.selection.main.head).toBe(gap + 1 + '😀'.length);
      expect(folded(view)).toBe(true);
      expect(view.dom.textContent).not.toContain('folio-table');
    });

    it('does the same for a table that ends the page', () => {
      const doc = `# T\n\n${TABLE}`;
      const view = mount(doc, 0);
      view.dispatch({ selection: EditorSelection.cursor(doc.length), userEvent: 'select.pointer' });
      expect(view.state.doc.toString()).toBe(`${doc}\n`);

      compositionStart(view);

      expect(view.state.doc.toString()).toBe(`${doc}\n\n`);
      expect(view.state.selection.main.head).toBe(doc.length + 2);
      expect(folded(view)).toBe(true);
    });

    it('leaves a composition anywhere else alone', () => {
      const doc = `${DOC}\n\n\nmore`;
      const spare = doc.indexOf('\n\n\nmore') + 2; // the blank line between two blank lines
      for (const [name, view] of [
        ['a paragraph', mount(DOC, DOC.indexOf('above'))],
        ['a blank line with another blank line above', mount(doc, spare)],
        ['source mode', mount(DOC, gap, false)],
      ] as const) {
        const before = view.state.doc.toString();
        compositionStart(view);
        expect(view.state.doc.toString(), name).toBe(before);
      }
    });

    it('does not touch a selection that is a range', () => {
      const view = mount(DOC, gap);
      view.dispatch({ selection: EditorSelection.range(gap, gap + 1 + 'below'.length) });
      compositionStart(view);
      expect(view.state.doc.toString()).toBe(DOC);
    });
  });

  it('a pasted block is moved down as a whole', () => {
    const view = mount(DOC, gap);
    typeAt(view, gap, '😀 first\nsecond', 'input.paste');
    expect(view.state.doc.toString()).toBe(`# T\n\nabove\n\n${BLOCK}\n\n😀 first\nsecond\nbelow`);
    expect(folded(view)).toBe(true);
  });

  it('a table that ends the page gets its writing line separated too', () => {
    const doc = `# T\n\n${TABLE}`;
    const view = mount(doc, 0);
    // The caret that came from a click below the table (`tablePointerGuard`).
    view.dispatch({ selection: EditorSelection.cursor(doc.length), userEvent: 'select.pointer' });
    expect(view.state.doc.toString()).toBe(`${doc}\n`);

    typeAt(view, doc.length + 1, '😀');

    expect(view.state.doc.toString()).toBe(`${doc}\n\n😀`);
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
    expect(folded(view)).toBe(true);
  });

  it('whitespace and Enter on that line leave it blank, so they are not touched', () => {
    const view = mount(DOC, gap);
    typeAt(view, gap, ' ');
    expect(view.state.doc.toString()).toBe(`${DOC.slice(0, gap)} ${DOC.slice(gap)}`);
    view.dispatch({
      changes: { from: gap + 1, insert: '\n' },
      selection: EditorSelection.cursor(gap + 2),
      userEvent: 'input',
    });
    expect(view.state.doc.toString()).toBe(`${DOC.slice(0, gap)} \n${DOC.slice(gap)}`);
    expect(folded(view)).toBe(true);
  });

  it('a line that already has a blank line above it is typed on as usual', () => {
    const doc = DOC.replace('\n\nbelow', '\n\n\nbelow');
    const view = mount(doc, gap + 1);
    typeAt(view, gap + 1, '😀');
    expect(view.state.doc.toString()).toBe(doc.slice(0, gap + 1) + '😀' + doc.slice(gap + 1));
    expect(folded(view)).toBe(true);
  });

  it('only the author\'s own input is rewritten: a peer\'s change is applied as it came', () => {
    const view = mount(DOC, 0);
    // Remote and programmatic transactions carry no user event; rewriting one
    // would put the local document out of step with the shared text.
    view.dispatch({ changes: { from: gap, insert: 'x' } });
    expect(view.state.doc.toString()).toBe(`${DOC.slice(0, gap)}x${DOC.slice(gap)}`);
  });

  it('source mode is plain text: nothing is moved', () => {
    const view = mount(DOC, gap, false);
    typeAt(view, gap, 'x');
    expect(view.state.doc.toString()).toBe(`${DOC.slice(0, gap)}x${DOC.slice(gap)}`);
  });
});
