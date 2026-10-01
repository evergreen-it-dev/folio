/**
 * What an uploaded or repository file is allowed to be when Folio serves it
 * back on its own origin.
 *
 * WHY THIS EXISTS (F-04): an attachment is chosen by whoever uploaded it, and
 * Folio serves attachments from the same origin as the application. A browser
 * that opens `image/svg+xml` directly treats it as a DOCUMENT — scripts in it
 * run with the visitor's session. The multipart MIME type is just a string the
 * client typed, so it cannot be what decides how bytes are served.
 *
 * THE POLICY, in one place so every route that serves user files applies the
 * same rules:
 *  - The served type comes from an ALLOWLIST keyed by what the bytes really
 *    are (magic numbers for rasters and PDF, a root-element check for SVG) and,
 *    for opaque formats that have no magic number (office files, archives), by
 *    the file extension. The client's claim is never consulted.
 *  - Verified rasters (png/jpeg/gif/webp/avif/heic/bmp/ico/tiff) and PDF are
 *    shown inline. Nothing else is: an unknown or unverifiable file is
 *    `application/octet-stream` with `Content-Disposition: attachment`.
 *  - SVG is the one active format that must stay viewable (diagrams, boards,
 *    pasted images). It is shown inline but under `SANDBOX_CSP`: no script, no
 *    network, and — because `sandbox` has no `allow-same-origin` — an opaque
 *    origin even if a script somehow ran. A CSP header on a response does not
 *    affect that same file used as `<img src>`, so pages keep rendering it.
 *  - Everything gets `X-Content-Type-Options: nosniff`.
 *  - The sandbox policy is also sent on every download, as a second layer
 *    behind `attachment`. It is NOT sent on PDF or raster images: both are
 *    verified by their magic numbers, neither can run script when opened
 *    directly, and a sandboxed document handed to a browser's built-in viewer
 *    is a compatibility risk that buys nothing here (Chrome showed a top-level
 *    PNG and loaded its PDF viewer with the header present; other browsers
 *    were not tried, so it is left off).
 *
 * This module is pure (no I/O besides the optional file-head helper) so both
 * the `/a/...` asset route and the repository `/files/...` handler can call it.
 */
import * as fs from 'node:fs/promises';

/** Opening an SVG directly: no script, no network, opaque origin. Images in `<img>` are unaffected. */
export const SANDBOX_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";

export interface ServePolicy {
  /** The Content-Type to send — always from the allowlist, never from the uploader. */
  contentType: string;
  /** `inline` only for verified rasters, PDF and (sandboxed) SVG. */
  inline: boolean;
  /** Send `SANDBOX_CSP` with the response. */
  sandbox: boolean;
}

const OPAQUE: ServePolicy = { contentType: 'application/octet-stream', inline: false, sandbox: true };
const SVG: ServePolicy = { contentType: 'image/svg+xml', inline: true, sandbox: true };

// ---------------------------------------------------------------------------
// what the bytes are
// ---------------------------------------------------------------------------

function startsWith(buf: Buffer, bytes: number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buf[offset + i] === b);
}
const ascii = (buf: Buffer, start: number, end: number): string => buf.subarray(start, end).toString('latin1');

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);
const BMP_DIB_SIZES = new Set([12, 40, 52, 56, 64, 108, 124]);

/** Verified raster/PDF type from magic numbers, or null. Order is irrelevant: none of these prefixes overlap. */
function sniffBinary(buf: Buffer): ServePolicy | null {
  const inline = (contentType: string): ServePolicy => ({ contentType, inline: true, sandbox: false });
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return inline('image/png');
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return inline('image/jpeg');
  if (ascii(buf, 0, 6) === 'GIF87a' || ascii(buf, 0, 6) === 'GIF89a') return inline('image/gif');
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WEBP') return inline('image/webp');
  if (ascii(buf, 4, 8) === 'ftyp') {
    const brand = ascii(buf, 8, 12);
    if (brand === 'avif' || brand === 'avis') return inline('image/avif');
    if (HEIC_BRANDS.has(brand)) return inline('image/heic');
  }
  if (ascii(buf, 0, 2) === 'BM' && buf.length >= 18 && BMP_DIB_SIZES.has(buf.readUInt32LE(14))) return inline('image/bmp');
  if (startsWith(buf, [0x00, 0x00, 0x01, 0x00]) && buf.length >= 6 && buf.readUInt16LE(4) > 0) return inline('image/x-icon');
  if (startsWith(buf, [0x49, 0x49, 0x2a, 0x00]) || startsWith(buf, [0x4d, 0x4d, 0x00, 0x2a])) return inline('image/tiff');
  // ISO 32000 lets junk precede the header; a BOM or a stray newline is all real files have.
  const pdfAt = buf.subarray(0, 16).indexOf('%PDF-', 0, 'latin1');
  if (pdfAt >= 0 && pdfAt <= 8) return inline('application/pdf');
  return null;
}

const SNIFF_WINDOW = 1024 * 1024; // a board's SVG can open with a large comment holding its scene

function isXmlSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/**
 * Is the document element `<svg>`? Skips the BOM, XML declaration, comments,
 * processing instructions and DOCTYPE (with an internal subset). 'unknown'
 * means the prolog ran past what was scanned — the caller decides.
 */
