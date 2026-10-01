/**
 * Round 23 (EXPORT), R23 addendum 4: data tables (`kind:'table'`) in MD.
 *
 * Same trap as boards — a table page has no markdown body of its own, so a
 * naive collation would emit the page's prose and silently drop the data.
 * Spec: "a data table is serialized into an ordinary GFM pipe table (header =
 * the columns of the current view, rows = the records in the order of the
 * view, with its filters and sorting applied) ... For an agent this is
 * critical: a table must read as DATA, not as a link to a page."
 *
 * Every piece of behaviour here that could drift from the product's own idea
 * of a table is DELEGATED to `shared/tables/**`, which round 26 already
 * landed and tested: `applyFilters`/`applySort` decide which rows and in
 * what order, `encodeCell` decides how a typed value becomes text (dates
 * ISO, multi-select comma-joined, checkbox `[x]`/`[ ]`). This file owns only
 * the two things that are genuinely export-specific: view-column resolution
 * (order + hidden) and GFM cell escaping.
 */
import type { TableColumn, TableDoc, TableView } from '../../shared/contracts.js';
import { applyFilters, applySort, encodeCell, formatLinkValue, parseLinkValue, TABLE_LIMITS } from '../../shared/tables/index.js';
import { rowsTruncation, type ExportTruncation } from './limits.js';

/**
 * Default row cap for one exported table. `TABLE_LIMITS.rows.soft` (5 000) —
 * the number the product ALREADY warns at, reused rather than invented, so a
 * table that exports whole is exactly a table the product considers normal.
 * Anything beyond it is cut with an explicit marker (never silently).
 */
export const DEFAULT_EXPORT_ROW_CAP = TABLE_LIMITS.rows.soft;

/** Header of the synthetic fallback column for a table with no visible columns — same name `<slug>.table.md` gives its own row-id column. */
export const ROW_ID_COLUMN = 'id';

/** Mirrors codec.ts's (private) writeCell: newlines fold to `<br>`, `|` is escaped — a cell may never break the row. */
function gfmCell(text: string): string {
  return text.replace(/\r\n|\r|\n/g, '<br>').replace(/\|/g, '\\|');
}

function alignMarker(align: TableColumn['align']): string {
  switch (align) {
    case 'left':
      return ':---';
    case 'right':
      return '---:';
    case 'center':
      return ':---:';
    default:
      return '---';
  }
}

/**
 * The view's columns: `columns.order` first (in that order), then any column
 * the view never mentioned (a column added after the view was saved), minus
 * everything in `columns.hidden`. A view referencing a since-deleted column
 * id simply skips it.
 */
export function viewColumns(doc: TableDoc, view: TableView | undefined): TableColumn[] {
  const byId = new Map(doc.columns.map((c) => [c.id, c]));
  const hidden = new Set(view?.columns.hidden ?? []);
  const ordered: TableColumn[] = [];
  const taken = new Set<string>();

  for (const id of view?.columns.order ?? []) {
    const col = byId.get(id);
    if (col && !taken.has(id)) {
      taken.add(id);
      ordered.push(col);
    }
  }
  for (const col of doc.columns) if (!taken.has(col.id)) ordered.push(col);

  return ordered.filter((c) => !hidden.has(c.id));
}

/** The view to export: the requested id, else the table's first view, else undefined (raw column order, no filter/sort). */
export function pickView(doc: TableDoc, requestedViewId?: string): TableView | undefined {
  if (requestedViewId) {
    const found = doc.views.find((v) => v.id === requestedViewId);
    if (found) return found;
  }
  return doc.views[0];
}

/**
 * One cell's exported text. `encodeCell` does the type work; the one
 * export-specific override is `link`, which the spec wants as a real
 * markdown link even when the cell stores a bare URL with no caption.
 */
export function exportCellText(col: TableColumn, value: unknown): string {
  const encoded = encodeCell(col, (value ?? null) as never);
  if (col.type !== 'link') return encoded;
  const parsed = parseLinkValue(encoded);
  return parsed ? formatLinkValue(parsed.url, parsed.caption ?? parsed.url) : '';
}

export interface TableMarkdownResult {
  markdown: string;
  truncation: ExportTruncation | null;
}

export interface TableMarkdownOptions {
  viewId?: string;
  rowCap?: number;
  /** `applyFilters`' QueryContext — `is_me`/`today` need to know who is asking and when. */
  currentUser?: string;
  now?: Date;
}

/**
 * `head` prose (which carries the page's H1) + the GFM table + `tail` prose.
 * A table with no rows emits the header and separator and nothing else —
 * that's not an error, there is genuinely nothing to write.
 *
 * A table with no VISIBLE columns but real rows used to emit prose only:
 * three rows became a 21-byte `# Title\n` and the data was gone with no
 * marker of any kind (QA-3). Rows are not optional content, so this case now
 * falls back to the one column such a table still has — `id`, exactly the
 * synthetic column `<slug>.table.md` itself carries (shared/tables/codec.ts's
 * `options.rowIds`), and one every TableRow has even in `rowIds: 'none'`
 * mode. The export then says "N rows, here they are" instead of lying by
 * omission. Same fallback whether the columns were never defined or a view
 * hid every one of them: in both cases the rows exist and the reader is
 * entitled to know it.
 */
export function tableDocToMarkdown(doc: TableDoc, opts: TableMarkdownOptions = {}): TableMarkdownResult {
  const view = pickView(doc, opts.viewId);
  const cols = viewColumns(doc, view);

  const filtered = applyFilters(doc.rows, doc.columns, view?.filter, { currentUser: opts.currentUser, now: opts.now });
  const sorted = applySort(filtered, doc.columns, view?.sort);

  const cap = opts.rowCap ?? DEFAULT_EXPORT_ROW_CAP;
  const kept = sorted.slice(0, cap);
  const truncation = sorted.length > kept.length ? rowsTruncation(sorted.length - kept.length) : null;

  const parts: string[] = [];
  const head = doc.head.trim();
  if (head) parts.push(head);

  if (cols.length > 0) {
    const lines = [
      `| ${cols.map((c) => gfmCell(c.name)).join(' | ')} |`,
      `| ${cols.map((c) => alignMarker(c.align)).join(' | ')} |`,
      ...kept.map((row) => `| ${cols.map((c) => gfmCell(exportCellText(c, row.values[c.id]))).join(' | ')} |`),
    ];
    parts.push(lines.join('\n'));
  } else if (kept.length > 0) {
    parts.push([`| ${ROW_ID_COLUMN} |`, '| --- |', ...kept.map((row) => `| ${gfmCell(row.id)} |`)].join('\n'));
  }

  const tail = doc.tail.trim();
  if (tail) parts.push(tail);

  return { markdown: parts.join('\n\n'), truncation };
}
