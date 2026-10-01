/**
 * Round 26 (DATA TABLES) — RFC 4180 CSV/TSV grid codec + §10.1 column-type
 * inference for paste-from-spreadsheet import (docs/spec-tables.md). Pure,
 * no IO. Works on plain `string[][]` grids; codec.ts owns the actual
 * `.table.md` file, values.ts owns per-cell type conversion — this module
 * only bridges "a grid of strings" (what a CSV file or a browser paste
 * event gives you) to/from that.
 */
import { z } from 'zod';
import {
  tableColorSchema,
  tableColumnTypeSchema,
  tableOptionSchema,
  type TableCellValue,
  type TableColumn,
  type TableRow,
} from '../contracts.js';
import { decodeCell, encodeCell } from './values.js';
import { NO_WORDS, YES_WORDS } from './booleanWords.js';

type TableColor = z.infer<typeof tableColorSchema>;
type TableColumnType = z.infer<typeof tableColumnTypeSchema>;
type TableOption = z.infer<typeof tableOptionSchema>;

// ---------- RFC 4180 parse ----------

/**
 * Parses delimited text (CSV `,` or TSV `\t`) into a grid of raw strings.
 * Handles quoted fields (with embedded delimiter/newline/quote via `""`),
 * CRLF and LF line endings, and a trailing blank line.
 */
