// @vitest-environment jsdom
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { livePreview, livePreviewConfig } from './live-preview';
import { markdownEditorExtensions } from './markdown-setup';

const source = [
  '![Sample caption](sample.png)',
  '',
  '| Item | Value |',
  '| --- | --- |',
  '| Example | 1 |',
  '',
  'End of page.',
].join('\n');

const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

function mount(): EditorView {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: source,
      selection: { anchor: source.length },
      extensions: [markdownEditorExtensions(), livePreview,
        livePreviewConfig(true, { space: 'example', pagePath: 'sample.md', pageId: 'sample' })],
    }),
  });
  views.push(view);
  return view;
}

function openImageEditor(view: EditorView): HTMLElement {
  view.dom.querySelector<HTMLImageElement>('.cm-md-image img')!.click();
  return document.querySelector<HTMLElement>('.folio-image-editor')!;
}

describe('the live image editor', () => {
  it('dismisses on a table press and lets that same press start editing the cell', () => {
    const view = mount();
    const panel = openImageEditor(view);
    const cell = view.dom.querySelector<HTMLTableCellElement>('.cm-md-table-widget td')!;

    expect(cell.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))).toBe(true);
    expect(panel.isConnected).toBe(false);
    cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));

    expect(cell.querySelector('.cm-md-cellinput')).not.toBeNull();
    expect(view.state.doc.toString()).toBe(source);
  });

  it('dismisses on editor and page scrolling, while unrelated scrolling leaves it open', () => {
    const view = mount();
    const other = document.body.appendChild(document.createElement('div'));
    const panel = openImageEditor(view);

    other.dispatchEvent(new Event('scroll'));
    expect(panel.isConnected).toBe(true);
    view.scrollDOM.dispatchEvent(new Event('scroll'));
    expect(panel.isConnected).toBe(false);

    const reopened = openImageEditor(view);
    document.dispatchEvent(new Event('scroll'));
    expect(reopened.isConnected).toBe(false);
  });

  it('keeps the active panel when another image is removed and closes it with its own widget', () => {
    const first = mount();
    const second = mount();
    const oldPanel = openImageEditor(first);
    const panel = openImageEditor(second);
    expect(oldPanel.isConnected).toBe(false);

    first.dispatch({ changes: { from: 0, to: first.state.doc.line(1).to, insert: 'A paragraph.' } });
    expect(panel.isConnected).toBe(true);
    second.dispatch({ changes: { from: 0, to: second.state.doc.line(1).to, insert: 'A paragraph.' } });
    expect(panel.isConnected).toBe(false);
  });

  it('accepts input inside the dialog and saves the caption and size', () => {
    const view = mount();
    const panel = openImageEditor(view);
    const description = panel.querySelector('input')!;
    expect(document.activeElement).toBe(description);
    description.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(panel.isConnected).toBe(true);

    description.value = 'Updated caption';
    panel.querySelector('select')!.value = '50%';
    panel.querySelector<HTMLButtonElement>('.folio-image-editor__save')!.click();

    expect(panel.isConnected).toBe(false);
    expect(view.state.doc.toString()).toBe(source.replace(source.split('\n')[0],
      '<img src="sample.png" alt="Updated caption" width="50%">'));
  });
});
