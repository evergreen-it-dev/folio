/**
 * Per-share-link Open Graph/title injection into the SPA's index.html — see
 * OWNER ASK 22.09.2026 (SEO extension: no per-page preview on shared links).
 *
 * `/share/:token` and `/share/:token/p/:pageId` are the only client routes
 * reachable WITHOUT a session (web/src/app/App.tsx's AppRoutes) — everything
 * else sits behind the login wall, so a link-preview bot (Slack, Telegram,
 * iMessage, ...) that never runs the SPA's JS would otherwise always see the
 * generic site-level meta from web/index.html, never the shared page's own
 * title. This module is what server/index.ts's setNotFoundHandler (the SPA
 * fallback that serves those two routes — there is no server-registered GET
 * for them) calls to rewrite that HTML per request, share routes only.
 *
 * Two notes about the generic tags in web/index.html this builds on, kept
 * here rather than as an HTML comment (that file ships to every visitor, and
 * internal rationale has no business in public page source):
 *  - `lang="uk"` there matches the app's own DEFAULT_LANG
 *    (web/src/i18n/index.ts). It used to be a hardcoded `en` that never
 *    matched what renders; the runtime sets documentElement.lang correctly,
 *    but a preview bot reads the raw HTML without running the SPA's JS.
 *  - No `og:image`: web/public/ holds only favicon.svg, and most preview
 *    consumers (Slack, Telegram, iMessage) ignore or badly render an SVG —
 *    omitting it beats pointing at one. Add a raster image if one is made.
 *
 * Title/body are USER CONTENT reaching an HTML attribute — every injected
 * value goes through escapeHtmlAttr. Any failure to resolve the token
 * (unknown, revoked, deleted page, thrown error) must fall back to the
 * UNCHANGED original HTML: a broken or hostile share link must never surface
 * an error, a partial rewrite, or a stack trace.
 */
import { resolveShareScope } from './export/shareScope.js';
import * as storage from './storage.js';

export interface ShareRouteMatch {
  token: string;
  /** Present for the child-page route (`/share/:token/p/:pageId`) only. */
  pageId?: string;
}

const SHARE_ROUTE_RE = /^\/share\/([^/]+)(?:\/p\/([^/]+))?\/?$/;

/** Matches only the two client routes App.tsx's AppRoutes mounts for a share visitor. */
export function matchShareRoute(pathname: string): ShareRouteMatch | undefined {
  const m = SHARE_ROUTE_RE.exec(pathname);
  if (!m) return undefined;
  return { token: decodeURIComponent(m[1]), pageId: m[2] ? decodeURIComponent(m[2]) : undefined };
}

/** Escapes the characters that matter inside an HTML attribute or text node: & < > " ' */
export function escapeHtmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * A short plain-text og:description: strips the markdown syntax that would
 * otherwise show up verbatim (fenced code, headings, emphasis, links,
 * images, inline code, blockquote/list markers), collapses whitespace, and
 * truncates to roughly `maxLen` characters on a word boundary. Deliberately
 * simple — this produces a preview snippet, not a renderer; there is no
 * existing markdown-to-plain-text excerpt helper in server/ to reuse (the
 * closest, storage.tableDocToPlainText/formDocToPlainText, denormalize a
 * structured doc rather than strip prose markdown).
 */
export function excerptFromMarkdown(markdown: string, maxLen = 180): string {
  const text = (markdown || '')
    .replace(/^---[\s\S]*?---\s*/, '') // leftover frontmatter, if any slipped into the body
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks
    .replace(/!\[([^\]]*)]\([^)]*\)/g, '$1') // images -> alt text
    .replace(/\[([^\]]*)]\([^)]*\)/g, '$1') // links -> label text
    .replace(/`([^`]*)`/g, '$1') // inline code
    .replace(/^#{1,6}\s+/gm, '') // headings
    .replace(/^>\s?/gm, '') // blockquote markers
    .replace(/^\s*[-*+]\s+/gm, '') // bullet list markers
    .replace(/^\s*\d+\.\s+/gm, '') // numbered list markers
    .replace(/[*_~]{1,3}/g, '') // emphasis/strikethrough markers
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  const trimmed = lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${trimmed.trim()}…`;
}

/** Replaces the first match of `re` in `html` with `replacement`, or appends nothing if absent. */
function replaceTag(html: string, re: RegExp, replacement: string): string {
  return re.test(html) ? html.replace(re, replacement) : html;
}

function injectShareMeta(html: string, title: string, description: string, url: string): string {
  const escTitle = escapeHtmlAttr(title);
  const escDescription = escapeHtmlAttr(description);
  const escUrl = escapeHtmlAttr(url);

  // The generic tags these replace are written by hand in web/index.html
  // with a known, stable shape (double-quoted attributes, property/name
  // first) — regexes keyed on the attribute, never on the site-level
  // content they currently hold, so this stays correct if that copy changes.
  let out = html;
  out = replaceTag(out, /<title>[^<]*<\/title>/, `<title>${escTitle} · Folio</title>`);
  out = replaceTag(out, /<meta\s+property="og:title"[^>]*\/>/, `<meta property="og:title" content="${escTitle}" />`);
  // Only when there IS an excerpt: a board indexes as unsearchable (storage's
  // rowToEntry maps `body` from `plain_text`, null for boards), and an empty
  // excerpt would otherwise overwrite the site-level description with
  // content="" — a blank preview is strictly worse than the generic one.
  if (escDescription) {
    out = replaceTag(
      out,
      /<meta\s+property="og:description"[^>]*\/>/,
      `<meta property="og:description" content="${escDescription}" />`,
    );
  }
  out = replaceTag(out, /<meta\s+name="twitter:card"[^>]*\/>/, `<meta name="twitter:card" content="summary" />`);

  const ogUrlTag = `<meta property="og:url" content="${escUrl}" />`;
  const headClose = out.indexOf('</head>');
  if (headClose === -1) return out; // no recognizable <head> — nothing sane to inject into
  return `${out.slice(0, headClose)}    ${ogUrlTag}\n  ${out.slice(headClose)}`;
}

/**
 * Resolves `pathname` as a share route and, if it names a real (non-revoked)
 * share and page, returns `originalHtml` with per-page <title>/og:title/
 * og:description/og:url/twitter:card injected. Returns `originalHtml`
 * UNCHANGED for every other case: unmatched pathname, unknown/revoked
 * token, a page deleted since, an out-of-scope child id, or any thrown
 * error while resolving — this must never surface an error or a partial
 * rewrite to a share visitor. The share page's own client-side 404 handling
 * is untouched; this only decides what a bot sees in the raw HTML.
 */
export async function renderShareIndexHtml(originalHtml: string, pathname: string, absoluteUrl: string): Promise<string> {
  const match = matchShareRoute(pathname);
  if (!match) return originalHtml;
  try {
    const scope = await resolveShareScope(match.token);
    if (!scope) return originalHtml;
    let entry = scope.root;
    if (match.pageId && match.pageId !== scope.root.id) {
      if (!scope.collected.ids.has(match.pageId)) return originalHtml;
      const child = await storage.getEntry(match.pageId);
      if (!child) return originalHtml;
      entry = child;
    }
    const title = entry.title?.trim() || 'Folio';
    const description = excerptFromMarkdown(entry.body ?? '');
    return injectShareMeta(originalHtml, title, description, absoluteUrl);
  } catch {
    return originalHtml;
  }
}
