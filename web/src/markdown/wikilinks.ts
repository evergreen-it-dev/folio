/**
 * Wikilinks in the reading view (Obsidian vault compatibility, wave 2): which
 * page does `[[Note]]` mean, and what does a click on a link to nothing offer.
 *
 * Resolution is the SERVER's (Obsidian's "shortest path" rules in
 * server/wikilinks.ts, applied when the page is indexed); the reading view only
 * reads the answer. One request per page, not per link: the typed links of the
 * page being shown come from `GET /api/pages/:id/meta` (`PageMetadata.links`;
 * on a public site `GET /api/public/spaces/:slug/pages/:id/links`), and each
 * wikilink of the rendered text is looked up in them by what was written
 * (`linkPath` + fragment). A plain fetch with a small module cache, not
 * react-query, for the reason mentionIndex.ts gives: `<Markdown>` also mounts
 * in detached roots without a QueryClientProvider.
 */
import type { PageLinkRef, PageMetadata, PublicPageLinks } from '@shared/contracts';
import { extensionOf, fragmentInfo } from '@shared/ofm/wikilink';
import { dirOf, resolveRelativePath } from './resolvePath';

export type WikilinkResolution =
  | { state: 'page'; pageId: string; fragmentResolved: boolean | null }
  | { state: 'asset' }
  | { state: 'unresolved' };

export interface WikilinkRef {
  /** The link path as written (`Note`, `folder/Note`, `img.png`); '' for `[[#Heading]]`. */
  path: string;
  fragment: string | null;
  embed: boolean;
}

/**
 * What the renderer knows about the wikilinks of the page it draws.
 *  - `ready`: `resolve` answers (undefined: the index has no row for this very
 *    link - the text is newer than the index);
 *  - `pending`: the answer is on its way;
 *  - `unavailable`: nothing can answer here (a share link, a history preview),
 *    so a wikilink is drawn as its text.
 */
export type WikilinkContext =
  | {
      status: 'ready';
      resolve: (ref: WikilinkRef) => WikilinkResolution | undefined;
      /**
       * The space path of an attachment (an image, a pdf) the index resolved by NAME, Obsidian-style: `x.png` written
       * on a page whose file lives at `Attachments/x.png`. `path` is what the page wrote (an `<img src>`, an embed or a
       * link target); undefined when the index has no resolved attachment for it - the caller keeps the path as written.
       */
      resolveAttachment?: (path: string) => string | undefined;
    }
  | { status: 'pending' }
  | { status: 'unavailable' };

export const WIKILINKS_UNAVAILABLE: WikilinkContext = { status: 'unavailable' };
export const WIKILINKS_PENDING: WikilinkContext = { status: 'pending' };

function keyOf(embed: boolean, path: string, fragment: string | null): string {
  return `${embed ? 'e' : 'w'}|${path.toLowerCase()}|${fragment ?? ''}`;
}

