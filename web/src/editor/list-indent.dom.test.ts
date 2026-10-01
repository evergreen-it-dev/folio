// @vitest-environment jsdom
/**
 * Tab / Shift+Tab nesting a real EditorView, the way format-toolbar.dom.test.ts
 * drives formatCommand — a stub view (as slash-menu.test.ts uses) can't stand
 * in here because the whole point is that Tab has NO effect outside a list
 * line, which only a dispatched keydown proves.
 */
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { livePreview, livePreviewConfig } from './live-preview';
import { markdownEditorExtensions } from './markdown-setup';

const views: EditorView[] = [];

function mount(doc: string, from: number, to = from): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        markdownEditorExtensions(),
        livePreview,
        livePreviewConfig(true, { space: 'eng', pagePath: 'a.md', pageId: 'P1' }),
      ],
      selection: EditorSelection.single(from, to),
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

/** A real keydown, so it goes through CodeMirror's own keymap resolution
 *  exactly as a Mod-Shift-k press does in format-toolbar.dom.test.ts. */
function pressTab(view: EditorView, shift = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Tab',
    code: 'Tab',
    keyCode: 9,
    shiftKey: shift,
    bubbles: true,
    cancelable: true,
  });
  view.contentDOM.dispatchEvent(event);
  return event;
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

describe('Tab in a list', () => {
  it('nests a bullet under its parent, two spaces to line up with the parent\'s text', () => {
    const doc = '- Parent\n- Child';
    const view = mount(doc, doc.indexOf('Child'));
    const event = pressTab(view);
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe('- Parent\n  - Child');
  });

  it('un-nests back with Shift+Tab', () => {
    const doc = '- Parent\n  - Child';
    const view = mount(doc, doc.indexOf('Child'));
    pressTab(view, true);
    expect(view.state.doc.toString()).toBe('- Parent\n- Child');
  });

  it('nests every line a selection touches by the same amount, and keeps the selection', () => {
    const doc = '- Parent\n- A\n- B';
    const from = doc.indexOf('A');
    const to = doc.indexOf('B') + 1;
    const view = mount(doc, from, to);
    pressTab(view);
    expect(view.state.doc.toString()).toBe('- Parent\n  - A\n  - B');
    // Selection stays over the same two lines' content, shifted by the indent.
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('A\n  - B');
  });

  it('never dedents past column 0', () => {
    const doc = '- top level';
    const view = mount(doc, 2);
    pressTab(view, true);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it('does NOT consume Tab on a plain paragraph line', () => {
    const doc = 'hello world';
    const view = mount(doc, 0);
    const event = pressTab(view);
    expect(event.defaultPrevented).toBe(false);
    expect(view.state.doc.toString()).toBe(doc);
  });
});
