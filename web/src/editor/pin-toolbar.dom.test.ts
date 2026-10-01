// @vitest-environment jsdom
/**
 * The pinned command toolbar inside a real editor (round 25): that it carries
 * the same commands the «/» menu does, that its buttons write exactly what the
 * menu writes, and that unpinning is remembered — with a way back.
 */
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TOOLBAR_PRIMARY,
  blockItemById,
  runBlockCommand,
  toolbarOverflowItems,
} from './block-commands';
import { livePreview, livePreviewConfig } from './live-preview';
import { markdownEditorExtensions } from './markdown-setup';
import {
  TOOLBAR_HOTKEY,
  isToolbarPinned,
  subscribeToolbarPinned,
  toggleToolbar,
  toggleToolbarPinned,
  toolbarHotkeyLabel,
  toolbarPinnedNow,
} from './pin-toolbar';

/** Views are destroyed in `afterEach`: a live one keeps CodeMirror's measuring
    loop running, and jsdom has nothing for it to measure. */
const views: EditorView[] = [];

function mount(doc = '', at = doc.length): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        markdownEditorExtensions(),
        livePreview,
        livePreviewConfig(true, { space: 'eng', pagePath: 'a.md', pageId: 'P1' }),
      ],
      selection: EditorSelection.single(at),
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

const toolbar = (): HTMLElement | null => document.querySelector('.cm-folio-toolbar');
const commandButton = (id: string): HTMLButtonElement | null =>
  document.querySelector<HTMLButtonElement>(`.cm-folio-toolbar__btn[data-command="${id}"]`);

const click = (node: Element): void => {
  node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
};

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
  localStorage.clear();
});

describe('the strip', () => {
  it('is pinned until somebody says otherwise', () => {
    const view = mount('hello');
    expect(isToolbarPinned(view.state)).toBe(true);
    expect(toolbar()).toBeTruthy();
  });

  it('carries the formatting bar and a button per primary command', () => {
    mount('hello');
    // The floating selection bar, reused verbatim: six inline formats, the
    // link and the quote.
    // …plus the highlight colour chevron (24.09.2026).
    expect(toolbar()!.querySelectorAll('.cm-folio-format__btn')).toHaveLength(9);
    for (const id of TOOLBAR_PRIMARY) expect(commandButton(id), id).toBeTruthy();
  });

  it('makes a link from the strip, over a selection made in the document', () => {
    const view = mount('word', 0);
    view.dispatch({ selection: EditorSelection.single(0, 4) });
    const link = [...toolbar()!.querySelectorAll('.cm-folio-format__btn')].find(
      (button) => button.getAttribute('aria-label') === 'Link',
    );
    expect(link, 'no link button in the pinned toolbar').toBeTruthy();
    click(link!);
    expect(view.state.doc.toString()).toBe('[word](url)');
  });

  it('keeps the link out of the block list — it has its own button', () => {
    mount('hello');
    expect(commandButton('link')).toBeNull();
    expect(toolbarOverflowItems().map((item) => item.id)).not.toContain('link');
  });

  it('offers the blocks the owner named, callouts and page tree included', () => {
    mount('hello');
    for (const id of ['heading1', 'list', 'task', 'table', 'code', 'mermaid', 'image', 'note', 'warning', 'divider', 'pagetree']) {
      expect(commandButton(id), id).toBeTruthy();
    }
  });

  it('puts every remaining «/» command behind the overflow button', () => {
    mount('hello');
    const buttons = toolbar()!.querySelectorAll('.cm-folio-toolbar__btn');
    // One per primary command, plus indent/dedent (next to the list buttons,
    // not «/» commands of their own) and the «…» that opens the rest.
    expect(buttons).toHaveLength(TOOLBAR_PRIMARY.length + 2 + 1);
    expect(toolbarOverflowItems().length).toBeGreaterThan(0);
    // The block quote is not duplicated: the formatting group already has it.
    expect(toolbarOverflowItems().map((item) => item.id)).not.toContain('quote');
  });

  it('re-reads the pressed states as the caret moves', () => {
    const view = mount('**bold** plain');
    const bold = () => toolbar()!.querySelector('.cm-folio-format__btn')!;

    view.dispatch({ selection: EditorSelection.single(2, 6) });
    expect(bold().getAttribute('aria-pressed')).toBe('true');

    view.dispatch({ selection: EditorSelection.single(10, 14) });
    expect(bold().getAttribute('aria-pressed')).toBe('false');
  });
});

