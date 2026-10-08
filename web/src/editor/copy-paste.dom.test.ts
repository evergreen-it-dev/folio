// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { FolioHighlight } from './highlight-syntax';
import { FolioUnderline } from './underline-syntax';
import { FolioStatus } from './status-syntax';
import { noSetextHeadings } from './markdown-setup';
import { clipboardHtml } from './copy-html';
import { copyMarkdown } from './copy-markdown';
import { convertClipboardHtml, htmlHasRichFormatting, isFolioClipboardHtml } from './html-paste';
import { markdownPasteChooser } from './paste-chooser';
import { assetUploads } from './uploads';
import { liveModeFacet, pageContextFacet } from './live-preview';

const CTX = { space: 'eng', pagePath: 'page.md', pageId: 'P1' };

function mount(doc: string, live = true): { view: EditorView; done: () => void } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage, extensions: [FolioHighlight, FolioUnderline, FolioStatus, noSetextHeadings] }),
        liveModeFacet.of(live),
        pageContextFacet.of(CTX),
        markdownPasteChooser(),
        assetUploads(),
        copyMarkdown,
      ],
    }),
  });
  return { view, done: () => (view.destroy(), host.remove()) };
}

function clipboard(initial: Record<string, string> = {}) {
  const data: Record<string, string> = { ...initial };
  return {
    data,
    files: [] as File[],
    get types() {
      return Object.keys(data);
    },
    getData: (type: string) => data[type] ?? '',
    setData: (type: string, value: string) => void (data[type] = value),
    clearData: () => Object.keys(data).forEach((key) => delete data[key]),
  };
}

function fire(view: EditorView, type: 'copy' | 'cut' | 'paste', transfer = clipboard()) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: transfer });
  view.contentDOM.dispatchEvent(event);
  return { event, transfer };
}

describe('copy / cut in Live edit', () => {
  it('writes the markdown with its folded markers and a rendered HTML twin', () => {
    const doc = '2. **==SELECTED==** Transfer';
    const { view, done } = mount(doc);
    const from = doc.indexOf('SELECTED');
    view.dispatch({ selection: { anchor: from, head: from + 'SELECTED'.length } });
    const { event, transfer } = fire(view, 'copy');
    expect(event.defaultPrevented).toBe(true);
    expect(transfer.data['text/plain']).toBe('**==SELECTED==**');
    expect(transfer.data['text/html']).toContain('<strong><mark');
    expect(transfer.data['text/html']).toContain('SELECTED');
    expect(isFolioClipboardHtml(transfer.data['text/html'])).toBe(true);
    expect(view.state.doc.toString()).toBe(doc); // copy never edits
    done();
  });

  it('cut removes the selected source and keeps the same clipboard', () => {
    const { view, done } = mount('a **bold** b');
    view.dispatch({ selection: { anchor: 4, head: 8 } });
    const { transfer } = fire(view, 'cut');
    expect(transfer.data['text/plain']).toBe('**bold**');
    expect(view.state.doc.toString()).toBe('a **** b');
    done();
  });

  it('source mode and empty selections are left to CodeMirror', () => {
    const source = mount('a **bold** b', false);
    source.view.dispatch({ selection: { anchor: 4, head: 8 } });
    expect(fire(source.view, 'copy').event.defaultPrevented).toBe(false);
    source.done();

    const caret = mount('a **bold** b');
    caret.view.dispatch({ selection: { anchor: 4 } });
    expect(fire(caret.view, 'copy').event.defaultPrevented).toBe(false);
    caret.done();
  });
});

describe('clipboardHtml', () => {
  it('is self-contained: highlight colour, status badge and absolute links as inline styles / URLs', () => {
    const html = clipboardHtml(
      '==hl=={.green} :status[Done]{color=green} [a](https://e.com/x) [b](/s/eng/p)',
      CTX,
      'https://folio.test',
    );
    expect(html).toMatch(/<mark[^>]*background-color: ?(?:#d3f9d8|rgb\(211, 249, 216\))/);
    expect(html).toMatch(/folio-status--green[^>]*style="[^"]*background-color/);
    expect(html).toContain('href="https://e.com/x"');
    expect(html).toContain('href="https://folio.test/s/eng/p"');
  });

  it('an inline selection has no paragraph wrapper; a block one does', () => {
    expect(clipboardHtml('**x** y', CTX, 'https://f')).toMatch(/^<span data-folio-clip="1"><strong>x<\/strong> y<\/span>$/);
    expect(clipboardHtml('# T\n\ntext', CTX, 'https://f')).toMatch(/^<div data-folio-clip="1"><h1/);
  });
});

describe('paste into Live edit', () => {
  it('Folio copy round-trips as exact markdown (HTML twin is ignored)', () => {
    const src = mount('x **==hi==**{.a} :status[Done]{color=green} [l](https://e.com "t")');
    const text = src.view.state.doc.toString();
    src.view.dispatch({ selection: { anchor: 2, head: text.length } });
    const { transfer } = fire(src.view, 'copy');
    src.done();

    const dst = mount('');
    fire(dst.view, 'paste', clipboard(transfer.data));
    // Our handler declines; CodeMirror's own plain-text paste inserts text/plain verbatim.
    expect(transfer.data['text/plain']).toBe(text.slice(2));
    expect(dst.view.state.doc.toString()).toBe(text.slice(2));
    dst.done();
  });

  it('Reading-mode HTML (Folio classes) becomes markdown with highlight colour, status and links', () => {
    const html =
      '<p>a <strong>b</strong> <em>i</em> <del>s</del> <mark class="folio-hl folio-hl-green">hl</mark> ' +
      '<mark class="folio-hl folio-hl-yellow">y</mark> <ins>u</ins> <u>v</u> <code>c</code> ' +
      '<span class="folio-status folio-status--green">Done</span> <span class="folio-status folio-status--grey">Todo</span> ' +
      '<a href="https://e.com/x">link</a></p>';
    expect(htmlHasRichFormatting(html)).toBe(true);
    const out = convertClipboardHtml(html)!.markdown;
    expect(out).toBe(
      'a **b** _i_ ~~s~~ ==hl=={.green} ==y== ++u++ ++v++ `c` :status[Done]{color=green} :status[Todo] [link](https://e.com/x)',
    );
  });

  it('Confluence lozenges and bare <mark> convert too', () => {
    expect(
      convertClipboardHtml('<p><span class="status-macro aui-lozenge aui-lozenge-success">DONE</span> <mark> x </mark></p>')!
        .markdown,
    ).toBe(':status[DONE]{color=green} ==x==');
  });

  it('a Reading-mode HTML-only clipboard is converted on paste', () => {
    const { view, done } = mount('');
    const html = '<p>a <strong>b</strong> <mark class="folio-hl folio-hl-red">c</mark></p>';
    const { event } = fire(view, 'paste', clipboard({ 'text/html': html, 'text/plain': 'a b c' }));
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe('a **b** ==c=={.red}');
    done();
  });
});
