// @vitest-environment jsdom
/**
 * link-guard.ts generalised beyond links: `**strong**`, `*em*`, `~~strike~~`,
 * `` `code` ``, `<ins>`/`<mark>` all fold their markers the same way a link
 * does, so a Backspace/Delete/Enter at the folded boundary has the same trap
 * — and the owner's screenshot (a Backspace that ate only the opening `**`,
 * stranding the closing one) is specifically about `**bold**`, not a link.
 * Same harness as link-guard.dom.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { livePreview, livePreviewConfig } from './live-preview';
import { markdownEditorExtensions } from './markdown-setup';

const views: EditorView[] = [];

function mount(doc: string, pos: number): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        markdownEditorExtensions(),
        livePreview,
        livePreviewConfig(true, { space: 'eng', pagePath: 'a.md', pageId: 'P1' }),
      ],
      selection: EditorSelection.single(pos),
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

function press(view: EditorView, key: string) {
  view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }));
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

// 24.09.2026: a Backspace at the folded edge eats ONE visible character on
// the far side of the marker (the owner: "the whole text was gone"), never half of
// the markup — and the pair goes only once nothing is left between it.
describe('Backspace right after a folded construct eats its last character, markup intact', () => {
  const cases: [string, string, string][] = [
    ['**bold**', '**bold**', '**bol**'],
    ['*em*', '*em*', '*e*'],
    ['~~strike~~', '~~strike~~', '~~strik~~'],
    ['`code`', '`code`', '`cod`'],
    ['<ins>ins</ins>', '<ins>ins</ins>', '<ins>in</ins>'],
    ['<mark>mark</mark>', '<mark>mark</mark>', '<mark>mar</mark>'],
  ];

  for (const [label, markup, after] of cases) {
    it(`${label}: no orphaned opening marker left behind`, () => {
      const doc = `When to use it in sales.${markup}`;
      const view = mount(doc, doc.length);

      press(view, 'Backspace');

      // The whole construct is gone — not just its closing marker, which
      // would leave the opening one (and its content) stranded and visible.
      expect(view.state.doc.toString()).toBe(`When to use it in sales.${after}`);
    });
  }
});

describe('Delete right before a folded construct eats its first character, markup intact', () => {
  it('**bold**: no orphaned closing marker left behind', () => {
    const doc = '**bold**Architecture…';
    const view = mount(doc, 0);

    press(view, 'Delete');

    expect(view.state.doc.toString()).toBe('**old**Architecture…');
  });
});

describe('Enter at the folded boundary never splits the markup in half', () => {
  it('**bold** at the visual end of the line: splits after it, whole', () => {
    const doc = '- **bold**';
    const view = mount(doc, doc.length); // right after "bold", before the hidden "**"

    press(view, 'Enter');

    expect(view.state.doc.toString()).toContain('**bold**');
    expect(view.state.doc.line(1).text).toBe(doc);
  });
});

describe('mid-text editing is untouched', () => {
  it('Backspace inside the visible text of a bold span deletes one character, not the whole thing', () => {
    const doc = 'x**bold**y';
    const mid = doc.indexOf('bold') + 2; // between "bo" and "ld"
    const view = mount(doc, mid);

    press(view, 'Backspace');

    expect(view.state.doc.toString()).toBe('x**bld**y');
  });
});
