// @vitest-environment jsdom
/**
 * A URL pasted over selected text links the text (paste-link.ts), in a real
 * EditorView with the same paste handlers the page mounts behind it: in live
 * and in source mode alike, with one undo step, and with every other paste
 * (no selection, other text, code, an existing link, files, rich HTML) left
 * exactly as it was.
 */
import { history, undo } from '@codemirror/commands';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { livePreview, livePreviewConfig } from './live-preview';
import { markdownEditorExtensions } from './markdown-setup';
import { markdownPasteChooser } from './paste-chooser';
import { assetUploads } from './uploads';

const URL = 'https://example.com/page';

const views: EditorView[] = [];
const upload = vi.fn().mockResolvedValue('/a/deadbeef/pasted-image.png');

function mount(doc: string, selected: string | [number, number], live = true): EditorView {
  const [from, to] =
    typeof selected === 'string'
      ? [doc.indexOf(selected), doc.indexOf(selected) + selected.length]
      : selected;
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(from, to),
      extensions: [
        EditorState.allowMultipleSelections.of(true),
        history(),
        markdownEditorExtensions(),
        livePreview,
        livePreviewConfig(live, { space: 'eng', pagePath: 'a.md', pageId: 'P1' }),
        // The page's own paste handlers, in the order index.tsx lists them.
        markdownPasteChooser(),
        assetUploads(upload),
      ],
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

function paste(view: EditorView, plain: string, extra: { html?: string; files?: File[] } = {}): Event {
  const files = extra.files ?? [];
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      files,
      types: [...(extra.html ? ['text/html'] : []), 'text/plain', ...(files.length > 0 ? ['Files'] : [])],
      getData: (type: string) => (type === 'text/plain' ? plain : type === 'text/html' ? (extra.html ?? '') : ''),
    },
  });
  view.contentDOM.dispatchEvent(event);
  return event;
}

const text = (view: EditorView): string => view.state.doc.toString();

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
  upload.mockClear();
});

describe.each([
  ['live', true],
  ['source', false],
] as const)('a URL pasted over selected text (%s mode)', (_name, live) => {
  it('makes the selection a link and puts the caret after it', () => {
    const view = mount('Meeting 02/10 at noon', '02/10', live);
    const event = paste(view, URL);

    expect(event.defaultPrevented).toBe(true);
    expect(text(view)).toBe(`Meeting [02/10](${URL}) at noon`);
    const caret = view.state.selection.main;
    expect(caret.empty).toBe(true);
    expect(caret.head).toBe(`Meeting [02/10](${URL})`.length);
  });

  it('takes the text back with ONE undo', () => {
    const view = mount('Meeting 02/10 at noon', '02/10', live);
    paste(view, URL);
    undo(view);

    expect(text(view)).toBe('Meeting 02/10 at noon');
  });

  it('ignores the whitespace and newline around the copied URL', () => {
    const view = mount('go here now', 'here', live);
    paste(view, `  ${URL}\n`);

    expect(text(view)).toBe(`go [here](${URL}) now`);
  });

  it('still links www. and mailto: addresses, as the markdown package did before', () => {
    const www = mount('go here now', 'here', live);
    paste(www, 'www.example.com');
    expect(text(www)).toBe('go [here](https://www.example.com) now');

    const mail = mount('write Anna now', 'Anna', live);
    paste(mail, 'mailto:anna@example.com');
    expect(text(mail)).toBe('write [Anna](mailto:anna@example.com) now');
  });

  it('links a word inside a list item', () => {
    const view = mount('- first\n- 02/10\n- third', '02/10', live);
    paste(view, URL);

    expect(text(view)).toBe(`- first\n- [02/10](${URL})\n- third`);
  });

  it('keeps formatting inside the selection', () => {
    const view = mount('a **bold** word', '**bold**', live);
    paste(view, URL);

    expect(text(view)).toBe(`a [**bold**](${URL}) word`);
  });

  it('writes an address with a parenthesis in the <…> form', () => {
    const view = mount('see Folio now', 'Folio', live);
    paste(view, 'https://en.wikipedia.org/wiki/Folio_(book)');

    expect(text(view)).toBe('see [Folio](<https://en.wikipedia.org/wiki/Folio_(book)>) now');
  });

  it('links the cell text of a table row written in source', () => {
    const table = '| a | b |\n| --- | --- |\n| one | two |';
    const view = mount(table, 'one', live);
    paste(view, URL);

    expect(text(view)).toBe(`| a | b |\n| --- | --- |\n| [one](${URL}) | two |`);
  });
});

