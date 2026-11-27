// @vitest-environment jsdom
/**
 * The app's own page URL ("Copy link" in the sidebar) pasted at a caret becomes
 * a link reading as the page title (paste-page-link.ts): in the document, in
 * live and source mode, and in a table cell; same markdown everywhere.
 */
import { history, undo } from '@codemirror/commands';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearFolioLinkIndex } from '../markdown/folioLinkIndex';
import { livePreview, livePreviewConfig } from './live-preview';
import { markdownEditorExtensions } from './markdown-setup';
import { clearPageIndex } from './page-index';

const ORIGIN = window.location.origin;
const SAME = `${ORIGIN}/s/eng/p/P2`;
const OTHER = `${ORIGIN}/s/ops/p/P9`;
const CTX = { space: 'eng', pagePath: 'a/b.md', pageId: 'P1' };

const views: EditorView[] = [];

// jsdom has no layout; CodeMirror's measure pass asks for rects.
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

function mount(doc: string, caret: number, live = true): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(caret),
      extensions: [history(), markdownEditorExtensions(), livePreview, livePreviewConfig(live, CTX)],
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

function pasteOn(target: HTMLElement, plain: string): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { files: [], types: ['text/plain'], getData: (t: string) => (t === 'text/plain' ? plain : '') },
  });
  target.dispatchEvent(event);
  return event;
}

const text = (view: EditorView) => view.state.doc.toString();
const flush = () => new Promise((r) => setTimeout(r, 20));

function mockApi(opts: { tree?: boolean } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 404, json: async () => body });
    if (url === '/api/spaces/eng/tree') {
      if (opts.tree === false) return json({}, false);
      return json({
        tree: [{ id: 'P2', title: 'Data [flow] | notes', path: 'x/data.md', kind: 'doc', children: [] }],
      });
    }
    if (url === '/api/pages/P9') return json({ id: 'P9', title: 'Ops page' });
    if (url.startsWith('/api/pages/')) return json({}, false);
    return json({}, false);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  clearPageIndex();
  clearFolioLinkIndex();
});

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe.each([
  ['live', true],
  ['source', false],
] as const)('a page URL pasted at a caret (%s mode)', (_n, live) => {
  it('writes a relative .md link with the page title for a page of this space', async () => {
    mockApi();
    const view = mount('see: end', 5, live);
    const event = pasteOn(view.contentDOM, SAME);
    expect(event.defaultPrevented).toBe(true);
    await flush();
    expect(text(view)).toBe('see: [Data \\[flow\\] | notes](../x/data.md)end');
    expect(view.state.selection.main.head).toBe('see: [Data \\[flow\\] | notes](../x/data.md)'.length);
  });

  it('keeps the absolute URL as target for another space, titled from the page', async () => {
    mockApi();
    const view = mount('see: ', 5, live);
    pasteOn(view.contentDOM, OTHER);
    await flush();
    expect(text(view)).toBe(`see: [Ops page](${OTHER})`);
  });

  it('puts the bare URL in at once and upgrades that range when the title arrives', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal('fetch', async () => {
      await gate;
      return { ok: true, status: 200, json: async () => ({ tree: [{ id: 'P2', title: 'Late', path: 'x/data.md', kind: 'doc' }] }) };
    });
    const view = mount('ab', 1, live);
    pasteOn(view.contentDOM, SAME);
    expect(text(view)).toBe(`a${SAME}b`); // nothing held
    view.dispatch({ changes: { from: 0, insert: 'XX' } }); // typing before it meanwhile
    release();
    await flush();
    expect(text(view)).toBe('XXa[Late](../x/data.md)b');
    undo(view);
    expect(text(view)).toBe(`XXa${SAME}b`); // the upgrade is its own undo step
  });

  it('leaves the URL when the text under the range was edited meanwhile', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal('fetch', async () => {
      await gate;
      return { ok: true, status: 200, json: async () => ({ tree: [{ id: 'P2', title: 'Late', path: 'x/data.md', kind: 'doc' }] }) };
    });
    const view = mount('ab', 1, live);
    pasteOn(view.contentDOM, SAME);
    view.dispatch({ changes: { from: 3, insert: 'Q' } });
    release();
    await flush();
    expect(text(view)).toBe(`a${SAME.slice(0, 2)}Q${SAME.slice(2)}b`);
    expect(text(view)).not.toContain('[Late]');
  });

  it('falls back to the bare URL when the title cannot be had', async () => {
    mockApi({ tree: false });
    const view = mount('x ', 2, live);
    pasteOn(view.contentDOM, `${ORIGIN}/s/eng/p/GONE`);
    await flush();
    await new Promise((r) => setTimeout(r, 50));
    expect(text(view)).toBe(`x ${ORIGIN}/s/eng/p/GONE`);
  });
});

