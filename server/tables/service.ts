/**
 * Round 26 (DATA TABLES) — the SINGLE write path for a table's rows,
 * columns and views (spec §8: "Writing to a table whose collab room is open
 * is possible only through server-side application to the Y.Doc — writing
 * straight to the file past the room is forbidden ... This is an invariant,
 * not an implementation detail"). Every mutating function in this module funnels
 * through `applyPatch` below, and NOTHING ELSE in server/tables/routes.ts or
 * server/mcp.ts is allowed to call storage.writeTableDoc directly.
 *
 * Reads prefer the live collab snapshot when one exists
 * (`collab.getLiveTable`), falling back to the file otherwise
 * (`storage.readFreshTableDoc`) — the same "live room is the truth, else the
 * file is" shape a doc's own read path uses (collab.getLiveText). Writes
 * check `collab.isLiveTable` (not the coarser `isDocLive`): it additionally
 * confirms the room's table Y.Doc is fully seeded, which is exactly the
 * condition `collab.editTableDoc` itself requires before it will accept a
 * patch (it throws otherwise) — see its doc comment in collab.ts.
 *
 * ## Integration with `collab.ts` (COLLAB-TABLES, landed)
 *
 * `collab.editTableDoc(id, patch)` accepts EITHER this module's `type`-
 * discriminated `TableDocPatch` (defined below) or the grid's own `kind`-
 * discriminated `TablePatch` — collab.ts deliberately keeps its own
 * structurally-identical copy of this module's `TableDocPatch` (see that
 * file's doc comment on why: importing this module's copy into collab.ts
 * would create a require cycle, since this module already imports
 * collab.ts). SERVER-TABLES (this file) owns the canonical declaration;
 * collab.ts's copy is expected to be kept in sync with it by hand.
 */
import { badRequest, notFound } from '../errors.js';
import * as storage from '../storage.js';
import * as collab from '../collab.js';
import { translitSlug } from '../translit.js';
import {
  applyFilters,
  applySearch,
  applySort,
  checkCellLength,
  checkColumnCount,
  checkOptionCount,
  checkRowCount,
  checkViewCount,
  convertColumnType,
  convertMultipleToSingle,
  defaultCellValue,
  dumpTableYaml,
  encodeCell,
  generateRowId,
  gridToTableValues,
  inferColumns,
  isTableParseError,
  isTableYamlParseError,
  parseCsv,
  parseTableFile,
  parseTableYaml,
  parseTsv,
  serializeTableFile,
  stringifyCsv,
  stringifyTsv,
  tableToGrid,
  type QueryContext,
} from '../../shared/tables/index.js';
import type {
  PageMeta,
  TableCellValue,
  TableColumn,
  TableDoc,
  TableRow,
  TableView,
} from '../../shared/contracts.js';

// ---------------------------------------------------------------------------
// The write-path patch contract — see the module doc comment above for why
// this exact shape and why it's what `collab.editTableDoc` is written
// against. Row/column/view ids are always minted HERE (service.ts), never
// inside collab.ts or storage.ts, so both write paths (collab-routed and
// direct-file) mint ids identically.
// ---------------------------------------------------------------------------

export type TableDocPatch =
  | { type: 'insertRows'; rows: TableRow[] }
  | { type: 'replaceRows'; rows: TableRow[] }
  | { type: 'updateRows'; rowIds: string[]; values: Record<string, TableCellValue> }
  | { type: 'deleteRows'; rowIds: string[] }
  | { type: 'addColumn'; column: TableColumn }
  | { type: 'updateColumn'; columnId: string; column: Partial<Omit<TableColumn, 'id'>>; rowValues?: Record<string, TableCellValue> }
  | { type: 'deleteColumn'; columnId: string }
  | { type: 'addView'; view: TableView }
  | { type: 'updateView'; viewId: string; view: Partial<Omit<TableView, 'id'>> }
  | { type: 'deleteView'; viewId: string }
  /**
   * Full structural replace of columns+views+rows — the one patch used only
   * by a YAML "replace" import (spec §10: export -> import round-trips
   * byte-for-byte), which is a deliberate whole-schema restore, not an
   * incremental edit. A live collab room applying this drops any OTHER
   * user's concurrent structural change made in the same instant — accepted
   * for this one drastic operation the same way a page restore-to-sha
   * already overwrites a live doc's content wholesale (routes.ts's restore
   * handler, editDocBody's non-live branch).
   */
  | {
      type: 'replaceAll';
      columns: TableColumn[];
      views: TableView[];
      rows: TableRow[];
      /**
       * Round 26 follow-up (restore-to-sha): the prose above/below the table.
       * OPTIONAL because a YAML import legitimately carries no prose and must
       * leave whatever the page already had alone — `undefined` means "don't
       * touch", not "clear". A restore, unlike an import, DOES pass both:
       * restoring a revision has to bring back its text too, or the page comes
       * back with today's prose wrapped around an old table.
       */
      head?: string;
      tail?: string;
    };

