/**
 * The `text/html` half of a Live edit copy: the selection's markdown rendered
 * by the same pipeline Reading mode uses, then made self-contained for the
 * apps it is pasted into (Google Docs, Slack, mail clients), which know nothing
 * about Folio's stylesheet:
 *  - highlight / status colours become inline styles;
 *  - root-relative links and images get the site origin;
 *  - a single inline paragraph loses its `<p>`, so pasting a word mid-sentence
 *    does not break the line.
 *
 * The root carries `data-folio-clip`: when this HTML comes back into Folio the
 * paste handler recognises it and pastes the exact markdown from `text/plain`
 * instead of converting the HTML back (html-paste.ts, `isFolioClipboardHtml`).
 */
import { renderMarkdownToHtml } from '../markdown/pipeline';
import { STATUS_PALETTE, resolveStatusColor } from '@shared/status';
import type { PageContext } from './live-preview';

/** Light-theme fills of `mark.folio-hl-<token>` (markdown.css); the pasted-into app has no dark variant. */
const HIGHLIGHT_FILL: Record<string, string> = {
  yellow: '#fff3bf',
  green: '#d3f9d8',
  teal: '#c5f6fa',
  blue: '#d0ebff',
  purple: '#e5dbff',
  red: '#ffdeeb',
  orange: '#ffe8cc',
  gray: '#e9ecef',
};

/** Attribute that marks clipboard HTML written by Folio itself. */
export const FOLIO_CLIP_ATTR = 'data-folio-clip';

// Reading mode asks the page-link index to resolve Folio URLs (a network
// round trip, and a title swap); a copy must not trigger either.
const NO_LINK_LOOKUP = {
  resolve: () => undefined,
  hasFailed: () => true,
  ensureResolve: () => undefined,
};

function absolutize(url: string, origin: string): string {
  return url.startsWith('/') && !url.startsWith('//') ? `${origin}${url}` : url;
}

/** Inline styles and absolute URLs, applied to the rendered fragment. */
function makeSelfContained(root: HTMLElement, origin: string): void {
  for (const mark of Array.from(root.querySelectorAll<HTMLElement>('mark'))) {
    const token = Array.from(mark.classList)
      .map((cls) => /^folio-hl-(.+)$/.exec(cls)?.[1])
      .find((value): value is string => !!value);
    mark.style.backgroundColor = HIGHLIGHT_FILL[token ?? 'yellow'] ?? HIGHLIGHT_FILL.yellow;
  }
  for (const badge of Array.from(root.querySelectorAll<HTMLElement>('.folio-status'))) {
    const color = Array.from(badge.classList)
      .map((cls) => /^folio-status--(.+)$/.exec(cls)?.[1])
      .find((value): value is string => !!value);
    const palette = STATUS_PALETTE[resolveStatusColor(color)];
    badge.style.cssText =
      `background-color:${palette.bg};color:${palette.fg};border-radius:3px;padding:0 4px;` +
      'font-size:0.85em;font-weight:700;text-transform:uppercase;';
  }
  for (const link of Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
    link.setAttribute('href', absolutize(link.getAttribute('href') ?? '', origin));
  }
  for (const image of Array.from(root.querySelectorAll<HTMLImageElement>('img[src]'))) {
    image.setAttribute('src', absolutize(image.getAttribute('src') ?? '', origin));
  }
}

/** Rendered, self-contained HTML for a markdown fragment copied out of the editor. */
export function clipboardHtml(markdown: string, ctx: PageContext, origin = globalThis.location?.origin ?? ''): string {
  const rendered = renderMarkdownToHtml(markdown, {
    space: ctx.space,
    pagePath: ctx.pagePath,
    shareToken: ctx.shareToken,
    origin,
    folioLinks: NO_LINK_LOOKUP,
  });
  const body = new DOMParser().parseFromString(rendered, 'text/html').body;
  makeSelfContained(body, origin);

  // A lone paragraph is an inline selection; its block wrapper would only add a line break.
  const only = body.children.length === 1 && body.childNodes.length === 1 ? body.children[0] : null;
  if (only?.tagName === 'P') {
    return `<span ${FOLIO_CLIP_ATTR}="1">${only.innerHTML}</span>`;
  }
  return `<div ${FOLIO_CLIP_ATTR}="1">${body.innerHTML}</div>`;
}