describe('a page URL left alone', () => {
  it('stays the plain paste inside code and an existing link', async () => {
    mockApi();
    for (const [doc, caret] of [
      ['```\n\n```', 4],
      ['a `code` b', 4],
      ['[text](http://x.y)', 3],
    ] as const) {
      const view = mount(doc, caret);
      pasteOn(view.contentDOM, SAME);
      await flush();
      expect(text(view)).toContain(SAME);
      expect(text(view)).not.toContain('Data');
    }
  });

  it('stays the plain paste for a foreign URL or other text', async () => {
    mockApi();
    const foreign = mount('a b', 1);
    pasteOn(foreign.contentDOM, 'https://example.com/s/eng/p/P2');
    await flush();
    expect(text(foreign)).toBe('ahttps://example.com/s/eng/p/P2 b');
    const mixed = mount('a b', 1);
    pasteOn(mixed.contentDOM, `hello ${SAME}`);
    await flush();
    expect(text(mixed)).toBe(`ahello ${SAME} b`);
  });

  it('over a selection still links the selected words (paste-link.ts)', async () => {
    mockApi();
    const sel = mount('a word b', 2);
    sel.dispatch({ selection: EditorSelection.single(2, 6) });
    pasteOn(sel.contentDOM, SAME);
    await flush();
    expect(text(sel)).toBe(`a [word](${SAME}) b`);
  });
});

describe('a page URL in a table', () => {
  it('escapes the | of a title in a source-mode row', async () => {
    mockApi();
    const doc = '| a | b |\n| --- | --- |\n| one |  |';
    const view = mount(doc, doc.length - 3, false);
    pasteOn(view.contentDOM, SAME);
    await flush();
    expect(text(view)).toContain('[Data \\[flow\\] \\| notes](../x/data.md)');
  });

  it('writes the same markdown into a cell (live widget)', async () => {
    mockApi();
    const doc = ['# page', '', '| a |', '| --- |', '| x |', ''].join('\n');
    const view = mount(doc, 0, true);
    const cell = document.querySelector<HTMLTableCellElement>('[data-row="0"][data-col="0"]')!;
    cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    const field = document.querySelector<HTMLTextAreaElement>('.cm-md-cellinput')!;
    field.value = '';
    field.setSelectionRange(0, 0);
    const event = pasteOn(field, SAME);
    expect(event.defaultPrevented).toBe(true);
    await flush();
    expect(field.value).toBe('[Data \\[flow\\] | notes](../x/data.md)');
    expect(view.state.doc.length).toBeGreaterThan(0);
  });

  it('puts the URL into a cell at once and upgrades it in the open cell', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal('fetch', async () => {
      await gate;
      return { ok: true, status: 200, json: async () => ({ tree: [{ id: 'P2', title: 'Late', path: 'x/data.md', kind: 'doc' }] }) };
    });
    const doc = ['# page', '', '| a |', '| --- |', '| x |', ''].join('\n');
    mount(doc, 0, true);
    document
      .querySelector<HTMLTableCellElement>('[data-row="0"][data-col="0"]')!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    const field = document.querySelector<HTMLTextAreaElement>('.cm-md-cellinput')!;
    field.value = 'a ';
    field.setSelectionRange(2, 2);
    pasteOn(field, SAME);
    expect(field.value).toBe(`a ${SAME}`);
    release();
    await flush();
    expect(field.value).toBe('a [Late](../x/data.md)');
  });
});
