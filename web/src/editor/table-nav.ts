/**
 * Keyboard navigation rules for the table grid. Pure so the whole Tab/Enter
 * matrix can be checked without a browser.
 *
 * Rows are addressed the way `gfm-table` addresses them: `HEADER_ROW` (-1) is
 * the header, 0..n-1 are body rows.
 */
import { HEADER_ROW } from './gfm-table';

export interface CellRef {
  row: number;
  col: number;
}

export type CellMove =
  /** Move the editor to an existing cell. */
  | { kind: 'cell'; row: number; col: number }
  /** Append a row first, then edit the given cell in it. */
  | { kind: 'newRow'; row: number; col: number }
  /** Leave the grid and hand focus back to the document. */
  | { kind: 'exit' };

/**
 * Enter / Shift+Enter: stay in the column, step a row. Going down off the last
 * body row grows the table, which is what makes filling a fresh grid feel
 * continuous; going up off the header leaves the grid.
 */
export function verticalMove(ref: CellRef, rowCount: number, dir: 1 | -1): CellMove {
  if (dir === 1) {
    if (ref.row === HEADER_ROW) {
      return rowCount > 0 ? { kind: 'cell', row: 0, col: ref.col } : { kind: 'newRow', row: 0, col: ref.col };
    }
    if (ref.row < rowCount - 1) return { kind: 'cell', row: ref.row + 1, col: ref.col };
    return { kind: 'newRow', row: ref.row + 1, col: ref.col };
  }
  if (ref.row === HEADER_ROW) return { kind: 'exit' };
  if (ref.row === 0) return { kind: 'cell', row: HEADER_ROW, col: ref.col };
  return { kind: 'cell', row: ref.row - 1, col: ref.col };
}

/**
 * Tab / Shift+Tab: reading order across the whole grid, header included.
 *
 * Tab off the *last* cell appends a row and carries on into its first cell
 * (round 20), so filling a table is one uninterrupted run of Tabs — the same
 * way Enter already grows it downward. Shift+Tab off the first cell still
 * leaves the grid: there is nothing above the header to grow into.
 */
export function horizontalMove(ref: CellRef, cols: number, rowCount: number, step: number): CellMove {
  if (cols <= 0) return { kind: 'exit' };
  const index = (ref.row + 1) * cols + ref.col + step;
  if (index < 0) return { kind: 'exit' };
  if (index >= (rowCount + 1) * cols) {
    // Stepping forward off the end grows the table; anything else leaves it.
    return step > 0 ? { kind: 'newRow', row: rowCount, col: 0 } : { kind: 'exit' };
  }
  return { kind: 'cell', row: Math.floor(index / cols) - 1, col: index % cols };
}
