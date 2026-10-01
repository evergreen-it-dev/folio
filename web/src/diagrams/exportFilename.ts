/**
 * Round 21 follow-up (DIAGRAMS) — filename for a board's PNG/SVG export.
 *
 * "From the page's name" (DEV-PLAN) is deliberately resolved from `path`
 * first, not `title`: `path` is the slug the system already computed for
 * this exact page when it was created (round 2's translit slugs — see
 * web/src/app/translit.ts, a different zone we don't import from), so
 * reusing its basename gives the same filename-safe slug the rest of the
 * app already treats as canonical, instead of this zone inventing a second,
 * possibly-divergent slugification of the human-readable title. `title` is
 * only a fallback for the rare case `path` isn't available at all (e.g. a
 * malformed response) — sanitized for filesystem-invalid characters, but
 * deliberately NOT transliterated: modern filesystems and browsers handle
 * Unicode filenames natively, so "Übersicht.png" is a perfectly good download
 * name and inventing transliteration here would just duplicate another
 * zone's logic for no real benefit.
 */
export interface ExportFilenameSource {
  /** PageMeta/PageDoc's own `path`, e.g. "diagrams/my-flow.excalidraw.svg". */
  path?: string;
  /** PageMeta/PageDoc's own `title`, e.g. "My flow". Used only if `path` yields nothing usable. */
  title?: string;
}

export type ExportExtension = 'png' | 'svg';

/** Extensions a board's on-disk `path` may end in — stripped to recover the bare slug. Longest-first so `.excalidraw.svg` wins over the plain `.svg` it also ends with. */
const BOARD_PATH_SUFFIXES = ['.excalidraw.svg', '.svg', '.md'] as const;

const FALLBACK_BASENAME = 'board';

/** Characters invalid (or awkward) in a filename on at least one of Windows/macOS/Linux: path separators, wildcards, quotes, colons. Collapsed runs of whitespace/dashes are tidied too. */
function sanitizeForFilename(value: string): string {
  return value
    .trim()
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-+/g, '-')
    .replace(/^[-\s]+|[-\s]+$/g, '');
}

/** Last path segment with a known board/doc extension stripped, or null if `path` has no usable basename at all. */
function slugFromPath(path: string): string | null {
  const segment = path.split('/').pop() ?? '';
  if (!segment) return null;
  const lower = segment.toLowerCase();
  for (const suffix of BOARD_PATH_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      return segment.slice(0, segment.length - suffix.length);
    }
  }
  return segment;
}

/** The filename base (no extension) for a board export: `path`'s basename, falling back to a sanitized `title`, falling back to a fixed generic name. Never empty. */
export function deriveExportBasename(source: ExportFilenameSource): string {
  if (source.path) {
    const fromPath = slugFromPath(source.path);
    if (fromPath) {
      const sanitized = sanitizeForFilename(fromPath);
      if (sanitized) return sanitized;
    }
  }
  if (source.title) {
    const sanitized = sanitizeForFilename(source.title);
    if (sanitized) return sanitized;
  }
  return FALLBACK_BASENAME;
}

/** Full download filename: `deriveExportBasename(source) + '.' + extension`. */
export function exportFilename(source: ExportFilenameSource, extension: ExportExtension): string {
  return `${deriveExportBasename(source)}.${extension}`;
}
