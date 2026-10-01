/**
 * `==highlight==` and `==highlight=={.green}` for the editor's markdown parser.
 *
 * `@lezer/markdown` knows GFM only; this is the same shape as its own
 * `Strikethrough` extension (a delimiter pair resolved into one node with two
 * `HighlightMark` children), plus one extra inline element: the optional
 * `{.token}` colour attribute that may follow a closing `==`, parsed as a
 * `HighlightAttr` SIBLING right after the `Highlight` node (a delimiter pair
 * cannot swallow trailing text, so the attribute cannot live inside it —
 * consumers pair the two by adjacency, see live-decorations.ts / link-guard.ts).
 *
 * The syntax choice itself is format.ts's story (the owner, 24.09.2026).
 */
import type { MarkdownConfig } from '@lezer/markdown';
import { tags } from '@lezer/highlight';

const HighlightDelim = { resolve: 'Highlight', mark: 'HighlightMark' };
const Punctuation = /[!-/:-@[-`{-~¡§«¶·»¿‐-‧‰-⁞⸀-⹿]/;
const ATTR = /^\{\.[a-z]+\}/;

export const FolioHighlight: MarkdownConfig = {
  defineNodes: [
    { name: 'Highlight', style: { 'Highlight/...': tags.special(tags.content) } },
    { name: 'HighlightMark', style: tags.processingInstruction },
    { name: 'HighlightAttr', style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: 'Highlight',
      parse(cx, next, pos) {
        if (next !== 61 /* '=' */ || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) return -1;
        if (pos > 0 && cx.char(pos - 1) === 61) return -1;
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 2, pos + 3);
        const sBefore = /\s|^$/.test(before);
        const sAfter = /\s|^$/.test(after);
        const pBefore = Punctuation.test(before);
        const pAfter = Punctuation.test(after);
        const canOpen = !sAfter && (!pAfter || sBefore || pBefore);
        // `{` right after a closer is the colour attribute, not text that
        // would stop the delimiter from closing.
        const canClose = !sBefore && (!pBefore || sAfter || pAfter || after === '{');
        return cx.addDelimiter(HighlightDelim, pos, pos + 2, canOpen, canClose);
      },
      after: 'Emphasis',
    },
    {
      name: 'HighlightAttr',
      parse(cx, next, pos) {
        if (next !== 123 /* '{' */ || cx.slice(pos - 2, pos) !== '==') return -1;
        const match = ATTR.exec(cx.slice(pos, pos + 16));
        if (!match) return -1;
        return cx.addElement(cx.elt('HighlightAttr', pos, pos + match[0].length));
      },
      before: 'Escape',
    },
  ],
};
