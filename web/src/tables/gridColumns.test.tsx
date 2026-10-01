// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import type { TableRow, TableView } from '@shared/contracts';
import { ADD_COLUMN_ID, buildGridColumns } from './gridColumns';
import { MOCK_COLUMNS } from './fixtures';
import './i18n/register';

/**
 * Round 26 follow-up — where the add-column «+» lives.
 *
 * The owner asked for it "at the end of the table", after the last column, instead of
 * pinned to the right edge of the viewport with a gap in between. It is a
 * real trailing grid column now, so these assert the contract that placement
 * rests on: it is LAST, it is never frozen, and its flex numbers are the ones
 * that make it hug the last header at any width.
 *
 * What this file cannot check is the pixels — see the note in gridColumns.tsx
 * and the report: the layout itself is react-datasheet-grid's flex pass, and
 * every box is 0×0 in jsdom.
 */

beforeEach(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const view: TableView = {
  id: 'all',
  name: 'All',
  columns: { hidden: [], order: [], width: {} },
  sort: [],
  filter: { op: 'and', rules: [] },
  frozen: 2,
  rowHeight: 'short',
};

const row: TableRow = { id: 'r1', values: {} };

describe('buildGridColumns — the add-column slot', () => {
  it('appends the slot AFTER the last data column', () => {
    const columns = buildGridColumns(MOCK_COLUMNS, view, { onAddColumn: vi.fn() });
    expect(columns).toHaveLength(MOCK_COLUMNS.length + 1);
    expect(columns.at(-1)?.id).toBe(ADD_COLUMN_ID);
    // …and it did not displace anything.
    expect(columns.slice(0, -1).map((column) => column.id)).toEqual(MOCK_COLUMNS.map((c) => c.id));
  });

  it('is absent without a callback, and for a viewer', () => {
    expect(buildGridColumns(MOCK_COLUMNS, view, {})).toHaveLength(MOCK_COLUMNS.length);
    const asViewer = buildGridColumns(MOCK_COLUMNS, view, { onAddColumn: vi.fn(), readOnly: true });
    expect(asViewer).toHaveLength(MOCK_COLUMNS.length);
  });

  it('absorbs slack width but pins to its own basis once the columns overflow', () => {
    const slot = buildGridColumns(MOCK_COLUMNS, view, { onAddColumn: vi.fn() }).at(-1);
    // grow 1 closes the empty gap after the last column on a wide viewport…
    expect(slot?.grow).toBe(1);
    // …shrink 0 keeps it a narrow slot at the far end when they overflow.
    expect(slot?.shrink).toBe(0);
    expect(slot?.basis).toBe(46);
    expect(slot?.minWidth).toBe(46);
  });

  it('never lands inside the frozen (sticky-left) range', () => {
    // TableGrid hands `view.frozen` down as a dep; mirror that here.
    const columns = buildGridColumns(MOCK_COLUMNS, view, { onAddColumn: vi.fn(), frozen: view.frozen });
    const frozen = columns.filter((column) => column.cellClassName === 'folio-frozen-col');
    expect(frozen).toHaveLength(view.frozen);
    expect(frozen.some((column) => column.id === ADD_COLUMN_ID)).toBe(false);
    expect(columns.at(-1)?.cellClassName).toBe('folio-add-col');
  });

  it('cannot be edited, copied into, pasted into or cleared', () => {
    const slot = buildGridColumns(MOCK_COLUMNS, view, { onAddColumn: vi.fn() }).at(-1);
    expect(slot?.disabled).toBe(true);
    expect(slot?.copyValue?.({ rowData: row, rowIndex: 0 })).toBe('');
    expect(slot?.pasteValue?.({ rowData: row, value: 'x', rowIndex: 0 })).toBe(row);
    expect(slot?.deleteValue?.({ rowData: row, rowIndex: 0 })).toBe(row);
    expect(slot?.isCellEmpty?.({ rowData: row, rowIndex: 0 })).toBe(true);
    // Its body cells render nothing at all.
    const Cell = slot?.component as () => null;
    expect(Cell?.()).toBeNull();
  });

  it('its header is a working «+» that creates a typed column', () => {
    const onAddColumn = vi.fn();
    const slot = buildGridColumns(MOCK_COLUMNS, view, { onAddColumn }).at(-1);
    render(<>{slot?.title}</>);

    fireEvent.click(screen.getByRole('button', { name: 'Add column' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Link to the spec' } });
    fireEvent.click(screen.getByRole('option', { name: 'Link' }));

    expect(onAddColumn).toHaveBeenCalledWith('Link to the spec', 'link');
  });
});
