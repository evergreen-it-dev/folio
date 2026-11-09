/**
 * Comments on table cells: the rules that need neither React nor the grid, so
 * they can be tested on their own (the board's counterpart is
 * diagrams/boardCommentsModel.ts).
 *
 * A thread hangs on a cell by the ids of its row and its column
 * (`target.rowId`, `target.columnId`). Ids outlive edits, filters and hidden
 * columns, so a thread keeps pointing at the same cell however the view is set;
 * only deleting the row or the column takes the cell away, and then the thread
 * stays in the list, marked, with the label saved when it began.
 */
import type { CommentThread } from '@shared/comments';
import type { TableColumn, TableRow } from '@shared/contracts';
import { encodeCell } from '@shared/tables/values';

export interface CellRef {
  rowId: string;
  columnId: string;
}

/** The cell a table thread is about; undefined for a thread that is not a cell thread. */
export function threadCell(thread: Pick<CommentThread, 'target'>): CellRef | undefined {
  return thread.target?.kind === 'table_cell' ? { rowId: thread.target.rowId, columnId: thread.target.columnId } : undefined;
}

/** Open threads of each cell as rowId -> columnId -> thread ids, in the order given. */
export function threadsByCell(threads: readonly CommentThread[]): Map<string, Map<string, string[]>> {
  const out = new Map<string, Map<string, string[]>>();
  for (const thread of threads) {
    const cell = threadCell(thread);
    if (!cell) continue;
    const row = out.get(cell.rowId) ?? new Map<string, string[]>();
    const ids = row.get(cell.columnId);
    if (ids) ids.push(thread.id);
    else row.set(cell.columnId, [thread.id]);
    out.set(cell.rowId, row);
  }
  return out;
}

/** Ids of the threads whose row or column is no longer in the table. */
export function deletedCellThreads(threads: readonly CommentThread[], rowIds: ReadonlySet<string>, columnIds: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const thread of threads) {
    const cell = threadCell(thread);
    if (cell && (!rowIds.has(cell.rowId) || !columnIds.has(cell.columnId))) out.add(thread.id);
  }
  return out;
}

/** What the draft card quotes before the server writes its own label: the cell's text, else the column's name. */
export function cellPreview(rows: readonly TableRow[], columns: readonly TableColumn[], cell: CellRef): string {
  const row = rows.find((r) => r.id === cell.rowId);
  const column = columns.find((c) => c.id === cell.columnId);
  if (!row || !column) return '';
  const text = encodeCell(column, row.values[column.id] ?? null).replace(/\s+/g, ' ').trim();
  const label = text || column.name;
  return label.length > 120 ? `${label.slice(0, 119)}…` : label;
}
