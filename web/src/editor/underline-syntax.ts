/**
 * `++underline++` for the editor's markdown parser.
 *
 * The same shape as `@lezer/markdown`'s own `Strikethrough` (and as
 * highlight-syntax.ts): a delimiter pair resolved into one `Underline` node
 * with two `UnderlineMark` children, using the GFM flanking rules — which is
 * what lets it nest with `**`, `*`, `~~` and `==` in any order and keeps it
 * from ever crossing them (the reason the `<ins>` tag pair was dropped, see
 * format.ts). Exactly two plus signs: `C++`, `a + b` and `+++` are text.
 *
 * Reading and the exports have their own copy of the rule, a micromark
 * extension in `shared/underline.ts`; keep the two in step.
 */
import type { MarkdownConfig } from '@lezer/markdown';
import { tags } from '@lezer/highlight';

const UnderlineDelim = { resolve: 'Underline', mark: 'UnderlineMark' };
const Punctuation = /[!-/:-@[-`{-~¡§«¶·»¿‐-‧‰-⁞⸀-⹿]/;

export const FolioUnderline: MarkdownConfig = {
  defineNodes: [
    { name: 'Underline', style: { 'Underline/...': tags.special(tags.content) } },
    { name: 'UnderlineMark', style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: 'Underline',
      parse(cx, next, pos) {
        if (next !== 43 /* '+' */ || cx.char(pos + 1) !== 43 || cx.char(pos + 2) === 43) return -1;
        if (pos > 0 && cx.char(pos - 1) === 43) return -1;
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 2, pos + 3);
        const sBefore = /\s|^$/.test(before);
        const sAfter = /\s|^$/.test(after);
        const pBefore = Punctuation.test(before);
        const pAfter = Punctuation.test(after);
        const canOpen = !sAfter && (!pAfter || sBefore || pBefore);
        const canClose = !sBefore && (!pBefore || sAfter || pAfter);
        return cx.addDelimiter(UnderlineDelim, pos, pos + 2, canOpen, canClose);
      },
      after: 'Emphasis',
    },
  ],
};
