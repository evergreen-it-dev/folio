import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { visit } from 'unist-util-visit';
import type { Root, Heading as MdHeading, Text, InlineCode } from 'mdast';
import { slugify } from './slugify';
import { stripFrontmatter } from './frontmatter';

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface HeadingInfo {
  level: HeadingLevel;
  text: string;
  slug: string;
}

/**
 * rehype-sanitize's default schema treats `id` as a DOM-clobbering risk and
 * unconditionally prefixes every one it sees with this string (a deliberate
 * security default folioSanitizeSchema doesn't override — see pipeline.ts).
 * `HeadingInfo.slug` stays the clean, semantic value everywhere it's used
 * for display/dedup/comparison; anything that needs to find the actual
 * rendered element (the outline panel's scrollIntoView/IntersectionObserver)
 * must look up `HEADING_ID_PREFIX + slug`, not the bare slug.
 */
export const HEADING_ID_PREFIX = 'user-content-';

/** A slug generator deduped against every slug it has already produced (GitHub convention: 1st occurrence bare, 2nd `-2`, 3rd `-3`, ...). */
export function createSlugDeduper() {
  const seen = new Map<string, number>();
  return (text: string): string => {
    const base = slugify(text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count + 1}`;
  };
}

/**
 * Parses `markdown` (just enough to find heading nodes — code fence
 * content, mermaid included, is never parsed as markdown text, so this
 * doesn't need the rendering pipeline's mermaid-fence pre-split) and
 * returns every heading in document order with a deduped slug.
 *
 * The rendering pipeline's rehypeAssignHeadingIds (pipeline.ts) consumes
 * this exact array, in order, via a shared cursor rather than recomputing
 * slugs itself — the outline panel calls this directly on the page's raw
 * markdown, and the two would silently drift apart (different heading ids
 * than what the TOC links to) if each ran its own independent dedupe.
 *
 * Strips a leading frontmatter block first (see frontmatter.ts) — otherwise
 * a `key: value` line immediately above the closing `---` parses as a
 * setext h2 underline, and a fake "icon: ..." heading would show up in the
 * outline panel for any page with an icon/cover set.
 */
export function extractHeadings(rawMarkdown: string): HeadingInfo[] {
  const markdown = stripFrontmatter(rawMarkdown);
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as Root;
  const dedupe = createSlugDeduper();
  const headings: HeadingInfo[] = [];

  visit(tree, 'heading', (node: MdHeading) => {
    const text = headingText(node);
    headings.push({ level: node.depth as HeadingLevel, text, slug: dedupe(text) });
  });

  return headings;
}

function headingText(node: MdHeading): string {
  let text = '';
  visit(node, (child) => {
    if (child.type === 'text') text += (child as Text).value;
    else if (child.type === 'inlineCode') text += (child as InlineCode).value;
  });
  return text;
}
