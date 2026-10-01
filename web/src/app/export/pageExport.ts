/**
 * Round 23 (EXPORT), client half — the network side of "Export".
 *
 * Kept as its own React-free module (same spirit as diagrams/download.ts and
 * diagrams/exportFilename.ts next to it) for two concrete reasons:
 *
 *  1. The three export endpoints return a FILE, not JSON, so app/api.ts's
 *     `request()` cannot be reused — it unconditionally does `res.json()`.
 *     This module owns the blob path instead, while still mirroring the two
 *     behaviors of `request()` that actually matter to the rest of the app:
 *     a 401 re-dispatches UNAUTHORIZED_EVENT, and every non-2xx becomes an
 *     ApiError carrying the server's own `{ error }` message.
 *  2. The interesting logic here (URL building, Content-Disposition parsing,
 *     truncation-header reading, the chromium-unavailable classification) is
 *     pure and worth testing without a DOM.
 *
 * The actual save-to-disk step is deliberately NOT here: the caller pairs
 * this with diagrams/download.ts's `downloadBlob`, so this module never
 * touches `URL.createObjectURL`.
 */
import type { ExportFormat } from '@shared/contracts';
import { ApiError, UNAUTHORIZED_EVENT } from '../api';

/**
 * `X-Folio-Export-Truncated` is `false` on a clean export, otherwise names
 * WHY the server cut the document short (server/export/limits.ts): too many
 * pages, too many bytes, or too many table rows.
 *
 * This is the whole reason the export goes through `fetch` rather than a
 * plain `<a download>`: a truncated export is still a 200 with a perfectly
 * valid file attached, so without reading this header a half-document is
 * indistinguishable from a complete one. `reason` is kept as a plain string
 * (not a union) so an unknown future reason still surfaces as a warning
 * instead of being silently classified as "clean".
 */
export interface ExportTruncationInfo {
  reason: string;
  /** `X-Folio-Export-Truncation-Detail` — the server's own ASCII-scrubbed English explanation. */
  detail?: string;
}

export interface PageExportResult {
  blob: Blob;
  filename: string;
  /** `X-Folio-Export-Pages` — how many pages actually made it into the document. */
  pageCount: number | null;
  /** null when `X-Folio-Export-Truncated` is `false` (or absent). */
  truncation: ExportTruncationInfo | null;
}

export interface PageExportOptions {
  /** Collate the whole subtree into one document (`?children=1`). Absent/false means this page only. */
  children?: boolean;
  /**
   * R23 tail: a TABLE page's view id (`?view=<id>`) — which saved view's
   * filter/sort/hidden-columns the server applies when serializing the table
   * (server/export/routes.ts, `tableViewId`). Absent for non-table pages.
   */
  view?: string;
}

/**
 * `?children=1` is sent ONLY when opting in. The server already defaults
 * `children` to false for a session-authenticated export, so omitting the
 * parameter and sending `children=0` mean the same thing — but omitting it
 * keeps the URL (and the test assertions on it) honest about what the UI
 * actually asked for. Same policy for `?view=`: only sent when the caller
 * actually picked a table view.
 */
