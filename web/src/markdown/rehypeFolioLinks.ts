/**
 * Rehype plugin: rewrites an `<a href>` that points at another Folio page by
 * its full app URL (see folioLinks.ts's three shapes) into an in-app page
 * link — the page's TITLE (and icon, if it has one), navigating client-side
 * on click, same look as a `[[page]]`-picked relative link.
 *
 * Runs BEFORE rehypeRelativeLinks in pipeline.ts: a Folio URL is absolute
 * (or root-relative) and would otherwise be caught by that plugin's own
 * external-link / already-app-absolute early returns and left untouched —
 * exactly the "naked URL" bug this exists to fix. Once THIS plugin has
 * rewritten a resolved link's href to a root-relative app path,
 * rehypeRelativeLinks' `href.startsWith('/')` branch is a deliberate no-op
 * on it; an UNresolved one is left with its original href and falls through
 * to that plugin's ordinary external-link handling (target=_blank etc.) —
 * which is exactly the "show the URL until the title resolves" fallback.
 *
 * Title resolution is async (folioLinkIndex.ts) and this transform is not,
 * so a first pass over freshly-seen refs can only ever kick the fetch off
 * and leave the anchor as authored; index.tsx re-renders (bumping a
 * "links version" state, via `onFolioLinkSettled`) once it lands, same
 * pattern as `mentionsVersion` for `@handles`.
 */
import { visit } from 'unist-util-visit';
import type { Root, Element, ElementContent } from 'hast';
import { parseFolioLink, type FolioLinkRef } from './folioLinks';
import { ensureFolioLinkResolved, folioLinkFailed, resolvedFolioLink, type ResolvedFolioLink } from './folioLinkIndex';

export interface FolioPageLinksOptions {
  /** `window.location.origin` in the browser; undefined in a non-browser context (SSR, most tests) — an absolute URL then simply never matches (see parseFolioLink), only root-relative ones can. */
  origin?: string;
  /**
   * Set only on the public /share/:token route (round 8's shape, same as
   * relativeLinks.ts's own `shareToken`) — an anonymous guest has no
   * session, so both endpoints folioLinkIndex.ts calls would just 401.
   * Skips resolution entirely rather than spending a guaranteed-failing
   * fetch per link; the anchor is simply left as authored, degrading to
   * the plain URL exactly like any other unresolved link.
   */
  shareToken?: string;
  /** Defaults to folioLinkIndex.ts's module cache — injectable so tests can exercise "already resolved" / "known to have failed" without touching that (session-wide, singleton) cache. */
  resolve?: (ref: FolioLinkRef) => ResolvedFolioLink | undefined;
  hasFailed?: (ref: FolioLinkRef) => boolean;
  ensureResolve?: (ref: FolioLinkRef) => void;
}

export function rehypeFolioPageLinks({
  origin,
  shareToken,
  resolve = resolvedFolioLink,
  hasFailed = folioLinkFailed,
  ensureResolve = ensureFolioLinkResolved,
}: FolioPageLinksOptions) {
  return (tree: Root) => {
    if (shareToken) return;
    visit(tree, 'element', (node: Element) => {
      if (node.tagName !== 'a') return;
      const href = node.properties.href;
      if (typeof href !== 'string' || !href) return;

      const ref = parseFolioLink(href, origin);
      if (!ref) return;

      const entry = resolve(ref);
      if (entry) {
        node.properties.href = entry.navPath;
        node.properties.dataFolioNav = entry.navPath;
        const children: ElementContent[] = entry.icon
          ? [{ type: 'text', value: `${entry.icon} ${entry.title}` }]
          : [{ type: 'text', value: entry.title }];
        node.children = children;
        return;
      }

      if (!hasFailed(ref)) ensureResolve(ref);
      // Unresolved (pending or given up) — leave the anchor untouched, see
      // this module's own doc comment above.
    });
  };
}
