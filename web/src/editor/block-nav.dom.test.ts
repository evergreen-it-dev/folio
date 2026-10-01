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
