import { visit } from 'unist-util-visit';
import type { Root, Element } from 'hast';
import type { HeadingInfo } from './headings';

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/** Threaded through every segment's renderMarkdownToHtml call for one page, so ids stay correctly numbered even when mermaid fences split a page's headings across several independent pipeline runs (see pipeline.ts's docblock). */
export interface HeadingIdCursor {
  headings: HeadingInfo[];
  index: number;
}

export function createHeadingIdCursor(headings: HeadingInfo[]): HeadingIdCursor {
  return { headings, index: 0 };
}

/**
 * Assigns `id` to each rendered h1-h6, consuming the next entry of a
 * pre-computed heading list (extractHeadings) in document order rather than
 * re-deriving slugs itself — see headings.ts's docblock for why duplicating
 * that logic here would risk the ids drifting from what the outline panel
 * and backlinks-adjacent features compute from the raw markdown.
 */
export function rehypeAssignHeadingIds(cursor: HeadingIdCursor | undefined) {
  return (tree: Root) => {
    if (!cursor) return;
    visit(tree, 'element', (node: Element) => {
      if (!HEADING_TAGS.has(node.tagName)) return;
      const next = cursor.headings[cursor.index];
      cursor.index += 1;
      if (next) node.properties.id = next.slug;
    });
  };
}
