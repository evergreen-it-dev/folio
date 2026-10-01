import { useCallback, useMemo, useRef } from 'react';
import { DynamicDataSheetGrid } from 'react-datasheet-grid';
import type { CellProps, SimpleColumn } from 'react-datasheet-grid';
import { Maximize2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TableColumn, TableRow, TableView } from '@shared/contracts';
import 'react-datasheet-grid/dist/style.css';
import './grid.css';
import { buildGridColumns } from './gridColumns';
import type { GridColumnDeps } from './gridColumns';
import { makeGridContextMenu } from './GridContextMenu';
import { translateOperations } from './patch';
// The library does not re-export its own `Operation` type from the package
// entry point — see patch.ts for why this comes from there instead.
import type { Operation } from './patch';
import { ROW_HEIGHT_PX } from './types';
import type { TablePatch } from './types';

/**
 * Round 26 (DATA TABLES) — the react-datasheet-grid chunk.
 *
 * THIS MODULE IS LAZY-LOADED (see TableView.tsx's React.lazy import) and is
 * the only file in the zone allowed to import `react-datasheet-grid`. That
 * single-entry rule is what keeps the library — plus its transitive
 * @tanstack/react-virtual and its stylesheet — out of the main bundle, the
 * same arrangement diagrams/BoardEditor.tsx uses to keep Excalidraw out of
 * it. Spec §12a, constraint 7 requires exactly this.
 *
 * `DynamicDataSheetGrid` rather than `DataSheetGrid`: the dynamic variant
 * measures row heights instead of assuming them, which is what lets the
 * view's `rowHeight: short|medium|tall` change without remounting.
 */

export interface TableGridProps {
  rows: TableRow[];
  columns: TableColumn[];
  view: TableView;
  onPatch: (patches: TablePatch[]) => void;
  /** Viewer role — disables editing without hiding data (spec §12). */
  readOnly?: boolean;
  /** Blocks row add/delete while keeping cells editable (e.g. an active sort). */
  lockRows?: boolean;
  createRow: () => TableRow;
  deps: Omit<GridColumnDeps, 'readOnly' | 'sort' | 'frozen'>;
  height?: number;
  onActiveCellChange?: (rowId: string | null, columnId: string | null) => void;
  /** Bulk-selection state (spec §4, "bulk operations through the checkboxes on the left"). */
  selectedIds?: Set<string>;
  onToggleRow?: (rowId: string) => void;
  onToggleAll?: () => void;
  selectAllLabel?: string;
  selectRowLabel?: string;
}

interface GutterData {
  selectedIds: Set<string>;
  onToggleRow: (rowId: string) => void;
  label: string;
}

interface RowExpandData {
  onOpenRow: (rowId: string) => void;
  label: string;
}

/** One action for the whole row instead of an accidental button in longtext only. */
export function RowExpandCell({ rowData, columnData }: CellProps<TableRow, RowExpandData>) {
  return (
    <span className="flex h-full w-full items-center justify-center">
      <button
        type="button"
        aria-label={columnData.label}
        title={columnData.label}
        onClick={(event) => {
          event.stopPropagation();
          columnData.onOpenRow(rowData.id);
        }}
        className="folio-row-expand rounded p-1 text-neutral-400 opacity-0 transition-opacity hover:bg-neutral-100 hover:text-neutral-800 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-blue-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
      >
        <Maximize2 size={13} />
      </button>
    </span>
  );
}

/**
 * Row checkbox in the grid's gutter — the built-in slot on the left, which
 * normally shows the row number. Selection lives in the SHELL's state, not
 * in the row data, so that selecting rows never counts as an edit (it must
 * not produce a patch, a commit, or an undo entry).
 */
function GutterCell({ rowData, columnData }: CellProps<TableRow, GutterData>) {
  const selected = columnData.selectedIds.has(rowData.id);
  return (
    <span className="flex h-full w-full items-center justify-center">
      <input
        type="checkbox"
        checked={selected}
        aria-label={columnData.label}
        onChange={() => columnData.onToggleRow(rowData.id)}
        className="h-3.5 w-3.5 cursor-pointer accent-blue-600"
      />
    </span>
  );
}