describe('what the buttons write', () => {
  it('inserts exactly what the «/» menu inserts, from a blank line', () => {
    const view = mount('');
    click(commandButton('list')!);
    expect(view.state.doc.toString()).toBe('- ');
  });

  /**
   * A block is new content, so it cannot take over the line being typed on —
   * there is no way to turn a paragraph into a table without eating it.
   */
  it('opens a fresh line for a block rather than mangling the one being typed on', () => {
    const view = mount('already typed');
    click(commandButton('table')!);
    expect(view.state.doc.toString().split('\n')[0]).toBe('already typed');
    expect(view.state.doc.toString()).toContain('| --- |');
  });

  /**
   * QA-3: a line style is a property of the line, the way B/I/U are a property
   * of the selection — the strip used to answer "Heading 2" with a new empty
   * `## ` below the paragraph the author meant to promote.
   */
  it('restyles the line the caret is on for a heading, a list or a task', () => {
    for (const [id, before, after] of [
      ['heading2', 'already typed', '## already typed'],
      ['task', 'already typed', '- [ ] already typed'],
      ['list', 'already typed', '- already typed'],
      ['ordered', 'already typed', '1. already typed'],
    ] as const) {
      const view = mount(before, 4);
      click(commandButton(id)!);
      expect(view.state.doc.toString(), id).toBe(after);
      view.destroy();
      document.body.replaceChildren();
    }
  });

  it('swaps one line style for another instead of stacking them up', () => {
    const view = mount('- [ ] done thing', 8);
    click(commandButton('heading1')!);
    expect(view.state.doc.toString()).toBe('# done thing');
    click(commandButton('list')!);
    expect(view.state.doc.toString()).toBe('- done thing');
  });

  it('restyles every line the selection touches', () => {
    const view = mount('one\ntwo\nthree', 0);
    view.dispatch({ selection: EditorSelection.single(0, 9) });
    click(commandButton('task')!);
    expect(view.state.doc.toString()).toBe('- [ ] one\n- [ ] two\n- [ ] three');
  });

  it('writes the marker INSIDE a blockquote rather than unquoting the line', () => {
    const view = mount('> quoted', 4);
    click(commandButton('heading3')!);
    expect(view.state.doc.toString()).toBe('> ### quoted');
  });

  it('leaves the caret ready to type on a blank line, as it always did', () => {
    const view = mount('');
    click(commandButton('heading2')!);
    expect(view.state.doc.toString()).toBe('## ');
    expect(view.state.selection.main.head).toBe(3);
  });

  it('agrees with the direct command runner on every primary entry', () => {
    for (const id of TOOLBAR_PRIMARY) {
      // The picker-driven ones open OS dialogs; their text edit is the empty
      // one, which is not what this comparison is about.
      if (id === 'image') continue;
      const item = blockItemById(id)!;

      const byButton = mount('');
      click(commandButton(id)!);
      const buttonText = byButton.state.doc.toString();
      byButton.destroy();
      document.body.replaceChildren();

      const byCommand = mount('');
      runBlockCommand(byCommand, item);
      expect(byCommand.state.doc.toString(), id).toBe(buttonText);
      byCommand.destroy();
      document.body.replaceChildren();
    }
  });
});

describe('the indent/dedent buttons', () => {
  it('nests a list item exactly like Tab, and sits disabled off a list line', () => {
    // Outside a list: visible (the owner has to see the action exists) but
    // disabled — clicking it must not touch the document.
    const outside = mount('plain text', 4);
    const indentOutside = commandButton('listIndent')!;
    const dedentOutside = commandButton('listDedent')!;
    expect(indentOutside.disabled).toBe(true);
    expect(dedentOutside.disabled).toBe(true);
    click(indentOutside);
    expect(outside.state.doc.toString()).toBe('plain text');
    outside.destroy();
    document.body.replaceChildren();

    // On a list line: enabled, and writes exactly what a Tab press writes
    // (list-indent.ts's own `listIndent` — no second implementation here).
    const doc = '- Parent\n- Child';
    const at = doc.indexOf('Child');

    const byButton = mount(doc, at);
    const indentOnList = commandButton('listIndent')!;
    expect(indentOnList.disabled).toBe(false);
    click(indentOnList);
    const afterButton = byButton.state.doc.toString();
    expect(afterButton).toBe('- Parent\n  - Child');
    byButton.destroy();
    document.body.replaceChildren();

    const byTab = mount(doc, at);
    byTab.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', keyCode: 9, bubbles: true, cancelable: true }),
    );
    expect(byTab.state.doc.toString()).toBe(afterButton);
  });
});

