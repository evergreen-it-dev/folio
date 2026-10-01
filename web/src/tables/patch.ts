import type { TableCellValue, TableDoc, TableRow } from '@shared/contracts';
import type { TablePatch } from './types';

/**
 * The element type of the second argument of react-datasheet-grid's
 * `onChange(value, operations)`.
 *
 * Declared here rather than imported: the library defines `Operation` in its
 * internal `dist/types.d.ts` but does NOT re-export it from its package
 * entry point — `dist/index.d.ts` re-exports Column, CellProps, CellComponent,
 * SimpleColumn, ContextMenuItem, DataSheetGridRef and stops short of this
 * one — so `import type { Operation } from 'react-datasheet-grid'` does not
 * compile. Deep-importing `react-datasheet-grid/dist/types` instead would
 * bind this zone to the package's internal file layout, which is a worse
 * trade than restating three fields. The declaration is structurally
 * identical to the library's own, and TableGrid.tsx's onChange handler is
 * what keeps it honest: passing this type where the library expects its own
 * would stop compiling the moment the shape diverged.
 */
export interface Operation {
  type: 'UPDATE' | 'DELETE' | 'CREATE';
  fromRowIndex: number;
  toRowIndex: number;
}

/**
 * Round 26 (DATA TABLES) — grid operations → TablePatch, and TablePatch →
 * new TableDoc.
 *
 * Kept as a plain module with no React and no grid rendering so the rules
 * below are unit-testable directly (patch.test.ts) — the alternative,
 * asserting them through a mounted virtualised grid in jsdom, tests the
 * library rather than us.
 *
 * ─── Why operations and not a diff ───────────────────────────────────────
 * DEV-PLAN R26 makes this normative for this zone: "onChange(value,
 * operations) is translated into CRDT patches by operation, not by diffing the array".
 * Two independent reasons:
 *  1. cost — diffing 5 000 rows on every keystroke is O(n) work per edit
 *     where the operation list is O(1);
 *  2. correctness — a diff genuinely cannot distinguish "row deleted" from
 *     "row moved", and cannot tell which of two identical rows changed. In
 *     a CRDT those are different operations with different merge outcomes,
 *     so guessing would corrupt concurrent edits (spec §6.1).
 *
 * ─── The DELETE asymmetry ────────────────────────────────────────────────
 * react-datasheet-grid indexes CREATE/UPDATE into the NEW array and DELETE
 * into the OLD one (the deleted rows are, of course, no longer in the new
 * array). Getting this backwards silently deletes the wrong rows, so
 * translateOperations takes both arrays and is explicit about which side
 * each operation reads from.
 */

export function translateOperations(
  previous: TableRow[],
  next: TableRow[],
  operations: Operation[],
): TablePatch[] {
  const patches: TablePatch[] = [];

  for (const operation of operations) {
    if (operation.type === 'CREATE') {
      patches.push({
        kind: 'rows:create',
        at: operation.fromRowIndex,
        rows: next.slice(operation.fromRowIndex, operation.toRowIndex),
      });
      continue;
    }

    if (operation.type === 'DELETE') {
      // Indexes address the OLD array — see the docblock.
      patches.push({
        kind: 'rows:delete',
        ids: previous.slice(operation.fromRowIndex, operation.toRowIndex).map((row) => row.id),
      });
      continue;
    }

    // UPDATE — emit only the cells that actually changed, not the whole row.
    // A paste over a 200×10 block would otherwise produce 2 000 no-op cell
    // writes, each of which is a real CRDT operation and a real entry in the
    // undo stack.
    const changed: { id: string; values: Record<string, TableCellValue> }[] = [];
    const byId = new Map(previous.map((row) => [row.id, row]));
    for (let index = operation.fromRowIndex; index < operation.toRowIndex; index += 1) {
      const row = next[index];
      if (!row) continue;
      const before = byId.get(row.id);
      if (!before) {
        // Row not in the old array under this id: the grid replaced it
        // wholesale (e.g. paste beyond the last row). Treat as a full write.
        changed.push({ id: row.id, values: { ...row.values } });
        continue;
      }
      const delta: Record<string, TableCellValue> = {};
      for (const key of new Set([...Object.keys(row.values), ...Object.keys(before.values)])) {
        if (!Object.is(row.values[key], before.values[key])) delta[key] = row.values[key] ?? null;
      }
      if (Object.keys(delta).length > 0) changed.push({ id: row.id, values: delta });
    }
    if (changed.length > 0) patches.push({ kind: 'rows:update', rows: changed });
  }

  return patches;
}

