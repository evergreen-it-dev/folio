// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { keepTitleSlot, placeTitleSlot, titleSlot } from './title-slot';

function host(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'folio-title-slot';
  el.textContent = 'props';
  return el;
}

function prose(html: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'folio-editor__prose';
  el.innerHTML = html;
  document.body.append(el);
  return el;
}

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.innerHTML = '';
});

describe('placeTitleSlot (reading)', () => {
  it('goes right after the H1 the page opens with, inside its segment', () => {
    const page = prose('<div class="folio-markdown"><div class="folio-md-segment"><h1>Title</h1><p>Body</p></div></div>');
    const slot = host();
    expect(placeTitleSlot(page, slot)).toBe(true);
    expect(page.querySelector('h1')?.nextElementSibling).toBe(slot);
    expect(placeTitleSlot(page, slot)).toBe(false);
  });

  it('goes to the top of the page when it does not open with an H1, or has not rendered yet', () => {
    const page = prose('<div class="folio-markdown"><div class="folio-md-segment"><p>Body</p><h1>Late</h1></div></div>');
    const slot = host();
    placeTitleSlot(page, slot);
    expect(page.querySelector('.folio-markdown')?.firstChild).toBe(slot);

    const loading = prose('<p>Loading…</p>');
    const other = host();
    placeTitleSlot(loading, other);
    expect(loading.firstChild).toBe(other);
  });

  it('comes back under the title when the renderer replaces that part of the page', async () => {
    const page = prose('<div class="folio-markdown"><div class="folio-md-segment"><h1>Title</h1><p>Body</p></div></div>');
    const slot = host();
    const stop = keepTitleSlot(page, slot);
    page.querySelector('.folio-md-segment')!.innerHTML = '<h1>Title 2</h1><p>Body</p>';
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(page.querySelector('h1')?.nextElementSibling).toBe(slot);
    stop();
    expect(slot.isConnected).toBe(false);
  });
});

describe('titleSlot (live / source)', () => {
  function view(doc: string, slot: HTMLElement): EditorView {
    const parent = document.createElement('div');
    document.body.append(parent);
    const v = new EditorView({ state: EditorState.create({ doc, extensions: [titleSlot(slot)] }), parent });
    views.push(v);
    return v;
  }

  it('draws the host as a block right after an H1 first line', () => {
    const slot = host();
    const v = view('# Title\n\nBody', slot);
    const lines = Array.from(v.contentDOM.children);
    expect(lines.indexOf(slot)).toBe(1);
    expect(lines[0].textContent).toBe('# Title');
    expect(slot.contentEditable).toBe('false');
  });

  it('stays under the title when Enter is pressed at its end, and keeps the same node', () => {
    const slot = host();
    const v = view('# Title\nBody', slot);
    v.dispatch({ changes: { from: 7, insert: '\n' } });
    const lines = Array.from(v.contentDOM.children);
    expect(lines.indexOf(slot)).toBe(1);
    expect(slot.textContent).toBe('props');
  });

  it('sits at the top of a page that does not open with an H1', () => {
    const slot = host();
    const v = view('Body\n# Late', slot);
    expect(v.contentDOM.firstElementChild).toBe(slot);
  });
});