describe('pin and unpin', () => {
  it('remembers being unpinned, and says how to get it back', () => {
    const view = mount('hello');

    toggleToolbar(view);
    expect(isToolbarPinned(view.state)).toBe(false);
    expect(toolbar()).toBeNull();
    expect(localStorage.getItem('folio.editor.toolbar')).toBe('off');

    const hint = document.querySelector('.folio-editor__toast');
    expect(hint?.textContent).toContain(toolbarHotkeyLabel());
    expect(hint?.textContent).toContain('/');
  });

  it('shows the way-back hint once and not on every unpin', () => {
    const view = mount('hello');

    toggleToolbar(view);
    document.querySelector('.folio-editor__toast')?.remove();
    toggleToolbar(view);
    toggleToolbar(view);

    expect(document.querySelector('.folio-editor__toast')).toBeNull();
  });

  it('starts unpinned when that is what was stored, and comes back on the hotkey', () => {
    localStorage.setItem('folio.editor.toolbar', 'off');
    const view = mount('hello');
    expect(toolbar()).toBeNull();

    toggleToolbar(view);
    expect(toolbar()).toBeTruthy();
    expect(localStorage.getItem('folio.editor.toolbar')).toBe('on');
  });

  it('binds a hotkey no browser has already claimed', () => {
    // ⌘⇧P is Firefox's private window, ⌘⇧B the bookmark bar, ⌘⇧T a reopened
    // tab: a page cannot intercept any of them.
    expect(TOOLBAR_HOTKEY).toBe('Alt-Shift-p');
    expect(toolbarHotkeyLabel()).toMatch(/⌥⇧P|Alt\+Shift\+P/);
  });

  it('unpins from the button on the strip itself', () => {
    const view = mount('hello');
    click(document.querySelector('.cm-folio-toolbar__unpin')!);
    expect(isToolbarPinned(view.state)).toBe(false);
  });
});

/**
 * The way back.
 *
 * Round 26: the owner unpinned the strip in production and could not get it
 * back — the hotkey was dead on his Mac (pin-toolbar-hotkey.dom.test.ts) and the
 * toast naming it had already gone. The answer then was a reveal tab standing
 * where the strip had been. Round 27 replaced that tab with a button in the
 * chrome row beside the mode switch, because a full-width strip was a lot of
 * document to spend on one chevron.
 *
 * The button itself is React and lives in index.tsx (covered in
 * index.dom.test.tsx). What has to hold *here* is the channel it reaches the
 * panel through: this module's shared state. Break that and the button goes
 * back to being decoration, which is the exact failure round 26 was about.
 */
describe('the way back, now in the chrome row', () => {
  it('hides the panel outright instead of leaving a reveal strip behind', () => {
    const view = mount('hello');

    toggleToolbar(view);

    expect(toolbar()).toBeNull();
    expect(document.querySelector('.cm-folio-toolbar-tab')).toBeNull();
  });

  it('publishes every toggle to whoever is rendering the button', () => {
    const view = mount('hello');
    const seen: boolean[] = [];
    const stop = subscribeToolbarPinned((pinned) => seen.push(pinned));

    toggleToolbar(view);
    toggleToolbar(view);
    stop();
    // Nothing after the unsubscribe: an unmounted button must not be told.
    toggleToolbar(view);

    expect(seen).toEqual([false, true]);
    expect(toolbarPinnedNow()).toBe(false);
  });

  it('brings the strip back from a toggle that has no view in hand', () => {
    // Exactly what the chrome-row button calls: it cannot reach the view, and
    // in reading mode there is not even one mounted.
    const view = mount('hello');
    toggleToolbar(view);
    expect(toolbar()).toBeNull();

    toggleToolbarPinned();

    expect(isToolbarPinned(view.state)).toBe(true);
    expect(toolbar()).not.toBeNull();
    expect(localStorage.getItem('folio.editor.toolbar')).toBe('on');
  });

  it('reads back as hidden on a fresh load of a page left unpinned', () => {
    // The reload path: no toast fires on this visit, so what the button renders
    // from is the only thing telling the reader the strip is merely hidden.
    localStorage.setItem('folio.editor.toolbar', 'off');
    const view = mount('hello');

    expect(isToolbarPinned(view.state)).toBe(false);
    expect(toolbarPinnedNow()).toBe(false);
    expect(document.querySelector('.folio-editor__toast')).toBeNull();
  });

  it('does not depend on the one-off hint having been seen', () => {
    // Second unpin ever: the hint is spent (it is deliberately once-only), and
    // the button still has to be the answer.
    localStorage.setItem('folio.editor.toolbar.hinted', 'yes');
    const view = mount('hello');

    toggleToolbar(view);

    expect(document.querySelector('.folio-editor__toast')).toBeNull();
    toggleToolbarPinned();
    expect(isToolbarPinned(view.state)).toBe(true);
  });

  it('stops talking to a view once it is destroyed', () => {
    // The subscription is per-view. Left dangling it would dispatch into a dead
    // view on the next toggle — a page navigation is all it takes to get here.
    const view = mount('hello');
    view.destroy();

    expect(() => toggleToolbarPinned()).not.toThrow();
    expect(toolbarPinnedNow()).toBe(false);
  });
});