/** Pure application of one patch to a plain TableDoc — the direct (non-collab) write path's own interpreter. collab.ts's CRDT-aware application is a SEPARATE implementation over Y.Doc structures, not a caller of this function (see module doc comment). */
export function applyTablePatch(doc: TableDoc, patch: TableDocPatch): TableDoc {
  switch (patch.type) {
    case 'insertRows':
      return { ...doc, rows: [...doc.rows, ...patch.rows] };
    case 'replaceRows':
      return { ...doc, rows: patch.rows };
    case 'updateRows': {
      const ids = new Set(patch.rowIds);
      return { ...doc, rows: doc.rows.map((r) => (ids.has(r.id) ? { ...r, values: { ...r.values, ...patch.values } } : r)) };
    }
    case 'deleteRows': {
      const ids = new Set(patch.rowIds);
      return { ...doc, rows: doc.rows.filter((r) => !ids.has(r.id)) };
    }
    case 'addColumn':
      return { ...doc, columns: [...doc.columns, patch.column] };
    case 'updateColumn': {
      const columns = doc.columns.map((c) => (c.id === patch.columnId ? ({ ...c, ...patch.column, id: c.id } as TableColumn) : c));
      const rowValues = patch.rowValues;
      const rows = rowValues
        ? doc.rows.map((r) => (Object.prototype.hasOwnProperty.call(rowValues, r.id) ? { ...r, values: { ...r.values, [patch.columnId]: rowValues[r.id] } } : r))
        : doc.rows;
      return { ...doc, columns, rows };
    }
    case 'deleteColumn': {
      const columns = doc.columns.filter((c) => c.id !== patch.columnId);
      const rows = doc.rows.map((r) => {
        const values = { ...r.values };
        delete values[patch.columnId];
        return { ...r, values };
      });
      const views = doc.views.map((v) => ({
        ...v,
        columns: { ...v.columns, hidden: v.columns.hidden.filter((id) => id !== patch.columnId), order: v.columns.order.filter((id) => id !== patch.columnId) },
        sort: v.sort.filter((s) => s.column !== patch.columnId),
        filter: { ...v.filter, rules: v.filter.rules.filter((rule) => rule.column !== patch.columnId) },
      }));
      return { ...doc, columns, rows, views };
    }
    case 'addView':
      return { ...doc, views: [...doc.views, patch.view] };
    case 'updateView':
      return { ...doc, views: doc.views.map((v) => (v.id === patch.viewId ? ({ ...v, ...patch.view, id: v.id } as TableView) : v)) };
    case 'deleteView':
      return { ...doc, views: doc.views.filter((v) => v.id !== patch.viewId) };
    case 'replaceAll':
      return {
        ...doc,
        columns: patch.columns,
        views: patch.views,
        rows: patch.rows,
        // `?? doc.x` — see the patch type: absent means "leave the prose alone"
        // (YAML import), not "clear it".
        head: patch.head ?? doc.head,
        tail: patch.tail ?? doc.tail,
      };
    default:
      return doc;
  }
}

/**
 * THE single write path (spec §8's invariant, quoted in the module doc
 * comment). `collab.isLiveTable` (not the coarser `isDocLive`) additionally
 * confirms the room's Y.Doc is a fully-seeded table — the exact
 * precondition `collab.editTableDoc` itself enforces (it throws otherwise,
 * per its own doc comment), so checking it here means this function never
 * calls editTableDoc in a state where it's documented to throw.
 */
