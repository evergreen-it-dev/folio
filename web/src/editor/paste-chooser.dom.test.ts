// @vitest-environment jsdom
/**
 * paste-chooser.ts inside a real EditorView: a document-shaped markdown paste
 * offers the panel instead of landing in the document immediately, "Insert
 * into the body" writes it verbatim once chosen, and anything short enough to be an
 * ordinary paste (not a whole document) is left to CodeMirror as always.
 */
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { liveModeFacet, pageContextFacet } from './live-preview';
import { markdownPasteChooser } from './paste-chooser';

const views: EditorView[] = [];

function mount(doc = '', at = doc.length): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: at },
      extensions: [
        // Source mode too — the chooser has to fire regardless of live/source.
        liveModeFacet.of(false),
        pageContextFacet.of({ space: 'eng', pagePath: 'page.md', pageId: 'P1' }),
        markdownPasteChooser(),
      ],
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

function dispatchPaste(view: EditorView, plainText: string, html = ''): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      files: [] as File[],
      types: html ? ['text/html', 'text/plain'] : ['text/plain'],
      getData: (type: string) => (type === 'text/plain' ? plainText : type === 'text/html' ? html : ''),
    },
  });
  view.contentDOM.dispatchEvent(event);
  return event;
}

const panel = (): HTMLElement | null => document.querySelector('.cm-folio-paste-chooser');
const primaryButton = (): HTMLButtonElement | null =>
  document.querySelector<HTMLButtonElement>('.cm-folio-paste-chooser__btn--primary');

const click = (node: Element): void => {
  node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
};

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

const DOCUMENT_PASTE = '# Pasted title\n\nA paragraph of body text explaining things.\n\nAnd more.';

describe('a document-shaped markdown paste', () => {
  it('offers the panel instead of inserting the text right away', () => {
    const view = mount('before');
    const event = dispatchPaste(view, DOCUMENT_PASTE);

    expect(event.defaultPrevented).toBe(true);
    expect(panel()).toBeTruthy();
    // Nothing landed in the document yet — the choice hasn't been made.
    expect(view.state.doc.toString()).toBe('before');
  });

  it('writes the text verbatim, unescaped, once "Insert into the body" is clicked', () => {
    const view = mount('before');
    dispatchPaste(view, DOCUMENT_PASTE);

    click(primaryButton()!);

    expect(view.state.doc.toString()).toBe(`before${DOCUMENT_PASTE}`);
    expect(panel()).toBeNull();
  });
});

describe('a markdown-shaped paste with a rich HTML twin', () => {
  it('leaves the chooser closed so assetUploads can convert the HTML instead', () => {
    const view = mount('before');
    const richHtml =
      '<h1>Announcement</h1><ul><li>Item one</li><li>Item two</li><li>Item three</li></ul>' +
      '<p><a href="https://example.com/page">example</a></p>';
    // A heading makes this "document-shaped" too, so without the HTML check
    // below the chooser would otherwise offer to file it away as a page.
    const plain = '# Announcement\n\n- Item one\n- Item two\n- Item three\n\nexample';
    dispatchPaste(view, plain, richHtml);

    // Document-shaped, and plain text alone looks like markdown, but the HTML
    // twin carries real formatting — this paste is not the chooser's to offer.
    // (CodeMirror's own paste handling takes over and inserts the plain text
    // verbatim; that's assetUploads' HTML-conversion branch to intercept, not
    // this handler's, so the chooser itself must stay out of the way.)
    expect(panel()).toBeNull();
    expect(view.state.doc.toString()).toBe(`before${plain}`);
  });
});

describe('an ordinary short paste', () => {
  it('leaves the panel closed and the paste to CodeMirror itself', () => {
    const view = mount('');
    dispatchPaste(view, 'hello');

    // Not our handler's business: it returns false, and CodeMirror's own
    // built-in paste handling (not this extension) is what inserts the text —
    // the visible proof being that the text landed with no panel involved.
    expect(panel()).toBeNull();
    expect(view.state.doc.toString()).toBe('hello');
  });
});
