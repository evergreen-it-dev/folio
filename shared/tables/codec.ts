/**
 * Round 26 (DATA TABLES) — `<slug>.table.md` file format codec, spec §2
 * (docs/spec-tables.md, normative). Pure, no IO: `parseTableFile`/
 * `serializeTableFile` convert between the raw file text and `TableDoc`
 * (shared/contracts.ts, final — imported, never redefined here).
 *
 * File shape (spec §2.2):
 *
 *   ---
 *   folio: table
 *   version: 1
 *   id: <ulid>
 *   columns: [...]
 *   views: [...]
 *   options: { rowIds: column | none }
 *   ---
 *   <head — free prose, incl. the H1, preserved byte-for-byte>
 *   <!-- folio:table:begin -->
 *
 *   | Col A | Col B | id |
 *   | --- | --- | --- |
 *   | ... | ... | ... |
 *
 *   <!-- folio:table:end -->
 *   <tail — free prose, preserved byte-for-byte>
 *
 * `head`/`tail` are stored and reproduced as opaque, verbatim strings — this
 * module never reformats user prose. `parseTableFile` always produces a
 * `head` that is either '' or ends with '\n' (it is exactly the text before
 * the begin-marker's own line, which by construction ends where that line's
 * preceding '\n' is), and a `tail` that starts exactly where the end
 * marker's line ends. `serializeTableFile` relies on that convention rather
 * than re-normalizing, so `parse(serialize(doc))` round-trips a `doc` shaped
 * the way `parseTableFile` itself produces it (see codec.test.ts).
 *
 * The GFM table itself (columns/rows) is NOT preserved byte-for-byte — it is
 * re-derived structurally from `doc.columns`/`doc.rows` on every serialize
 * (canonical spacing), and re-parsed into the same structured shape on the
 * next read. That's what the round-trip test actually asserts: structural
 * (deep-equal) fidelity of the table, byte fidelity of the prose around it.
 */
import * as matterNS from 'gray-matter';
import { ulid } from 'ulidx';
import {
  tableColumnSchema,
  tableViewSchema,
  type TableCellValue,
  type TableColumn,
  type TableDoc,
  type TableRow,
} from '../contracts.js';
import { decodeCell, encodeCell } from './values.js';

// gray-matter is CJS (`export =`); same interop fallback as server/storage.ts,
// needed because Vite/Vitest's esbuild-based CJS interop can land the
// callable on `.default` instead of the namespace object itself.
const matter = (typeof matterNS === 'function' ? matterNS : (matterNS as unknown as { default: typeof matterNS }).default) as typeof matterNS;

const BEGIN_MARKER = '<!-- folio:table:begin -->';
const END_MARKER = '<!-- folio:table:end -->';

// ---------- error type ----------

/**
 * Returned (never thrown) by parseTableFile on any structural problem —
 * missing/duplicate markers, invalid frontmatter, a row whose cell count
 * doesn't match the schema, etc. Per the round's brief: never silently drop
 * rows or coerce a broken file into a partial table — a bad column
 * definition destroying data silently is exactly the landmine to avoid, so
 * any inconsistency fails the whole parse with a human-readable message
 * instead of best-effort recovery.
 */
export interface TableParseError {
  readonly kind: 'table-parse-error';
  readonly message: string;
  readonly cause?: unknown;
}

export function isTableParseError(x: TableDoc | TableParseError): x is TableParseError {
  return (x as TableParseError).kind === 'table-parse-error';
}

function parseError(message: string, cause?: unknown): TableParseError {
  return { kind: 'table-parse-error', message, cause };
}

// ---------- frontmatter validation ----------

