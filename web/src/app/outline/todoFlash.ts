/**
 * After the panel's TODO row scrolled the page, flash the target so the owner sees which item it was:
 * the CodeMirror editor flashes through a decoration (editor/todo-highlight.ts flashTodoAt); the reading
 * view gets a class on the `[data-todo-index]` mark and on its line / list item, removed after FLASH_MS.
 */
import '../../markdown/todoFlash.css';
import { flashTodoAt } from '../../editor/todo-highlight';
import { mountedEditorView } from '../../editor/scroll-to-heading';

const FLASH_MS = 1600;
const LINE_SELECTOR = 'li, p, h1, h2, h3, h4, h5, h6, td, th, blockquote';

function pulse(el: Element, cls: string): void {
  el.classList.remove(cls);
  void (el as HTMLElement).offsetWidth; // restart the animation on a repeated click
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), FLASH_MS);
}

/** Reading view: flash the numbered TODO mark (and its line). False when there is no such mark. */
export function flashReadingTodo(index: number): boolean {
  const mark = document.querySelector(`[data-todo-index="${index}"]`);
  if (!mark) return false;
  pulse(mark, 'folio-todo-flash');
  const line = mark.closest(LINE_SELECTOR);
  if (line) pulse(line, 'folio-todo-flash-line');
  return true;
}

/** Editor surface: flash the TODO at this offset (after scrollActiveEditorToOffset succeeded). */
export function flashEditorTodo(pos: number): void {
  const view = mountedEditorView();
  if (view) flashTodoAt(view, pos);
}

/** Reading view: the same brief flash for a note (callout / checklist item) the panel's row scrolled to. */
export function flashReadingNote(index: number): boolean {
  const mark = document.querySelector(`[data-note-index="${index}"]`);
  if (!mark) return false;
  const line = mark.closest(LINE_SELECTOR) ?? mark;
  pulse(line, 'folio-todo-flash-line');
  return true;
}
