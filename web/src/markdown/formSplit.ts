import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkDirective from 'remark-directive';
import { visit } from 'unist-util-visit';
import type { Root } from 'mdast';
import type { MarkdownSegment, TextSegment } from './mermaidSplit';
import type { MarkdownSegmentWithPagetree } from './pagetreeSplit';

/**
 * Round FORMS — `::form{id=<page-id>}`: embeds a form's fields inline in any
 * other page, mirroring `::pagetree{depth=N}` exactly (pagetreeSplit.ts) —
 * same reason: it needs a real, data-fetching React island (<FormEmbed>,
 * fetches GET /api/pages/:id), not something the sanitized-HTML pipeline
 * can render on its own.
 */
export interface FormEmbedSegment {
  type: 'form-embed';
  pageId: string;
}

/**
 * Chained AFTER splitPagetreeDirectives in index.tsx (splitFormDirectives(
 * splitPagetreeDirectives(splitMermaidFences(markdown)))), so the input here
 * is already `MarkdownSegmentWithPagetree[]`, not the bare `MarkdownSegment[]`
 * mermaidSplit produces — a 'pagetree' segment rides through this pass
 * untouched via the same "non-text segment, push and continue" branch below
 * a 'mermaid' one already does.
 */
export type MarkdownSegmentWithFormEmbed = MarkdownSegmentWithPagetree | FormEmbedSegment;

interface DirectiveSpan {
  start: number;
  end: number;
  pageId: string;
}

// mdast-util-directive's node shape isn't in @types/mdast — same local
// narrowing pagetreeSplit.ts uses, not worth its own types package.
interface DirectiveNode {
  type: string;
  name?: string;
  attributes?: Record<string, string | null | undefined> | null;
  position?: { start: { offset?: number }; end: { offset?: number } };
}

function findFormDirectives(text: string): DirectiveSpan[] {
  const tree = unified().use(remarkParse).use(remarkDirective).parse(text) as Root;
  const spans: DirectiveSpan[] = [];
  visit(tree, (node) => {
    if (node.type !== 'leafDirective' && node.type !== 'containerDirective' && node.type !== 'textDirective') return;
    const directive = node as unknown as DirectiveNode;
    if (directive.name !== 'form') return;
    const start = directive.position?.start.offset;
    const end = directive.position?.end.offset;
    const pageId = directive.attributes?.id;
    // No `id` at all: not a usable embed — leave it for directiveFallback.ts's
    // "undeclared/malformed directive" degrade instead of rendering a widget
    // that can never fetch anything.
    if (start === undefined || end === undefined || !pageId) return;
    spans.push({ start, end, pageId });
  });
  return spans.sort((a, b) => a.start - b.start);
}

/** Further splits any 'text' segment on top-level `::form{id=...}` directives — same shape as splitPagetreeDirectives, see that function's own doc comment for why remark-directive (not a regex) is what finds them. */
export function splitFormDirectives(segments: MarkdownSegmentWithPagetree[]): MarkdownSegmentWithFormEmbed[] {
  const result: MarkdownSegmentWithFormEmbed[] = [];
  for (const segment of segments) {
    if (segment.type !== 'text') {
      result.push(segment);
      continue;
    }
    const spans = findFormDirectives(segment.value);
    if (spans.length === 0) {
      result.push(segment);
      continue;
    }
    let cursor = 0;
    for (const span of spans) {
      const before = segment.value.slice(cursor, span.start);
      if (before.trim() !== '') result.push({ type: 'text', value: before } satisfies TextSegment);
      result.push({ type: 'form-embed', pageId: span.pageId });
      cursor = span.end;
    }
    const rest = segment.value.slice(cursor);
    if (rest.trim() !== '') result.push({ type: 'text', value: rest } satisfies TextSegment);
  }
  return result;
}
