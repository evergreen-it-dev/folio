import { describe, expect, it } from 'vitest';
import { HEADER_ROW, insertRow, parseGfmTable, serializeGfmTable } from './gfm-table';
import { horizontalMove, verticalMove } from './table-nav';

const at = (row: number, col: number) => ({ row, col });

describe('verticalMove — Enter', () => {
  it('steps from the header into the first body row', () => {
    expect(verticalMove(at(HEADER_ROW, 1), 3, 1)).toEqual({ kind: 'cell', row: 0, col: 1 });
  });

  it('steps down the same column', () => {
    expect(verticalMove(at(0, 2), 3, 1)).toEqual({ kind: 'cell', row: 1, col: 2 });
    expect(verticalMove(at(1, 2), 3, 1)).toEqual({ kind: 'cell', row: 2, col: 2 });
  });

  it('grows the table when leaving the last body row', () => {
    expect(verticalMove(at(2, 0), 3, 1)).toEqual({ kind: 'newRow', row: 3, col: 0 });
  });

  it('grows a header-only table', () => {
    expect(verticalMove(at(HEADER_ROW, 0), 0, 1)).toEqual({ kind: 'newRow', row: 0, col: 0 });
  });
});

describe('verticalMove — Shift+Enter', () => {
  it('steps up the same column', () => {
    expect(verticalMove(at(2, 1), 3, -1)).toEqual({ kind: 'cell', row: 1, col: 1 });
  });

  it('steps from the first body row into the header', () => {
    expect(verticalMove(at(0, 1), 3, -1)).toEqual({ kind: 'cell', row: HEADER_ROW, col: 1 });
  });

  it('leaves the grid above the header', () => {
    expect(verticalMove(at(HEADER_ROW, 0), 3, -1)).toEqual({ kind: 'exit' });
  });

  it('never grows the table upward', () => {
    expect(verticalMove(at(HEADER_ROW, 0), 0, -1)).toEqual({ kind: 'exit' });
  });
});

describe('horizontalMove — Tab', () => {
  it('walks the header left to right', () => {
    expect(horizontalMove(at(HEADER_ROW, 0), 3, 2, 1)).toEqual({
      kind: 'cell',
      row: HEADER_ROW,
      col: 1,
    });
  });

  it('wraps from the end of a row to the start of the next', () => {
    expect(horizontalMove(at(HEADER_ROW, 2), 3, 2, 1)).toEqual({ kind: 'cell', row: 0, col: 0 });
    expect(horizontalMove(at(0, 2), 3, 2, 1)).toEqual({ kind: 'cell', row: 1, col: 0 });
  });

  it('wraps backwards across the row boundary', () => {
    expect(horizontalMove(at(1, 0), 3, 2, -1)).toEqual({ kind: 'cell', row: 0, col: 2 });
  });

  it('leaves the grid backwards off the very first cell', () => {
    expect(horizontalMove(at(HEADER_ROW, 0), 3, 2, -1)).toEqual({ kind: 'exit' });
  });

  it('handles a single-column table', () => {
    expect(horizontalMove(at(HEADER_ROW, 0), 1, 1, 1)).toEqual({ kind: 'cell', row: 0, col: 0 });
  });

  it('refuses to navigate a table with no columns', () => {
    expect(horizontalMove(at(0, 0), 0, 0, 1)).toEqual({ kind: 'exit' });
  });
});

/*
 * Round 20: Tab off the last cell grows the table rather than dropping out of
 * it, so a table is filled in one uninterrupted run of Tabs.
 */
describe('horizontalMove — Tab out of the last cell', () => {
  it('appends a row and lands in its first cell', () => {
    expect(horizontalMove(at(1, 2), 3, 2, 1)).toEqual({ kind: 'newRow', row: 2, col: 0 });
  });

  it('does the same in a single-column table', () => {
    expect(horizontalMove(at(0, 0), 1, 1, 1)).toEqual({ kind: 'newRow', row: 1, col: 0 });
  });

  it('grows a header-only table off the last header cell', () => {
    expect(horizontalMove(at(HEADER_ROW, 2), 3, 0, 1)).toEqual({ kind: 'newRow', row: 0, col: 0 });
  });

  it('is never triggered backwards', () => {
    expect(horizontalMove(at(HEADER_ROW, 0), 3, 0, -1)).toEqual({ kind: 'exit' });
  });

  /*
   * The move only says "grow"; table-widget.ts turns that into
   * `insertRow(table, move.row - 1)`. Checking the pair together is what
   * actually proves Tab lands the caret in the row it just created.
   */
  it('produces a row the widget appends at the end', () => {
    const table = parseGfmTable('| a | b |\n| - | - |\n| 1 | 2 |');
    expect(table).not.toBeNull();
    const move = horizontalMove(at(0, 1), 2, 1, 1);
    expect(move).toEqual({ kind: 'newRow', row: 1, col: 0 });

    const grown = insertRow(table!, (move as { row: number }).row - 1);
    expect(serializeGfmTable(grown)).toBe(
      ['| a   | b   |', '| --- | --- |', '| 1   | 2   |', '|     |     |'].join('\n'),
    );
    expect(grown.rows[(move as { row: number }).row]).toEqual(['', '']);
  });
});
