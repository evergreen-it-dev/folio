import { visit } from 'unist-util-visit';
import type { Root, Element, Text } from 'hast';
import { splitPipeRow, isDelimiterRow } from './tableSyntax';

/**
 * Rehype plugin: flags a pipe table that GFM refused to render as a table
 * because it directly follows other paragraph content with no blank line in
 * between.
 *
 * Per the GFM Tables extension, a table row cannot interrupt a paragraph —
 * and per CommonMark's lazy-continuation rule, that means a line like
 * `| a | b |` right after prose (or right after a `> [!NOTE]` callout's own
 * text, which is exactly a blockquote's lazily-continued paragraph) is parsed
 * as MORE TEXT of that same paragraph, not a table. remark-gfm/remark-parse
 * already do this correctly (verified against this file's own test) — Live
 * edit's table widget is the one that disagrees (renders a table there
 * anyway); see the handoff note in pipeline.test.ts for the editor-side
 * report.
 *
 * Reading mode's default rendering of that swallowed text is still rough:
 * the pipe lines are literal text inside a <p>, so a soft line break collapses
 * to a single space and the whole "table" runs together into one unreadable
 * line. This plugin doesn't try to render a table (that would just be the
 * wrong verdict with extra steps) — it only makes the mis-typed table
 * VISIBLE as raw lines again, with a `folio-stray-table` marker paragraph
 * gets so markdown.css can set it apart (monospace, preformatted, dashed
 * border) instead of letting it blend into normal prose.
 *
 * Deliberately conservative: only touches a <p> whose children are ALL plain
 * text (no bold/link/etc — mixed inline content is rare here and not worth
 * the complexity of splicing around it), and only when it finds a real
 * header-row/delimiter-row pair (tableSyntax.ts's own parser, the same one
 * the editor's grid and rehypeTableExtensions use) inside that text — so
 * plain prose that merely happens to contain a `|` never matches.
 */
export function rehypeFlagStrayTables() {
  return (tree: Root) => {
    visit(tree, 'element', (node: Element) => {
      if (node.tagName !== 'p') return;
      // The text of the paragraph + <br> between lines: remark-breaks (17.09)
      // makes a soft break a real <br>, so the lines no longer lie in one text
      // node — this is exactly what the plugin tripped over after the merge.
      const isBreak = (child: Element['children'][number]): boolean => child.type === 'element' && child.tagName === 'br';
      if (node.children.length === 0 || !node.children.every((child) => child.type === 'text' || isBreak(child))) return;

      const lines: string[] = [''];
      const pushLine = () => lines.push('');
      for (const child of node.children) {
        if (child.type === 'text') {
          const parts = (child as Text).value.split('\n');
          lines[lines.length - 1] += parts[0];
          for (const part of parts.slice(1)) lines.push(part);
        } else if (lines[lines.length - 1] !== '') {
          // A <br> immediately followed by text with \n would give an extra empty line.
          pushLine();
        }
      }
      // Empty lines are an artifact of <br> + \n: for finding the
      // "header/delimiter" pair only meaningful lines matter, and an exact
      // reconstruction is not needed here (we rewrite nothing, only hang a
      // class on the paragraph).
      const meaningful = lines.map((line) => line.trim()).filter((line) => line !== '');
      if (!meaningful.some((line) => line.includes('|'))) return;

      const hasTablePair = meaningful.some((line, i) => {
        if (i === 0 || !meaningful[i - 1].includes('|')) return false;
        const headerCells = splitPipeRow(meaningful[i - 1]).cells;
        return headerCells.length > 0 && isDelimiterRow(splitPipeRow(line).cells);
      });
      if (!hasTablePair) return;

      // We mark the paragraph ITSELF without rewriting its children: so the
      // markup inside (links, <br>) stays as it is, and css shows the block monospaced.
      const existing = node.properties?.className;
      const classes = Array.isArray(existing) ? existing.map(String) : existing ? [String(existing)] : [];
      node.properties = { ...node.properties, className: [...classes, 'folio-stray-table'] };
    });
  };
}
