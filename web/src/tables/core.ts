import { tableFilterOperatorSchema } from '@shared/contracts';
import type { TableCellValue, TableColumn, TableRow, TableView } from '@shared/contracts';
import { applyFilters as applyFiltersCore } from '@shared/tables/query';
import { decodeCell, encodeCell } from '@shared/tables/values';
import { YES_WORDS } from '@shared/tables/booleanWords';
import { COLUMN_ID_TRANSLIT } from './translit';

/**
 * Round 26 (DATA TABLES) — TABLES-UI ⇄ TABLES-CORE seam.
 *
 * ══════════════════════════════════════════════════════════════════════
 *  WAVE 3: COLLAPSED ONTO shared/tables (SHELL-TABLES)
 * ══════════════════════════════════════════════════════════════════════
 * Until wave 3 this file carried a full stand-in engine, written while
 * `shared/tables/**` was still an empty directory (waves 1 run in parallel
 * by design). TABLES-CORE has since landed, so the engine is gone: the
 * filter/sort/search/inference/codec implementations now come from
 * `shared/tables`, which is the SAME code the server runs for `GET /rows`,
 * MCP's `folio_table_query` and every export — one engine, no drift.
 *
 * What is still written out below is only what `shared/tables` does not
 * export, and each one is a UI concern rather than a second engine:
 *
 *   foldText / cellToText   column-less text for the option picker and the
 *                           search highlighter (shared's own normalizer and
 *                           `encodeCell` both need a column; these don't have
 *                           one at the call site)
 *   isRuleComplete          a half-typed filter rule must not be sent to the
 *                           engine at all — see applyFilters below
 *   uniqueColumnId          Cyrillic-aware id slug (see its own note)
 *   parseCellText           CLIPBOARD text → value, a superset of the file
 *                           codec's `decodeCell` (see its own note)
 *   formatCellText          value → the text a human sees, `encodeCell` with
 *                           one documented exception for longtext
 *
 * Anything here that duplicates behaviour `shared/tables` also implements is
 * a bug: CORE is normative, and the server uses it.
 */

// Re-exported verbatim — these ARE shared/tables, under the names this zone
// already imports them by.
export { applySort, applySearch } from '@shared/tables/query';
export { inferColumns } from '@shared/tables/csv';
export { decodeCell, encodeCell, isEmptyCellValue } from '@shared/tables/values';
export type { QueryContext } from '@shared/tables/query';

/** The shape `TableView['filter']` already has; kept as a name this zone imports by. */
export type TableFilterState = TableView['filter'];

// ---------------------------------------------------------------- helpers

/**
 * Case- AND diacritic-insensitive folding, per spec §5 ("case- and
 * diacritic-insensitive"). Byte-for-byte the same normalization
 * `shared/tables/query.ts` applies internally (NFD + strip combining marks +
 * lowercase); it isn't exported from there, and this is only used for
 * UI-local matching (the option picker's own filter box), never for the
 * table's own filter/search — those go through the shared engine.
 */
export function foldText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * A cell as plain text WITHOUT knowing its column — what a textarea shows and
 * what the highlighter scans. Column-aware rendering is `formatCellText`.
 */
export function cellToText(value: TableCellValue): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

// ------------------------------------------------------------- filtering

/**
 * A rule the user has started but not finished (operator picked, value still
 * blank) must not filter anything out — otherwise the table blanks the
 * instant you add a rule, before you have typed the value.
 * Ported in spirit from tablecn's getValidFilters (MIT).
 */
export function isRuleComplete(rule: TableView['filter']['rules'][number]): boolean {
  if (!tableFilterOperatorSchema.safeParse(rule.operator).success) return false;
  const valueless: string[] = [
    'is_empty', 'is_not_empty', 'is_checked', 'is_unchecked', 'is_me', 'today', 'this_week',
  ];
  if (valueless.includes(rule.operator)) return true;
  const value = rule.value;
  if (Array.isArray(value)) return value.length > 0 && value.every((v) => v !== '' && v !== null && v !== undefined);
  return value !== '' && value !== null && value !== undefined;
}

/**
 * shared/tables' engine, with ONE thing done before it: rules that aren't
 * ready are dropped rather than evaluated.
 *
 * This is not a second filter implementation — every surviving rule is
 * decided by `shared/tables/query.ts` alone. It exists because the engine's
 * contract is "evaluate what you are given", and an unfinished rule
 * (`contains` with an empty value) or one carrying an operator this build
 * doesn't know (a view authored by a newer client, or hand-edited
 * frontmatter) evaluates to `false` there — i.e. the table goes blank, which
 * on screen is indistinguishable from data loss. FilterPanel already counts
 * "active" rules with the very same `isRuleComplete`, so the badge and the
 * result set agree.
 *
 * NOTE (reported to the round): `GET /api/tables/:id/rows` hands the engine
 * the stored rules unfiltered, so a view containing an unknown operator
 * returns 0 rows server-side while showing every row here. Only reachable by
 * hand-editing frontmatter; the fix belongs in shared/tables or the server,
 * not in a second client-side engine.
 */
