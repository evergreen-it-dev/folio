// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import type { CellProps } from 'react-datasheet-grid';
import type { TableColumn, TableRow, TableView } from '@shared/contracts';
import { LONGTEXT_CLAMP_LINES, LONGTEXT_LINE_HEIGHT_PX, LongTextCell } from './CellComponents';
import type { CellContext } from './CellComponents';
import { ROW_HEIGHT_PX } from '../types';
import '../i18n/register';

/**
 * Round 26 follow-up — the owner reported "long text cannot be edited".
 *
 * It never was broken: longtext is read-only in the grid on purpose (spec
 * §12a constraint 3 — a one-line editor would destroy every line but the
 * first) and is edited in the row panel. It was INVISIBLE: the expand button
 * was `opacity-0` unless the mouse hovered the row, so a clicked, empty cell
 * rendered a blank box with no affordance at all.
 *
 * These pin the discoverability, not the read-only rule — which stays.
 */

beforeEach(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const column: TableColumn = { id: 'details', name: 'Details', type: 'longtext' };
const row: TableRow = { id: 'r7k2mq4c', values: { details: '' } };

function cellProps(over: Partial<CellProps<TableRow, CellContext>> = {}) {
  const props: CellProps<TableRow, CellContext> = {
    rowData: row,
    rowIndex: 0,
    columnIndex: 0,
    active: false,
    focus: false,
    disabled: false,
    columnData: { column },
    setRowData: vi.fn(),
    stopEditing: vi.fn(),
    insertRowBelow: vi.fn(),
    duplicateRow: vi.fn(),
    deleteRow: vi.fn(),
    getContextMenuItems: () => [],
    ...over,
  };
  return props;
}

describe('LongTextCell — the row panel has to be findable', () => {
  it('hints what an empty active cell is, instead of a blank box', () => {
    const onOpenRow = vi.fn();
    render(<LongTextCell {...cellProps({ active: true, columnData: { column, onOpenRow } })} />);
    expect(screen.getByText(/Edit…/)).toBeTruthy();
  });

  it('keeps quiet on the 4 999 rows that are not selected', () => {
    const onOpenRow = vi.fn();
    render(<LongTextCell {...cellProps({ columnData: { column, onOpenRow } })} />);
    // The open button is now one for the whole row (TableGrid), not in the cell.
    expect(screen.queryByText('Expand…')).toBeNull();
    expect(screen.queryByLabelText('Expand in the row panel')).toBeNull();
  });

  it('shows the value, not the hint, once the cell has one', () => {
    const onOpenRow = vi.fn();
    const filled: TableRow = { id: 'r1', values: { details: 'first line\nsecond' } };
    render(
      <LongTextCell
        {...cellProps({ active: true, rowData: filled, columnData: { column, onOpenRow } })}
      />,
    );
    expect(screen.queryByText('Expand…')).toBeNull();
    expect(screen.getByText(/first line/)).toBeTruthy();
  });

  it('edits multiline text directly inside the cell', () => {
    const onOpenRow = vi.fn();
    const stopEditing = vi.fn();
    render(
      <LongTextCell
        {...cellProps({ active: true, focus: true, stopEditing, columnData: { column, onOpenRow } })}
      />,
    );

    const editor = screen.getByRole('textbox');
    fireEvent.change(editor, { target: { value: 'the first line\nthe second line' } });
    expect(cellProps().setRowData).not.toHaveBeenCalled();
    expect(onOpenRow).not.toHaveBeenCalled();
    expect(editor.tagName).toBe('TEXTAREA');
  });

  it('writes the edited multiline value and finishes on Cmd/Ctrl+Enter', () => {
    const setRowData = vi.fn();
    const stopEditing = vi.fn();
    render(<LongTextCell {...cellProps({ active: true, focus: true, setRowData, stopEditing })} />);
    const editor = screen.getByRole('textbox');
    fireEvent.change(editor, { target: { value: 'one\ntwo' } });
    expect(setRowData).toHaveBeenCalledWith({ ...row, values: { details: 'one\ntwo' } });
    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true });
    expect(stopEditing).toHaveBeenCalledWith({ nextRow: false });
  });

  it('offers nothing at all when there is no row panel to open', () => {
    render(<LongTextCell {...cellProps({ active: true })} />);
    expect(screen.queryByLabelText('Expand in the row panel')).toBeNull();
    expect(screen.queryByText('Expand…')).toBeNull();
  });
});