/**
 * Applies a patch to a TableDoc, returning a new doc.
 *
 * WAVE 1 ONLY. In wave 3 the patch goes to COLLAB-TABLES'
 * `editTableDoc(id, patch)` and the doc comes back from the Y.Doc mirror
 * instead — this reducer is the local stand-in that lets the UI be driven
 * and tested with no server. The patch SHAPE is the contract; this
 * particular reducer is not.
 *
 * Structural sharing is deliberate: rows the patch doesn't touch keep their
 * object identity, because the grid needs a referentially stable array to
 * avoid re-rendering every visible cell on each keystroke (spec §12a,
 * constraint 4).
 */
export function applyPatch(doc: TableDoc, patch: TablePatch): TableDoc {
  switch (patch.kind) {
    case 'rows:create': {
      const rows = [...doc.rows];
      rows.splice(patch.at, 0, ...patch.rows);
      return { ...doc, rows };
    }
    case 'rows:update': {
      const updates = new Map(patch.rows.map((row) => [row.id, row.values]));
      return {
        ...doc,
        rows: doc.rows.map((row) => {
          const delta = updates.get(row.id);
          // Identity preserved for untouched rows — see the docblock.
          return delta ? { ...row, values: { ...row.values, ...delta } } : row;
        }),
      };
    }
    case 'rows:delete': {
      const doomed = new Set(patch.ids);
      return { ...doc, rows: doc.rows.filter((row) => !doomed.has(row.id)) };
    }
    case 'rows:move': {
      const from = doc.rows.findIndex((row) => row.id === patch.id);
      if (from === -1) return doc;
      const rows = [...doc.rows];
      const [moved] = rows.splice(from, 1);
      if (moved) rows.splice(patch.to, 0, moved);
      return { ...doc, rows };
    }
    case 'columns:create': {
      const columns = [...doc.columns];
      columns.splice(patch.at, 0, patch.column);
      return { ...doc, columns };
    }
    case 'columns:update':
      return {
        ...doc,
        columns: doc.columns.map((column) =>
          column.id === patch.id ? { ...column, ...patch.patch } : column,
        ),
      };
    case 'columns:delete': {
      return {
        ...doc,
        columns: doc.columns.filter((column) => column.id !== patch.id),
        // Cell values for a deleted column are dropped here because this
        // reducer serialises immediately. Note the CRDT behaves DIFFERENTLY
        // and deliberately so (spec §6.1): there the orphaned keys survive
        // in the row's Y.Map and are discarded only at serialisation, which
        // is what makes undoing a column deletion restore its data. Wave 3
        // gets that behaviour for free by not using this reducer.
        rows: doc.rows.map((row) => {
          if (!(patch.id in row.values)) return row;
          const values = { ...row.values };
          delete values[patch.id];
          return { ...row, values };
        }),
      };
    }
    case 'views:create':
      return { ...doc, views: [...doc.views, patch.view] };
    case 'views:update':
      return {
        ...doc,
        views: doc.views.map((view) => (view.id === patch.id ? { ...view, ...patch.patch } : view)),
      };
    case 'views:delete':
      // Spec §5: "The last view cannot be deleted" — enforced here as well as
      // in the UI, so a stray patch can't leave a table with no view at all.
      if (doc.views.length <= 1) return doc;
      return { ...doc, views: doc.views.filter((view) => view.id !== patch.id) };
    default:
      return doc;
  }
}

export function applyPatches(doc: TableDoc, patches: TablePatch[]): TableDoc {
  return patches.reduce(applyPatch, doc);
}

/** A blank row carrying every column's `default` (spec §2.3). */
export function makeEmptyRow(doc: TableDoc, id: string): TableRow {
  const values: TableRow['values'] = {};
  for (const column of doc.columns) {
    if (column.default !== undefined) values[column.id] = column.default as TableRow['values'][string];
    else if (column.type === 'checkbox') values[column.id] = false;
    else values[column.id] = null;
  }
  return { id, values };
}

/**
 * Row id in the file's own alphabet: 8 chars of Crockford base32 (spec §2.5).
 * The server assigns real ULID tails; this is the client-side placeholder
 * for optimistic insertion, and collides at a rate that does not matter for
 * a 20 000-row hard limit.
 */
const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';

export function makeRowId(random: () => number = Math.random): string {
  let id = '';
  for (let index = 0; index < 8; index += 1) {
    id += CROCKFORD[Math.floor(random() * CROCKFORD.length)];
  }
  return id;
}
