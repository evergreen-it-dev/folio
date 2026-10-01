import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkDirective from 'remark-directive';
import { visit } from 'unist-util-visit';
import type { Root } from 'mdast';
import type { MarkdownSegment, TextSegment } from './mermaidSplit';

/**
 * Round 13: `::pagetree{depth=N}` (leaf) or `:::pagetree{depth=N}\n:::`
 * (container) — a list of the CURRENT page's own child pages, down to
 * `depth` levels. Needs a real, data-fetching React island (<PageTree>,
 * fetches GET /api/pages/:id/subtree), the same reason ```mermaid fences are
 * pulled out before the string-based rehype pipeline runs in
 * splitMermaidFences — not something the sanitized-HTML pipeline can render
 * on its own.
 */
export interface PagetreeSegment {
  type: 'pagetree';
  depth: number;
}

export type MarkdownSegmentWithPagetree = MarkdownSegment | PagetreeSegment;

const DEFAULT_DEPTH = 2;
const MIN_DEPTH = 1;
const MAX_DEPTH = 5;

/** Parses/clamps the `depth` attribute — 1..5, default 2 (DEV-PLAN Round 13). */
export function parsePagetreeDepth(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw === '') return DEFAULT_DEPTH;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_DEPTH;
  return Math.min(MAX_DEPTH, Math.max(MIN_DEPTH, n));
}

interface DirectiveSpan {
  start: number;
  end: number;
  depth: number;
}

// mdast-util-directive's node shape isn't in @types/mdast (a third-party
// extension) — narrowed locally rather than pulling in its own types
// package just for this one field set.
interface DirectiveNode {
  type: string;
  name?: string;
  attributes?: Record<string, string | null | undefined> | null;
  position?: { start: { offset?: number }; end: { offset?: number } };
}

function findPagetreeDirectives(text: string): DirectiveSpan[] {
  const tree = unified().use(remarkParse).use(remarkDirective).parse(text) as Root;
  const spans: DirectiveSpan[] = [];
  visit(tree, (node) => {
    if (node.type !== 'leafDirective' && node.type !== 'containerDirective' && node.type !== 'textDirective') return;
    const directive = node as unknown as DirectiveNode;
    if (directive.name !== 'pagetree') return;
    const start = directive.position?.start.offset;
    const end = directive.position?.end.offset;
    if (start === undefined || end === undefined) return;
    spans.push({ start, end, depth: parsePagetreeDepth(directive.attributes?.depth) });
  });
  return spans.sort((a, b) => a.start - b.start);
}

/**
 * Further splits any 'text' segment (the output of splitMermaidFences) on
 * top-level ::pagetree{depth=N} directives. Uses remark-directive itself to
 * find them — respects real markdown structure (won't match text that only
 * looks like a directive inside a code fence or inline code span), unlike a
 * regex would. pipeline.ts's own remark-directive pass (which runs on
 * whatever's LEFT in each resulting text segment) still provides the
 * sanitized-HTML fallback for any occurrence a non-Folio renderer sees, and
 * for a directive somehow missed here (defense in depth, not the primary path).
 */
export function splitPagetreeDirectives(segments: MarkdownSegment[]): MarkdownSegmentWithPagetree[] {
  const result: MarkdownSegmentWithPagetree[] = [];
  for (const segment of segments) {
    if (segment.type !== 'text') {
      result.push(segment);
      continue;
    }
    const spans = findPagetreeDirectives(segment.value);
    if (spans.length === 0) {
      result.push(segment);
      continue;
    }
    let cursor = 0;
    for (const span of spans) {
      const before = segment.value.slice(cursor, span.start);
      if (before.trim() !== '') result.push({ type: 'text', value: before } satisfies TextSegment);
      result.push({ type: 'pagetree', depth: span.depth });
      cursor = span.end;
    }
    const rest = segment.value.slice(cursor);
    if (rest.trim() !== '') result.push({ type: 'text', value: rest } satisfies TextSegment);
  }
  return result;
}
