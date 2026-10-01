/**
 * Round 26 (DATA TABLES) — filter / sort / search engine, spec §3 and §5
 * (docs/spec-tables.md). Pure, no IO. This is the ONE implementation the
 * server imports for `GET /rows` and MCP's `folio_table_query`, and later
 * the client for its local "quick filter" — the spec is explicit that a
 * second implementation on either side is a guaranteed drift bug, so
 * nothing here may depend on fs/db/React.
 *
 * Normative details called out in the brief:
 * - select/status sort by OPTION ORDER (`col.options[].value` index), not
 *   alphabetically;
 * - empty values always sort last, in both asc and desc;
 * - search is case- and diacritic-insensitive, and must handle uk/ru text
 *   where the "same" letter can arrive precomposed or decomposed (e.g. Cyrillic
 *   letters with a breve or a diaeresis vs their base letter + combining mark) — handled via NFD
 *   normalization + stripping combining marks, which folds both forms to the
 *   same comparison key;
 * - dates compare as ISO strings (lexicographic order == chronological order
 *   for ISO 8601, so no Date parsing is needed for ordering).
 */
import { z } from 'zod';
import {
  tableFilterRuleSchema,
  type TableCellValue,
  type TableColumn,
  type TableRow,
  type TableView,
} from '../contracts.js';
import { encodeCell, isEmptyCellValue, parseLinkValue } from './values.js';

export type TableFilterRule = z.infer<typeof tableFilterRuleSchema>;
export type TableFilter = TableView['filter'];
export type TableSort = TableView['sort'];

/** Inputs a pure function can't otherwise know: "now" and "who's asking" (for today/this_week/last_n_days/is_me). */
export interface QueryContext {
  now?: Date;
  currentUser?: string;
}

// ---------- search text normalization ----------

/** Lowercase + NFD + strip combining marks, so precomposed and decomposed forms of the same letter compare equal. */
function normalizeSearchText(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

// ---------- label extraction (for is_any_of / is_none_of / has_all / has_any / contains) ----------

function toLabelArray(value: TableCellValue): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  return [String(value)];
}

// ---------- ordering ----------

function optionOrderIndex(col: TableColumn, label: string): number {
  const options = col.options ?? [];
  const idx = options.findIndex((o) => o.value === label);
  return idx === -1 ? options.length : idx; // out-of-list labels sort after known options
}

function compareLinkForOrder(a: TableCellValue, b: TableCellValue): number {
  const la = parseLinkValue(a == null ? '' : String(a));
  const lb = parseLinkValue(b == null ? '' : String(b));
  const ka = (la?.caption ?? la?.url ?? '').toString();
  const kb = (lb?.caption ?? lb?.url ?? '').toString();
  return ka.localeCompare(kb);
}

/** Compares two NON-EMPTY values of the same column for ordering. Empty-handling lives in applySort. */
function compareForOrder(col: TableColumn, a: TableCellValue, b: TableCellValue): number {
  switch (col.type) {
    case 'number':
      return (a as number) - (b as number);
    case 'date': {
      const sa = String(a);
      const sb = String(b);
      return sa < sb ? -1 : sa > sb ? 1 : 0; // ISO strings compare chronologically
    }
    case 'checkbox':
      return a === b ? 0 : a ? 1 : -1; // false < true
    case 'select':
    case 'status': {
      if (col.multiple) {
        const la = Array.isArray(a) ? a : [];
        const lb = Array.isArray(b) ? b : [];
        const ia = la.length ? Math.min(...la.map((l) => optionOrderIndex(col, l))) : Number.MAX_SAFE_INTEGER;
        const ib = lb.length ? Math.min(...lb.map((l) => optionOrderIndex(col, l))) : Number.MAX_SAFE_INTEGER;
        return ia - ib;
      }
      return optionOrderIndex(col, String(a)) - optionOrderIndex(col, String(b));
    }
    case 'link':
      return compareLinkForOrder(a, b);
    default: {
      const sa = col.multiple && Array.isArray(a) ? encodeCell(col, a) : String(a);
      const sb = col.multiple && Array.isArray(b) ? encodeCell(col, b) : String(b);
      return sa.localeCompare(sb);
    }
  }
}