export default function TableGrid({
  rows,
  columns,
  view,
  onPatch,
  readOnly,
  lockRows,
  createRow,
  deps,
  height,
  onActiveCellChange,
  selectedIds,
  onToggleRow,
  onToggleAll,
  selectAllLabel,
  selectRowLabel,
}: TableGridProps) {
  const { t } = useTranslation('tables');
  // The array the grid last rendered. onChange hands us the NEW array plus
  // operations whose DELETE indexes address the OLD one, so we have to keep
  // it — see translateOperations' docblock.
  const previousRef = useRef<TableRow[]>(rows);
  previousRef.current = rows;

  const gridColumns = useMemo(
    () =>
      buildGridColumns(columns, view, {
        ...deps,
        readOnly,
        sort: view.sort,
        // Spec §12a constraint 1: sticky-position the first `frozen`
        // columns. Only honoured on wide screens — on a phone a frozen
        // column would eat most of the viewport, and §14 hands that job to
        // the row panel instead.
        frozen: view.frozen,
      }),
    [columns, view, deps, readOnly],
  );

  const handleChange = useCallback(
    (next: TableRow[], operations: Operation[]) => {
      const patches = translateOperations(previousRef.current, next, operations);
      if (patches.length > 0) onPatch(patches);
    },
    [onPatch],
  );

  /**
   * Our own right-click menu: the library's is hard-coded English and offers
   * no way to add an item, and the owner wants "Hide column" in it. See
   * GridContextMenu's docblock for what is and isn't in the menu.
   *
   * Memoised on the two things it closes over: `contextMenuComponent` is a
   * component TYPE, so handing the grid a fresh one every render would remount
   * the menu (and lose it) on the very click that opened it.
   *
   * NOTE the library couples this to row locking — its own
   * `disableContextMenu = disableContextMenu || lockRows` — so a view with an
   * active sort has no context menu at all, ours included.
   */
  const contextMenuComponent = useMemo(
    () => makeGridContextMenu({
      columns,
      onHideColumn: readOnly ? undefined : deps.actions?.onHide,
      onEditColumn: readOnly ? undefined : deps.actions?.onEdit,
    }),
    [columns, readOnly, deps.actions],
  );

  const gutterColumn = useMemo((): SimpleColumn<TableRow, GutterData> | undefined => {
    if (!selectedIds || !onToggleRow) return undefined;
    const allSelected = rows.length > 0 && rows.every((row) => selectedIds.has(row.id));
    return {
      basis: 34,
      component: GutterCell as SimpleColumn<TableRow, GutterData>['component'],
      columnData: { selectedIds, onToggleRow, label: selectRowLabel ?? '' },
      title: (
        <span className="flex h-full w-full items-center justify-center">
          <input
            type="checkbox"
            checked={allSelected}
            aria-label={selectAllLabel}
            onChange={() => onToggleAll?.()}
            className="h-3.5 w-3.5 cursor-pointer accent-blue-600"
          />
        </span>
      ),
    };
  }, [rows, selectedIds, onToggleRow, onToggleAll, selectAllLabel, selectRowLabel]);

  const rowExpandColumn = useMemo((): SimpleColumn<TableRow, RowExpandData> | undefined => {
    if (!deps.onOpenRow) return undefined;
    return {
      basis: 34,
      minWidth: 34,
      maxWidth: 34,
      grow: 0,
      shrink: 0,
      title: '',
      component: RowExpandCell,
      columnData: { onOpenRow: deps.onOpenRow, label: t('cell.expand') },
    };
  }, [deps.onOpenRow, t]);

  return (
    <div className="folio-table-grid min-w-0">
      <DynamicDataSheetGrid<TableRow>
        value={rows}
        columns={gridColumns}
        gutterColumn={gutterColumn}
        stickyRightColumn={rowExpandColumn}
        onChange={handleChange}
        // Our own row id, NOT the array index: the grid uses it as its React
        // key, so a filtered/sorted reorder moves DOM nodes instead of
        // rewriting every cell — and it is what makes a row's identity
        // survive a concurrent insert above it (spec §2.5).
        rowKey="id"
        createRow={createRow}
        // `lockRows` is the spec's answer to "dragging rows is available
        // only in a view without an active sort": with a sort on, the
        // visible order isn't the file order, so adding/removing rows by
        // position would land them somewhere the user didn't point at.
        lockRows={readOnly || lockRows}
        disableContextMenu={readOnly}
        contextMenuComponent={contextMenuComponent}
        rowHeight={ROW_HEIGHT_PX[view.rowHeight]}
        headerRowHeight={36}
        height={height}
        addRowsComponent={false}
        onActiveCellChange={
          onActiveCellChange
            ? ({ cell }) =>
                onActiveCellChange(cell ? (rows[cell.row]?.id ?? null) : null, cell?.colId ?? null)
            : undefined
        }
      />
    </div>
  );
}