export function applyFilters(
  rows: TableRow[],
  columns: TableColumn[],
  filter: TableFilterState,
  ctx: { now?: Date; currentUser?: string } = {},
): TableRow[] {
  const rules = filter.rules.filter(isRuleComplete);
  if (rules.length === 0) return rows;
  return applyFiltersCore(rows, columns, { ...filter, rules }, ctx);
}

// ------------------------------------------------------- column identity

/**
 * Latin/Cyrillic → `[a-z0-9_]{1,32}` slug, `_2`-suffixed on collision
 * (spec §2.3), for a column the user creates in the UI.
 *
 * shared/tables/csv.ts has its own (unexported) slugifier for inferred
 * columns; it strips diacritics rather than transliterating, so a Cyrillic
 * header collapses to `col_0`/`col_1` there while the same name typed into
 * the column editor becomes `zadacha` here. Reported as a CORE-side gap
 * rather than papered over: both produce ids matching the contract's
 * pattern, and neither is wrong, but only one is readable in the file.
 */
export function uniqueColumnId(name: string, index: number, used: Set<string>): string {
  let base = name
    .toLowerCase()
    .split('')
    .map((ch) => COLUMN_ID_TRANSLIT[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  if (base === '') base = `col_${index + 1}`;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base.slice(0, 30)}_${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

// ------------------------------------------------------- cell codec (UI)

/** A stand-in column used purely to borrow shared's label-list codec (spec §2.4 quoting). */
const LABEL_LIST: TableColumn = { id: 'labels', name: 'labels', type: 'select', multiple: true };

/**
 * `"a, b", c` → `['a, b', 'c']` — spec §2.4's quoted-label convention, so a
 * multi-select option whose own label contains a comma survives a round trip.
 * Delegates to shared's list codec rather than re-parsing.
 */
export function splitLabels(text: string): string[] {
  const value = decodeCell(LABEL_LIST, text);
  return Array.isArray(value) ? value : [];
}

/** Inverse of splitLabels — quotes any label containing a comma or a quote. */
export function joinLabels(values: string[]): string {
  return encodeCell(LABEL_LIST, values);
}

/**
 * CLIPBOARD text → typed value, for the paste path and the text-ish cell
 * editors.
 *
 * A deliberate superset of `decodeCell`, which is the FILE codec: what
 * arrives on the clipboard is whatever Google Sheets/Excel produced, not
 * what Folio would have written. Two tolerances are added, and only these:
 *
 *  - a decimal comma (`3,5`) — normal in uk/ru locales, `Number()` rejects it;
 *  - the checkbox vocabulary shared/tables' own column INFERENCE accepts
 *    (`x`, `true`, `yes`, `1` and the localized words) rather than only `[x]`. Without
 *    this, pasting a yes/no column infers as `checkbox` (csv.ts's
 *    CHECKBOX_TRUE) and then decodes every single value to `false` — that
 *    inference/decode asymmetry inside shared/tables is reported with the
 *    round.
 *
 * Everything else — including stripping the `@` from a user handle and the
 * quoted multi-label split — is `decodeCell` verbatim.
 */
export function parseCellText(column: TableColumn, raw: string): TableCellValue {
  const text = raw.trim();
  if (column.type === 'number') return decodeCell(column, text.replace(',', '.'));
  if (column.type === 'checkbox') {
    return ['[x]', 'x', 'true', '1', ...YES_WORDS].includes(text.toLowerCase());
  }
  return decodeCell(column, text);
}

/**
 * Typed value → the text a human sees: grid cells, the row panel, the
 * clipboard, and CSV/markdown export (which is why it matters that this is
 * `encodeCell` — the client's CSV then matches `GET /export`'s byte for byte).
 *
 * The single exception is `longtext`: `encodeCell` rewrites its newlines as
 * `<br>` because a GFM cell is one physical line, and that is codec.ts's
 * business, not the screen's. A literal `<br>` shown to a user in a row panel
 * (or exported into a CSV field, where a real newline inside quotes is both
 * legal and what Sheets expects) would be the file format leaking through.
 */
export function formatCellText(column: TableColumn, value: TableCellValue): string {
  if (column.type === 'longtext') return value === null || value === undefined ? '' : String(value);
  return encodeCell(column, value);
}
