/**
 * Round 23 (EXPORT) — assembly limits, R23 addendum 2 point 5: "no more than
 * 200 pages and no more than ~5 MB per assembly; when exceeded — cut and
 * return an EXPLICIT truncation marker ... rather than silently hand over half".
 *
 * Two independent budgets, because they fail differently: a wide-and-shallow
 * subtree hits the page cap first, one enormous page hits the byte cap first.
 * Both surface through the SAME `ExportTruncation` value so no caller can
 * accidentally handle one and silently swallow the other.
 */

export const MAX_EXPORT_PAGES = 200;
/** ~5 MB, measured in UTF-8 BYTES of assembled markdown (not JS string length). */
export const MAX_EXPORT_BYTES = 5 * 1024 * 1024;

export type ExportTruncationReason = 'pages' | 'bytes' | 'rows';

export interface ExportTruncation {
  reason: ExportTruncationReason;
  /** Pages that were dropped from the collation (0 for a row-level truncation). */
  omittedPages: number;
  /** Table rows dropped, when reason === 'rows'. */
  omittedRows?: number;
  /** Human-readable, embedded verbatim in the MD marker comment and the API field. */
  message: string;
}

/**
 * The truncation marker embedded in the assembled markdown. An HTML comment
 * (invisible when rendered, impossible to miss when an agent reads the raw
 * text) — spec: "in MD — as a comment, in the API response — as a field".
 */
export function truncationMarkerComment(t: ExportTruncation): string {
  return `<!-- folio-export: TRUNCATED (${t.reason}) — ${t.message} -->`;
}

export function pagesTruncation(omittedPages: number): ExportTruncation {
  return {
    reason: 'pages',
    omittedPages,
    message: `page limit of ${MAX_EXPORT_PAGES} reached; ${omittedPages} page(s) omitted from this export`,
  };
}

export function bytesTruncation(omittedPages: number): ExportTruncation {
  return {
    reason: 'bytes',
    omittedPages,
    message: `size limit of ${MAX_EXPORT_BYTES} bytes reached; ${omittedPages} page(s) omitted from this export`,
  };
}

export function rowsTruncation(omittedRows: number): ExportTruncation {
  return {
    reason: 'rows',
    omittedPages: 0,
    omittedRows,
    message: `table row limit reached; ${omittedRows} row(s) omitted from this export`,
  };
}

/** UTF-8 byte length — what MAX_EXPORT_BYTES is actually measured in. */
export function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}
