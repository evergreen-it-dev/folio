import type { Column } from 'react-datasheet-grid';
import type { TableCellValue, TableColumn, TableRow, TableView } from '@shared/contracts';
import {
  CheckboxCell,
  DateCell,
  LinkCell,
  LongTextCell,
  NumberCell,
  OptionCell,
  TextCell,
} from './cells/CellComponents';
import type { CellContext } from './cells/CellComponents';
import { ColumnHeader } from './header/ColumnHeader';
import { AddColumnButton } from './header/AddColumnButton';
import type { ColumnMenuActions } from './header/ColumnMenu';
import { formatCellText, isEmptyCellValue, parseCellText } from './core';

/**
 * Round 26 (DATA TABLES) — TableColumn[] → react-datasheet-grid columns.
 *
 * This is the integration contract DEV-PLAN R26 spells out for this zone,
 * in one place:
 *
 *   rowKey                 our row `id` (set by the caller on the grid)
 *   copyValue              typed value → clipboard text
 *   prePasteValues         clipboard text[] → typed values, ONCE per paste
 *   pasteValue             typed value → new row object
 *   disabled               true for the viewer role (spec §12)
 *   deleteValue            what Delete/Backspace writes
 *
 * `prePasteValues` is the important one and the reason paste-from-Google
 * Sheets works at all (spec §17.3): the grid calls it once with the whole
 * pasted column, so type coercion happens in one batch against the column's
 * own type rather than per cell — which is also where an async server-side
 * `POST /infer` would hang in wave 3, since the signature allows a Promise.
 */

export interface GridColumnDeps extends Omit<CellContext, 'column'> {
  /** Viewer role — disables every editor without hiding anything (spec §12). */
  readOnly?: boolean;
  actions?: ColumnMenuActions;
  /** Active sort, only so the header can show its ↑/↓ marker. */
  sort?: TableView['sort'];
  /** How many leading columns are sticky (spec §12a, constraint 1). */
  frozen?: number;
  /** Supplied → the grid grows an add-column slot after the last column. */
  onAddColumn?: (name: string, type: TableColumn['type']) => void;
  /** Supplied → each header grows a drag handle that writes a pixel width. */
  onResizeColumn?: (columnId: string, width: number) => void;
}

type GridColumn = Column<TableRow, CellContext, TableCellValue>;

/**
 * `colId` of the trailing add-column slot. A colon can never appear in a real
 * column id (`tableColumnSchema` pins them to `^[a-z0-9_]{1,32}$`), so this
 * cannot collide with a column from a file.
 */
export const ADD_COLUMN_ID = 'folio:add-column';

/** Nothing renders in the slot's body cells — it exists for its header. */
function EmptyCell() {
  return null;
}

/**
 * The add-column slot, appended AFTER the last data column.
 *
 * The «+» used to have nowhere to live but the right edge of the viewport,
 * separated from the last column by a gap ("move the (+) column to the end of
 * the table" — owner). Making it a real grid column instead of an overlay is
 * what buys the tricky parts for free: it is laid out by the same flex pass
 * as every other column, so it sits immediately after the last header at any
 * width; it lives inside the grid's own horizontal scroller, so it scrolls
 * with the columns rather than fighting them; and it is never among the
 * first `frozen` columns, so the sticky-left rule cannot touch it. No
 * measurement, no absolute positioning, no second scroll listener.
 *
 * `grow: 1` lets it absorb the leftover width when the columns don't fill the
 * viewport — which is what closes the empty gap the owner was pointing at —
 * while `shrink: 0` pins it to its 46px once the columns overflow, so with
 * many columns it stays a narrow slot at the far end. The button inside is
 * left-aligned, so it hugs the last column either way.
 *
 * `disabled` keeps it out of cell editing; the class below undoes the
 * library's disabled tint so it reads as empty space, not a broken column.
 */
function addColumnSlot(onAdd: (name: string, type: TableColumn['type']) => void): GridColumn {
  return {
    id: ADD_COLUMN_ID,
    title: <AddColumnButton onCreate={onAdd} />,
    basis: 46,
    grow: 1,
    shrink: 0,
    minWidth: 46,
    component: EmptyCell,
    disabled: true,
    headerClassName: 'folio-add-col',
    cellClassName: 'folio-add-col',
    // Belt and braces: the defaults are already no-ops, but spelling them out
    // means a Ctrl+A copy that reaches this far emits an empty cell rather
    // than whatever a future default might decide to do.
    copyValue: () => '',
    pasteValue: ({ rowData }) => rowData,
    deleteValue: ({ rowData }) => rowData,
    isCellEmpty: () => true,
  };
}

function componentFor(type: TableColumn['type']): GridColumn['component'] {
  switch (type) {
    case 'longtext':
      return LongTextCell;
    case 'number':
      return NumberCell;
    case 'date':
      return DateCell;
    case 'checkbox':
      return CheckboxCell;
    case 'select':
    case 'status':
    case 'user':
      return OptionCell;
    case 'link':
      return LinkCell;
    default:
      return TextCell;
  }
}

