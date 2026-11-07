/**
 * TODO highlight — reading mode.
 *
 * Wraps every qualifying TODO in the rendered text as
 * `<span class="folio-todo" data-todo-index="N">`. N is the match's ordinal in
 * document order, and markdown/todos.ts's extractTodos() counts the SAME
 * matches in the SAME order (see its doc comment), so the panel can scroll to
 * `[data-todo-index="N"]`. Like noteIds.ts this needs a cursor, because
 * pipeline.ts renders one page in several independent segments.
 *
 * Never matched in code, strikethrough (a struck-out TODO is done) or a bare
 * URL. Without a cursor (a page embedded in another) the words are still
 * highlighted, just not numbered.
 */
import type { Element, ElementContent, Root } from 'hast';
import { findTodoOffsets, isBareAddressText, TODO_LENGTH } from '@shared/todo';

export interface TodoCursor {
  index: number;
}

export function createTodoCursor(): TodoCursor {
  return { index: 0 };
}

const SKIP_TAGS = new Set(['code', 'pre', 'del', 'script', 'style']);

function isBareAddressLink(node: Element): boolean {
  if (node.tagName !== 'a' || node.children.length !== 1) return false;
  const only = node.children[0];
  return only.type === 'text' && isBareAddressText(only.value);
}

function splitText(value: string, cursor: TodoCursor | undefined): ElementContent[] | null {
  const offsets = findTodoOffsets(value);
  if (offsets.length === 0) return null;
  const parts: ElementContent[] = [];
  let at = 0;
  for (const offset of offsets) {
    if (offset > at) parts.push({ type: 'text', value: value.slice(at, offset) });
    const properties: Element['properties'] = { className: ['folio-todo'] };
    if (cursor) {
      properties.dataTodoIndex = String(cursor.index);
      cursor.index += 1;
    }
    parts.push({
      type: 'element',
      tagName: 'span',
      properties,
      children: [{ type: 'text', value: value.slice(offset, offset + TODO_LENGTH) }],
    });
    at = offset + TODO_LENGTH;
  }
  if (at < value.length) parts.push({ type: 'text', value: value.slice(at) });
  return parts;
}

function walk(children: ElementContent[], cursor: TodoCursor | undefined): void {
  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    if (node.type === 'text') {
      const parts = splitText(node.value, cursor);
      if (parts) {
        children.splice(i, 1, ...parts);
        i += parts.length - 1;
      }
      continue;
    }
    if (node.type !== 'element') continue;
    if (SKIP_TAGS.has(node.tagName) || isBareAddressLink(node)) continue;
    walk(node.children, cursor);
  }
}

export function rehypeTodoMarks(cursor: TodoCursor | undefined) {
  return (tree: Root) => {
    walk(tree.children as ElementContent[], cursor);
  };
}