async function applyPatch(pageId: string, patch: TableDocPatch): Promise<TableDoc> {
  if (collab.isLiveTable(pageId)) {
    return collab.editTableDoc(pageId, patch);
  }
  const current = await storage.readFreshTableDoc(pageId);
  const next = applyTablePatch(current, patch);
  await storage.writeTableDoc(pageId, next);
  return next;
}

/** Live room -> the CRDT is the truth (collab.getLiveTable); nothing live -> the file is. Same shape as a doc's own read path (collab.getLiveText / storage.readFreshDocBody). */
async function loadDoc(pageId: string): Promise<TableDoc> {
  return collab.getLiveTable(pageId) ?? (await storage.readFreshTableDoc(pageId));
}

function findColumn(doc: TableDoc, columnId: string): TableColumn {
  const col = doc.columns.find((c) => c.id === columnId);
  if (!col) throw notFound('column');
  return col;
}

function findView(doc: TableDoc, viewId: string): TableView {
  const view = doc.views.find((v) => v.id === viewId);
  if (!view) throw notFound('view');
  return view;
}

// ---------------------------------------------------------------------------
// Limits (spec §13) — enforced identically on both write paths, at the
// service layer, BEFORE the patch is built — collab.editTableDoc and the
// direct-file path both just apply whatever patch they're handed, so this is
// the one place these checks live.
// ---------------------------------------------------------------------------

function enforceHardLimit(check: { level: 'ok' | 'warn' | 'error'; message?: string }): void {
  if (check.level === 'error') throw badRequest(check.message ?? 'limit exceeded');
}

function checkCellLengths(columns: TableColumn[], values: Record<string, TableCellValue>): void {
  for (const col of columns) {
    if (!(col.id in values)) continue;
    const len = encodeCell(col, values[col.id] ?? null).length;
    enforceHardLimit(checkCellLength(len));
  }
}

// ---------------------------------------------------------------------------
// Read API
// ---------------------------------------------------------------------------

export interface TableSnapshot {
  meta: PageMeta;
  columns: TableColumn[];
  views: TableView[];
  rows: TableRow[];
}

export async function getTableSnapshot(pageId: string): Promise<TableSnapshot> {
  const [entry, doc] = await Promise.all([storage.requireEntry(pageId), loadDoc(pageId)]);
  return { meta: storage.toPageMeta(entry), columns: doc.columns, views: doc.views, rows: doc.rows };
}

/**
 * The table's whole file as markdown, live-room-aware like every other read
 * here. Exists because the generic page routes (`GET /api/pages/:id`, the
 * public `GET /api/share/:token`) hand a table's content back as `markdown`
 * on `PageDoc` — DEV-PLAN R26 is explicit that PageDoc is NOT extended for
 * tables: "the content of a table is markdown (.table.md), and through the
 * page endpoints it travels as markdown". Serializing the live doc (rather than
 * reading the file) is what makes an unsaved live edit visible to those
 * routes, exactly as collab.getLiveText does for a prose page.
 */
export async function readTableMarkdown(pageId: string): Promise<string> {
  const [entry, doc] = await Promise.all([storage.requireEntry(pageId), loadDoc(pageId)]);
  return storage.withTablePageFields(serializeTableFile(doc), entry.explicitOrder, entry.icon);
}

/**
 * Restore-to-sha for a table (routes.ts's POST /api/pages/:id/restore/:sha).
 *
 * A table CANNOT go through `collab.editDocBody` the way a doc restore does:
 * that writes the prose Y.Text room, while a live table's room is the
 * structured Y.Doc — the write would land in the wrong place and the file
 * that got persisted afterwards would be whatever the structured doc still
 * held. So the raw revision is parsed and applied as one `replaceAll`
 * (prose included), which the CRDT applies BY KEY: rows/columns/views whose
 * ids survive the restore keep their identity instead of being destroyed and
 * recreated.
 *
 * `gitSync.getPageAtSha` already returns a table's file RAW (frontmatter
 * intact) rather than frontmatter-stripped — without that this would parse a
 * schema-less body and restore an empty table.
 */