function decoded(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

/**
 * The resolved attachments of a page: what was written (`linkPath`, also percent-decoded, the way a renderer sees an
 * `<img src>`) -> the file's path in the space (`targetPath`). Only links the index resolved to a FILE count.
 */
export function attachmentLookupFromLinks(links: readonly PageLinkRef[]): (path: string) => string | undefined {
  const byPath = new Map<string, string>();
  // A PDF, docx ... is a PAGE kind in the index (it has a page id), yet `![[spec.pdf]]` still means the file.
  const isFile = (link: PageLinkRef) => link.kind === 'asset' || (link.kind === 'page' && !['', 'md'].includes(extensionOf(link.targetPath)));
  // Embeds and markdown links first, then a wikilink to a file (`[[doc.pdf]]`).
  for (const wikilinks of [false, true]) {
    for (const link of links) {
      if (!isFile(link) || !link.targetPath || (link.syntax === 'wikilink') !== wikilinks) continue;
      for (const key of new Set([link.linkPath, decoded(link.linkPath)])) if (!byPath.has(key)) byPath.set(key, link.targetPath);
    }
  }
  return (path) => byPath.get(path) ?? byPath.get(decoded(path));
}

/** Looks the page's wikilinks up in its typed links. */
export function wikilinkContextFromLinks(links: readonly PageLinkRef[]): WikilinkContext {
  const resolveAttachment = attachmentLookupFromLinks(links);
  const exact = new Map<string, PageLinkRef>();
  const anyFragment = new Map<string, PageLinkRef>();
  for (const link of links) {
    if (link.syntax !== 'wikilink' && link.syntax !== 'embed') continue;
    const embed = link.syntax === 'embed';
    const key = keyOf(embed, link.linkPath, link.fragment);
    if (!exact.has(key)) exact.set(key, link);
    const loose = keyOf(embed, link.linkPath, null);
    if (!anyFragment.has(loose)) anyFragment.set(loose, link);
  }
  return {
    status: 'ready',
    resolveAttachment,
    resolve: ({ path, fragment, embed }) => {
      const link = exact.get(keyOf(embed, path, fragment)) ?? anyFragment.get(keyOf(embed, path, null));
      if (!link) return undefined;
      if (link.kind === 'page' && link.targetPageId) {
        // The row of the same link with ANOTHER fragment says nothing about this fragment: only an exact row does.
        const own = exact.get(keyOf(embed, path, fragment));
        return { state: 'page', pageId: link.targetPageId, fragmentResolved: own ? own.fragmentResolved : null };
      }
      if (link.kind === 'asset') return { state: 'asset' };
      return { state: 'unresolved' };
    },
  };
}

/** The in-app hash a fragment navigates to: a heading's slug, or `^id` for a block. */
export function fragmentHash(fragment: string | null): string {
  const info = fragmentInfo(fragment);
  if (!info) return '';
  return info.kind === 'block' ? `#^${info.fragment.slice(1).trim()}` : `#${info.key}`;
}

// ---------------------------------------------------------------------------
// Fetching the page's links
// ---------------------------------------------------------------------------

const cache = new Map<string, readonly PageLinkRef[]>();
const inflight = new Map<string, Promise<readonly PageLinkRef[]>>();

function urlFor(pageId: string, publicSpace: string | undefined, shareToken?: string): string {
  // A share link has no session: its own read-only route answers with the file links of the page only.
  if (shareToken) return `/api/share/${encodeURIComponent(shareToken)}/links?page=${encodeURIComponent(pageId)}`;
  return publicSpace
    ? `/api/public/spaces/${encodeURIComponent(publicSpace)}/pages/${encodeURIComponent(pageId)}/links`
    : `/api/pages/${encodeURIComponent(pageId)}/meta`;
}

/** The last answer for this page, if any (shown at once while a fresh one is fetched). */
export function cachedPageLinks(pageId: string, publicSpace?: string, shareToken?: string): readonly PageLinkRef[] | undefined {
  return cache.get(urlFor(pageId, publicSpace, shareToken));
}

/** Fetches the typed links of a page; concurrent callers share one request. Rejects on any failure. */
export function fetchPageLinks(pageId: string, publicSpace?: string, shareToken?: string): Promise<readonly PageLinkRef[]> {
  const url = urlFor(pageId, publicSpace, shareToken);
  const pending = inflight.get(url);
  if (pending) return pending;
  const request = fetch(url, { credentials: 'same-origin' })
    .then(async (res) => {
      if (!res.ok) throw new Error(`links request failed with ${res.status}`);
      const data = (await res.json()) as Partial<PageMetadata> & Partial<PublicPageLinks>;
      const links = Array.isArray(data.links) ? data.links : [];
      cache.set(url, links);
      return links;
    })
    .finally(() => {
      inflight.delete(url);
    });
  inflight.set(url, request);
  return request;
}

/** Testing hook. */
export function clearPageLinksCache(): void {
  cache.clear();
  inflight.clear();
}

// ---------------------------------------------------------------------------
// "Create page “Note”"
// ---------------------------------------------------------------------------

export interface WikilinkCreateTarget {
  /** The folder of the new page, relative to the space root. */
  parentPath: string;
  /** The file name without `.md`, also the new page's title. */
  stem: string;
}

/** Characters server/storage.ts refuses in a file stem (a link could not carry them). */
const BAD_STEM = /[/\\#|^:[\]%\u0000-\u001f]/;

/**
 * Where `[[linkPath]]` written on the page at `pagePath` would live if it
 * existed: a bare name next to the page, `./x` / `../x` relative to it, any
 * other path from the space root (Obsidian writes full paths from the vault
 * root). Null when the name cannot be a file name.
 */
export function wikilinkCreateTarget(pagePath: string, linkPath: string): WikilinkCreateTarget | null {
  const clean = linkPath.trim().replace(/\.mdx?$/i, '');
  if (!clean) return null;
  let parentPath: string;
  let name: string;
  if (!clean.includes('/')) {
    parentPath = dirOf(pagePath);
    name = clean;
  } else {
    const resolved = clean.startsWith('./') || clean.startsWith('../') ? resolveRelativePath(pagePath, clean) : resolveRelativePath('', clean);
    parentPath = dirOf(resolved);
    name = resolved.slice(resolved.lastIndexOf('/') + 1);
  }
  if (!name || name.startsWith('.') || BAD_STEM.test(name) || name !== name.trim()) return null;
  return { parentPath, stem: name };
}
