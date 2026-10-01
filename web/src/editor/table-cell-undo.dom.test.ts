// @vitest-environment jsdom
/**
 * Ctrl+Z inside an open table cell (fix/undo).
 *
 * The cell editor (`.cm-md-cellinput`) is a `contenteditable` div living
 * inside the table widget, outside `view.contentDOM` — CodeMirror's own
 * `yUndoManagerKeymap` (wired in index.tsx via `keymap.of(yUndoManagerKeymap)`)
 * never sees a keystroke typed in there, so before this round Ctrl+Z inside a
 * cell did nothing at all. `table-widget.ts`'s field now keeps a small local
 * history and falls through to the document's own undo/redo once it is
 * exhausted — these tests pin that down against a REAL `EditorView` wired to a
 * real `Y.Doc`/`Y.UndoManager` the way `collab.ts` and `index.tsx` build them,
 * because the whole point is what the *document's* undo stack ends up holding.
 *
 * The last describe block is the other half of the same bug report ("many
 * people can work at once"): undo must never revert a change that arrived under
 * a Yjs transaction origin the sync plugin does not track — a remote peer's
 * edit chief among them. That guarantee already falls out of how
 * `y-codemirror.next` wires `addTrackedOrigin`, but it is cheap insurance to
 * pin down as a regression test rather than trust an upstream implementation
 * detail to keep holding.
 */
import { Compartment, EditorSelection, EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { afterEach, describe, expect, it } from 'vitest';
import { livePreview, livePreviewConfig } from './live-preview';
import { markdownEditorExtensions } from './markdown-setup';
import { parseGfmTable, serializeGfmTable } from './gfm-table';

const CONTEXT = { space: 'eng', pagePath: 'a.md', pageId: 'P1' };
// `serializeGfmTable` pads columns to a fixed width, and every cell commit —
// including a no-op one, see `closeWithoutWriting` in table-widget.ts — goes
// through it. Building the table from that same function (rather than
// hand-typing it) keeps it byte-identical to what a real no-op commit would
// produce, so opening and closing a cell without typing anything cannot by
// itself add a spurious entry to the document's undo stack.
const TABLE = serializeGfmTable(parseGfmTable(['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n'))!);
const DOC = ['# page', '', TABLE, ''].join('\n');

interface Harness {
  view: EditorView;
  ytext: Y.Text;
  text(): string;
  cell(row: number, col: number): HTMLTableCellElement | null;
  field(): HTMLTextAreaElement | null;
}

const views: EditorView[] = [];
const docs: Y.Doc[] = [];

function mount(initial = DOC): Harness {
  const doc = new Y.Doc();
  docs.push(doc);
  const ytext = doc.getText('content');
  ytext.insert(0, initial);
  const awareness = new Awareness(doc);
  // 0: every dispatch is its own undo step, so the tests below don't have to
  // fight Yjs coalescing rapid transactions together.
  const undoManager = new Y.UndoManager(ytext, { captureTimeout: 0 });

  const mode = new Compartment();
  const view = new EditorView({
    state: EditorState.create({
      doc: initial,
      extensions: [
        markdownEditorExtensions(),
        livePreview,
        mode.of(livePreviewConfig(true, CONTEXT)),
        keymap.of(yUndoManagerKeymap),
        yCollab(ytext, awareness, { undoManager }),
      ],
      selection: EditorSelection.single(0),
    }),
    parent: document.body,
  });
  views.push(view);

  return {
    view,
    ytext,
    text: () => view.state.doc.toString(),
    cell: (row, col) =>
      document.querySelector<HTMLTableCellElement>(`[data-row="${row}"][data-col="${col}"]`),
    field: () => document.querySelector<HTMLTextAreaElement>('.cm-md-cellinput'),
  };
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  for (const doc of docs.splice(0)) doc.destroy();
  document.body.replaceChildren();
});

/** Open a cell the way a click does. */
function openCell(h: Harness, row: number, col: number): HTMLTextAreaElement {
  h.cell(row, col)!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  return h.field()!;
}

/** Replace the field's value and fire the `input` event the real DOM would. */
function type(field: HTMLTextAreaElement, value: string): void {
  field.value = value;
  field.dispatchEvent(new InputEvent('input', { bubbles: true, data: value.slice(-1) }));
}

function undoKey(target: EventTarget, extra: KeyboardEventInit = {}): void {
  target.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'z',
      code: 'KeyZ',
      metaKey: true,
      bubbles: true,
      cancelable: true,
      ...extra,
    }),
  );
}

/**
 * `yUndoManagerKeymap`'s `Mod-z` entry, called directly on the view — the
 * same command table-widget.ts's own field handler falls back to. A raw
 * `KeyboardEvent` would work too, but CodeMirror's `Mod` resolves to either
 * Cmd or Ctrl depending on `navigator.platform`, which this suite does not
 * pin down; going straight to the command is what actually verifies its
 * behaviour instead of the platform's keyboard convention.
 */