/**
 * Round 26 follow-up #2 — the owner reported "multi-line does not work — it
 * has to render properly inline" against the PREVIOUS fix,
 * which collapsed `\n` into a literal " ⏎ " and truncated to one CSS line.
 *
 * jsdom cannot lay out text or apply `-webkit-line-clamp` — every box here
 * is 0×0, so nothing below can confirm text actually WRAPS or gets clipped
 * at a real line boundary in a browser. What it CAN confirm, and does:
 *  - the DOM contract: real newlines reach the DOM as real newlines (no
 *    `⏎` anywhere, `white-space: pre-wrap` so the browser honours them and
 *    still wraps long lines), and `truncate` (nowrap + ellipsis, which
 *    would fight both wrapping and the clamp) is gone from this cell;
 *  - which `line-clamp-N` class is picked per row-height token;
 *  - the arithmetic tying that class count to ROW_HEIGHT_PX, so a future
 *    change to either constant without the other fails a unit test instead
 *    of silently cropping text mid-line in someone's browser.
 * A human still has to look at an actual row, at each of the three
 * heights, and confirm the text visibly wraps and clips cleanly — see this
 * PR's report for exactly that.
 */
describe('LongTextCell — multi-line rendering', () => {
  const multiline: TableRow = { id: 'r9', values: { details: 'first line\nsecond line\nthird' } };

  function renderAt(rowHeight: TableView['rowHeight']) {
    return render(
      <LongTextCell
        {...cellProps({ active: false, rowData: multiline, columnData: { column, rowHeight } })}
      />,
    );
  }

  it('never emits the old ⏎ substitution glyph, at any row height', () => {
    (['short', 'medium', 'tall'] as const).forEach((rowHeight) => {
      const { container, unmount } = renderAt(rowHeight);
      expect(container.textContent).not.toContain('⏎');
      unmount();
    });
  });

  it('puts the real text, real newlines included, into the DOM', () => {
    const { container } = renderAt('medium');
    // Text nodes carry the literal '\n' from the value — this is what
    // `white-space: pre-wrap` needs to render an actual line break; a
    // flattened " ⏎ " string would fail this exact assertion.
    expect(container.textContent).toContain('first line\nsecond line\nthird');
  });

  it('is not truncate/nowrap — that would fight both wrap and clamp', () => {
    const { container } = renderAt('medium');
    const textNode = container.querySelector('.whitespace-pre-wrap');
    expect(textNode).toBeTruthy();
    expect(textNode?.className).not.toContain('truncate');
  });

  it('picks line-clamp-1/2/3 straight off the row-height token', () => {
    expect(renderAt('short').container.querySelector('.line-clamp-1')).toBeTruthy();
    cleanup();
    expect(renderAt('medium').container.querySelector('.line-clamp-2')).toBeTruthy();
    cleanup();
    expect(renderAt('tall').container.querySelector('.line-clamp-3')).toBeTruthy();
  });

  it('defaults to the app-wide default row height (short) when none is supplied', () => {
    // gridColumns.tsx always supplies one; this covers any other caller.
    const { container } = render(
      <LongTextCell {...cellProps({ rowData: multiline, columnData: { column } })} />,
    );
    expect(container.querySelector('.line-clamp-1')).toBeTruthy();
  });

  it('keeps the search highlight working inside the wrapped text', () => {
    const { container } = render(
      <LongTextCell
        {...cellProps({
          rowData: multiline,
          columnData: { column, rowHeight: 'tall', search: 'second' },
        })}
      />,
    );
    const mark = container.querySelector('mark');
    expect(mark?.textContent).toBe('second');
  });

  it('sizes the clamp so it fits inside the row it is drawn in, for every token', () => {
    // The invariant the constants' comments promise: N lines at the fixed
    // line-height must never exceed the row's own pixel height, or the
    // row's box (not line-clamp's ellipsis) would be the thing doing the
    // cropping, mid-line, exactly what this whole fix exists to prevent.
    (Object.keys(ROW_HEIGHT_PX) as TableView['rowHeight'][]).forEach((rowHeight) => {
      const budget = LONGTEXT_CLAMP_LINES[rowHeight] * LONGTEXT_LINE_HEIGHT_PX;
      expect(budget).toBeLessThanOrEqual(ROW_HEIGHT_PX[rowHeight]);
    });
  });

  it('still shows a genuinely short row as one real (unflattened) line', () => {
    // "Short rows may legitimately still show one line" — but it has to be
    // the clamped first line, not a synthetic stand-in for the rest.
    const { container } = renderAt('short');
    expect(container.querySelector('.line-clamp-1')?.textContent).toContain('first line');
  });
});
