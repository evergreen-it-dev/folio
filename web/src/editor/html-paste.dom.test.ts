// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { convertClipboardHtml, htmlHasRichFormatting, unwrapRedirectHref } from './html-paste';
import { assetUploads, replaceClipboardImageEdit } from './uploads';
import { liveModeFacet, pageContextFacet } from './live-preview';

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+X3ENWQAAAABJRU5ErkJggg==';

const GOOGLE_DOCS_HTML = `
  <meta charset="utf-8">
  <b id="docs-internal-guid" style="font-weight:normal">
    <p><span style="font-size:22pt;font-weight:700">Workshop title</span></p>
    <h1><span style="font-size:16pt;font-weight:700">Heading</span></h1>
    <p>
      <span style="font-weight:700">bold</span>
      <span style="font-style:italic">italic</span>
      <span style="text-decoration:underline">underlined</span>
      <span style="background-color:#d9d9d9">highlighted</span>
      <a href="https://example.com"><span style="text-decoration:underline">link</span></a>
    </p>
    <table>
      <colgroup><col width="113"><col width="508"></colgroup>
      <thead><tr>
        <th style="background-color:#d9e2f3"><p><span style="font-weight:700">Kind</span></p></th>
        <th style="background-color:#d9e2f3"><p><span style="font-weight:700">Example</span></p></th>
      </tr></thead>
      <tbody><tr>
        <td><p>Nested</p></td>
        <td><ul><li aria-level="1"><p>one</p></li><ul><li aria-level="2"><p>two</p></li></ul></ul></td>
      </tr></tbody>
    </table>
    <p><img src="data:image/png;base64,${PNG_1X1}" width="600" height="301"></p>
  </b>`;

describe('convertClipboardHtml', () => {
  it('preserves Google Docs structure, inline formatting and editable table metadata', () => {
    const converted = convertClipboardHtml(GOOGLE_DOCS_HTML)!;
    expect(converted.block).toBe(true);
    expect(converted.markdown).toContain('**Workshop title**');
    expect(converted.markdown).toContain('# **Heading**');
    expect(converted.markdown).toContain('**bold**');
    expect(converted.markdown).toMatch(/[_*]italic[_*]/);
    expect(converted.markdown).toContain('<ins>underlined</ins>');
    expect(converted.markdown).toContain('<mark>highlighted</mark>');
    expect(converted.markdown).toContain('[link](https://example.com)');
    expect(converted.markdown).toContain('folio-table: bg=HA:blue,HB:blue; w=1:18%,2:82%');
    expect(converted.markdown).toContain('| **Kind** | **Example** |');
    expect(converted.markdown).toContain('• one<br>  • two');
    expect(converted.markdown).not.toContain('data:image');
  });

  it('extracts data images as uploadable files and leaves unique markers', () => {
    const converted = convertClipboardHtml(GOOGLE_DOCS_HTML)!;
    expect(converted.images).toHaveLength(1);
    expect(converted.images[0].file.name).toBe('pasted-image-01.png');
    expect(converted.images[0].file.type).toBe('image/png');
    expect(converted.images[0].file.size).toBeGreaterThan(0);
    expect(converted.markdown).toContain(converted.images[0].marker);
  });

  it('turns consecutive grey monospace paragraphs into one fenced code block', () => {
    const html = `
      <p style="background-color:#f2f2f2"><span style="font-family:Consolas">first</span></p>
      <p style="background-color:#f2f2f2"><span style="font-family:Consolas">second</span></p>`;
    expect(convertClipboardHtml(html)?.markdown).toBe('```\nfirst\nsecond\n```');
  });

  it('drops executable clipboard content and unsafe links', () => {
    const converted = convertClipboardHtml(
      '<script>alert(1)</script><p><a href="javascript:alert(2)">safe text</a></p>',
    )!;
    expect(converted.markdown).toBe('safe text');
  });
});

const GOOGLE_DOCS_LIST_HTML = `
  <meta charset="utf-8">
  <b style="font-weight:700">Announcement</b>
  <ul>
    <li>Item one</li>
    <li>Item two</li>
    <li>Item three</li>
  </ul>
  <p><a href="https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fpage&amp;sa=D&amp;source=docs&amp;ust=1690000000000000">example</a></p>`;

// What Google Docs (and most rich sources) put on the clipboard's text/plain
// twin for the HTML above — list markers and no link syntax, which is exactly
// the shape `looksLikeMarkdown` was built to recognize.
const GOOGLE_DOCS_LIST_PLAIN = 'Announcement\n- Item one\n- Item two\n- Item three\n\nexample';

describe('htmlHasRichFormatting', () => {
  it('recognizes semantic tags and Google Docs-style inline styles', () => {
    expect(htmlHasRichFormatting(GOOGLE_DOCS_LIST_HTML)).toBe(true);
    expect(htmlHasRichFormatting('<p><span style="font-weight:700">bold</span></p>')).toBe(true);
    expect(htmlHasRichFormatting('<p><span style="text-decoration:underline">u</span></p>')).toBe(true);
  });

  it('is false for plain unstyled HTML', () => {
    expect(htmlHasRichFormatting('<div>just some text<br>more text</div>')).toBe(false);
    expect(htmlHasRichFormatting('')).toBe(false);
  });
});

