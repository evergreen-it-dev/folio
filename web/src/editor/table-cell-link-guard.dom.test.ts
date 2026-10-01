// @vitest-environment jsdom
/**
 * The owner's bug, reproduced in a TABLE CELL (fix/cell-enter-links): a cell
 * with a numbered list whose item is a markdown link. Enter at the visual end
 * of the item used to split `[label](url)` — `1. [AI-driven SDLC: …` /
 * `2. ](https://…)` — because the cell's own caret translation
 * (`rawOffsetAtDom` in table-widget.ts) has the exact same trap the top-level
 * document has (see link-guard.ts): the raw offset it hands back for a caret
 * sitting at the end of the rendered label is legal, but strictly inside the
 * link's raw span, right before the hidden `](url)`.
 *
 * This is the cell editor's own (contenteditable, not CodeMirror-document)
 * caret model, so it needed its own guard — `enterSafeRawPos`/`riskyLinkSpan`
 * in gfm-table.ts, sharing `nearestLinkEdge` with link-guard.ts rather than
 * re-deriving the same arithmetic twice.
 */
import { Compartment, EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCellLine, parseInlineSpans } from './gfm-table';
import { livePreview, livePreviewConfig } from './live-preview';
import { markdownEditorExtensions } from './markdown-setup';

const CONTEXT = { space: 'eng', pagePath: 'a.md', pageId: 'P1' };

const views: EditorView[] = [];

interface Harness {
  view: EditorView;
  cell(row: number, col: number): HTMLTableCellElement | null;
  field(): HTMLTextAreaElement | null;
}

function mount(cellText: string): Harness {
  const doc = ['# page', '', '| a |', '| --- |', `| ${cellText} |`, ''].join('\n');
  const mode = new Compartment();
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [markdownEditorExtensions(), livePreview, mode.of(livePreviewConfig(true, CONTEXT))],
      selection: EditorSelection.single(0),
    }),
    parent: document.body,
  });
  views.push(view);
  return {
    view,
    cell: (row, col) => document.querySelector<HTMLTableCellElement>(`[data-row="${row}"][data-col="${col}"]`),
    field: () => document.querySelector<HTMLTextAreaElement>('.cm-md-cellinput'),
  };
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

/** Open a cell the way a click does. The table's body rows are 0-indexed. */
function openCell(h: Harness, row: number, col: number): HTMLTextAreaElement {
  h.cell(row, col)!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  return h.field()!;
}

function press(field: HTMLTextAreaElement, key: string) {
  field.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }));
}

function pressEnter(field: HTMLTextAreaElement) {
  press(field, 'Enter');
}

/** Raw offset right after a cell line's visible label/text — what the caret looks like at "the visual end of the item". */
function visualEndOffset(line: string): number {
  const parsed = parseCellLine(line);
  const spans = parseInlineSpans(parsed.text);
  const last = spans[spans.length - 1];
  // Mirrors displayToRawOffset(parsed.text, <end of the last span's display text>).
  const chunk = parsed.text.slice(last.from, last.to);
  const rawEnd = last.from + Math.max(0, chunk.indexOf(last.text)) + last.text.length;
  return parsed.marker.length + rawEnd;
}

/** Raw offset right before a link's visible label — the caret looks like it sits at the start of the item. */
function labelStartOffset(line: string): number {
  const parsed = parseCellLine(line);
  const link = parseInlineSpans(parsed.text).find((span) => span.type === 'link')!;
  const chunk = parsed.text.slice(link.from, link.to);
  const labelFrom = link.from + Math.max(0, chunk.indexOf(link.text));
  return parsed.marker.length + labelFrom;
}

describe('Enter next to a folded link inside a table cell', () => {
  it('at the visual end of a list item: splits after the link, never inside it', () => {
    const item = '1. [AI-driven SDLC: label](https://example.com/x)';
    const h = mount(item);
    const field = openCell(h, 0, 0);

    const pos = visualEndOffset(item);
    field.setSelectionRange(pos, pos);
    pressEnter(field);

    const lines = field.value.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(item); // the link's line is untouched
    expect(lines[1]).toBe('2. '); // a clean new (empty) numbered item
  });

  it('a bare URL in a list item is not split either', () => {
    const item = '1. See https://example.com/page';
    const h = mount(item);
    const field = openCell(h, 0, 0);

    const pos = visualEndOffset(item);
    field.setSelectionRange(pos, pos);
    pressEnter(field);

    const lines = field.value.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(item);
    expect(lines[1]).toBe('2. ');
  });
});

describe('Backspace next to a folded link inside a table cell', () => {
  it('right before the label removes the whole link, not just the leading "["', () => {
    const item = '1. [label](https://example.com/x)';
    const h = mount(item);
    const field = openCell(h, 0, 0);

    const pos = labelStartOffset(item); // right before "label", after the hidden "["
    field.setSelectionRange(pos, pos);
    press(field, 'Backspace');

    // No orphaned "1. label](https://example.com/x)" left behind — the whole link is gone.
    expect(field.value).toBe('1. ');
  });
});
