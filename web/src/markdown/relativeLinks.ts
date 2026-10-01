import { visit } from 'unist-util-visit';
import type { Root, Element } from 'hast';
import { dirOf, isExternalUrl, isMarkdownPath, resolveRelativePath, splitFragment } from './resolvePath';

export interface RelativeLinksOptions {
  space: string;
  /** Path of the page being rendered, relative to the space root. */
  pagePath: string;
  /**
   * Round 8: set only on the public /share/:token route. /files/<space>/...
   * is role-guarded (needs a session cookie) — SERVER now also accepts
   * ?share=<token> there, so every /files/... URL this plugin produces
   * (image src, and now non-markdown link href — see below) gets that query
   * appended when a guest with no session is the one rendering the page.
   * undefined for every other caller (the normal authenticated reading view
   * and the editor's reading mode), which needs nothing appended — the
   * request already carries a cookie.
   */
  shareToken?: string;
}

/** /files/<space>/<resolved>, plus ?share=<token> when rendering for a guest (round 8). */
function filesUrl(space: string, resolved: string, shareToken: string | undefined): string {
  const base = `/files/${space}/${resolved}`;
  return shareToken ? `${base}?share=${encodeURIComponent(shareToken)}` : base;
}

/**
 * Rehype plugin:
 * - rewrites relative <img src> to the static file route (/files/<space>/<resolved>);
 * - marks relative <a href> that point at another markdown page with
 *   data-folio-link="<resolved path>" so the reading container can intercept
 *   the click and route in-app instead of doing a full page navigation;
 * - rewrites relative <a href> that point at anything else (a linked PDF,
 *   export, etc. living next to the page) to the SAME /files/<space>/...
 *   route as images — round 8: these were previously left as bare relative
 *   hrefs, which only ever happened to work by accident nowhere (the page
 *   itself is served from a client-routed /s/<space>/p/<id> URL with no
 *   relation to the file's real location, so the browser's own relative
 *   resolution never pointed at the right place);
 * - external links get target="_blank" rel="noopener noreferrer";
 * - round 25: so does that same rewritten /files/... link — it's a real
 *   download/new-tab destination (an uploaded file, never another Folio
 *   page: those go through the isMarkdownPath branch below instead, as an
 *   in-app data-folio-link navigation, not a plain href), so it gets the
 *   identical "leaves the current page" treatment as an external link.
 *   This is shared by every caller of renderMarkdownToHtml (see pipeline.ts),
 *   which covers both the reading view and the editor's hover link-preview
 *   card (link-preview.tsx renders a previewed page's body through this same
 *   <Markdown> pipeline) — one fix here reaches both surfaces.
 */
export function rehypeRelativeLinks({ space, pagePath, shareToken }: RelativeLinksOptions) {
  return (tree: Root) => {
    visit(tree, 'element', (node: Element) => {
      if (node.tagName === 'img') {
        const src = node.properties.src;
        if (
          typeof src === 'string' &&
          src &&
          !isExternalUrl(src) &&
          !src.startsWith('data:') &&
          // App-absolute srcs (the /a/<sha>/... asset store is public and
          // already correct) must not be re-resolved against the page path —
          // that used to produce a broken /files/<space>//a/... URL, so
          // reading mode showed a dead image where live mode was fine.
          !src.startsWith('/')
        ) {
          const { path } = splitFragment(src);
          const resolved = resolveRelativePath(pagePath, path);
          node.properties.src = filesUrl(space, resolved, shareToken);
        }
        return;
      }

      if (node.tagName === 'a') {
        const href = node.properties.href;
        if (typeof href !== 'string' || !href) return;

        if (isExternalUrl(href)) {
          node.properties.target = '_blank';
          node.properties.rel = ['noopener', 'noreferrer'];
          return;
        }

        if (href.startsWith('#')) return; // same-page anchor, leave alone
        if (href.startsWith('/')) return; // app-absolute (/a/... asset, app route) — already correct

        const { path, hash } = splitFragment(href);
        if (!path) return;
        const resolved = resolveRelativePath(pagePath, path);
        if (isMarkdownPath(path)) {
          node.properties.dataFolioLink = resolved;
          return;
        }
        // A real file (pdf/zip/etc.), not another Folio page — opens outside
        // the SPA, same as an external link (round 25).
        node.properties.href = filesUrl(space, resolved, shareToken) + hash;
        node.properties.target = '_blank';
        node.properties.rel = ['noopener', 'noreferrer'];
      }
    });
  };
}

// Re-exported for callers that need the directory of the current page
// without depending on the rest of the pipeline (e.g. tests).
export { dirOf };