export function svgRootStatus(buf: Buffer, truncated = false): 'svg' | 'not-svg' | 'unknown' {
  const scanned = Math.min(buf.length, SNIFF_WINDOW);
  const cut = truncated || buf.length > scanned;
  const give = cut ? 'unknown' : 'not-svg';
  const s = buf.subarray(0, scanned).toString('latin1');
  const n = s.length;
  let i = s.startsWith('\u00ef\u00bb\u00bf') ? 3 : 0; // UTF-8 BOM

  for (;;) {
    while (i < n && isXmlSpace(s.charCodeAt(i))) i++;
    if (i >= n) return give;
    if (s.startsWith('<?', i)) {
      const end = s.indexOf('?>', i + 2);
      if (end < 0) return give;
      i = end + 2;
    } else if (s.startsWith('<!--', i)) {
      const end = s.indexOf('-->', i + 4);
      if (end < 0) return give;
      i = end + 3;
    } else if (s.startsWith('<!', i)) {
      let depth = 0;
      let quote = '';
      let k = i + 2;
      for (; k < n; k++) {
        const c = s[k];
        if (quote) {
          if (c === quote) quote = '';
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
      }
      if (k >= n) return give;
      i = k + 1;
    } else {
      break;
    }
  }
  if (cut && n - i < 64) return 'unknown';
  return /^<(?:[A-Za-z_][\w.-]*:)?svg(?=[\s/>])/i.test(s.slice(i, i + 64)) ? 'svg' : 'not-svg';
}

// ---------------------------------------------------------------------------
// formats that have no magic number: allowed as downloads, by extension
// ---------------------------------------------------------------------------

const OOXML = 'application/vnd.openxmlformats-officedocument.';
const ODF = 'application/vnd.oasis.opendocument.';
const DOWNLOAD_TYPES: Record<string, string> = {
  txt: 'text/plain',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  md: 'text/markdown',
  json: 'application/json',
  rtf: 'application/rtf',
  doc: 'application/msword',
  docx: `${OOXML}wordprocessingml.document`,
  xls: 'application/vnd.ms-excel',
  xlsx: `${OOXML}spreadsheetml.sheet`,
  ppt: 'application/vnd.ms-powerpoint',
  pptx: `${OOXML}presentationml.presentation`,
  odt: `${ODF}text`,
  ods: `${ODF}spreadsheet`,
  odp: `${ODF}presentation`,
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
};

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot < 0 ? '' : filename.slice(dot + 1).toLowerCase();
}

/**
 * Decides how a file is served. `truncated` says `data` is only the start of
 * a larger file (see `serveHeadersForPath`).
 */
export function classifyForServing(filename: string, data: Buffer, truncated = false): ServePolicy {
  const binary = sniffBinary(data);
  if (binary) return binary;

  const ext = extensionOf(filename);
  const root = svgRootStatus(data, truncated);
  // 'unknown' = too much prolog to see the root; `.svg` gets the sandboxed SVG policy, which is safe for any bytes.
  if (root === 'svg' || (root === 'unknown' && ext === 'svg')) return SVG;

  const download = DOWNLOAD_TYPES[ext];
  if (download) return { contentType: download, inline: false, sandbox: true };
  return OPAQUE;
}

// ---------------------------------------------------------------------------
// headers
// ---------------------------------------------------------------------------

/** `Content-Disposition` with an ASCII fallback plus RFC 5987 (non-ASCII names crash Node on a raw header). */
export function contentDisposition(inline: boolean, filename: string): string {
  const asciiName = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '') || 'file';
  return `${inline ? 'inline' : 'attachment'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function headersFor(policy: ServePolicy, filename: string): Record<string, string> {
  const headers: Record<string, string> = {
    // Text types declare their charset on the wire: a client that gets none
    // (Python `requests` falls back to ISO-8859-1 for text/*) would show
    // Cyrillic as mojibake, and the repository route always declared UTF-8.
    // The policy's own `contentType` (also what the asset table stores) stays bare.
    'Content-Type': policy.contentType.startsWith('text/') ? `${policy.contentType}; charset=utf-8` : policy.contentType,
    'Content-Disposition': contentDisposition(policy.inline, filename),
    'X-Content-Type-Options': 'nosniff',
  };
  if (policy.sandbox) headers['Content-Security-Policy'] = SANDBOX_CSP;
  return headers;
}

/** The complete security-relevant header set for serving `data` under `filename`. Apply with `reply.headers(...)`. */
export function serveHeaders(filename: string, data: Buffer, truncated = false): Record<string, string> {
  return headersFor(classifyForServing(filename, data, truncated), filename);
}

/**
 * Same as `serveHeaders` for a file on disk, reading only its first bytes —
 * for handlers that stream the file (e.g. `reply.sendFile`) instead of
 * holding it in memory. Returns null when the path is not a readable regular
 * file (missing, a directory, ...): set no headers then and let the caller's
 * own not-found handling answer.
 *
 * WITH `reply.sendFile` apply the result in an `onSend` hook, not before the
 * call: @fastify/static chooses Content-Type from the extension itself and
 * overwrites anything set earlier (verified in safeServe.test.ts — a `.html`
 * file still went out as text/html).
 */
export async function serveHeadersForPath(absPath: string, filename: string): Promise<Record<string, string> | null> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(absPath, 'r');
  } catch {
    return null;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    const head = Buffer.alloc(Math.min(stat.size, SNIFF_WINDOW));
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return serveHeaders(filename, head.subarray(0, bytesRead), stat.size > bytesRead);
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}
