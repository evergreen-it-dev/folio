// @vitest-environment jsdom
/**
 * Formatting commands inside a real editor. The document-level floating bar
 * was removed because mounting it over a selection moved the perceived caret;
 * the pinned toolbar and hotkeys still drive these same commands.
 */
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { LINK_KEY, formatCommand, linkCommand, quoteCommand, highlightColorCommand } from './format-toolbar';
import { livePreview, livePreviewConfig } from './live-preview';
import { markdownEditorExtensions } from './markdown-setup';

/** Views are destroyed in `afterEach`: a live one keeps CodeMirror's measuring
    loop running, and jsdom has nothing for it to measure. */
const views: EditorView[] = [];

function mount(doc: string, from = 0, to = doc.length): EditorView {
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

const bar = (): HTMLElement | null =>
  Array.from(document.querySelectorAll<HTMLElement>('.cm-folio-format')).find(
    (element) => element.closest('.cm-folio-toolbar') === null,
  ) ?? null;

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

describe('the document-level floating bar', () => {
  // Back by the owner's request (24.09.2026): a selection is where the
  // formatting decision is made, and the pinned strip is far from it.
  it('mounts over a selection and goes when it collapses', () => {
    const view = mount('hello world', 0, 5);
    expect(bar()).toBeTruthy();
    view.dispatch({ selection: EditorSelection.single(3) });
    expect(bar()).toBeNull();
  });
});

describe('commands', () => {
  const write = (doc: string, run: (view: EditorView) => void, from = 0, to = doc.length) => {
    const view = mount(doc, from, to);
    run(view);
    return view.state.doc.toString();
  };

  it('paints a highlight colour, and takes it off again', () => {
    expect(write('x', (v) => highlightColorCommand('green')(v))).toBe('==x=={.green}');
    expect(write('x', (v) => highlightColorCommand('yellow')(v))).toBe('==x==');
    expect(write('a ==x=={.green} b', (v) => highlightColorCommand('none')(v), 4, 5)).toBe('a x b');
  });

  it('un-bolds the selected tail of a bold run by splitting it', () => {
    expect(write('**A sel** c', (v) => formatCommand('bold')(v), 4, 7)).toBe('**A** sel c');
  });

  it('writes every inline format the toolbar offers', () => {
    expect(write('x', (v) => formatCommand('bold')(v))).toBe('**x**');
    expect(write('x', (v) => formatCommand('italic')(v))).toBe('*x*');
    expect(write('x', (v) => formatCommand('underline')(v))).toBe('<ins>x</ins>');
    expect(write('x', (v) => formatCommand('strike')(v))).toBe('~~x~~');
    expect(write('x', (v) => formatCommand('code')(v))).toBe('`x`');
    expect(write('x', (v) => formatCommand('highlight')(v))).toBe('==x==');
  });

  it('toggles a format back off', () => {
    const view = mount('word', 0, 4);
    formatCommand('bold')(view);
    expect(view.state.doc.toString()).toBe('**word**');
    formatCommand('bold')(view);
    expect(view.state.doc.toString()).toBe('word');
  });

  it('touches only the selected part of a long document', () => {
    const doc = `${'lorem '.repeat(200)}target tail`;
    const at = doc.indexOf('target');
    expect(write(doc, (v) => formatCommand('code')(v), at, at + 6)).toContain('`target` tail');
  });

  it('makes a link out of the selection and leaves the target selected', () => {
    const view = mount('word', 0, 4);
    expect(linkCommand(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('[word](url)');
    const { from, to } = view.state.selection.main;
    expect(view.state.sliceDoc(from, to)).toBe('url');
  });

  it('answers the link hotkey, which is not the quick switcher\'s ⌘K', () => {
    expect(LINK_KEY).toBe('Mod-Shift-k');
    const view = mount('word', 0, 4);
    // Shift+K types «K», so CodeMirror has to fall back to the physical key to
    // resolve the binding — `keyCode` is what it reads for that, and it is why
    // this binding works on a Cyrillic layout where an Alt one would not.
    // jsdom reports no platform, so `Mod` here is Ctrl.
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'K',
        keyCode: 75,
        shiftKey: true,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(view.state.doc.toString()).toBe('[word](url)');
  });

  it('quotes and unquotes whole lines', () => {
    const view = mount('one\ntwo', 0, 7);
    quoteCommand(view);
    expect(view.state.doc.toString()).toBe('> one\n> two');
    quoteCommand(view);
    expect(view.state.doc.toString()).toBe('one\ntwo');
  });
});

describe('live preview of the HTML formats', () => {
  it('renders <ins> and <mark> instead of showing their tags', () => {
    const view = mount('a <ins>u</ins> and <mark>h</mark> b', 0, 0);
    const text = view.contentDOM.textContent ?? '';
    expect(text).not.toContain('<ins>');
    expect(text).not.toContain('<mark>');
    expect(view.contentDOM.querySelector('.cm-md-ins')?.textContent).toBe('u');
    expect(view.contentDOM.querySelector('.cm-md-mark')?.textContent).toBe('h');
  });

  it('keeps the tags hidden when the caret is inside them', () => {
    const view = mount('a <ins>u</ins> b', 8, 8);
    expect(view.contentDOM.textContent).not.toContain('<ins>');
  });

  it('leaves an unpaired tag as plain source', () => {
    const view = mount('a <mark>u b', 0, 0);
    expect(view.contentDOM.textContent).toContain('<mark>');
  });
});