export function applySort(rows: TableRow[], cols: TableColumn[], sort: TableSort | undefined): TableRow[] {
  if (!sort || sort.length === 0) return rows;
  const colMap = new Map(cols.map((c) => [c.id, c]));
  const withKeys = sort.map((s) => ({ ...s, col: colMap.get(s.column) })).filter((s) => s.col);
  if (withKeys.length === 0) return rows;

  const out = [...rows];
  out.sort((ra, rb) => {
    for (const s of withKeys) {
      const col = s.col as TableColumn;
      const va = ra.values[col.id] ?? null;
      const vb = rb.values[col.id] ?? null;
      const ea = isEmptyCellValue(col, va);
      const eb = isEmptyCellValue(col, vb);
      if (ea && eb) continue;
      if (ea) return 1; // empty always sorts last, regardless of dir
      if (eb) return -1;
      const cmp = compareForOrder(col, va, vb);
      if (cmp !== 0) return s.dir === 'asc' ? cmp : -cmp;
    }
    return 0;
  });
  return out;
}

// ---------- filtering ----------

function dateOnly(iso: string): string {
  return iso.slice(0, 10);
}

function utcDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Monday..Sunday (UTC) range containing `now`, as ISO date-only strings. */
function isoWeekRange(now: Date): [string, string] {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() - dow + 1);
  const start = utcDateOnly(d);
  const endD = new Date(d);
  endD.setUTCDate(d.getUTCDate() + 6);
  return [start, utcDateOnly(endD)];
}

function lastNDaysRange(now: Date, n: number): [string, string] {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end);
  start.setUTCDate(end.getUTCDate() - Math.max(0, n - 1));
  return [utcDateOnly(start), utcDateOnly(end)];
}

