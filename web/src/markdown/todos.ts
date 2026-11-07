import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { remarkUnderline } from '@shared/underline';
import { phrasingToPlainText } from '@shared/inlineText';
import { findTodoOffsets, isBareAddressText } from '@shared/todo';
import type { Heading, Paragraph, PhrasingContent, Root, RootContent, TableCell } from 'mdast';
import { stripFrontmatter } from './frontmatter';
import { findMentionTokens } from './mentions';

export interface TodoEntry {
  /** Plain text of the source line holding the TODO, its markup resolved. */
  text: string;
  /** Every `@handle` on that line, lower-cased and de-duplicated, in order of appearance. */
  assignees: string[];
  /** Offset of the line's first TODO in the *original* markdown (frontmatter included). */
  pos: number;
  /** Ordinal of that TODO among ALL qualifying matches on the page: the `data-todo-index` of its span in reading mode. */
  index: number;
}

type Container = Paragraph | Heading | TableCell;
type Node = Root | RootContent | PhrasingContent;

const CONTAINERS = new Set(['paragraph', 'heading', 'tableCell']);

/** Tag-less text of a raw HTML block, so its words count in the numbering the way the rendered page shows them. */
function htmlText(value: string): string {
  return value.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, '');
}

/**
 * Every TODO line on a page, in document order — the mdast half of the page
 * panel's TODO list; todoMarks.ts's rehypeTodoMarks walks the SAME rendered
 * text and must find the SAME matches in the SAME order, so a click can
 * scroll to the right one in reading mode.
 *
 * One entry per source LINE with a qualifying match (adjacent lines are one
 * paragraph in markdown, but a TODO is a line-level note). A match is not
 * qualifying inside inline code, strikethrough (`~~TODO x~~` is done) or a
 * bare URL; fenced/indented code is not text at all. An item in a checked task
 * list item is done: it has no entry but still takes its numbers.
 *
 * Raw HTML blocks are not entries but their visible words are counted: the
 * rendered page cannot tell them from markdown text, so the numbering must
 * not skip them.
 */
export function extractTodos(markdown: string): TodoEntry[] {
  const body = stripFrontmatter(markdown);
  const shift = markdown.length - body.length;
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkUnderline).parse(body) as Root;
  const out: TodoEntry[] = [];
  let counter = 0;

  function readContainer(container: Container, done: boolean, rowHandles: readonly string[] = []): void {
    interface Found {
      lineIndex: number;
      pos: number;
      index: number;
    }
    const found: Found[] = [];
    const handles = new Map<number, string[]>();

    const visitInline = (node: PhrasingContent): void => {
      if (node.type === 'inlineCode' || node.type === 'delete') return;
      if (node.type === 'link' && node.children.length === 1) {
        const only = node.children[0];
        if (only.type === 'text' && isBareAddressText(only.value)) return;
      }
      if (node.type === 'text') {
        readText(node);
        return;
      }
      if ('children' in node) (node.children as PhrasingContent[]).forEach(visitInline);
    };

    const readText = (node: { value: string; position?: { start: { offset?: number; line: number }; end: { offset?: number } } }): void => {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      const source = body.slice(start, end);
      const offsets = findTodoOffsets(node.value);
      // The text value is not always the source (`&amp;`, escapes): locate the matches in the source itself when it can be done unambiguously.
      const inSource = source === node.value ? offsets : findTodoOffsets(source);
      const exact = inSource.length === offsets.length;
      const startLine = (node.position?.start.line ?? 1) - (container.position?.start.line ?? 1);

      offsets.forEach((_offset, k) => {
        const inNode = exact ? inSource[k] : 0;
        const lineIndex = startLine + (source.slice(0, inNode).match(/\n/g)?.length ?? 0);
        found.push({ lineIndex, pos: start + inNode, index: counter });
        counter += 1;
      });

      let lineAt = startLine;
      for (const segment of node.value.split('\n')) {
        const tokens = findMentionTokens(segment).map((token) => token.handle);
        if (tokens.length > 0) handles.set(lineAt, [...(handles.get(lineAt) ?? []), ...tokens]);
        lineAt += 1;
      }
    };

    container.children.forEach((child) => visitInline(child as PhrasingContent));
    if (found.length === 0 || done) return;

    const lines = phrasingToPlainText(container.children as PhrasingContent[], { breakText: '\n', collapse: false }).split('\n');
    const seen = new Set<number>();
    for (const match of found) {
      if (seen.has(match.lineIndex)) continue;
      seen.add(match.lineIndex);
      const rawLine = body.split('\n')[(container.position?.start.line ?? 1) - 1 + match.lineIndex] ?? '';
      const text = (lines[match.lineIndex] ?? rawLine).trim();
      out.push({
        text,
        assignees: [...new Set([...(handles.get(match.lineIndex) ?? []), ...rowHandles])],
        pos: shift + match.pos,
        index: match.index,
      });
    }
  }

  function walk(node: Node, done: boolean): void {
    if (node.type === 'tableRow') {
      // A table row is one source line: an owner in the next column is this line's assignee too.
      const rowHandles = node.children.flatMap((cell) =>
        findMentionTokens(phrasingToPlainText(cell.children, { breakText: ' ', collapse: false })).map((token) => token.handle),
      );
      node.children.forEach((cell) => readContainer(cell, done, rowHandles));
      return;
    }
    if (CONTAINERS.has(node.type)) {
      readContainer(node as Container, done);
      return;
    }
    if (node.type === 'html') {
      counter += findTodoOffsets(htmlText(node.value)).length;
      return;
    }
    if (node.type === 'code') return;
    const childDone = done || (node.type === 'listItem' && node.checked === true);
    if ('children' in node) (node.children as Node[]).forEach((child) => walk(child, childDone));
  }

  walk(tree, false);
  return out;
}
