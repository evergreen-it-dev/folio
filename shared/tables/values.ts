/**
 * Round 26 (DATA TABLES) — per-cell value <-> file-text codec, spec §2.4 and
 * §3 (docs/spec-tables.md). Pure, no IO. `encodeCell`/`decodeCell` convert
 * between the typed API value (`TableCellValue`, per shared/contracts.ts,
 * final) and the *logical* text a cell holds once it is inside the GFM
 * table — i.e. after any type-specific formatting (comma-joined lists,
 * `[x]`/`[ ]`, `<br>` for embedded newlines, `[caption](url)`) but BEFORE
 * the generic `|` -> `\|` GFM-cell escaping, which is codec.ts's job (it
 * applies uniformly to every column type, so it doesn't belong here).
 *
 * ## Design note: `select`/`status` values outside the option list
 *
 * Spec §2.4: an unrecognized select/status label found in a cell (e.g. the
 * file was hand-edited) must never be dropped — it's shown "as is" with an
 * "out of list" flag. `TableCellValue` (contracts.ts, final) has no room to
 * carry that flag alongside the label itself, so this module keeps it
 * derived rather than stored: `decodeCell` always returns the raw label
 * unchanged (nothing is lost), and `getOutOfListLabels(col, value)` below
 * recomputes which label(s) aren't in `col.options` on demand. Callers
 * (server/UI) call it whenever they need to render or count the flag.
 *
 * ## Design note: `link` values
 *
 * Spec §3 wants a two-field editor (URL + caption), but `TableCellValue`
 * has no object variant to hold both. Since the file's own encoding for a
 * captioned link is already `[caption](url)` (§2.4), that markdown
 * snippet IS the typed value for a `link` cell — the encoded file form and
 * the API value coincide for this one type. `parseLinkValue`/
 * `formatLinkValue` below give structured access (used by query.ts for
 * sort-by-caption/URL) without changing what's stored.
 */
import type { TableCellValue, TableColumn } from '../contracts.js';

// ---------- list-of-labels encoding (select multiple, user multiple) ----------
// Spec §2.4: joined by ", "; a label containing a comma is quoted:
// `"a, b", c`. We also quote (and double-escape) a literal `"` in a label,
// since an unescaped quote inside an unquoted token would be ambiguous —
// the spec doesn't cover this case explicitly, documented here.

function labelNeedsQuote(label: string): boolean {
  return label.includes(',') || label.includes('"');
}

function encodeLabelList(labels: string[]): string {
  return labels
    .map((l) => (labelNeedsQuote(l) ? `"${l.replace(/"/g, '""')}"` : l))
    .join(', ');
}

function decodeLabelList(raw: string): string[] {
  const s = raw;
  const result: string[] = [];
  let i = 0;
  while (i < s.length) {
    while (s[i] === ' ') i++;
    if (i >= s.length) break;
    if (s[i] === '"') {
      i++;
      let val = '';
      while (i < s.length) {
        if (s[i] === '"') {
          if (s[i + 1] === '"') {
            val += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        val += s[i];
        i++;
      }
      result.push(val);
      while (i < s.length && s[i] !== ',') i++;
      if (s[i] === ',') i++;
    } else {
      const start = i;
      while (i < s.length && s[i] !== ',') i++;
      result.push(s.slice(start, i).trim());
      if (s[i] === ',') i++;
    }
  }
  return result.filter((v) => v.length > 0);
}

// ---------- number ----------

function formatNumber(value: number, precision?: number): string {
  if (precision != null) return value.toFixed(precision);
  if (Number.isInteger(value)) return String(value);
  // Avoid scientific notation and thousands separators (spec §2.4).
  return value.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });
}

// ---------- link ----------

const LINK_MD_RE = /^\[(.*)\]\((\S+)\)$/s;

/** Structured read of a `link` cell's stored value. */
export function parseLinkValue(raw: string | null | undefined): { url: string; caption?: string } | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const m = LINK_MD_RE.exec(trimmed);
  if (m) return { url: m[2], caption: m[1] || undefined };
  return { url: trimmed };
}

/** Inverse of parseLinkValue: builds the stored `link` value string. */
export function formatLinkValue(url: string, caption?: string): string {
  return caption ? `[${caption}](${url})` : url;
}

// ---------- encode: TableCellValue -> logical cell text ----------

export function encodeCell(col: TableColumn, value: TableCellValue): string {
  switch (col.type) {
    case 'text':
      return value == null ? '' : String(value);
    case 'longtext':
      return value == null ? '' : String(value).replace(/\r\n|\r|\n/g, '<br>');
    case 'number':
      return value == null || typeof value !== 'number' || Number.isNaN(value)
        ? ''
        : formatNumber(value, col.precision);
    case 'date':
      return value == null ? '' : String(value);
    case 'checkbox':
      return value === true ? '[x]' : '[ ]';
    case 'select':
    case 'status':
      if (col.multiple) {
        const labels = Array.isArray(value) ? value : [];
        return labels.length ? encodeLabelList(labels) : '';
      }
      return value == null ? '' : String(value);
    case 'user':
      if (col.multiple) {
        const handles = Array.isArray(value) ? value : [];
        return handles.length ? encodeLabelList(handles.map((h) => `@${stripAt(h)}`)) : '';
      }
      return value == null ? '' : `@${stripAt(String(value))}`;
    case 'link':
      return value == null ? '' : String(value);
    default:
      return value == null ? '' : String(value);
  }
}

