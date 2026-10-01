/**
 * Round 26 (DATA TABLES) — the CLIENT half of the structured table Y.Doc.
 *
 * ┌─ READ THIS BEFORE CHANGING ANYTHING HERE ─────────────────────────────┐
 * │ This module is a deliberate MIRROR of the table section of            │
 * │ `server/collab.ts`. The two must describe the SAME six-root Y.Doc     │
 * │ layout, or the server and the browser will read each other's CRDT as  │
 * │ garbage. They are separate files only because the server module       │
 * │ imports fastify/pg and cannot be loaded in a browser, while           │
 * │ `shared/tables/**` (the natural home for the shared half) belongs to  │
 * │ another agent this round.                                             │
 * │                                                                       │
 * │ `server/collabTables.test.ts` contains a PARITY suite that seeds with │
 * │ one side and reads with the other, in both directions — it exists     │
 * │ specifically so this duplication cannot drift silently. Change the    │
 * │ layout here and that suite fails.                                     │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 *   meta:    Y.Map              { id, version, rowIds, seeded }
 *   head:    Y.Text             prose above the table (incl. the H1)
 *   tail:    Y.Text             prose below the table
 *   columns: Y.Array<Y.Map>     { id, name, type, …, options: Y.Array<Y.Map> }
 *   rows:    Y.Array<Y.Map>     { id, <colId>: scalar | Y.Text (longtext) }
 *   views:   Y.Array<Y.Map>     { id, name, columns, sort, filter, … }
 *
 * See docs/spec-tables.md §6 for the rationale (rows/columns/views are
 * Y.Arrays because their ORDER is data; longtext and the prose are Y.Text
 * because that is where two people type into one string at once; everything
 * else is a plain value, because spec §6.1's outcome for those is
 * "last writer wins", which is what a Y.Map value already gives).
 *
 * Unlike the server, the browser only ever loads ONE copy of Yjs, so this
 * file uses `Y.*` constructors directly — the server's `yEngineFor` dance
 * exists purely because y-websocket's CJS build pulls in a second instance
 * there.
 */
import * as Y from 'yjs';
import { tableColumnSchema, tableViewSchema } from '@shared/contracts';
import type { TableCellValue, TableColumn, TableDoc, TableRow, TableView } from '@shared/contracts';
import type { TablePatch } from '../types';

/**
 * Transaction origin for edits made by THIS browser tab. The UndoManager is
 * scoped to it (spec §6 rule 7: "Cmd+Z does not roll back other people's edits"), and the
 * server tags its own seed/reconcile passes with a different origin so
 * "someone changed the file while you were away" never lands in your undo
 * stack.
 */
export const TABLE_LOCAL_ORIGIN = 'folio:table:local';

const TABLE_SEEDED_KEY = 'seeded';

type TableOption = NonNullable<TableColumn['options']>[number];
type YMapAny = Y.Map<unknown>;

export interface TableRoots {
  meta: YMapAny;
  head: Y.Text;
  tail: Y.Text;
  columns: Y.Array<YMapAny>;
  rows: Y.Array<YMapAny>;
  views: Y.Array<YMapAny>;
}

export function tableRoots(ydoc: Y.Doc): TableRoots {
  return {
    meta: ydoc.getMap<unknown>('meta'),
    head: ydoc.getText('head'),
    tail: ydoc.getText('tail'),
    columns: ydoc.getArray<YMapAny>('columns'),
    rows: ydoc.getArray<YMapAny>('rows'),
    views: ydoc.getArray<YMapAny>('views'),
  };
}

/**
 * True once the SERVER has populated this room from the file. Until then the
 * doc is an empty husk and must not be rendered as "an empty table" — that is
 * the client-side half of the same rule that makes the server refuse to
 * persist an unseeded doc.
 */