export function exportUrl(pageId: string, format: ExportFormat, options: PageExportOptions = {}): string {
  const base = `/api/pages/${encodeURIComponent(pageId)}/export.${format}`;
  const params = new URLSearchParams();
  if (options.children) params.set('children', '1');
  if (options.view) params.set('view', options.view);
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

/** Percent-decodes an RFC 5987 `filename*=UTF-8''…` value, tolerating a malformed one. */
function decodeExtendedValue(raw: string): string | null {
  const match = /^[^']*'[^']*'(.*)$/.exec(raw);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    // Malformed percent-escapes — fall through to the plain `filename=` form.
    return null;
  }
}

/**
 * Pulls the download name out of `Content-Disposition`. The server sends both
 * halves of the ASCII-fallback + RFC 5987 pair (server/export/routes.ts's
 * `contentDisposition`), and `filename*` is the one that survives the uk/ru
 * titles that are the norm here — the plain `filename=` half has every
 * non-ASCII character replaced with `_`. So `filename*` is preferred, always.
 */
export function filenameFromDisposition(header: string | null | undefined): string | null {
  if (!header) return null;

  const extended = /filename\*\s*=\s*([^;]+)/i.exec(header);
  if (extended) {
    const decoded = decodeExtendedValue(extended[1].trim());
    if (decoded) return decoded;
  }

  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
  if (plain) {
    const value = (plain[2] ?? plain[1]).trim();
    if (value) return value;
  }

  return null;
}

/** Page-path suffixes across all three page kinds — longest-first so `.table.md`/`.excalidraw.svg` win over the plain `.md`/`.svg` they also end with. */
const PAGE_PATH_SUFFIXES = ['.excalidraw.svg', '.table.md', '.svg', '.md'] as const;

/** Characters invalid (or awkward) in a filename on at least one of Windows/macOS/Linux. */
function sanitizeForFilename(value: string): string {
  return value
    .trim()
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[-\s]+|[-\s]+$/g, '');
}

export interface ExportNameSource {
  /** PageMeta's own `path`, e.g. `notes/plan.md`. Preferred — it's the slug the system already computed for this page. */
  path?: string;
  /** PageMeta's own `title`. Used only when `path` yields nothing usable. */
  title?: string;
}

/**
 * The name to save under when the response carried no usable
 * `Content-Disposition` (a proxy stripping it, say). Mirrors the server's own
 * `slugOf` — basename with the kind's suffix stripped — so the fallback name
 * matches what the server would have called it.
 */
export function fallbackExportFilename(source: ExportNameSource, format: ExportFormat): string {
  let base = '';

  const segment = source.path?.split('/').pop() ?? '';
  if (segment) {
    const lower = segment.toLowerCase();
    const suffix = PAGE_PATH_SUFFIXES.find((candidate) => lower.endsWith(candidate));
    base = sanitizeForFilename(suffix ? segment.slice(0, segment.length - suffix.length) : segment);
  }
  if (!base && source.title) base = sanitizeForFilename(source.title);
  if (!base) base = 'export';

  return `${base}.${format}`;
}

/**
 * True when a failed PDF export is the host simply having no chromium, rather
 * than anything the user did wrong — the one export failure with a genuinely
 * different remedy ("ask an admin to install it"), so it gets its own copy.
 *
 * Matched on BOTH the status and the message on purpose. server/export/routes.ts
 * currently raises this through `badRequest(...)`, i.e. HTTP **400** — not the
 * 503 the shape of the condition suggests — so a status-only check would miss
 * it today, and a message-only check would miss a future move to 503. Neither
 * side of this is speculative: the 400 is what prod returns right now.
 */
export function isChromiumUnavailable(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.status === 503) return true;
  return /chromium/i.test(error.message);
}

/**
 * Fetches one export and hands back the blob plus everything the UI needs to
 * report on it. Throws ApiError (never a bare Response) on any non-2xx.
 */
export async function fetchPageExport(
  pageId: string,
  format: ExportFormat,
  options: PageExportOptions = {},
  nameSource: ExportNameSource = {},
): Promise<PageExportResult> {
  const res = await fetch(exportUrl(pageId, format, options));

  if (!res.ok) {
    let message = res.statusText || `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // Not JSON (a proxy's HTML error page, an empty body) — keep the status fallback.
    }
    // Same contract as api.ts's request(): a 401 anywhere means the session is
    // gone, and AuthProvider listens for exactly this to bounce to login.
    if (res.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new ApiError(res.status, message);
  }

  const truncatedHeader = res.headers.get('X-Folio-Export-Truncated');
  const detail = res.headers.get('X-Folio-Export-Truncation-Detail');
  const pagesHeader = res.headers.get('X-Folio-Export-Pages');
  const pageCount = pagesHeader !== null && pagesHeader !== '' && Number.isFinite(Number(pagesHeader)) ? Number(pagesHeader) : null;

  return {
    blob: await res.blob(),
    filename: filenameFromDisposition(res.headers.get('Content-Disposition')) ?? fallbackExportFilename(nameSource, format),
    pageCount,
    // Anything other than the literal `false` (including a header a proxy
    // dropped entirely -> null) is treated as "clean" only for `false`/absent;
    // any other value is a real truncation we must not swallow.
    truncation:
      truncatedHeader && truncatedHeader !== 'false'
        ? { reason: truncatedHeader, ...(detail ? { detail } : {}) }
        : null,
  };
}
