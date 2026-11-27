// @vitest-environment jsdom
/**
 * The link popover (link-popover.ts) behind the toolbar link button and ⇧⌘K,
 * in the document and in a table cell: an address or a page of the space,
 * keyboard driven, and no change at all when it is dismissed.
 */
import { history, undo } from '@codemirror/commands';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearFolioLinkIndex } from '../markdown/folioLinkIndex';
import { linkAround } from './link-span';
import { linkCommand } from './format-toolbar';
import { linkMarkdown, looksLikeAddress, normalizeAddress } from './link-popover';
import { livePreview, livePreviewConfig } from './live-preview';
import { markdownEditorExtensions } from './markdown-setup';
import { clearPageIndex } from './page-index';

Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

const ORIGIN = window.location.origin;
const CTX = { space: 'eng', pagePath: 'a/b.md', pageId: 'P1' };
const views: EditorView[] = [];

function mount(doc: string, from: number, to = from): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(from, to),
      extensions: [history(), markdownEditorExtensions(), livePreview, livePreviewConfig(true, CTX)],
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

const input = () => document.querySelector<HTMLInputElement>('.folio-link-pop__input')!;
const popover = () => document.querySelector('.folio-link-pop');
const rows = () => Array.from(document.querySelectorAll<HTMLElement>('.folio-link-pop__row'));
const key = (k: string) => input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const type = (value: string) => {
  input().value = value;
  input().dispatchEvent(new Event('input', { bubbles: true }));
};
/** The link button of the cell's own bar (not the pinned toolbar's). */
const cellLinkButton = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('.cm-folio-format:not(.cm-folio-toolbar *) .cm-folio-format__btn[aria-label="Link"]')).pop() ?? null;
const flush = () => new Promise((r) => setTimeout(r, 20));
const text = (v: EditorView) => v.state.doc.toString();

beforeEach(() => {
  clearPageIndex();
  clearFolioLinkIndex();
  vi.stubGlobal('fetch', async (u: RequestInfo | URL) => {
    const url = String(u);
    const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 404, json: async () => body });
    if (url === '/api/spaces/eng/tree') {
      return json({
        tree: [
          { id: 'P2', title: 'Data flow', path: 'x/data.md', kind: 'doc', children: [] },
          { id: 'P3', title: 'Onboarding', path: 'onboarding.md', kind: 'doc', children: [] },
        ],
      });
    }
    if (url === '/api/pages/P9') return json({ id: 'P9', title: 'Ops page' });
    return json({}, false);
  });
});

