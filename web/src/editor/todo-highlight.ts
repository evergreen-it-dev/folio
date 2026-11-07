/**
 * TODO highlight — a mark over the word `TODO`, in live and source mode alike.
 *
 * The text is never folded or replaced, only marked, so the markdown reads the
 * same either way. What counts as a TODO is shared/todo.ts (also used by the
 * reading view and the page panel); where it may not be drawn — code, links'
 * destinations, raw HTML, and struck-out text (a `~~TODO x~~` is done) — is
 * decided here from the syntax tree. The scan is kept free of the view layer
 * so it can be unit-tested in plain node, like mentions.ts.
 */
import { syntaxTree } from '@codemirror/language';
import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import type { Tree } from '@lezer/common';
import { findTodoOffsets, isBareAddressText, TODO_LENGTH } from '@shared/todo';
import type { DocText, Span } from './live-decorations';
import { CODE_NODES } from './mentions';

const SKIP_NODES = new Set([...CODE_NODES, 'Strikethrough']);

export interface TodoScan {
  doc: DocText;
  tree: Tree;
  /** Ranges to scan — the viewport, in the running editor. */
  ranges: readonly Span[];
}

function skippedRanges(tree: Tree, from: number, to: number): Span[] {
  const spans: Span[] = [];
  tree.iterate({
    from,
    to,
    enter: (node) => {
      if (!SKIP_NODES.has(node.name)) return true;
      spans.push({ from: node.from, to: node.to });
      return false;
    },
  });
  return spans;
}

/** A TODO inside a bare URL or e-mail address written in the text (the `URL` node only covers `<...>` and links' destinations). */
function insideBareAddress(text: string, offset: number): boolean {
  let start = offset;
  while (start > 0 && !/\s/.test(text[start - 1])) start -= 1;
  let end = offset + TODO_LENGTH;
  while (end < text.length && !/\s/.test(text[end])) end += 1;
  return isBareAddressText(text.slice(start, end));
}

/** Every TODO in the scanned ranges outside code, strikethrough and bare URLs. Line by line, so a range boundary can't split one. */
export function computeTodoRanges({ doc, tree, ranges }: TodoScan): Span[] {
  const found: Span[] = [];
  const seen = new Set<number>();

  for (const range of ranges) {
    const skip = skippedRanges(tree, range.from, range.to);
    const first = doc.lineAt(range.from).number;
    const last = doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) {
      const line = doc.line(n);
      for (const offset of findTodoOffsets(line.text)) {
        const from = line.from + offset;
        const to = from + TODO_LENGTH;
        if (seen.has(from)) continue;
        if (skip.some((span) => span.from < to && span.to > from)) continue;
        if (insideBareAddress(line.text, offset)) continue;
        seen.add(from);
        found.push({ from, to });
      }
    }
  }

  return found;
}

const todoMark = Decoration.mark({ class: 'folio-todo' });

function buildDecorations(view: EditorView): DecorationSet {
  const ranges = computeTodoRanges({
    doc: view.state.doc,
    tree: syntaxTree(view.state),
    ranges: view.visibleRanges,
  });
  return Decoration.set(ranges.map((range) => todoMark.range(range.from, range.to)), true);
}

/** Duration of the "this is the one you clicked" flash (the CSS animation in markdown/todoFlash.css lasts as long). */
export const TODO_FLASH_MS = 1600;

const setFlash = StateEffect.define<number | null>();
const flashWord = Decoration.mark({ class: 'folio-todo-flash' });
const flashLine = Decoration.line({ class: 'folio-todo-flash-line' });

/** The briefly flashed TODO: its word and its line, only while a click on the panel's row asked for it. */
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(setFlash)) continue;
      if (effect.value === null) return Decoration.none;
      const pos = Math.min(effect.value, tr.state.doc.length);
      const line = tr.state.doc.lineAt(pos);
      const to = Math.min(pos + TODO_LENGTH, line.to);
      return Decoration.set([flashLine.range(line.from), ...(to > pos ? [flashWord.range(pos, to)] : [])], true);
    }
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Flash the TODO at this offset (the panel's row click) and clear it after TODO_FLASH_MS. Needs `todoHighlight()` installed. */
export function flashTodoAt(view: EditorView, pos: number): void {
  if (pos < 0 || pos > view.state.doc.length) return;
  view.dispatch({ effects: setFlash.of(pos) });
  setTimeout(() => {
    try {
      view.dispatch({ effects: setFlash.of(null) });
    } catch {
      /* the view was destroyed meanwhile */
    }
  }, TODO_FLASH_MS);
}

export function todoHighlight(): Extension {
  return [flashField, ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view);
      }

      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          syntaxTree(update.state) !== syntaxTree(update.startState)
        ) {
          this.decorations = buildDecorations(update.view);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  )];
}