describe('unwrapRedirectHref', () => {
  it('recovers the real target from a Google Docs redirect link', () => {
    expect(
      unwrapRedirectHref(
        'https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fpage&sa=D&source=docs&ust=1690000000000000',
      ),
    ).toBe('https://example.com/page');
  });

  it('leaves ordinary links untouched', () => {
    expect(unwrapRedirectHref('https://example.com/page')).toBe('https://example.com/page');
    expect(unwrapRedirectHref('mailto:a@example.com')).toBe('mailto:a@example.com');
  });

  it('falls back to the original href when the redirect has no usable target', () => {
    expect(unwrapRedirectHref('https://www.google.com/url?sa=D')).toBe('https://www.google.com/url?sa=D');
  });
});

describe('rich paste integration', () => {
  it('converts Google Docs list/link HTML even though its plain-text twin looks like markdown', () => {
    const converted = convertClipboardHtml(GOOGLE_DOCS_LIST_HTML)!;
    expect(converted.markdown).toContain('**Announcement**');
    expect(converted.markdown).toMatch(/-\s+Item one/);
    expect(converted.markdown).toMatch(/-\s+Item two/);
    expect(converted.markdown).toMatch(/-\s+Item three/);
    expect(converted.markdown).toContain('[example](https://example.com/page)');
  });

  it('intercepts the paste event for rich HTML instead of falling back to the markdown-shaped plain text', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: '',
        extensions: [
          liveModeFacet.of(true),
          pageContextFacet.of({ space: 'eng', pagePath: 'page.md', pageId: 'P1' }),
          assetUploads(),
        ],
      }),
    });

    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        files: [] as File[],
        types: ['text/html', 'text/plain'],
        getData: (type: string) => (type === 'text/html' ? GOOGLE_DOCS_LIST_HTML : GOOGLE_DOCS_LIST_PLAIN),
      },
    });
    view.contentDOM.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toContain('**Announcement**');
    expect(view.state.doc.toString()).toContain('[example](https://example.com/page)');

    view.destroy();
    host.remove();
  });

  it('leaves a markdown paste alone when its HTML twin carries no real formatting', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: '',
        extensions: [
          liveModeFacet.of(true),
          pageContextFacet.of({ space: 'eng', pagePath: 'page.md', pageId: 'P1' }),
          assetUploads(),
        ],
      }),
    });

    const plain = '# Heading\n\n- one\n- two\n- three';
    const html = `<div>${plain.replace(/\n/g, '<br>')}</div>`;
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        files: [] as File[],
        types: ['text/html', 'text/plain'],
        getData: (type: string) => (type === 'text/html' ? html : plain),
      },
    });
    view.contentDOM.dispatchEvent(event);

    // Our html-paste branch declines (returns false); CodeMirror's own paste
    // handling then takes over and inserts the plain text verbatim — proof
    // the HTML was never run through turndown (which would have escaped the
    // '#' and '-' markers instead of leaving them as plain characters).
    expect(view.state.doc.toString()).toBe(plain);

    view.destroy();
    host.remove();
  });
});

describe('rich paste integration (image + upload)', () => {
  it('intercepts text/html, inserts markdown and uploads embedded images', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const upload = vi.fn().mockResolvedValue('/a/deadbeef/pasted-image.png');
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: 'before',
        selection: { anchor: 6 },
        extensions: [
          // Rich-paste conversion is a live-mode feature; "Source" pastes text/plain verbatim.
          liveModeFacet.of(true),
          pageContextFacet.of({ space: 'eng', pagePath: 'page.md', pageId: 'P1' }),
          assetUploads(upload),
        ],
      }),
    });

    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        files: [] as File[],
        types: ['text/html', 'text/plain'],
        getData: (type: string) => (type === 'text/html' ? GOOGLE_DOCS_HTML : 'plain fallback'),
      },
    });
    view.contentDOM.dispatchEvent(event);

    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(view.state.doc.toString()).toContain('/a/deadbeef/pasted-image.png'));
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toContain('before\n**Workshop title**');
    expect(upload).toHaveBeenCalledWith('eng', expect.objectContaining({ name: 'pasted-image-01.png' }));

    view.destroy();
    host.remove();
  });

  it('removes a whole markdown image when its upload fails', () => {
    const marker = 'folio-clipboard-image://one/0';
    const text = `a ![pasted image](${marker}) b`;
    const edit = replaceClipboardImageEdit(text, marker, '')!;
    expect(text.slice(0, edit.from) + edit.insert + text.slice(edit.to)).toBe('a  b');
  });
});

/**
 * The owner, 17.09: a paste from Google Sheets landed in the page as a wall
 * of `<table style=…>` — tableMarkdown gave up on colspan/rowspan, and then
 * Turndown printed the table as it was. Now merged cells are laid out into a
 * rectangular grid: the text stays in the first cell, the covered ones go empty.
 */
describe('convertClipboardHtml: merged cells', () => {
  const SHEETS_HTML = `<table xmlns="http://www.w3.org/1999/xhtml" border="1" data-sheets-root="1">
      <tbody>
        <tr><td colspan="2" style="background-color:#46bdc6">TA_2</td><td>Medium business</td></tr>
        <tr><td rowspan="2">Country</td><td>Ukraine</td><td>EU</td></tr>
        <tr><td>Poland</td><td>Germany</td></tr>
      </tbody>
    </table>`;

  it('flattens a merged-cell table instead of dumping its raw HTML', () => {
    const markdown = convertClipboardHtml(SHEETS_HTML)!.markdown;

    expect(markdown).not.toContain('<table');
    expect(markdown).toContain('| TA\\_2 |  | Medium business |'); // the underscore is escaped, as everywhere in tables
    expect(markdown).toContain('| Country | Ukraine | EU |');
    expect(markdown).toMatch(/\|\s+\| Poland \| Germany \|/);
  });
});