describe('a paste that stays an ordinary replacement', () => {
  it('with nothing selected inserts the URL as text', () => {
    const view = mount('Meeting 02/10', [8, 8]);
    paste(view, URL);

    expect(text(view)).toBe(`Meeting ${URL}02/10`);
  });

  it.each([
    ['several words', 'see https://example.com/page'],
    ['two URLs', 'https://example.com/a https://example.com/b'],
    ['a URL and a line', 'https://example.com/a\nmore'],
    ['a non-http address', 'ftp://example.com/a'],
    ['a bare domain', 'example.com'],
    ['a markdown link', '[x](https://example.com/a)'],
  ])('with %s replaces the selection', (_name, clipboard) => {
    const view = mount('Meeting 02/10 at noon', '02/10');
    paste(view, clipboard);

    expect(text(view)).toBe(`Meeting ${clipboard} at noon`);
  });

  it('over a selection that spans lines replaces it', () => {
    const view = mount('line one\nline two', [5, 13]);
    paste(view, URL);

    expect(text(view)).toBe(`line ${URL} two`);
  });

  it('over a selection that is itself a URL replaces it', () => {
    const view = mount('open https://example.com/old now', 'https://example.com/old');
    paste(view, URL);

    expect(text(view)).toBe(`open ${URL} now`);
  });

  it('over text that is already a link replaces it instead of nesting', () => {
    const doc = 'a [label](https://example.com/old) b';
    for (const selected of ['label', '[label](https://example.com/old)', 'a [label', 'old']) {
      const view = mount(doc, selected);
      paste(view, URL);
      const at = doc.indexOf(selected);

      expect(text(view)).toBe(doc.slice(0, at) + URL + doc.slice(at + selected.length));
    }
  });

  it('over an image replaces it', () => {
    const view = mount('x ![alt](/img.png) y', '![alt](/img.png)');
    paste(view, URL);

    expect(text(view)).toBe(`x ${URL} y`);
  });

  it('inside inline code replaces the selection', () => {
    const view = mount('run `npm test` now', 'npm');
    paste(view, URL);

    expect(text(view)).toBe(`run \`${URL} test\` now`);
  });

  it('inside a fenced code block replaces the selection', () => {
    const view = mount('```ts\nconst name = 1;\n```', 'name');
    paste(view, URL);

    expect(text(view)).toBe(`\`\`\`ts\nconst ${URL} = 1;\n\`\`\``);
  });

  it('across two cells of a table row replaces the selection', () => {
    const table = '| a | b |\n| --- | --- |\n| one | two |';
    const view = mount(table, 'one | two', false);
    paste(view, URL);

    expect(text(view)).toBe(`| a | b |\n| --- | --- |\n| ${URL} |`);
  });

  it('in a table row, an address with a pipe is pasted as text — a link would split the row', () => {
    const table = '| a | b |\n| --- | --- |\n| one | two |';
    const view = mount(table, 'one', false);
    paste(view, 'https://example.com/a|b');

    expect(text(view)).toBe('| a | b |\n| --- | --- |\n| https://example.com/a|b | two |');
  });

  it('with several selections replaces each, as before', () => {
    const view = mount('aa bb', [0, 2]);
    view.dispatch({ selection: EditorSelection.create([EditorSelection.range(0, 2), EditorSelection.range(3, 5)]) });
    paste(view, URL);

    expect(text(view)).toBe(`${URL} ${URL}`);
  });
});

describe('the other paste handlers keep working', () => {
  it('a rich HTML paste (with a plain twin that is not a URL) still becomes markdown', () => {
    const view = mount('Meeting 02/10 at noon', '02/10');
    const event = paste(view, 'bold words', { html: '<p><strong>bold</strong> words</p>' });

    expect(event.defaultPrevented).toBe(true);
    expect(text(view)).toContain('**bold** words');
    expect(text(view)).not.toContain('](');
  });

  it('an image on the clipboard is uploaded, not linked, whatever the plain text says', async () => {
    const view = mount('Meeting 02/10 at noon', '02/10');
    const image = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });
    const event = paste(view, URL, { files: [image] });

    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(text(view)).not.toContain(`[02/10](${URL})`);
  });

  it('a file that is not an image is left to the plain-text paste', () => {
    const view = mount('Meeting 02/10 at noon', '02/10');
    const file = new File(['x'], 'notes.txt', { type: 'text/plain' });
    paste(view, URL, { files: [file] });

    expect(text(view)).toBe(`Meeting ${URL} at noon`);
  });

  it('a document-shaped markdown paste still opens the chooser', () => {
    const view = mount('Meeting 02/10 at noon', '02/10');
    const event = paste(view, '# Title\n\nSome body text.\n\nMore.');

    expect(event.defaultPrevented).toBe(true);
    expect(document.querySelector('.cm-folio-paste-chooser')).toBeTruthy();
    expect(text(view)).toBe('Meeting 02/10 at noon');
  });
});
