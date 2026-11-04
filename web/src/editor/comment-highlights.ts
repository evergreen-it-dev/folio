/**
 * Inline comments in the CodeMirror surface (Source / Live edit): the highlight
 * of every open thread's range, the bridge to the comments panel, and the
 * "Comment" shortcut.
 *
 * What the editor knows about comments is deliberately small: a list of
 * ranges in EDITOR coordinates (comment-anchors.ts resolved them from the
 * Y.Text, outside the view) and which one is active. Between two resolutions the
 * ranges are carried along by CodeMirror's own change mapping, so a keystroke
 * never leaves a highlight behind for a frame. The panel is React and lives
 * outside the view, so the view reaches it through the `commentsBridge` facet:
 * the format toolbar offers the Comment button only when a bridge that may
 * comment is installed.
 */
import { Compartment, Facet, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';

export interface CommentsBridge {
  /** May this user start a thread — the button and the shortcut are offered only then. */
  canComment: boolean;
  /** The user asked to comment on [from, to). */
  onStart(range: { from: number; to: number }): void;
  /** A highlight was clicked. */
  onOpenThread(id: string): void;
}

export const commentsBridge = Facet.define<CommentsBridge, CommentsBridge | null>({ combine: (values) => values[0] ?? null });

/** Where the bridge is plugged in, so it can change without rebuilding the view. */
export const commentsBridgeSlot = new Compartment();

export interface CommentMark {
  id: string;
  from: number;
  to: number;
}

export const setCommentMarks = StateEffect.define<{ marks: readonly CommentMark[]; activeId: string | null }>();
const setFlash = StateEffect.define<string | null>();

interface CommentsValue {
  marks: readonly CommentMark[];
  activeId: string | null;
  flashId: string | null;
  decorations: DecorationSet;
}

function build(marks: readonly CommentMark[], activeId: string | null, flashId: string | null, length: number): DecorationSet {
  const ranges = [];
  for (const mark of marks) {
    const from = Math.max(0, mark.from);
    const to = Math.min(length, mark.to);
    if (to <= from) continue;
    const classes = ['cm-comment'];
    if (mark.id === activeId) classes.push('cm-comment--active');
    if (mark.id === flashId) classes.push('cm-comment--flash');
    ranges.push(Decoration.mark({ class: classes.join(' '), attributes: { 'data-comment': mark.id } }).range(from, to));
  }
  return Decoration.set(ranges, true);
}

const commentsField = StateField.define<CommentsValue>({
  create: () => ({ marks: [], activeId: null, flashId: null, decorations: Decoration.none }),
  update(value, tr) {
    let { marks, activeId, flashId } = value;
    let changed = false;
    if (tr.docChanged && marks.length > 0) {
      marks = marks
        .map((mark) => ({ id: mark.id, from: tr.changes.mapPos(mark.from, 1), to: tr.changes.mapPos(mark.to, -1) }))
        .filter((mark) => mark.to > mark.from);
      changed = true;
    }
    for (const effect of tr.effects) {
      if (effect.is(setCommentMarks)) {
        marks = effect.value.marks;
        activeId = effect.value.activeId;
        changed = true;
      } else if (effect.is(setFlash)) {
        flashId = effect.value;
        changed = true;
      }
    }
    return changed ? { marks, activeId, flashId, decorations: build(marks, activeId, flashId, tr.state.doc.length) } : value;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

/** Scroll to a thread's highlight and flash it for a moment. False when the thread has no range here. */
export function scrollToComment(view: EditorView, id: string): boolean {
  const mark = view.state.field(commentsField).marks.find((m) => m.id === id);
  if (!mark) return false;
  view.dispatch({ effects: [EditorView.scrollIntoView(mark.from, { y: 'center' }), setFlash.of(id)] });
  window.setTimeout(() => {
    if (view.dom.isConnected) view.dispatch({ effects: setFlash.of(null) });
  }, 1400);
  return true;
}

/** Start a thread on the current selection. False when there is none or commenting is not on. */
export function commentOnSelection(view: EditorView): boolean {
  const bridge = view.state.facet(commentsBridge);
  const { from, to, empty } = view.state.selection.main;
  if (!bridge?.canComment || empty) return false;
  bridge.onStart({ from, to });
  return true;
}

/** ⌘⌥M / Ctrl+Alt+M, read from the physical key: Alt+M types «µ» on a Mac and is dead under AltGr layouts. */
export function isCommentShortcut(event: KeyboardEvent): boolean {
  return event.code === 'KeyM' && (event.metaKey || event.ctrlKey) && event.altKey && !event.shiftKey;
}

const handlers = EditorView.domEventHandlers({
  keydown(event, view) {
    if (!isCommentShortcut(event) || !commentOnSelection(view)) return false;
    event.preventDefault();
    return true;
  },
  click(event, view) {
    const bridge = view.state.facet(commentsBridge);
    if (!bridge || !view.state.selection.main.empty) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return false;
    // The innermost range when several overlap.
    const hit = view.state
      .field(commentsField)
      .marks.filter((mark) => mark.from <= pos && pos <= mark.to)
      .sort((a, b) => a.to - a.from - (b.to - b.from))[0];
    if (hit) bridge.onOpenThread(hit.id);
    return false;
  },
});

export const commentHighlights: Extension = [commentsField, handlers, commentsBridgeSlot.of([])];

/** The bridge as an extension for the slot (null = comments off for this view). */
export function bridgeExtension(bridge: CommentsBridge | null): Extension {
  return bridge ? commentsBridge.of(bridge) : [];
}
