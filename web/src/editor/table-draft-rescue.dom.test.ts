// @vitest-environment jsdom
/**
 * A half-typed table cell, against a REAL EditorView (round 28, QA-3).
 *
 * The rest of the grid is covered in table-widget.dom.test.ts through a stub
 * view, which is enough for "what markdown does this write". It is not enough
 * here: the bug this file guards lives in CodeMirror's own update pipeline —
 * the widget's DOM is thrown away in the middle of `DocView.updateInner`, and
 * both the crash and the lost keystrokes come from what the cell editor tries
 * to do at that exact moment. Only a real view has that moment.
 */
import { Compartment, EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { parseGfmTable } from './gfm-table';
import { livePreview, livePreviewConfig } from './live-preview';
import { markdownEditorExtensions } from './markdown-setup';

const CONTEXT = { space: 'eng', pagePath: 'a.md', pageId: 'P1' };
const DOC = ['# page', '', '| a | b |', '| --- | --- |', '| 1 | 2 |', ''].join('\n');

const views: EditorView[] = [];

interface Harness {
  view: EditorView;
  /** Switch the editor between live and source the way the mode toggle does. */
  setLive(live: boolean): void;
  text(): string;
  /** The document's one table, parsed — `parseGfmTable` wants the block alone. */
  rows(): readonly (readonly string[])[] | undefined;
  cell(row: number, col: number): HTMLTableCellElement | null;
  field(): HTMLTextAreaElement | null;
}

function mount(doc = DOC): Harness {
  const mode = new Compartment();
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        markdownEditorExtensions(),
        livePreview,
        mode.of(livePreviewConfig(true, CONTEXT)),
      ],
      // Away from the table: the caret inside a block unfolds it to source.
      selection: EditorSelection.single(0),
    }),
    parent: document.body,
  });
  views.push(view);

  return {
    view,
    setLive: (live) =>
      view.dispatch({ effects: mode.reconfigure(livePreviewConfig(live, CONTEXT)) }),
    text: () => view.state.doc.toString(),
    rows: () =>
      parseGfmTable(
        view.state.doc
          .toString()
          .split('\n')
          .filter((line) => line.startsWith('|'))
          .join('\n'),
      )?.rows,
    cell: (row, col) =>
      document.querySelector<HTMLTableCellElement>(`[data-row="${row}"][data-col="${col}"]`),
    field: () => document.querySelector<HTMLTextAreaElement>('.cm-md-cellinput'),
  };
}

/** Open a cell for editing and type into it, without ending the edit. */
function draft(h: Harness, row: number, col: number, value: string): HTMLTextAreaElement {
  h.cell(row, col)!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  const field = h.field()!;
  field.value = value;
  field.dispatchEvent(new InputEvent('input', { bubbles: true, data: value.slice(-1) }));
  return field;
}

/**
 * jsdom leaves focus on a node that has left the document; Blink does not. It
 * drops it from `WillRemoveChild` — synchronously, from inside the very DOM
 * mutation CodeMirror is making, and while the node is still attached, which
 * is precisely why a `field.isConnected` test cannot tell this blur from a
 * real one. Without this the exception the QA run reported cannot happen in a
 * test at all, and half of what these tests are for would go unchecked.
 */
function withBlinkFocusLoss<T>(run: () => T): T {
  const original = Node.prototype.removeChild;
  Node.prototype.removeChild = function <N extends Node>(this: Node, child: N): N {
    const active: Node | null = document.activeElement;
    if (active && active !== document.body && (child === active || child.contains(active))) {
      active.dispatchEvent(new FocusEvent('blur'));
    }
    return original.call(this, child) as N;
  };
  try {
    return run();
  } finally {
    Node.prototype.removeChild = original;
  }
}

/** Anything an event listener throws; jsdom reports it here instead of rethrowing. */
function collectErrors(): { seen: () => Error[]; stop: () => void } {
  const errors: Error[] = [];
  const onError = (event: ErrorEvent) => {
    errors.push(event.error ?? new Error(event.message));
  };
  window.addEventListener('error', onError);
  return {
    seen: () => errors,
    stop: () => window.removeEventListener('error', onError),
  };
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

describe('a cell edit that was never committed', () => {
  it('reaches the document when the editor switches to source mode', () => {
    const h = mount();
    draft(h, 0, 0, 'rescued');

    withBlinkFocusLoss(() => h.setLive(false));

    expect(h.rows()).toEqual([['rescued', '2']]);
  });

  it('does it without throwing out of CodeMirror', () => {
    const h = mount();
    draft(h, 0, 0, 'rescued');
    const errors = collectErrors();

    try {
      withBlinkFocusLoss(() => h.setLive(false));
      expect(errors.seen().map((error) => error.message)).toEqual([]);
    } finally {
      errors.stop();
    }
  });

  it('is written once, not once per following update', () => {
    const h = mount();
    draft(h, 0, 0, 'rescued');
    withBlinkFocusLoss(() => h.setLive(false));

    const after = h.text();
    h.setLive(true);
    h.setLive(false);
    expect(h.text()).toBe(after);
  });

  it('survives a table rewrite that comes from the grid itself', () => {
    const h = mount();
    draft(h, 0, 0, 'rescued');

    // The bar buttons suppress the field's blur on purpose (mousedown is
    // prevented), so this is the other way a live grid loses a draft.
    const addRow = [...document.querySelectorAll<HTMLButtonElement>('.cm-md-table-barbtn')][0];
    withBlinkFocusLoss(() => addRow.click());

    expect(h.rows()).toEqual([
      ['rescued', '2'],
      ['', ''],
    ]);
    // And the new row is still the one waiting for the author.
    expect(h.field()?.closest('td')?.dataset.row).toBe('1');
  });

  it('leaves an untouched cell alone', () => {
    const h = mount();
    h.cell(0, 0)!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(h.field()).toBeTruthy();

    withBlinkFocusLoss(() => h.setLive(false));

    expect(h.text()).toBe(DOC);
  });

  it('is thrown away by Escape, as before', () => {
    const h = mount();
    const field = draft(h, 0, 0, 'nope');
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    withBlinkFocusLoss(() => h.setLive(false));

    expect(h.text()).toBe(DOC);
  });

  /**
   * Clicking straight from one cell into another is the one path where two
   * cell editors exist for an instant: the grid's `mousedown` prevents the
   * default, so the open field only loses focus when the new one takes it —
   * and that commit rebuilds the grid, taking the new field with it.
   */
  it('commits the first cell when the click lands in a second one', () => {
    const h = mount();
    draft(h, 0, 0, 'first');
    withBlinkFocusLoss(() => {
      h.cell(0, 1)!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });

    expect(h.rows()).toEqual([['first', '2']]);
    // …and nothing is left holding a draft that could be written a second time.
    h.setLive(false);
    expect(h.rows()).toEqual([['first', '2']]);
  });

  it('is not written twice when the author committed it themselves', () => {
    const h = mount();
    const field = draft(h, 0, 0, 'typed');
    field.dispatchEvent(new FocusEvent('blur'));
    expect(h.rows()).toEqual([['typed', '2']]);

    withBlinkFocusLoss(() => h.setLive(false));

    expect(h.rows()).toEqual([['typed', '2']]);
  });
});
