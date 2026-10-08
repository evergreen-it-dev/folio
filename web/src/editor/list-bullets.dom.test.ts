// @vitest-environment jsdom
/**
 * Live-mode lists in a real EditorView: the bullet widget stands in for the
 * marker (document text untouched), the caret treats it as one unit, and the
 * list keymaps keep working on the text underneath.
 */
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { livePreview, livePreviewConfig } from './live-preview';
import { markdownEditorExtensions } from './markdown-setup';

const views: EditorView[] = [];

function mount(doc: string, pos = 0, live = true): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        markdownEditorExtensions(),
        livePreview,
        livePreviewConfig(live, { space: 'eng', pagePath: 'a.md', pageId: 'P1' }),
      ],
      selection: EditorSelection.single(pos),
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

const glyphs = (view: EditorView) =>
  [...view.contentDOM.querySelectorAll('.cm-md-bullet')].map((el) => el.textContent);

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

describe('bullet widget', () => {
  it('draws disc, circle, square, then starts over — and leaves the markdown alone', () => {
    const doc = '- a\n  - b\n    - c\n      - d\n';
    const view = mount(doc);
    expect(glyphs(view)).toEqual(['\u2022', '\u25E6', '\u25AA', '\u2022']);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it('puts the depth on the line, from the syntax tree', () => {
    const view = mount('- a\n  - b\n');
    const lines = [...view.contentDOM.querySelectorAll('.cm-line')] as HTMLElement[];
    expect(lines[0].classList.contains('cm-md-li')).toBe(true);
    expect(lines[0].style.getPropertyValue('--cm-li-depth')).toBe('1');
    expect(lines[1].style.getPropertyValue('--cm-li-depth')).toBe('2');
  });

  it('shows source mode as plain text: no widget, no list line classes', () => {
    const view = mount('- a\n  - b\n', 0, false);
    expect(glyphs(view)).toEqual([]);
    expect(view.contentDOM.querySelector('.cm-md-li')).toBeNull();
  });

  it('moves the caret over the marker as one unit', () => {
    const view = mount('- item\n', 0);
    view.focus();
    // Arrow-right from line start must not stop between `-` and the space.
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    const head = view.state.selection.main.head;
    expect([0, 2]).toContain(head);
  });

  it('keeps Tab / Shift+Tab nesting the item, text-wise', () => {
    const view = mount('- a\n- b\n', 7);
    const tab = (shiftKey: boolean) =>
      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', keyCode: 9, shiftKey, bubbles: true, cancelable: true }),
      );
    tab(false);
    expect(view.state.doc.toString()).toBe('- a\n  - b\n');
    expect(glyphs(view)).toEqual(['\u2022', '\u25E6']);
    tab(true);
    expect(view.state.doc.toString()).toBe('- a\n- b\n');
  });

  it('turns "- " typed on an empty line into a bullet', () => {
    const view = mount('para\n\n', 6);
    view.dispatch({ changes: { from: 6, insert: '- ' }, selection: { anchor: 8 } });
    expect(glyphs(view)).toEqual(['\u2022']);
  });
});