function formatZodIssues(issues: { path: PropertyKey[]; message: string }[]): string {
  return issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`).join('; ');
}

/** New row id: 8-char Crockford base32, the tail of a fresh ULID (spec §2.5). */
export function generateRowId(): string {
  return ulid().toLowerCase().slice(-8);
}

// ---------- row-line splitting (pipe-escaped, `\|` -> `|`) ----------

function endsWithUnescapedPipe(s: string): boolean {
  if (!s.endsWith('|')) return false;
  let backslashes = 0;
  let i = s.length - 2;
  while (i >= 0 && s[i] === '\\') {
    backslashes++;
    i--;
  }
  return backslashes % 2 === 0;
}

/** Splits one GFM table row line into its raw cell texts, unescaping `\|` -> `|` as it goes. */
function splitRowCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (endsWithUnescapedPipe(s)) s = s.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      current += '|';
      i++;
      continue;
    }
    if (s[i] === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += s[i];
  }
  cells.push(current.trim());
  return cells;
}

/** Escapes one cell's logical text for writing into a GFM table row: `|` -> `\|`, stray newlines -> `<br>`. */
function writeCell(text: string): string {
  return text.replace(/\r\n|\r|\n/g, '<br>').replace(/\|/g, '\\|');
}

// ---------- marker location ----------

interface MarkerMatch {
  lineStart: number;
  lineEnd: number;
}

/** All lines in `content` whose trimmed text equals `marker`, in order. */
function findMarkerLines(content: string, marker: string): MarkerMatch[] {
  const matches: MarkerMatch[] = [];
  let pos = 0;
  while (pos <= content.length) {
    const nl = content.indexOf('\n', pos);
    const lineTextEnd = nl === -1 ? content.length : nl;
    const line = content.slice(pos, lineTextEnd);
    const lineEnd = nl === -1 ? content.length : nl + 1;
    if (line.trim() === marker) matches.push({ lineStart: pos, lineEnd });
    if (nl === -1) break;
    pos = nl + 1;
  }
  return matches;
}

/** Strips leading/trailing blank lines; returns null if a blank line remains INSIDE (would split the GFM table in two). */
function extractContiguousLines(block: string): string[] | null {
  const raw = block.split('\n');
  let start = 0;
  let end = raw.length;
  while (start < end && raw[start].trim() === '') start++;
  while (end > start && raw[end - 1].trim() === '') end--;
  const lines = raw.slice(start, end);
  if (lines.some((l) => l.trim() === '')) return null;
  return lines;
}

// ---------- parse ----------

export function parseTableFile(raw: string): TableDoc | TableParseError {
  if (!raw.startsWith('---')) {
    return parseError('File does not start with a YAML frontmatter block (`---`)');
  }

  let parsed: { data: Record<string, unknown>; content: string };
  try {
    parsed = matter(raw);
  } catch (err) {
    return parseError('Malformed YAML frontmatter', err);
  }

  const data = parsed.data as Record<string, unknown>;
  if (data.folio !== 'table') {
    return parseError("Not a data table: frontmatter is missing `folio: table`");
  }
  if (data.version !== 1) {
    return parseError(`Unsupported table format version: ${JSON.stringify(data.version)} (expected 1)`);
  }
  if (typeof data.id !== 'string' || data.id.length === 0) {
    return parseError('Frontmatter `id` is missing or not a string');
  }

  const columnsResult = tableColumnSchema.array().safeParse(data.columns ?? []);
  if (!columnsResult.success) {
    return parseError(`Invalid \`columns\` in frontmatter: ${formatZodIssues(columnsResult.error.issues)}`, columnsResult.error);
  }
  const columns: TableColumn[] = columnsResult.data;

  const viewsResult = tableViewSchema.array().safeParse(data.views ?? []);
  if (!viewsResult.success) {
    return parseError(`Invalid \`views\` in frontmatter: ${formatZodIssues(viewsResult.error.issues)}`, viewsResult.error);
  }

  let rowIds: 'column' | 'none' = 'column';
  const options = data.options as Record<string, unknown> | undefined;
  if (options !== undefined) {
    if (typeof options !== 'object' || options === null) {
      return parseError('Frontmatter `options` must be an object');
    }
    if (options.rowIds !== undefined) {
      if (options.rowIds !== 'column' && options.rowIds !== 'none') {
        return parseError(`Frontmatter \`options.rowIds\` must be "column" or "none", got ${JSON.stringify(options.rowIds)}`);
      }
      rowIds = options.rowIds;
    }
  }

  const content = parsed.content;
  const beginMatches = findMarkerLines(content, BEGIN_MARKER);
  const endMatches = findMarkerLines(content, END_MARKER);
  if (beginMatches.length !== 1) {
    return parseError(`Expected exactly one ${BEGIN_MARKER} marker, found ${beginMatches.length}`);
  }
  if (endMatches.length !== 1) {
    return parseError(`Expected exactly one ${END_MARKER} marker, found ${endMatches.length}`);
  }
  const begin = beginMatches[0];
  const end = endMatches[0];
  if (end.lineStart < begin.lineStart) {
    return parseError(`${END_MARKER} appears before ${BEGIN_MARKER}`);
  }

  const head = content.slice(0, begin.lineStart);
  const tableBlockRaw = content.slice(begin.lineEnd, end.lineStart);
  const tail = content.slice(end.lineEnd);

  const tableLines = extractContiguousLines(tableBlockRaw);
  if (tableLines === null) {
    return parseError('Blank line found inside the table block — must be a single contiguous GFM table');
  }
  if (tableLines.length < 2) {
    return parseError('Table block must contain at least a header row and a separator row');
  }

  const expectedCellCount = columns.length + (rowIds === 'column' ? 1 : 0);
  const headerCells = splitRowCells(tableLines[0]);
  if (headerCells.length !== expectedCellCount) {
    return parseError(
      `Header row has ${headerCells.length} cell(s), expected ${expectedCellCount} (${columns.length} column(s)${rowIds === 'column' ? ' + id' : ''})`,
    );
  }
  const sepCells = splitRowCells(tableLines[1]);
  if (sepCells.length !== expectedCellCount) {
    return parseError(`Separator row has ${sepCells.length} cell(s), expected ${expectedCellCount}`);
  }

  const dataLines = tableLines.slice(2);
  const rows: TableRow[] = [];
  for (let i = 0; i < dataLines.length; i++) {
    const cells = splitRowCells(dataLines[i]);
    if (cells.length !== expectedCellCount) {
      return parseError(`Row ${i + 1} has ${cells.length} cell(s), expected ${expectedCellCount} — refusing to drop data silently`);
    }
    const values: Record<string, TableCellValue> = {};
    for (let c = 0; c < columns.length; c++) {
      values[columns[c].id] = decodeCell(columns[c], cells[c]);
    }
    let id: string;
    if (rowIds === 'column') {
      const rawId = cells[columns.length].trim();
      id = rawId.length > 0 ? rawId : generateRowId();
    } else {
      // rowIds: 'none' — identity is positional; no id is stored in the file.
      // A fresh id is minted for this in-memory representation each parse
      // (spec §2.5: an accepted trade-off of this mode).
      id = generateRowId();
    }
    rows.push({ id, values });
  }

  return {
    meta: { id: data.id, version: 1, rowIds },
    head,
    tail,
    columns,
    views: viewsResult.data,
    rows,
  };
}

