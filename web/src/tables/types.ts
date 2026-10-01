import type { TableCellValue, TableColumn, TableDoc, TableRow, TableView } from '@shared/contracts';

/**
 * Round 26 (DATA TABLES) — TABLES-UI zone-local types.
 *
 * Everything that crosses a zone boundary (TableDoc/TableColumn/TableView/
 * TableRow/TableCellValue) comes from @shared/contracts and is NOT redefined
 * here. What lives in this file is purely how the UI talks to itself: the
 * role gate, the draft-view state described in spec §5, and the patch shape
 * the grid's onChange is translated into.
 */

/** Space role, as it reaches the table UI. Drives `disabled`/`lockRows`. */
export type TableRole = 'viewer' | 'editor' | 'admin';

export function canEdit(role: TableRole): boolean {
  return role !== 'viewer';
}

/** Only an editor/admin may persist a view; a viewer may still drive a local draft (spec §5). */
export function canSaveViews(role: TableRole): boolean {
  return role !== 'viewer';
}

/**
 * The single shape every mutation in this zone is expressed as.
 *
 * NORMATIVE (DEV-PLAN R26, "Agent 4"): the grid's `onChange(value,
 * operations)` is translated into these patches *by operation*, never by
 * diffing the whole row array — on 5 000 rows a full diff is both slow and
 * ambiguous (it cannot tell "row deleted" from "row moved"). Wave 3 hands
 * these to COLLAB-TABLES' `editTableDoc(id, patch)` / the Y.Doc binding
 * verbatim; wave 1 applies them to local mock state via applyPatch() in
 * ./patch.ts. The union is deliberately closed so the collab side can
 * exhaustively switch on `kind`.
 */
export type TablePatch =
  | { kind: 'rows:create'; at: number; rows: TableRow[] }
  // `values` is a PARTIAL set of cells — only the ones that changed, not the
  // whole row (see translateOperations). Typed as TableCellValue rather than
  // `unknown` so applying a patch back onto a TableRow needs no cast, and so
  // the collab side in wave 3 gets the real value union to switch on.
  | { kind: 'rows:update'; rows: { id: string; values: Record<string, TableCellValue> }[] }
  | { kind: 'rows:delete'; ids: string[] }
  | { kind: 'rows:move'; id: string; to: number }
  | { kind: 'columns:create'; at: number; column: TableColumn }
  | { kind: 'columns:update'; id: string; patch: Partial<TableColumn> }
  | { kind: 'columns:delete'; id: string }
  | { kind: 'views:create'; view: TableView }
  | { kind: 'views:update'; id: string; patch: Partial<TableView> }
  | { kind: 'views:delete'; id: string };

/** Where a TablePatch goes. Wave 1: local state. Wave 3: the CRDT binding. */
export type TablePatchSink = (patch: TablePatch) => void;

/**
 * A view being edited locally without being saved (spec §5): "playing with
 * a filter" must never rewrite the shared view, nor produce a commit. `base` is
 * the saved view this draft descends from; `dirty` drives the appearance of
 * the "Save changes" / "Add as a new view" buttons.
 */
export interface ViewDraft {
  baseId: string;
  view: TableView;
  dirty: boolean;
}

/** Row-height token → px. Grid-wide, not per-row — see spec §12a, constraint 2. */
export const ROW_HEIGHT_PX: Record<TableView['rowHeight'], number> = {
  short: 32,
  medium: 44,
  tall: 64,
};

/** Props of the table zone's public entry point (wired by SHELL-TABLES in wave 3). */
export interface TableEditorProps {
  pageId: string;
  /** Wave 1 supplies this directly from a fixture; wave 3 from the CRDT mirror. */
  doc: TableDoc;
  role?: TableRole;
  /** Deep link from Cmd+K / `?row=<id>` (spec §11). */
  highlightRowId?: string;
  /** Wave 3 wires this to editTableDoc; wave 1 leaves it to internal mock state. */
  onPatch?: TablePatchSink;
  /** Mentionable users for the `user` column type; empty in wave 1 mocks. */
  mentionable?: string[];
  /**
   * Builds the deep link the row panel's "copy link" writes to the
   * clipboard. Wave 3 (SHELL-TABLES) supplies a router-aware, ABSOLUTE one;
   * without it the link falls back to the current window.location, which is
   * right for mocks and tests but knows nothing about a router basename and
   * yields a relative path that isn't clickable when pasted.
   */
  rowLinkFor?: (rowId: string) => string;
  /**
   * R23 tail (export view picker, SHELL's zone): notifies the shell which
   * SAVED view is active in the grid, so the header's export menu can default
   * its `?view=` to it. Fired on mount and on every active-view change with
   * the resolved saved view's id (the one the read pipeline actually uses,
   * i.e. after the fall-back-to-first-view when a selected view was deleted).
   * Pure notification — the table surface itself does not change behavior.
   */
  onActiveViewChange?: (viewId: string) => void;
}