export function isTableYDocSeeded(ydoc: Y.Doc): boolean {
  return tableRoots(ydoc).meta.get(TABLE_SEEDED_KEY) === true;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function newText(value: string): Y.Text {
  const t = new Y.Text();
  if (value) t.insert(0, value);
  return t;
}

function buildOptionMap(opt: TableOption): YMapAny {
  const m = new Y.Map<unknown>();
  m.set('value', opt.value);
  m.set('color', opt.color);
  if (opt.description !== undefined) m.set('description', opt.description);
  return m;
}

const COLUMN_SCALAR_FIELDS = ['name', 'type', 'description', 'width', 'align', 'multiple', 'allowCreate', 'precision', 'time', 'default'] as const;

export function applyColumnFields(m: YMapAny, patch: Partial<TableColumn>): void {
  for (const key of COLUMN_SCALAR_FIELDS) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value === undefined) m.delete(key);
    else if (m.get(key) !== value) m.set(key, value);
  }
  if ('options' in patch) {
    if (patch.options === undefined) m.delete('options');
    else {
      const arr = new Y.Array<YMapAny>();
      arr.push(patch.options.map(buildOptionMap));
      m.set('options', arr);
    }
  }
}

export function buildColumnMap(col: TableColumn): YMapAny {
  const m = new Y.Map<unknown>();
  m.set('id', col.id);
  applyColumnFields(m, col);
  return m;
}

export function buildRowMap(columns: readonly TableColumn[], row: TableRow): YMapAny {
  const m = new Y.Map<unknown>();
  m.set('id', row.id);
  for (const col of columns) {
    const value = row.values[col.id] ?? null;
    m.set(col.id, col.type === 'longtext' ? newText(value == null ? '' : String(value)) : value);
  }
  return m;
}

const VIEW_FIELDS = ['name', 'icon', 'columns', 'sort', 'filter', 'frozen', 'rowHeight'] as const;

export function applyViewFields(m: YMapAny, patch: Partial<TableView>): void {
  for (const key of VIEW_FIELDS) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value === undefined) m.delete(key);
    else if (!deepEquals(m.get(key), value)) m.set(key, structuredClone(value));
  }
}

export function buildViewMap(view: TableView): YMapAny {
  const m = new Y.Map<unknown>();
  m.set('id', view.id);
  applyViewFields(m, view);
  return m;
}

/** Populates a blank Y.Doc. Used by tests and by offline/preview rendering — the SERVER seeds real rooms. */
export function seedTableYDoc(ydoc: Y.Doc, file: TableDoc): void {
  const r = tableRoots(ydoc);
  r.meta.set('id', file.meta.id);
  r.meta.set('version', file.meta.version);
  r.meta.set('rowIds', file.meta.rowIds);
  if (file.head) r.head.insert(0, file.head);
  if (file.tail) r.tail.insert(0, file.tail);
  r.columns.push(file.columns.map(buildColumnMap));
  r.rows.push(file.rows.map((row) => buildRowMap(file.columns, row)));
  r.views.push(file.views.map(buildViewMap));
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

function plainOf(v: unknown): unknown {
  if (v instanceof Y.Text) return v.toString();
  if (v instanceof Y.Map || v instanceof Y.Array) return (v as { toJSON: () => unknown }).toJSON();
  return v;
}

function issues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join('; ');
}

function columnFromY(m: YMapAny): TableColumn {
  const raw: Record<string, unknown> = {};
  for (const [k, v] of m.entries()) raw[k] = plainOf(v);
  const parsed = tableColumnSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid column ${JSON.stringify(raw.id)}: ${issues(parsed.error)}`);
  return parsed.data;
}

function viewFromY(m: YMapAny): TableView {
  const raw: Record<string, unknown> = {};
  for (const [k, v] of m.entries()) raw[k] = plainOf(v);
  const parsed = tableViewSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid view ${JSON.stringify(raw.id)}: ${issues(parsed.error)}`);
  return parsed.data;
}

/**
 * One row, projected through the CURRENT columns. Keys no column claims are
 * not read at all — spec §6.1: a cell written into a concurrently-deleted
 * column survives in the CRDT (so undoing the deletion restores it) but is
 * invisible to everything downstream.
 */
function rowFromY(m: YMapAny, columns: readonly TableColumn[]): TableRow {
  const values: Record<string, TableCellValue> = {};
  for (const col of columns) {
    const raw = m.get(col.id);
    if (raw instanceof Y.Text) {
      const s = raw.toString();
      values[col.id] = s === '' ? null : s;
    } else {
      values[col.id] = raw === undefined ? null : (raw as TableCellValue);
    }
  }
  return { id: String(m.get('id') ?? ''), values };
}