// ---------- serialize ----------

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

export function serializeTableFile(doc: TableDoc): string {
  // JSON round-trip drops explicit `undefined` properties (e.g. an optional
  // TableColumn/TableView field a caller set to `undefined` rather than
  // omitting) — js-yaml v3's dumper throws on those ("unacceptable kind of
  // an object to dump [object Undefined]") rather than skipping them.
  const frontmatter: Record<string, unknown> = JSON.parse(
    JSON.stringify({
      folio: 'table',
      version: doc.meta.version,
      id: doc.meta.id,
      columns: doc.columns,
      views: doc.views,
      options: { rowIds: doc.meta.rowIds },
    }),
  );

  const includeIdColumn = doc.meta.rowIds === 'column';
  const headerCells = [...doc.columns.map((c) => c.name), ...(includeIdColumn ? ['id'] : [])];
  const sepCells = [...doc.columns.map((c) => alignMarker(c.align)), ...(includeIdColumn ? ['---'] : [])];

  const dataLines = doc.rows.map((row) => {
    const cells = doc.columns.map((col) => writeCell(encodeCell(col, row.values[col.id] ?? null)));
    if (includeIdColumn) cells.push(writeCell(row.id));
    return `| ${cells.join(' | ')} |`;
  });

  const headerLine = `| ${headerCells.map(writeCell).join(' | ')} |`;
  const sepLine = `| ${sepCells.join(' | ')} |`;
  const tableLines = [headerLine, sepLine, ...dataLines];

  const body = `${doc.head}${BEGIN_MARKER}\n\n${tableLines.join('\n')}\n\n${END_MARKER}\n${doc.tail}`;

  // `lineWidth: -1` disables js-yaml's default 80-col folding of long scalars
  // (column `description`, long select-option labels) — folding is lossless
  // for parsing, but keeping it off avoids any risk of a folding edge case
  // (leading/trailing whitespace inside a folded block) affecting round-trip.
  return matter.stringify(body, frontmatter, { lineWidth: -1 } as Parameters<typeof matter.stringify>[2]);
}