export function parseDelimited(text: string, delimiter: ',' | '\t' = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      i++;
      continue;
    }
    if (ch === '\r' && text[i + 1] === '\n') {
      pushRow();
      i += 2;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      pushRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // Final field/row, unless the text ended cleanly on a newline (nothing pending).
  if (field !== '' || row.length > 0) pushRow();
  // Drop a single fully-empty trailing row (common artifact of a trailing newline).
  if (rows.length > 0 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();
  return rows;
}

export function parseCsv(text: string): string[][] {
  return parseDelimited(text, ',');
}

export function parseTsv(text: string): string[][] {
  return parseDelimited(text, '\t');
}

// ---------- RFC 4180 stringify ----------

function fieldNeedsQuote(field: string, delimiter: string): boolean {
  return field.includes(delimiter) || field.includes('"') || field.includes('\n') || field.includes('\r');
}

function quoteField(field: string, delimiter: string): string {
  return fieldNeedsQuote(field, delimiter) ? `"${field.replace(/"/g, '""')}"` : field;
}

export function stringifyDelimited(rows: string[][], delimiter: ',' | '\t' = ','): string {
  return rows.map((row) => row.map((f) => quoteField(f, delimiter)).join(delimiter)).join('\r\n') + '\r\n';
}

export function stringifyCsv(rows: string[][]): string {
  return stringifyDelimited(rows, ',');
}

export function stringifyTsv(rows: string[][]): string {
  return stringifyDelimited(rows, '\t');
}

// ---------- TableRow[] <-> grid ----------

export interface TableToGridOptions {
  /** Include the hidden `id` column as the last column. Default false. */
  includeId?: boolean;
}

/** Header row + one row per TableRow, in column order — what an export button hands to stringifyCsv/Tsv. */
export function tableToGrid(cols: TableColumn[], rows: TableRow[], opts: TableToGridOptions = {}): string[][] {
  const header = [...cols.map((c) => c.name), ...(opts.includeId ? ['id'] : [])];
  const body = rows.map((row) => [
    ...cols.map((c) => encodeCell(c, row.values[c.id] ?? null)),
    ...(opts.includeId ? [row.id] : []),
  ]);
  return [header, ...body];
}

/** Inverse of tableToGrid's body rows: decodes a grid's DATA rows (no header) into TableCellValue records, by column position. */
export function gridToTableValues(cols: TableColumn[], dataRows: string[][]): Record<string, TableCellValue>[] {
  return dataRows.map((raw) => {
    const values: Record<string, TableCellValue> = {};
    cols.forEach((col, i) => {
      values[col.id] = decodeCell(col, raw[i] ?? '');
    });
    return values;
  });
}

// ---------- §10.1 column type inference ----------

const STATUS_PRESET = new Set([
  'PLANNING', 'WAITING', 'QUESTIONS', 'IN PROG', 'DONE', 'REPLAN', 'FAILED', 'CANCELLED',
]);

const CHECKBOX_TRUE = new Set(['x', '[x]', 'true', ...YES_WORDS]);
const CHECKBOX_FALSE = new Set(['', '[ ]', 'false', ...NO_WORDS]);

const DATE_ISO_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/;
const DATE_DMY_DOT_RE = /^(\d{2})\.(\d{2})\.(\d{4})$/;
const DATE_DMY_SLASH_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

function looksLikeDate(v: string): boolean {
  return DATE_ISO_RE.test(v) || DATE_DMY_DOT_RE.test(v) || DATE_DMY_SLASH_RE.test(v);
}

function looksLikeNumber(v: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(v);
}

function looksLikeUrl(v: string): boolean {
  return /^https?:\/\/\S+$/i.test(v);
}

function looksLikeUser(v: string): boolean {
  return /^@\S+$/.test(v);
}

const PALETTE: TableColor[] = ['blue', 'green', 'purple', 'orange', 'teal', 'pink', 'yellow', 'red', 'gray'];

function slugifyColumnId(name: string, index: number, used: Set<string>): string {
  let base = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  if (base === '') base = `col_${index}`;
  let candidate = base;
  let n = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${n}`.slice(0, 32);
    n++;
  }
  used.add(candidate);
  return candidate;
}

/**
 * Spec §10.1: infers a column type per column from up to 200 sample values,
 * in this precedence: status preset -> @user -> date -> number -> checkbox
 * -> URL -> select (<=12 distinct values, >=20 rows, label length <=40) ->
 * longtext (has newlines or length > 120) -> text.
 *
 * `rows` is the FULL grid including its header row (rows[0] = column names);
 * pass only the data rows if there's no header (columns are then named
 * "Column 1", "Column 2", ...).
 */
export function inferColumns(rows: string[][], opts: { hasHeader?: boolean } = {}): TableColumn[] {
  const hasHeader = opts.hasHeader ?? true;
  if (rows.length === 0) return [];
  const header = hasHeader ? rows[0] : rows[0].map((_, i) => `Column ${i + 1}`);
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const colCount = header.length;
  const used = new Set<string>();

  const columns: TableColumn[] = [];
  for (let c = 0; c < colCount; c++) {
    const name = header[c]?.trim() || `Column ${c + 1}`;
    const samples = dataRows
      .map((r) => (r[c] ?? '').trim())
      .filter((v) => v !== '')
      .slice(0, 200);
    const type = inferColumnType(samples, dataRows.length);
    const id = slugifyColumnId(name, c, used);
    const column: TableColumn = { id, name, type };
    if (type === 'select' || type === 'status') {
      const distinct = [...new Set(samples)];
      column.options = distinct.map((value, i): TableOption => ({
        value,
        color: (type === 'status' && STATUS_COLORS[value.toUpperCase()]) || PALETTE[i % PALETTE.length],
      }));
    }
    columns.push(column);
  }
  return columns;
}

const STATUS_COLORS: Record<string, TableColor> = {
  PLANNING: 'purple',
  WAITING: 'gray',
  QUESTIONS: 'orange',
  'IN PROG': 'blue',
  DONE: 'green',
  REPLAN: 'yellow',
  FAILED: 'red',
  CANCELLED: 'gray',
};

function inferColumnType(samples: string[], totalRows: number): TableColumnType {
  if (samples.length === 0) return 'text';

  if (samples.every((v) => STATUS_PRESET.has(v.toUpperCase()))) return 'status';
  if (samples.every(looksLikeUser)) return 'user';
  if (samples.every(looksLikeDate)) return 'date';
  if (samples.every(looksLikeNumber)) return 'number';
  if (samples.every((v) => CHECKBOX_TRUE.has(v.toLowerCase()) || CHECKBOX_FALSE.has(v.toLowerCase()))) return 'checkbox';
  if (samples.every(looksLikeUrl)) return 'link';

  const distinct = new Set(samples);
  if (distinct.size <= 12 && totalRows >= 20 && samples.every((v) => v.length <= 40)) return 'select';

  if (samples.some((v) => /\r|\n/.test(v) || v.length > 120)) return 'longtext';

  return 'text';
}
