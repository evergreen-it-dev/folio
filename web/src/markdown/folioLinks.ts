/**
 * Detects an `<a href>` that points at ANOTHER FOLIO PAGE by its full app
 * URL — round 22.09.2026, owner ask: pasting the exact URL
 * `TreeRow.tsx`'s own "Copy link" produces
 * (`${origin}/s/<space>/p/<id>`) into a document showed the naked URL in
 * reading mode instead of an in-app page link. `relativeLinks.ts` already
 * handles a RELATIVE `.md` link the same way; this module is that same idea
 * for the ABSOLUTE (or root-relative) shape a copied link/pasted URL is,
 * matching the three forms App.tsx's route table understands:
 *
 *  - `/s/<space>/p/<id>`   — a page by id (kind: 'page')
 *  - `/s/<space>/d/<dir>`  — a folder listing (kind: 'dir')
 *  - `/s/<space>`          — the space home (kind: 'space')
 *
 * Deliberately pure/sync and DOM-free — folioLinkIndex.ts (the stateful
 * resolve-and-cache half, mirroring mentionIndex.ts) and the rehype plugin
 * that wires both into the pipeline both depend on this, not the reverse.
 */

export type FolioLinkRef =
  | { space: string; kind: 'page'; id: string }
  | { space: string; kind: 'dir'; path: string }
  | { space: string; kind: 'space' };

const PAGE_RE = /^\/s\/([^/]+)\/p\/([^/]+)\/?$/;
const DIR_RE = /^\/s\/([^/]+)\/d\/(.+?)\/?$/;
const SPACE_RE = /^\/s\/([^/]+)\/?$/;

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment; // malformed escape — treat as already-literal rather than throwing
  }
}

/** Decodes each `/`-separated segment individually, so a literal (encoded) slash inside one segment survives as text rather than becoming a path separator. */
function decodeDirPath(path: string): string {
  return path.split('/').map(decodeSegment).join('/');
}

function matchPathname(pathname: string): FolioLinkRef | null {
  const page = pathname.match(PAGE_RE);
  if (page) return { space: decodeSegment(page[1]), kind: 'page', id: decodeSegment(page[2]) };

  const dir = pathname.match(DIR_RE);
  if (dir) return { space: decodeSegment(dir[1]), kind: 'dir', path: decodeDirPath(dir[2]) };

  const spaceOnly = pathname.match(SPACE_RE);
  if (spaceOnly) return { space: decodeSegment(spaceOnly[1]), kind: 'space' };

  return null;
}

/**
 * Parses `href` as a link to a page in THIS instance, or returns null for
 * anything else (a foreign absolute URL, a relative link, a bare anchor,
 * an app route this doesn't recognize). `origin` is the instance's own
 * origin (`window.location.origin` in the browser) — an absolute URL on any
 * OTHER origin is left completely alone, same as an ordinary external link.
 * A root-relative href (`/s/...`) matches regardless of `origin`, being
 * unambiguously this instance's own route already.
 */
export function parseFolioLink(href: string, origin: string | undefined): FolioLinkRef | null {
  const trimmed = href.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('/')) {
    const [pathname] = trimmed.split(/[?#]/);
    return matchPathname(pathname);
  }

  if (!origin) return null; // no browser origin to compare an absolute URL against (e.g. SSR/tests) — never guess
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  return matchPathname(url.pathname);
}

/** Stable cache key for one `FolioLinkRef` — same ref shape must always produce the same key, used by folioLinkIndex.ts. */
export function folioLinkKey(ref: FolioLinkRef): string {
  return ref.kind === 'page' ? `page:${ref.space}:${ref.id}` : ref.kind === 'dir' ? `dir:${ref.space}:${ref.path}` : `space:${ref.space}`;
}

/** The in-app SPA route `ref` navigates to — independent of whatever title/access resolution decides, since it's already fully determined by the parsed URL itself (see App.tsx's route table). */
export function folioLinkNavPath(ref: FolioLinkRef): string {
  if (ref.kind === 'page') return `/s/${ref.space}/p/${ref.id}`;
  if (ref.kind === 'dir') return `/s/${ref.space}/d/${ref.path}`;
  return `/s/${ref.space}`;
}
