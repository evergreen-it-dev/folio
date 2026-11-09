import type { TableColumn, TableRow } from '@shared/contracts';

/**
 * Where a cell can be shown right now: in the grid, only in the row panel
 * (its column is hidden in this view), or after dropping the view's filters
 * (its row is filtered out). `gone` means the row or column no longer exists.
 */
export type CellPlace = 'grid' | 'panel' | 'unfilter' | 'gone';

export function cellPlace(cell: { rowId: string; columnId: string }, allRows: readonly TableRow[], shownRows: readonly TableRow[], allColumns: readonly TableColumn[], shownColumns: readonly TableColumn[]): CellPlace {
  if (!allRows.some((r) => r.id === cell.rowId) || !allColumns.some((c) => c.id === cell.columnId)) return 'gone';
  if (!shownRows.some((r) => r.id === cell.rowId)) return 'unfilter';
  return shownColumns.some((c) => c.id === cell.columnId) ? 'grid' : 'panel';
}
