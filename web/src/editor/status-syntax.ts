/**
 * `:status[Selected]{color=green}` for the editor's markdown parser.
 *
 * `@lezer/markdown` knows GFM only, so — like `==highlight==` in
 * highlight-syntax.ts — the tag is a small inline extension: one leaf element,
 * `StatusTag`, covering the whole directive. Parsing at the `:` rather than
 * scanning lines afterwards means the parser's own rules decide where a tag
 * can be: inside inline code, a fenced block or after a backslash it is plain
 * text, exactly as remark-directive sees it in reading mode.
 *
 * The grammar itself (label escapes, `color=` attribute) lives in
 * shared/status.ts, the single place the reading pipeline, the exports and the
 * search index also read it from.
 */
import type { MarkdownConfig } from '@lezer/markdown';
import { parseStatusAt } from '@shared/status';

/** Longest tag the parser will look at; a label this long is not a status. */
const MAX_TAG = 200;

export const FolioStatus: MarkdownConfig = {
  defineNodes: [{ name: 'StatusTag' }],
  parseInline: [
    {
      name: 'StatusTag',
      parse(cx, next, pos) {
        if (next !== 58 /* ':' */ || cx.char(pos + 1) !== 115 /* 's' */) return -1;
        const parsed = parseStatusAt(cx.slice(pos, Math.min(cx.end, pos + MAX_TAG)));
        // An empty label is a directive remark would render as nothing; keep it text.
        if (!parsed || parsed.label === '') return -1;
        return cx.addElement(cx.elt('StatusTag', pos, pos + parsed.length));
      },
      // Before Link/Escape so nothing else claims the `[` that follows, and
      // before the GFM autolink so `:status[www.x.com]` is not split.
      before: 'Escape',
    },
  ],
};