function evaluateRule(row: TableRow, col: TableColumn | undefined, rule: TableFilterRule, ctx: Required<QueryContext>): boolean {
  if (!col) return false;
  const value = row.values[col.id] ?? null;

  switch (rule.operator) {
    case 'is_empty':
      return isEmptyCellValue(col, value);
    case 'is_not_empty':
      return !isEmptyCellValue(col, value);
    case 'is_checked':
      return value === true;
    case 'is_unchecked':
      return value !== true;
    case 'is_me': {
      const labels = toLabelArray(value).map((l) => (l.startsWith('@') ? l.slice(1) : l));
      return ctx.currentUser != null && labels.includes(ctx.currentUser);
    }
    case 'today': {
      if (isEmptyCellValue(col, value)) return false;
      return dateOnly(String(value)) === utcDateOnly(ctx.now);
    }
    case 'this_week': {
      if (isEmptyCellValue(col, value)) return false;
      const [start, end] = isoWeekRange(ctx.now);
      const d = dateOnly(String(value));
      return d >= start && d <= end;
    }
    case 'last_n_days': {
      if (isEmptyCellValue(col, value)) return false;
      const n = typeof rule.value === 'number' ? rule.value : Number(rule.value ?? 0);
      const [start, end] = lastNDaysRange(ctx.now, n);
      const d = dateOnly(String(value));
      return d >= start && d <= end;
    }
    case 'is':
    case 'is_not': {
      let equal: boolean;
      if (col.type === 'checkbox') equal = value === rule.value;
      else if (col.type === 'number') equal = typeof value === 'number' && value === rule.value;
      else if (col.multiple) {
        const a = new Set(toLabelArray(value));
        const b = new Set(Array.isArray(rule.value) ? rule.value.map(String) : []);
        equal = a.size === b.size && [...a].every((v) => b.has(v));
      } else {
        equal = normalizeSearchText(String(value ?? '')) === normalizeSearchText(String(rule.value ?? ''));
      }
      return rule.operator === 'is' ? equal : !equal;
    }
    case 'contains':
    case 'not_contains': {
      const haystack = normalizeSearchText(encodeCell(col, value));
      const needle = normalizeSearchText(String(rule.value ?? ''));
      const has = needle.length > 0 && haystack.includes(needle);
      return rule.operator === 'contains' ? has : !has;
    }
    case 'starts_with': {
      const haystack = normalizeSearchText(encodeCell(col, value));
      const needle = normalizeSearchText(String(rule.value ?? ''));
      return haystack.startsWith(needle);
    }
    case 'gt':
    case 'lt':
    case 'gte':
    case 'lte': {
      if (isEmptyCellValue(col, value)) return false;
      const target = col.type === 'number' ? Number(rule.value) : String(rule.value ?? '');
      const cmp = col.type === 'number' ? (value as number) - (target as number) : compareForOrder(col, value, target as TableCellValue);
      if (rule.operator === 'gt') return cmp > 0;
      if (rule.operator === 'lt') return cmp < 0;
      if (rule.operator === 'gte') return cmp >= 0;
      return cmp <= 0;
    }
    case 'between': {
      if (isEmptyCellValue(col, value)) return false;
      const [lo, hi] = Array.isArray(rule.value) ? rule.value : [undefined, undefined];
      if (col.type === 'number') {
        const v = value as number;
        return (lo == null || v >= Number(lo)) && (hi == null || v <= Number(hi));
      }
      const v = String(value);
      return (lo == null || v >= String(lo)) && (hi == null || v <= String(hi));
    }
    case 'is_any_of': {
      const wanted = Array.isArray(rule.value) ? rule.value.map(String) : [];
      const labels = toLabelArray(value);
      return labels.some((l) => wanted.includes(l));
    }
    case 'is_none_of': {
      const wanted = Array.isArray(rule.value) ? rule.value.map(String) : [];
      const labels = toLabelArray(value);
      return !labels.some((l) => wanted.includes(l));
    }
    case 'has_all': {
      const wanted = Array.isArray(rule.value) ? rule.value.map(String) : [];
      const labels = new Set(toLabelArray(value));
      return wanted.every((w) => labels.has(w));
    }
    case 'has_any': {
      const wanted = Array.isArray(rule.value) ? rule.value.map(String) : [];
      const labels = toLabelArray(value);
      return wanted.some((w) => labels.includes(w));
    }
    default:
      return false;
  }
}

export function applyFilters(
  rows: TableRow[],
  cols: TableColumn[],
  filter: TableFilter | undefined,
  ctx: QueryContext = {},
): TableRow[] {
  if (!filter || filter.rules.length === 0) return rows;
  const colMap = new Map(cols.map((c) => [c.id, c]));
  const fullCtx: Required<QueryContext> = { now: ctx.now ?? new Date(), currentUser: ctx.currentUser ?? '' };
  return rows.filter((row) => {
    const results = filter.rules.map((rule) => evaluateRule(row, colMap.get(rule.column), rule, fullCtx));
    return filter.op === 'or' ? results.some(Boolean) : results.every(Boolean);
  });
}

// ---------- search ----------

/**
 * Case- and diacritic-insensitive substring search across every column's
 * text representation (spec §5: text/select/status/user/link columns, plus
 * numbers "compared as text" — extended here to all types, since excluding
 * e.g. dates from a "search everything" box would surprise users and the
 * spec doesn't call for excluding them).
 */
export function applySearch(rows: TableRow[], cols: TableColumn[], q: string): TableRow[] {
  const needle = normalizeSearchText(q.trim());
  if (needle.length === 0) return rows;
  return rows.filter((row) =>
    cols.some((col) => normalizeSearchText(encodeCell(col, row.values[col.id] ?? null)).includes(needle)),
  );
}