afterEach(() => {
  if (popover()) key('Escape');
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('helpers', () => {
  it('tells an address from a page search', () => {
    expect(looksLikeAddress('https://a.b/c')).toBe(true);
    expect(looksLikeAddress('example.com/x')).toBe(true);
    expect(looksLikeAddress('../x.md')).toBe(true);
    expect(looksLikeAddress('data flow')).toBe(false);
    expect(normalizeAddress('example.com')).toBe('https://example.com');
    expect(linkMarkdown('', 'A [b]', 'x y.md')).toBe('[A \\[b\\]](<x y.md>)');
  });
});

describe('the link popover over a selection', () => {
  it('writes [selection](address) on Enter', async () => {
    const view = mount('see docs here', 4, 8);
    expect(linkCommand(view)).toBe(true);
    expect(text(view)).toBe('see docs here');
    type('https://example.com/a');
    key('Enter');
    await flush();
    expect(text(view)).toBe('see [docs](https://example.com/a) here');
    expect(popover()).toBeNull();
    undo(view);
    expect(text(view)).toBe('see docs here');
  });

  it('searches the pages and writes the [[ picker\'s relative link', async () => {
    const view = mount('read this', 5, 9);
    linkCommand(view);
    await flush();
    type('onb');
    expect(rows().map((r) => r.textContent)).toEqual(['Onboardingonboarding.md']);
    key('Enter');
    await flush();
    expect(text(view)).toBe('read [this](../onboarding.md)');
  });

  it('moves with the arrow keys', async () => {
    const view = mount('go', 0, 2);
    linkCommand(view);
    await flush();
    expect(rows()).toHaveLength(2);
    key('ArrowDown');
    key('Enter');
    await flush();
    expect(text(view)).toBe('[go](../onboarding.md)');
  });

  it('treats a pasted own-instance page URL as that page', async () => {
    const view = mount('see it', 4, 6);
    linkCommand(view);
    await flush();
    type(`${ORIGIN}/s/eng/p/P2`);
    await flush();
    key('Enter');
    await flush();
    expect(text(view)).toBe('see [it](../x/data.md)');
  });

  it('uses the page title as the text when nothing is selected', async () => {
    const view = mount('a  b', 2);
    linkCommand(view);
    await flush();
    type(`${ORIGIN}/s/ops/p/P9`);
    await flush();
    key('Enter');
    await flush();
    expect(text(view)).toBe(`a [Ops page](${ORIGIN}/s/ops/p/P9) b`);
  });

  it('uses the address as the text when nothing is selected and no page', async () => {
    const view = mount('x', 1);
    linkCommand(view);
    type('https://example.com');
    key('Enter');
    await flush();
    expect(text(view)).toBe('x[https://example.com](https://example.com)');
  });

  it('changes nothing on Esc or when the input loses focus', async () => {
    const view = mount('keep me', 0, 4);
    linkCommand(view);
    type('https://example.com');
    key('Escape');
    expect(text(view)).toBe('keep me');
    linkCommand(view);
    input().dispatchEvent(new FocusEvent('blur'));
    expect(popover()).toBeNull();
    expect(text(view)).toBe('keep me');
  });

  it('does nothing on Enter with something that is neither address nor page', async () => {
    const view = mount('keep', 0, 4);
    linkCommand(view);
    await flush();
    type('zzzzqq');
    key('Enter');
    await flush();
    expect(popover()).not.toBeNull();
    expect(text(view)).toBe('keep');
  });
});

describe('over an existing link', () => {
  const DOC = 'See [Item 0005](big-folder/item-0005.md) now';

  it('retargets the link instead of nesting a new one', async () => {
    const at = DOC.indexOf('Item 0005');
    const view = mount(DOC, at, at + 9);
    expect(linkCommand(view)).toBe(true);
    expect(input().value).toBe('big-folder/item-0005.md'); // the current target
    await flush();
    type('onb');
    key('Enter');
    await flush();
    expect(text(view)).toBe('See [Item 0005](../onboarding.md) now');
  });

  it('retargets to a typed address, from a caret inside the label', async () => {
    const view = mount(DOC, DOC.indexOf('0005'));
    linkCommand(view);
    type('https://example.com');
    key('Enter');
    await flush();
    expect(text(view)).toBe('See [Item 0005](https://example.com) now');
  });

  it('keeps the target when Enter is pressed on the prefilled address', async () => {
    const view = mount(DOC, DOC.indexOf('0005'));
    linkCommand(view);
    key('Enter');
    await flush();
    expect(text(view)).toBe(DOC);
  });

  it('refuses a selection that cuts across the edge of a link', () => {
    const from = DOC.indexOf('See');
    const view = mount(DOC, from, DOC.indexOf('Item') + 4);
    expect(linkCommand(view)).toBe(false);
    expect(popover()).toBeNull();
    expect(text(view)).toBe(DOC);
    const wide = mount(DOC, 0, DOC.length);
    expect(linkCommand(wide)).toBe(false);
  });

  it('reads the link around a selection (pure)', () => {
    expect(linkAround('a [b](<c d.md>) e', 3, 4)).toMatchObject({ kind: 'inside', span: { label: 'b', target: 'c d.md' } });
    expect(linkAround('a [b](c) e', 2, 2)).toBeNull(); // caret on the edge is outside
    expect(linkAround('a ![b](c) e', 4, 5)).toBeNull(); // an image is not a link
    expect(linkAround('a [b](c) e', 0, 5)).toEqual({ kind: 'partial' });
  });

  it('retargets a link in a cell too', async () => {
    const doc = ['# page', '', '| a |', '| --- |', '| x |', ''].join('\n');
    mount(doc, 0);
    document
      .querySelector<HTMLTableCellElement>('[data-row="0"][data-col="0"]')!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    const field = document.querySelector<HTMLTextAreaElement>('.cm-md-cellinput')!;
    field.value = 'go [Item](old/one.md) now';
    field.focus();
    field.setSelectionRange(4, 8);
    field.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    cellLinkButton()!.click();
    expect(input().value).toBe('old/one.md');
    await flush();
    type('onb');
    key('Enter');
    await flush();
    expect(field.value).toBe('go [Item](../onboarding.md) now');
  });
});

describe('the link popover in a table cell', () => {
  const open = () => {
    const doc = ['# page', '', '| a |', '| --- |', '| one two |', ''].join('\n');
    const view = mount(doc, 0);
    document
      .querySelector<HTMLTableCellElement>('[data-row="0"][data-col="0"]')!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    const field = document.querySelector<HTMLTextAreaElement>('.cm-md-cellinput')!;
    return { view, field };
  };

  it('writes the link into the cell value, keeping the cell open while it is up', async () => {
    const { field } = open();
    field.value = 'one two';
    field.focus();
    field.setSelectionRange(0, 3);
    field.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    const button = cellLinkButton();
    expect(button).toBeTruthy();
    button!.click();
    expect(popover()).not.toBeNull();
    field.dispatchEvent(new FocusEvent('blur')); // the cell's blur must not commit under the popover
    expect(document.querySelector('.cm-md-cellinput')).toBe(field);
    type('https://example.com');
    key('Enter');
    await flush();
    expect(field.value).toBe('[one](https://example.com) two');
    expect(document.activeElement).toBe(field);
  });

  it('Esc in the cell popover changes nothing', () => {
    const { field } = open();
    field.value = 'one two';
    field.focus();
    field.setSelectionRange(4, 7);
    field.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    cellLinkButton()!.click();
    key('Escape');
    expect(field.value).toBe('one two');
    expect(document.activeElement).toBe(field);
  });

  it('opens from the cell slash and writes the page title for a page address', async () => {
    const { field } = open();
    field.value = '/';
    field.focus();
    field.setSelectionRange(1, 1);
    field.dispatchEvent(new InputEvent('input', { bubbles: true, data: '/' }));
    const items = Array.from(document.querySelectorAll<HTMLButtonElement>('.folio-tablemenu__item'));
    expect(items.length).toBeGreaterThan(0);
    items[items.length - 1].click(); // "Link" is the last entry
    expect(popover()).not.toBeNull();
    type(`${ORIGIN}/s/eng/p/P2`);
    await flush();
    key('Enter');
    await flush();
    expect(field.value).toBe('[Data flow](../x/data.md)');
  });
});