export async function restoreTableFromMarkdown(pageId: string, raw: string): Promise<PageMeta> {
  const parsed = parseTableFile(raw);
  if (isTableParseError(parsed)) {
    throw badRequest(`this revision is not a valid data table file: ${parsed.message}`);
  }
  await applyPatch(pageId, {
    type: 'replaceAll',
    columns: parsed.columns,
    views: parsed.views,
    rows: parsed.rows,
    head: parsed.head,
    tail: parsed.tail,
  });
  return storage.toPageMeta(await storage.requireEntry(pageId));
}

export interface RowQueryParams {
  view?: string;
  q?: string;
  filter?: TableView['filter'];
  sort?: TableView['sort'];
  limit?: number;
  offset?: number;
  ctx?: QueryContext;
}

export interface RowQueryResult {
  rows: TableRow[];
  total: number;
  columns: TableColumn[];
}

/** GET /api/tables/:pageId/rows — spec §8. Uses shared/tables' applyFilters/applySort/applySearch directly (no server-side reimplementation, per the round's brief). */
export async function queryRows(pageId: string, params: RowQueryParams): Promise<RowQueryResult> {
  const doc = await loadDoc(pageId);
  let filter = params.filter;
  let sort = params.sort;
  if (params.view) {
    const view = findView(doc, params.view);
    filter = filter ?? view.filter;
    sort = sort ?? view.sort;
  }

  let rows = applyFilters(doc.rows, doc.columns, filter, params.ctx);
  if (params.q) rows = applySearch(rows, doc.columns, params.q);
  rows = applySort(rows, doc.columns, sort);

  const total = rows.length;
  const offset = params.offset ?? 0;
  const sliced = params.limit != null ? rows.slice(offset, offset + params.limit) : rows.slice(offset);
  return { rows: sliced, total, columns: doc.columns };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function newRow(columns: TableColumn[], values: Record<string, TableCellValue>): TableRow {
  const out: Record<string, TableCellValue> = {};
  for (const col of columns) {
    out[col.id] = col.id in values ? values[col.id] : defaultCellValue(col);
  }
  return { id: generateRowId(), values: out };
}

export async function insertRows(pageId: string, inputs: Record<string, TableCellValue>[]): Promise<{ rows: TableRow[]; rowCountWarning?: string }> {
  const doc = await loadDoc(pageId);
  for (const input of inputs) checkCellLengths(doc.columns, input);
  const rows = inputs.map((input) => newRow(doc.columns, input));

  const rowCheck = checkRowCount(doc.rows.length + rows.length);
  enforceHardLimit(rowCheck);

  await applyPatch(pageId, { type: 'insertRows', rows });
  return { rows, rowCountWarning: rowCheck.level === 'warn' ? rowCheck.message : undefined };
}

export async function updateRowCells(pageId: string, rowId: string, values: Record<string, TableCellValue>): Promise<TableRow> {
  const doc = await loadDoc(pageId);
  const row = doc.rows.find((r) => r.id === rowId);
  if (!row) throw notFound('row');
  checkCellLengths(doc.columns, values);
  const next = await applyPatch(pageId, { type: 'updateRows', rowIds: [rowId], values });
  const updated = next.rows.find((r) => r.id === rowId);
  if (!updated) throw notFound('row');
  return updated;
}

export async function deleteRow(pageId: string, rowId: string): Promise<void> {
  const doc = await loadDoc(pageId);
  if (!doc.rows.some((r) => r.id === rowId)) throw notFound('row');
  await applyPatch(pageId, { type: 'deleteRows', rowIds: [rowId] });
}

export interface BulkRowsResult {
  affected: number;
}

/** POST /api/tables/:pageId/rows/bulk — spec §8. `values` present -> bulk update; absent -> bulk delete. */
export async function bulkRows(pageId: string, rowIds: string[], values?: Record<string, TableCellValue>): Promise<BulkRowsResult> {
  const doc = await loadDoc(pageId);
  const existing = new Set(doc.rows.map((r) => r.id));
  const targetIds = rowIds.filter((id) => existing.has(id));
  if (targetIds.length === 0) return { affected: 0 };

  if (values) {
    checkCellLengths(doc.columns, values);
    await applyPatch(pageId, { type: 'updateRows', rowIds: targetIds, values });
  } else {
    await applyPatch(pageId, { type: 'deleteRows', rowIds: targetIds });
  }
  return { affected: targetIds.length };
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/** New column ids, spec §2.3: translit+slug of the name, `_2`/`_3`… on collision. Mirrors shared/tables/csv.ts's inferColumns slugifier (not exported from there — see this file's own header note in the round report on why this is a small, deliberate duplication rather than a shared/tables export). */
export function columnIdFromName(name: string, existing: Set<string>): string {
  let base = translitSlug(name).replace(/-/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
  if (base === '') base = 'col';
  let candidate = base;
  let n = 2;
  while (existing.has(candidate)) {
    const suffix = `_${n++}`;
    candidate = `${base.slice(0, Math.max(1, 32 - suffix.length))}${suffix}`;
  }
  return candidate;
}

export type NewColumnInput = Omit<TableColumn, 'id'> & { id?: string };

export async function addColumn(pageId: string, input: NewColumnInput): Promise<TableColumn> {
  const doc = await loadDoc(pageId);
  enforceHardLimit(checkColumnCount(doc.columns.length + 1));
  if (input.options) enforceHardLimit(checkOptionCount(input.options.length));

  const existingIds = new Set(doc.columns.map((c) => c.id));
  const id = input.id && !existingIds.has(input.id) ? input.id : columnIdFromName(input.name, existingIds);
  const column: TableColumn = { ...input, id };

  await applyPatch(pageId, { type: 'addColumn', column });
  return column;
}

export interface UpdateColumnResult {
  column: TableColumn;
  converted: number;
  cleared: number;
}

/**
 * PATCH /api/tables/:pageId/columns/:colId — spec §8: "changing the type of a
 * column returns a report of what was lost". A type change (or a multiple:true->false
 * narrowing) re-derives every row's value for this column through
 * convertColumnType/convertMultipleToSingle (shared/tables/values.ts) and
 * folds BOTH the column definition change and the resulting row values into
 * ONE patch, applied atomically — never two separate writes (which could
 * observably race a concurrent read between them).
 */
export async function updateColumn(pageId: string, columnId: string, patch: Partial<Omit<TableColumn, 'id'>>): Promise<UpdateColumnResult> {
  const doc = await loadDoc(pageId);
  const oldCol = findColumn(doc, columnId);
  if (patch.options) enforceHardLimit(checkOptionCount(patch.options.length));
  const newCol: TableColumn = { ...oldCol, ...patch, id: oldCol.id };

  const typeChanged = patch.type !== undefined && patch.type !== oldCol.type;
  const narrowedToSingle = patch.multiple === false && oldCol.multiple === true && !typeChanged;

  let rowValues: Record<string, TableCellValue> | undefined;
  let converted = 0;
  let cleared = 0;
  if (typeChanged || narrowedToSingle) {
    const values = doc.rows.map((r) => r.values[columnId] ?? null);
    const result = typeChanged ? convertColumnType(oldCol, newCol, values) : convertMultipleToSingle(values);
    converted = result.converted;
    cleared = result.cleared;
    rowValues = {};
    doc.rows.forEach((r, i) => {
      rowValues![r.id] = result.values[i];
    });
  }

  await applyPatch(pageId, { type: 'updateColumn', columnId, column: patch, rowValues });
  return { column: newCol, converted, cleared };
}

export async function deleteColumn(pageId: string, columnId: string): Promise<void> {
  const doc = await loadDoc(pageId);
  findColumn(doc, columnId); // 404 if unknown, before writing
  await applyPatch(pageId, { type: 'deleteColumn', columnId });
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export type NewViewInput = Omit<TableView, 'id'> & { id?: string };

function viewIdFromName(name: string, existing: Set<string>): string {
  let base = translitSlug(name) || 'view';
  if (!existing.has(base)) return base;
  let n = 2;
  let candidate = `${base}-${n}`;
  while (existing.has(candidate)) candidate = `${base}-${n++}`;
  return candidate;
}

export async function addView(pageId: string, input: NewViewInput): Promise<TableView> {
  const doc = await loadDoc(pageId);
  enforceHardLimit(checkViewCount(doc.views.length + 1));
  const existingIds = new Set(doc.views.map((v) => v.id));
  const id = input.id && !existingIds.has(input.id) ? input.id : viewIdFromName(input.name, existingIds);
  const view: TableView = { ...input, id };
  await applyPatch(pageId, { type: 'addView', view });
  return view;
}

export async function updateView(pageId: string, viewId: string, patch: Partial<Omit<TableView, 'id'>>): Promise<TableView> {
  const doc = await loadDoc(pageId);
  const oldView = findView(doc, viewId);
  const newView: TableView = { ...oldView, ...patch, id: oldView.id };
  await applyPatch(pageId, { type: 'updateView', viewId, view: patch });
  return newView;
}

/** Spec §5: "The last view cannot be deleted." */
export async function deleteView(pageId: string, viewId: string): Promise<void> {
  const doc = await loadDoc(pageId);
  findView(doc, viewId); // 404 if unknown
  if (doc.views.length <= 1) throw badRequest('cannot delete the last view');
  await applyPatch(pageId, { type: 'deleteView', viewId });
}

// ---------------------------------------------------------------------------
// Export / import (spec §10)
// ---------------------------------------------------------------------------

export type ExportFormat = 'csv' | 'tsv' | 'md' | 'yaml' | 'json';

export interface ExportResult {
  contentType: string;
  filename: string;
  data: string;
}

/** GET /api/tables/:pageId/export — spec §10: exports what's VISIBLE (current view's filter/sort/column order, hidden columns dropped) unless scope=all. `includeId` mirrors the view's "Show service columns" toggle. */
export async function exportTable(
  pageId: string,
  opts: { format: ExportFormat; view?: string; scope?: 'view' | 'all'; includeId?: boolean; ctx?: QueryContext },
): Promise<ExportResult> {
  const doc = await loadDoc(pageId);
  const entry = await storage.requireEntry(pageId);
  const scope = opts.scope ?? (opts.view ? 'view' : 'all');

  let rows = doc.rows;
  let columns = doc.columns;
  if (scope === 'view' && opts.view) {
    const view = findView(doc, opts.view);
    rows = applyFilters(rows, doc.columns, view.filter, opts.ctx);
    rows = applySort(rows, doc.columns, view.sort);
    const hidden = new Set(view.columns.hidden);
    const order = view.columns.order.length > 0 ? view.columns.order : doc.columns.map((c) => c.id);
    columns = order.map((id) => doc.columns.find((c) => c.id === id)).filter((c): c is TableColumn => c !== undefined && !hidden.has(c.id));
  }

  const stem = entry.title || 'table';
  switch (opts.format) {
    case 'csv': {
      const grid = tableToGrid(columns, rows, { includeId: opts.includeId });
      return { contentType: 'text/csv; charset=utf-8', filename: `${stem}.csv`, data: stringifyCsv(grid) };
    }
    case 'tsv': {
      const grid = tableToGrid(columns, rows, { includeId: opts.includeId });
      return { contentType: 'text/tab-separated-values; charset=utf-8', filename: `${stem}.tsv`, data: stringifyTsv(grid) };
    }
    case 'yaml': {
      const data = dumpTableYaml({ meta: doc.meta, columns, views: doc.views, rows });
      return { contentType: 'application/yaml; charset=utf-8', filename: `${stem}.yaml`, data };
    }
    case 'json': {
      const data = JSON.stringify({ meta: doc.meta, columns, views: doc.views, rows }, null, 2);
      return { contentType: 'application/json; charset=utf-8', filename: `${stem}.json`, data };
    }
    case 'md': {
      // The "flat" render — a normal GFM table of what's visible, for pasting into a doc (spec §10). No frontmatter, no folio:table markers — this is NOT the .table.md file itself.
      const header = `| ${columns.map((c) => c.name).join(' | ')} |`;
      const sep = `| ${columns.map(() => '---').join(' | ')} |`;
      const body = rows.map((r) => `| ${columns.map((c) => encodeCell(c, r.values[c.id] ?? null).replace(/\|/g, '\\|')).join(' | ')} |`);
      return { contentType: 'text/markdown; charset=utf-8', filename: `${stem}.md`, data: [header, sep, ...body].join('\n') };
    }
    default:
      throw badRequest(`unsupported export format: ${String(opts.format)}`);
  }
}

export interface ImportResult {
  imported: number;
  columns: TableColumn[];
}

/**
 * POST /api/tables/:pageId/import — spec §10. `mode: 'append'` adds rows
 * (existing schema kept); `mode: 'replace'` replaces every row but keeps the
 * schema too ("the modes append (add) and replace (replace the rows, keep the
 * schema)"). YAML is the one format that can also carry a full schema —
 * per spec it's the canonical round-trip format — so a YAML import additionally
 * REPLACES columns/views (never for csv/tsv, whose import is rows-only).
 */
export async function importTable(
  pageId: string,
  opts: { format: 'csv' | 'tsv' | 'yaml'; data: string; mode: 'append' | 'replace'; mapping?: Record<string, string> },
): Promise<ImportResult> {
  const doc = await loadDoc(pageId);

  if (opts.format === 'yaml') {
    const parsed = parseTableYaml(opts.data);
    if (isTableYamlParseError(parsed)) throw badRequest(`invalid table YAML: ${parsed.message}`);
    enforceHardLimit(checkRowCount(opts.mode === 'append' ? doc.rows.length + parsed.rows.length : parsed.rows.length));
    enforceHardLimit(checkColumnCount(parsed.columns.length));
    if (opts.mode === 'replace') {
      // Full structural replace: columns/views/rows all come from the import — a YAML
      // "replace" IS a full-schema restore (spec §10: "export -> import gives
      // byte for byte the same table"), routed through the SAME single write path as
      // every other mutation via the dedicated 'replaceAll' patch (see its doc comment
      // on TableDocPatch for the live-collab caveat).
      await applyPatch(pageId, { type: 'replaceAll', columns: parsed.columns, views: parsed.views, rows: parsed.rows });
      return { imported: parsed.rows.length, columns: parsed.columns };
    }
    await applyPatch(pageId, { type: 'insertRows', rows: parsed.rows });
    return { imported: parsed.rows.length, columns: doc.columns };
  }

  const grid = opts.format === 'csv' ? parseCsv(opts.data) : parseTsv(opts.data);
  if (grid.length === 0) return { imported: 0, columns: doc.columns };
  const [header, ...dataRows] = grid;
  // Positional alignment matters: `columnForIndex[i]` must stay the column for
  // HEADER COLUMN i, so an unmatched header cell doesn't shift every later
  // matched column's data left by one (gridToTableValues reads `raw[i]`
  // positionally — filtering `columns` and `dataRows` independently would
  // silently misalign whichever header cells don't match).
  const columnForIndex = header.map((name) => {
    const mappedId = opts.mapping?.[name];
    return mappedId ? doc.columns.find((c) => c.id === mappedId) : doc.columns.find((c) => c.name === name);
  });
  const matchedIndices = columnForIndex.reduce<number[]>((acc, c, i) => (c ? [...acc, i] : acc), []);
  if (matchedIndices.length === 0) throw badRequest("no matching columns to import into — provide `mapping` or match header names to the table's columns");
  const columns = matchedIndices.map((i) => columnForIndex[i] as TableColumn);
  const alignedDataRows = dataRows.map((row) => matchedIndices.map((i) => row[i] ?? ''));

  const valuesList = gridToTableValues(columns, alignedDataRows);
  enforceHardLimit(checkRowCount(opts.mode === 'append' ? doc.rows.length + valuesList.length : valuesList.length));
  const rows = valuesList.map((values) => newRow(doc.columns, values));

  if (opts.mode === 'replace') {
    await applyPatch(pageId, { type: 'replaceRows', rows });
  } else {
    await applyPatch(pageId, { type: 'insertRows', rows });
  }
  return { imported: rows.length, columns: doc.columns };
}

/** POST /api/tables/:pageId/infer — spec §8/§10.1: type preview for a paste, no write. */
export function inferImportColumns(grid: string[][], opts: { hasHeader?: boolean } = {}): TableColumn[] {
  return inferColumns(grid, opts);
}

// ---------------------------------------------------------------------------
// Table creation (used by the MCP folio_table_create tool; REST creation
// reuses the generic POST /api/pages with kind:'table', per spec §8)
// ---------------------------------------------------------------------------

export async function createTable(space: string, parentPath: string, title: string, columns?: TableColumn[], language?: string): Promise<PageMeta> {
  return storage.createPage({ space, parentPath, title, kind: 'table', columns }, undefined, language);
}
