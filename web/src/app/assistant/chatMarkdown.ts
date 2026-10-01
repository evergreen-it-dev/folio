import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import { visit } from 'unist-util-visit';
import type { Root, Element } from 'hast';

/**
 * Rehype plugin: external links open in a new tab. Deliberately not reusing
 * web/src/markdown/relativeLinks.ts — this panel has no stable
 * space/pagePath to resolve relative links against (a chat message isn't a
 * wiki page), and every link an assistant reply could plausibly produce is
 * an absolute http(s) URL anyway. Every `<a>` remark-rehype/remark-gfm can
 * produce here has an `href`, but we don't depend on that.
 */
function rehypeChatLinkTargets() {
  return (tree: Root) => {
    visit(tree, 'element', (node: Element) => {
      // In-app links (/s/<space>/p/<id>) navigate in the same tab; only external URLs open a new one.
      if (node.tagName === 'a' && typeof node.properties?.href === 'string' && /^https?:\/\//i.test(node.properties.href)) {
        node.properties.target = '_blank';
        node.properties.rel = ['noopener'];
      }
    });
  };
}

/**
 * Renders one assistant chat message's markdown to sanitized HTML, for
 * `dangerouslySetInnerHTML` in AssistantPanel. Deliberately NOT
 * web/src/markdown's `<Markdown>`/renderMarkdownToHtml — those pull in
 * mention-index lookups and page-relative link resolution this panel has no
 * stable space/pagePath to support (see AssistantPanel's own note). This is
 * the minimal slice of that same pipeline: remark-parse -> remark-gfm ->
 * remark-rehype -> rehype-sanitize (default GitHub-style schema, unmodified
 * — chat replies never need this renderer's extra tags/attributes) ->
 * rehypeChatLinkTargets (new-tab external links) -> rehype-stringify.
 *
 * Synchronous (`.processSync`) — called from a `useMemo` keyed on the
 * message text, including during streaming when that text changes on every
 * delta; unified's synchronous pipeline over a short chat message is cheap
 * enough for that. AssistantPanel only invokes this for assistant messages;
 * user messages render as plain text.
 */
export function renderChatMarkdown(markdown: string): string {
  const file = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeSanitize, defaultSchema)
    .use(rehypeChatLinkTargets)
    .use(rehypeStringify)
    .processSync(markdown);
  return String(file);
}