/** Drops a view's references to columns that no longer exist (mirrors the server; see its comment). */
export function pruneDanglingColumnRefs(view: TableView, columnIds: ReadonlySet<string>): TableView {
  const hidden = view.columns.hidden.filter((id) => columnIds.has(id));
  const order = view.columns.order.filter((id) => columnIds.has(id));
  const width = Object.fromEntries(Object.entries(view.columns.width).filter(([id]) => columnIds.has(id)));
  const sort = view.sort.filter((s) => columnIds.has(s.column));
  const rules = view.filter.rules.filter((rule) => columnIds.has(rule.column));
  const unchanged =
    hidden.length === view.columns.hidden.length &&
    order.length === view.columns.order.length &&
    Object.keys(width).length === Object.keys(view.columns.width).length &&
    sort.length === view.sort.length &&
    rules.length === view.filter.rules.length;
  if (unchanged) return view;
  return { ...view, columns: { hidden, order, width }, sort, filter: { ...view.filter, rules } };
}

/** The live Y.Doc as a plain TableDoc. THROWS on a structurally invalid doc — see useTableDoc, which turns that into a visible warning rather than a blank screen. */
export function tableDocFromYDoc(ydoc: Y.Doc): TableDoc {
  const r = tableRoots(ydoc);
  const columns = r.columns.toArray().map(columnFromY);
  const columnIds = new Set(columns.map((c) => c.id));
  const rowIds = r.meta.get('rowIds');
  return {
    meta: { id: String(r.meta.get('id') ?? ''), version: 1, rowIds: rowIds === 'none' ? 'none' : 'column' },
    head: r.head.toString(),
    tail: r.tail.toString(),
    columns,
    views: r.views.toArray().map((m) => pruneDanglingColumnRefs(viewFromY(m), columnIds)),
    rows: r.rows.toArray().map((m) => rowFromY(m, columns)),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEquals(x, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEquals((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

/** Rewrites `t` to `next` touching only what differs — keeps other people's cursors inside the same text where they were. */
export function setYText(t: Y.Text, next: string): void {
  const cur = t.toString();
  if (cur === next) return;
  const max = Math.min(cur.length, next.length);
  let prefix = 0;
  while (prefix < max && cur[prefix] === next[prefix]) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && cur[cur.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
  const removed = cur.length - prefix - suffix;
  const inserted = next.slice(prefix, next.length - suffix);
  if (removed > 0) t.delete(prefix, removed);
  if (inserted) t.insert(prefix, inserted);
}

function cloneYValue(v: unknown): unknown {
  if (v instanceof Y.Text) return newText(v.toString());
  if (v instanceof Y.Map) {
    const out = new Y.Map<unknown>();
    for (const [k, x] of v.entries()) out.set(k, cloneYValue(x));
    return out;
  }
  if (v instanceof Y.Array) {
    const arr = new Y.Array<unknown>();
    arr.push(v.toArray().map(cloneYValue));
    return arr;
  }
  return v;
}

function idOf(m: YMapAny): string {
  return String(m.get('id') ?? '');
}

function findIndexById(arr: Y.Array<YMapAny>, id: string): number {
  for (let i = 0; i < arr.length; i++) if (idOf(arr.get(i)) === id) return i;
  return -1;
}

// ---------------------------------------------------------------------------
// Patch application
// ---------------------------------------------------------------------------

/**
 * Applies one `TablePatch` (the grid's vocabulary — see ../types) to the
 * Y.Doc. Every lookup is BY ID: by the time a patch built from the grid's
 * operation list reaches the CRDT, a collaborator may have inserted or
 * deleted rows above it, so a positional write would land on the wrong row.
 *
 * Unknown ids are ignored rather than throwing: spec §6.1's outcome for
 * "edited a row someone else just deleted" is that the edit dissolves.
 */
export function applyTablePatch(ydoc: Y.Doc, patch: TablePatch): void {
  const r = tableRoots(ydoc);
  const columns = () => r.columns.toArray().map(columnFromY);

  switch (patch.kind) {
    case 'rows:create': {
      const cols = columns();
      r.rows.insert(Math.max(0, Math.min(patch.at, r.rows.length)), patch.rows.map((row) => buildRowMap(cols, row)));
      return;
    }
    case 'rows:update': {
      const byId = new Map(columns().map((c) => [c.id, c]));
      for (const update of patch.rows) {
        const i = findIndexById(r.rows, update.id);
        if (i === -1) continue;
        const m = r.rows.get(i);
        for (const [colId, value] of Object.entries(update.values)) {
          const col = byId.get(colId);
          if (!col) continue; // column deleted concurrently — don't mint an orphan key
          if (col.type === 'longtext') {
            const cur = m.get(colId);
            const next = value == null ? '' : String(value);
            if (cur instanceof Y.Text) setYText(cur, next);
            else m.set(colId, newText(next));
            continue;
          }
          m.set(colId, value ?? null);
        }
      }
      return;
    }
    case 'rows:delete': {
      const doomed = new Set(patch.ids);
      for (let i = r.rows.length - 1; i >= 0; i--) if (doomed.has(idOf(r.rows.get(i)))) r.rows.delete(i, 1);
      return;
    }
    case 'rows:move': {
      const from = findIndexById(r.rows, patch.id);
      if (from === -1) return;
      // Yjs 13 has no Y.Array move op, so a moved row is cloned, deleted and
      // reinserted — it is the ONE operation that costs a row its CRDT
      // identity, which is why nothing else in this file reorders anything.
      const clone = cloneYValue(r.rows.get(from)) as YMapAny;
      r.rows.delete(from, 1);
      r.rows.insert(Math.max(0, Math.min(patch.to, r.rows.length)), [clone]);
      return;
    }
    case 'columns:create':
      if (findIndexById(r.columns, patch.column.id) !== -1) return;
      r.columns.insert(Math.max(0, Math.min(patch.at, r.columns.length)), [buildColumnMap(patch.column)]);
      return;
    case 'columns:update': {
      const i = findIndexById(r.columns, patch.id);
      if (i !== -1) applyColumnFields(r.columns.get(i), patch.patch);
      return;
    }
    case 'columns:delete': {
      const i = findIndexById(r.columns, patch.id);
      if (i === -1) return;
      r.columns.delete(i, 1);
      // Per-row values stay in their Y.Maps on purpose — undo restores them (spec §6.1).
      return;
    }
    case 'views:create':
      if (findIndexById(r.views, patch.view.id) === -1) r.views.push([buildViewMap(patch.view)]);
      return;
    case 'views:update': {
      const i = findIndexById(r.views, patch.id);
      if (i !== -1) applyViewFields(r.views.get(i), patch.patch);
      return;
    }
    case 'views:delete': {
      if (r.views.length <= 1) return; // spec §5: the last view can't be deleted
      const i = findIndexById(r.views, patch.id);
      if (i !== -1) r.views.delete(i, 1);
      return;
    }
    default:
      return;
  }
}

/** Applies a batch as ONE transaction under the local origin: one undo step, one debounce window, one commit. */
export function applyTablePatches(ydoc: Y.Doc, patches: readonly TablePatch[], origin: unknown = TABLE_LOCAL_ORIGIN): void {
  if (patches.length === 0) return;
  ydoc.transact(() => {
    for (const p of patches) applyTablePatch(ydoc, p);
  }, origin);
}

/**
 * The Y types an UndoManager for this table must watch. All five are needed:
 * scoping it to `rows` alone would make Cmd+Z silently ignore a column or
 * view change, and scoping it to the whole Y.Doc would also capture the
 * server's reconcile passes.
 */
export function undoScope(ydoc: Y.Doc): UndoScope {
  const r = tableRoots(ydoc);
  return [r.rows, r.columns, r.views, r.head, r.tail];
}

/**
 * Exactly what `new Y.UndoManager(...)` accepts. Spelled via
 * ConstructorParameters rather than `Y.AbstractType<unknown>[]` because
 * AbstractType is invariant in its type parameter — a `Y.Array<Y.Map>` is not
 * assignable to `AbstractType<unknown>`, so the obvious annotation doesn't
 * compile even though the value is correct.
 */
export type UndoScope = ConstructorParameters<typeof Y.UndoManager>[0];