const runDocumentUndo = yUndoManagerKeymap.find((binding) => binding.key === 'Mod-z')?.run;


describe('undo inside a table cell', () => {
  it('undoes the typed text and leaves the document alone', () => {
    const h = mount();
    const field = openCell(h, 0, 0); // the one data row, cell "1"
    expect(field.value).toBe('1');

    type(field, '1 modified');
    expect(field.value).toBe('1 modified');

    undoKey(field);

    expect(field.value).toBe('1');
    // Nothing was ever dispatched: the whole edit happened inside the field.
    expect(h.text()).toBe(DOC);
  });

  it('is a no-op the old native contenteditable undo would not have been', () => {
    // Guards the `preventDefault`/`stopPropagation` call: without it the
    // browser's own undo runs on the contenteditable node and can corrupt the
    // `cm-md-cell-line` structure the field's value getter depends on. jsdom
    // has no native undo to trigger, so what this pins down is that OUR
    // handler always claims the key — the event must come back canceled.
    const h = mount();
    const field = openCell(h, 0, 0);
    type(field, 'x');

    const event = new KeyboardEvent('keydown', {
      key: 'z',
      code: 'KeyZ',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    field.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it('falls through to the document undo once the cell has nothing left to undo', () => {
    const h = mount();
    // A tracked, document-level edit made before the cell is even opened —
    // this is what the fallback below is supposed to remove.
    h.view.dispatch({ changes: { from: 2, insert: 'X' } });
    expect(h.text()).toContain('Xpage');

    const field = openCell(h, 0, 0); // fresh cell, no edits made in it
    undoKey(field);

    expect(h.text()).not.toContain('Xpage');
    expect(h.text()).toBe(DOC);
  });

  it('keeps handing off on repeated presses once its own history is spent', () => {
    const h = mount();
    h.view.dispatch({ changes: { from: 2, insert: 'X' } }); // '# Xpage'
    h.view.dispatch({ changes: { from: 3, insert: 'Y' } }); // '# XYpage'
    expect(h.text()).toContain('XYpage');

    const field = openCell(h, 0, 0);
    undoKey(field); // removes 'Y'
    // The cell closed on the first hand-off (it committed, no diff); the
    // second press has to reopen it to reach the same field-level handler.
    const again = openCell(h, 0, 0);
    undoKey(again); // removes 'X'

    expect(h.text()).toBe(DOC);
  });
});

describe('undo and a change from another origin', () => {
  it('does not revert an edit that arrived under a different Yjs transaction origin', () => {
    const h = mount();
    // Stands in for a remote peer's edit: the Yjs binding applies it under
    // its OWN origin, never `yCollab`'s sync origin, so `addTrackedOrigin`
    // — the mechanism that scopes the UndoManager to this browser's own
    // edits — must never see it as something to undo.
    h.ytext.doc!.transact(() => {
      h.ytext.insert(0, 'REMOTE-');
    }, 'remote-origin');
    expect(h.text()).toBe(`REMOTE-${DOC}`);

    runDocumentUndo?.(h.view);

    expect(h.text()).toBe(`REMOTE-${DOC}`);
  });

  it('still undoes the local edit sitting underneath the remote one', () => {
    const h = mount();
    h.view.dispatch({ changes: { from: 2, insert: 'LOCAL' } });
    h.ytext.doc!.transact(() => {
      h.ytext.insert(0, 'REMOTE-');
    }, 'remote-origin');
    expect(h.text()).toContain('REMOTE-');
    expect(h.text()).toContain('LOCALpage');

    runDocumentUndo?.(h.view);

    // The remote insert survives; only the local one is gone.
    expect(h.text()).toBe(`REMOTE-${DOC}`);
  });
});

describe('a cell commit that changes nothing', () => {
  it('leaves the document — and the undo stack — untouched (Tab-ing through cells)', () => {
    // An UNPADDED table: serializeGfmTable would re-pad it, so a commit that
    // rewrites the table always produces a document change even when the cell
    // value is identical. That is exactly what used to pile up undo steps.
    const ragged = ['# page', '', '| a | b |', '| --- | --- |', '| 1 | 2 |', ''].join('\n');
    const h = mount(ragged);
    const before = h.text();

    const field = openCell(h, 0, 0); // the one data row, cell "1"
    // No typing at all — just leave the cell, the way Tab or a click elsewhere does.
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));

    expect(h.text()).toBe(before);
  });

  it('still writes when the cell value really changed', () => {
    const h = mount();
    const field = openCell(h, 0, 0);
    type(field, 'changed');
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));

    expect(h.text()).toContain('changed');
  });
});
