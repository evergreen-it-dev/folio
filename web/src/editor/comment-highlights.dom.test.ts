// @vitest-environment jsdom
/**
 * Comments inside a real editor: the highlight follows edits, the selection
 * bar offers Comment only where the bridge allows it, and the shortcut starts
 * a thread on the selection.
 */
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bridgeExtension, commentHighlights, commentsBridgeSlot, setCommentMarks, type CommentsBridge } from './comment-highlights';
import { formatting } from './format-toolbar';
import { markdownEditorExtensions } from './markdown-setup';

const views: EditorView[] = [];

function mount(doc: string, from = 0, to = 0, bridge: CommentsBridge | null = null): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [markdownEditorExtensions(), formatting, commentHighlights],
      selection: EditorSelection.single(from, to),
    }),
    parent: document.body,
  });
  views.push(view);
  view.dispatch({ effects: commentsBridgeSlot.reconfigure(bridgeExtension(bridge)) });
  return view;
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

const bridge = (canComment: boolean): CommentsBridge => ({ canComment, onStart: vi.fn(), onOpenThread: vi.fn() });
const commentButton = () => document.querySelector<HTMLButtonElement>('.cm-folio-format [aria-label="Comment"]');

describe('highlights', () => {
  it('marks the ranges, emphasises the active one and carries them through edits', () => {
    const view = mount('alpha beta gamma');
    view.dispatch({ effects: setCommentMarks.of({ marks: [{ id: 'a', from: 6, to: 10 }, { id: 'b', from: 11, to: 16 }], activeId: 'b' }) });
    const marked = () => Array.from(view.dom.querySelectorAll('.cm-comment')).map((el) => [el.getAttribute('data-comment'), el.textContent, el.classList.contains('cm-comment--active')]);
    expect(marked()).toEqual([['a', 'beta', false], ['b', 'gamma', true]]);
    view.dispatch({ changes: { from: 0, insert: '>> ' } });
    expect(marked().map((m) => m[1])).toEqual(['beta', 'gamma']);
    // Typing at the edge of a range stays outside it.
    view.dispatch({ changes: { from: 9, insert: 'X' } });
    view.dispatch({ changes: { from: 14, insert: 'Y' } });
    expect(marked().map((m) => m[1])).toEqual(['beta', 'gamma']);
  });

  it('opens the thread of a clicked highlight', () => {
    const b = bridge(true);
    const view = mount('alpha beta', 0, 0, b);
    view.dispatch({ effects: setCommentMarks.of({ marks: [{ id: 'a', from: 6, to: 10 }], activeId: null }) });
    const posAtCoords = vi.spyOn(view, 'posAtCoords').mockReturnValue(7);
    view.contentDOM.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 1, clientY: 1 }));
    expect(posAtCoords).toHaveBeenCalled();
    expect(b.onOpenThread).toHaveBeenCalledWith('a');
  });
});

describe('the Comment action', () => {
  it('is on the selection bar when the user may comment', () => {
    const b = bridge(true);
    const view = mount('hello world', 0, 5, b);
    const button = commentButton();
    expect(button).toBeTruthy();
    button!.click();
    expect(b.onStart).toHaveBeenCalledWith({ from: 0, to: 5 });
    expect(view.state.doc.toString()).toBe('hello world');
  });

  it('is not offered without the right, nor without a bridge', () => {
    mount('hello world', 0, 5, bridge(false));
    expect(commentButton()).toBeNull();
    views.splice(0).forEach((v) => v.destroy());
    document.body.replaceChildren();
    mount('hello world', 0, 5, null);
    expect(commentButton()).toBeNull();
  });

  it('starts from the shortcut by physical key, and ignores it with no selection', () => {
    const b = bridge(true);
    const view = mount('hello world', 6, 11, b);
    const press = () => {
      const event = new KeyboardEvent('keydown', { code: 'KeyM', key: 'µ', metaKey: true, altKey: true, bubbles: true, cancelable: true });
      view.contentDOM.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(press()).toBe(true);
    expect(b.onStart).toHaveBeenCalledWith({ from: 6, to: 11 });
    view.dispatch({ selection: EditorSelection.single(3) });
    expect(press()).toBe(false);
    expect(b.onStart).toHaveBeenCalledTimes(1);
  });
});