/** Default width per type when neither the column nor the view pins one. */
function basisFor(column: TableColumn, view: TableView): number {
  const fromView = view.columns.width[column.id];
  if (typeof fromView === 'number') return fromView;
  if (typeof column.width === 'number') return column.width;
  if (column.type === 'checkbox') return 80;
  if (column.type === 'number') return 110;
  if (column.type === 'date') return 130;
  if (column.type === 'longtext') return 240;
  return 160;
}

/**
 * The columns actually shown, in the view's order, minus the hidden ones.
 * Order comes from the view; anything the view's `order` doesn't mention
 * keeps its schema position at the end — so adding a column to the schema
 * makes it appear rather than vanish (spec §5: order is optional).
 */
export function visibleColumns(columns: TableColumn[], view: TableView): TableColumn[] {
  const hidden = new Set(view.columns.hidden);
  const shown = columns.filter((column) => !hidden.has(column.id));
  const order = view.columns.order;
  if (order.length === 0) return shown;
  const byId = new Map(shown.map((column) => [column.id, column]));
  const ordered = order.map((id) => byId.get(id)).filter((column): column is TableColumn => Boolean(column));
  const rest = shown.filter((column) => !order.includes(column.id));
  return [...ordered, ...rest];
}

export function buildGridColumns(
  columns: TableColumn[],
  view: TableView,
  deps: GridColumnDeps,
): GridColumn[] {
  const sortDirs = new Map((deps.sort ?? []).map((level) => [level.column, level.dir]));
  const frozen = deps.frozen ?? 0;

  const built = columns.map((column, index): GridColumn => {
    // `grow: 0` / `shrink: 0` below mean the rendered width IS the basis, so
    // this doubles as the starting point a resize drag counts from — no box
    // measurement anywhere in that path.
    const basis = basisFor(column, view);
    const columnData: CellContext = {
      column,
      mentionable: deps.mentionable,
      onOpenRow: deps.onOpenRow,
      onCreateOption: deps.onCreateOption,
      search: deps.search,
      // `longtext`'s clamp has to agree with the row's actual pixel height —
      // see CellComponents.tsx's LONGTEXT_CLAMP_LINES — so it needs the
      // view's token, not just a column-level fact.
      rowHeight: view.rowHeight,
    };

    return {
      id: column.id,
      title: (
        <ColumnHeader
          column={column}
          actions={deps.actions}
          readOnly={deps.readOnly}
          sortDir={sortDirs.get(column.id)}
          width={basis}
          // A viewer may crank filters locally but not reshape a view (§12).
          onResize={deps.readOnly ? undefined : deps.onResizeColumn}
        />
      ),
      basis,
      // grow 0 / shrink 0: widths are the view's business (spec §5 stores
      // them per view), so the grid must not silently redistribute them.
      grow: 0,
      shrink: 0,
      minWidth: 60,
      component: componentFor(column.type),
      columnData,
      disabled: deps.readOnly === true,
      // `longtext` is edited in the row panel (spec §12a constraint 3), so
      // the grid must not swallow typing keys for it — let them through to
      // navigation instead of opening an editor that can't do the job.
      disableKeys: false,
      // The option/link editors are popovers rendered OUTSIDE this cell (in
      // a portal). Without keepFocus the grid treats focus landing in the
      // popover as "focus left the cell" and closes the editor instantly.
      keepFocus: column.type === 'select' || column.type === 'status' || column.type === 'user' || column.type === 'link',
      cellClassName: frozen > 0 && index < frozen ? 'folio-frozen-col' : undefined,

      copyValue: ({ rowData }) => formatCellText(column, (rowData.values[column.id] ?? null) as TableCellValue),

      // Whole pasted column at once — one place where a string becomes a
      // typed value, shared by Ctrl+V into the grid and by the import path.
      prePasteValues: (values) => values.map((value) => parseCellText(column, value)),

      pasteValue: ({ rowData, value }) => ({
        ...rowData,
        values: { ...rowData.values, [column.id]: value },
      }),

      deleteValue: ({ rowData }) => ({
        ...rowData,
        // Clearing a checkbox means false, not null — `[ ]` is its empty
        // form in the file (spec §2.4), and null would serialise wrong.
        values: { ...rowData.values, [column.id]: column.type === 'checkbox' ? false : null },
      }),

      // Wave 3: shared/tables' own type-aware emptiness test (the one sort
      // and filter use), replacing this zone's column-less stand-in.
      isCellEmpty: ({ rowData }) => isEmptyCellValue(column, (rowData.values[column.id] ?? null) as TableCellValue),
    };
  });

  // A viewer gets no add-column slot at all (spec §12) — the caller simply
  // doesn't pass the callback.
  return deps.onAddColumn && !deps.readOnly ? [...built, addColumnSlot(deps.onAddColumn)] : built;
}
