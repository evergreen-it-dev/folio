import { visit } from 'unist-util-visit';
import type { Root, Blockquote, Paragraph, Text } from 'mdast';
import { t } from './i18n/register';

/** GFM alert types, in the order GitHub documents them. */
export const ALERT_TYPES = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

// The marker must be alone on the blockquote's first line, e.g. "> [!NOTE]".
const MARKER_RE = new RegExp(`^\\[!(${ALERT_TYPES.join('|')})\\][ \\t]*(?:\\n|$)`);

export interface AlertMarkerMatch {
  type: AlertType;
  /** `text` with the leading `[!TYPE]` marker (and the whitespace/newline after it) removed. */
  rest: string;
}

/**
 * Recognizes a callout marker at the very start of `text` (a blockquote's
 * first text node) — the one place remarkAlerts decides "this blockquote is
 * a callout" at all. Exported so markdown/notes.ts can find the exact same
 * callouts from a separate, unmutated parse of the raw markdown (the same
 * relationship editor/scroll-to-heading.ts's headingPositions has with
 * headings.ts's extractHeadings) without a second copy of MARKER_RE drifting
 * out of sync with this one.
 */
export function matchAlertMarker(text: string): AlertMarkerMatch | null {
  const match = text.match(MARKER_RE);
  if (!match) return null;
  return { type: match[1] as AlertType, rest: text.slice(match[0].length) };
}

/**
 * Remark plugin: turns `> [!NOTE]\n> body` blockquotes into
 * `<div class="md-alert md-alert-note" data-alert="note" data-alert-label="Note">body</div>`
 * by attaching mdast-util-to-hast render hints (`data.hName`/`hProperties`) to
 * the blockquote node, and stripping the marker text itself.
 *
 * Round 22 (SHELL-5, callout-i18n): the visible label used to be produced
 * entirely in CSS (`.md-alert::before { content: attr(data-alert) }` +
 * `text-transform: capitalize`), which can only ever show the English
 * marker keyword — there's no such thing as a CSS selector "for the current
 * i18next language". `data-alert` (the lowercase machine type, e.g. "note")
 * stays as-is — still useful as a hook/for tests — but the actual on-screen
 * text now comes from `data-alert-label`, resolved HERE at render time via
 * the SAME non-React `t()` this zone's directiveFallback.ts already uses
 * (this runs inside a plain unified transform, not a component, and
 * `<Markdown>` itself can render in detached roots with no ambient
 * provider — see that file's own doc comment). markdown.css's `::before`
 * now reads `attr(data-alert-label)` instead, with no locale-specific CSS
 * selector anywhere.
 */
export function remarkAlerts() {
  return (tree: Root) => {
    visit(tree, 'blockquote', (node: Blockquote) => {
      const firstChild = node.children[0];
      if (!firstChild || firstChild.type !== 'paragraph') return;
      const paragraph = firstChild as Paragraph;
      const firstText = paragraph.children[0];
      if (!firstText || firstText.type !== 'text') return;

      const marker = matchAlertMarker((firstText as Text).value);
      if (!marker) return;

      const alertType = marker.type;
      const rest = marker.rest;
      if (rest) {
        (firstText as Text).value = rest;
      } else {
        paragraph.children.shift();
        if (paragraph.children.length === 0) node.children.shift();
      }

      const lower = alertType.toLowerCase();
      node.data = {
        ...node.data,
        hName: 'div',
        hProperties: {
          className: ['md-alert', `md-alert-${lower}`],
          dataAlert: lower,
          dataAlertLabel: t(`alerts.${lower}`),
        },
      };
    });
  };
}