function stripAt(handle: string): string {
  return handle.startsWith('@') ? handle.slice(1) : handle;
}

// ---------- decode: logical cell text -> TableCellValue ----------

export function decodeCell(col: TableColumn, raw: string): TableCellValue {
  const text = raw ?? '';
  switch (col.type) {
    case 'text':
      return text === '' ? null : text;
    case 'longtext':
      return text === '' ? null : text.replace(/<br\s*\/?>/gi, '\n');
    case 'number': {
      const t = text.trim();
      if (t === '') return null;
      const n = Number(t);
      return Number.isNaN(n) ? null : n;
    }
    case 'date':
      return text.trim() === '' ? null : text.trim();
    case 'checkbox':
      return /^\[x\]$/i.test(text.trim());
    case 'select':
    case 'status':
      if (col.multiple) {
        const labels = decodeLabelList(text);
        return labels; // [] for empty — a real string[] value, per contracts.
      }
      return text.trim() === '' ? null : text.trim();
    case 'user':
      if (col.multiple) {
        return decodeLabelList(text).map(stripAt);
      }
      return text.trim() === '' ? null : stripAt(text.trim());
    case 'link':
      return text.trim() === '' ? null : text.trim();
    default:
      return text === '' ? null : text;
  }
}

// ---------- out-of-list flag (select/status) ----------

/** Label(s) present in `value` that are not among `col.options` — see the module doc comment. */
export function getOutOfListLabels(col: TableColumn, value: TableCellValue): string[] {
  if (col.type !== 'select' && col.type !== 'status') return [];
  const known = new Set((col.options ?? []).map((o) => o.value));
  const labels = col.multiple ? (Array.isArray(value) ? value : []) : value == null ? [] : [String(value)];
  return labels.filter((l) => !known.has(l));
}

// ---------- value of an unfilled cell in a new row ----------

/**
 * What a brand-new row holds in column `col` when nobody filled that cell: the
 * column's own `default` (spec §2.3), else `false` for a checkbox (it always has
 * a definite state, see isEmptyCellValue), else `null`. ONE definition for every
 * way a row comes into being — the grid's "add row" (web/src/tables/patch.ts),
 * and the server's insert behind REST, MCP and form submissions
 * (server/tables/service.ts) — so a row added by an agent is indistinguishable
 * from one added by hand. An explicit `null` default counts as "no default" for a
 * checkbox: there is no null state to default to.
 */
export function defaultCellValue(col: TableColumn): TableCellValue {
  if (col.default !== undefined && col.default !== null) return col.default as TableCellValue;
  return col.type === 'checkbox' ? false : null;
}

// ---------- emptiness ----------

/** Is `value` "empty" for `col`'s type? Also used by query.ts (empty always sorts last) and convertColumnType below. */
export function isEmptyCellValue(col: TableColumn, value: TableCellValue): boolean {
  switch (col.type) {
    case 'number':
      return value == null;
    case 'checkbox':
      return false; // a checkbox always has a definite true/false state
    case 'select':
    case 'status':
    case 'user':
      if (col.multiple) return !Array.isArray(value) || value.length === 0;
      return value == null || value === '';
    default:
      return value == null || value === '';
  }
}

// ---------- column type-change converter ----------

export interface ColumnConversionResult {
  values: TableCellValue[];
  /** Values that carried over with the new type still holding meaningful content. */
  converted: number;
  /** Values that had content under the old type but decode to "empty" under the new one. */
  cleared: number;
}

/**
 * Converts a column's values from `fromCol`'s type/shape to `toCol`'s, by
 * round-tripping each value through the same encode/decode pair the file
 * format itself uses (encode under the old schema -> decode under the new
 * one). This keeps conversion semantics identical to "what the file would
 * show", and needs no N-by-N special-casing per type pair.
 */
export function convertColumnType(
  fromCol: TableColumn,
  toCol: TableColumn,
  values: TableCellValue[],
): ColumnConversionResult {
  let converted = 0;
  let cleared = 0;
  const result = values.map((v) => {
    const hadContent = !isEmptyCellValue(fromCol, v);
    const text = encodeCell(fromCol, v);
    const next = decodeCell(toCol, text);
    const hasContent = !isEmptyCellValue(toCol, next);
    if (hadContent && !hasContent) cleared++;
    else if (hadContent && hasContent) converted++;
    return next;
  });
  return { values: result, converted, cleared };
}

/**
 * Spec §3: toggling a select/user column's `multiple: true -> false` keeps
 * only the first value in each cell. Reported the same way as a type change
 * so the UI can show "N rows will be affected" before confirming.
 */
export function convertMultipleToSingle(values: TableCellValue[]): ColumnConversionResult {
  let converted = 0;
  let cleared = 0;
  const result = values.map((v) => {
    const arr = Array.isArray(v) ? v : [];
    if (arr.length === 0) return null;
    if (arr.length === 1) {
      converted++;
      return arr[0];
    }
    cleared++; // more than one value existed; all but the first are lost
    return arr[0];
  });
  return { values: result, converted, cleared };
}
