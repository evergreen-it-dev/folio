// @vitest-environment jsdom
/**
 * The owner's bug: a page that is a list of links. In live mode `[text](url)`
 * folds its `[`/`](url)` markers away, so a caret that LOOKS like it sits at
 * the end (or start) of the visible link text can legally be at the raw
 * boundary right next to the hidden markup — Enter there used to insert the
 * newline in the middle of the markdown, splitting `[text](url)` apart.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { livePreview, livePreviewConfig } from './live-preview';
import { markdownEditorExtensions } from './markdown-setup';

const LINK = '[Cases](https://example.com/a)';
const LABEL = 'Cases';

const views: EditorView[] = [];

function mount(doc: string, pos: number): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        markdownEditorExtensions(),
        livePreview,
        livePreviewConfig(true, { space: 'eng', pagePath: 'a.md', pageId: 'P1' }),
      ],
      selection: EditorSelection.single(pos),
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

function press(view: EditorView, key: string, code = key) {
  view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true }));
}

function pressEnter(view: EditorView) {
  press(view, 'Enter');
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

describe('Enter next to a folded link', () => {
  it('at the visual end of the line: splits after the link, never inside it', () => {
    const doc = `- ${LINK}`;
    const labelTo = doc.indexOf(LABEL) + LABEL.length; // right after "Cases", before the hidden "](url)"
    const view = mount(doc, labelTo);

    pressEnter(view);

    expect(view.state.doc.lines).toBe(2);
    expect(view.state.doc.toString()).toContain(LINK); // markdown intact, unbroken
    expect(view.state.doc.line(1).text).toBe(doc); // the link line is untouched
    expect(view.state.doc.line(2).text).toBe('- '); // a clean new (empty) bullet, list continued
    expect(view.state.selection.main.head).toBe(view.state.doc.line(2).to);
  });

  it('at the visual start of the line: splits before the link, never inside it', () => {
    const doc = `- ${LINK}`;
    const labelFrom = doc.indexOf(LABEL); // right before "Cases", after the hidden "["
    const view = mount(doc, labelFrom);

    pressEnter(view);

    expect(view.state.doc.lines).toBe(2);
    expect(view.state.doc.toString()).toContain(LINK); // markdown intact, unbroken
    expect(view.state.doc.line(1).text).toBe('-'); // an empty bullet left behind
    expect(view.state.doc.line(2).text).toBe(`- ${LINK}`); // the whole link on its own bullet
  });
});

/**
 * The owner, 24.09.2026: "the caret is in the middle of bold, Enter — the
 * piece after the caret must move to a new line, and instead the whole block moved".
 */
describe('Enter inside folded emphasis', () => {
  it('splits a bold run into two bold lines', () => {
    const doc = 'ab **bold text** c';
    const view = mount(doc, doc.indexOf('text'));

    pressEnter(view);

    expect(view.state.doc.toString()).toBe('ab **bold**\n**text** c'); // no space hugging a marker
    expect(view.state.selection.main.head).toBe('ab **bold**\n**'.length);
  });

  it('a cut that would leave a half empty snaps to the edge instead', () => {
    const doc = '**ab cd**';
    const view = mount(doc, '**ab cd'.length - 2); // right after "ab", before the space

    pressEnter(view);

    expect(view.state.doc.toString()).toBe('**ab**\n**cd**');
  });

  it('splits a coloured highlight, both halves keeping the colour', () => {
    const doc = '==ab=={.red}';
    const view = mount(doc, '==a'.length);

    pressEnter(view);

    expect(view.state.doc.toString()).toBe('==a=={.red}\n==b=={.red}');
  });

  it('splits nested runs completely', () => {
    const doc = '***ab***';
    const view = mount(doc, '***a'.length);

    pressEnter(view);

    expect(view.state.doc.toString()).toBe('***a***\n***b***');
  });

  it('keeps the list going when the bold run is a bullet', () => {
    const doc = '- **ab**';
    const view = mount(doc, '- **a'.length);

    pressEnter(view);

    expect(view.state.doc.toString()).toBe('- **a**\n- **b**');
  });

  it('at the visual start of the run, moves the whole run down instead', () => {
    const doc = '**ab**';
    const view = mount(doc, '**'.length);

    pressEnter(view);

    expect(view.state.doc.toString()).toBe('\n**ab**');
  });
});

describe('caret movement across a folded link', () => {
  it('ArrowRight from the visible end jumps clean over the hidden "](url)", never into it', () => {
    const labelTo = LINK.indexOf(LABEL) + LABEL.length;
    const view = mount(LINK, labelTo);

    press(view, 'ArrowRight');

    expect(view.state.selection.main.head).toBe(LINK.length); // past the whole link, not one char into it
  });

  it('ArrowLeft from just past the link jumps clean over "](url)" back to the label', () => {
    const view = mount(LINK, LINK.length);

    press(view, 'ArrowLeft');

    expect(view.state.selection.main.head).toBe(LINK.indexOf(LABEL) + LABEL.length);
  });
});

describe('Backspace/Delete next to a folded link', () => {
  it('Backspace right after the link eats the last label character, never the trailing ")"', () => {
    const view = mount(LINK, LINK.length);

    press(view, 'Backspace');

    expect(view.state.doc.toString()).toBe('[Case](https://example.com/a)'); // markup intact
    expect(view.state.selection.main.head).toBe('[Case'.length);
  });

  it('Delete right before the link eats the first label character, never the leading "["', () => {
    const view = mount(LINK, 0);

    press(view, 'Delete');

    expect(view.state.doc.toString()).toBe('[ases](https://example.com/a)');
  });

  it('a link whose label is emptied goes whole — no orphaned "[](url)"', () => {
    const view = mount('[a](https://example.com/a)', '[a'.length);

    press(view, 'Backspace');

    expect(view.state.doc.toString()).toBe('');
  });
});

/**
 * The owner, 24.09.2026: "the caret is before bold, Backspace — the whole
 * text is gone". The folded `**` makes "before the marker" and "after the marker"
 * the same spot to the eye; either way the key must eat one visible
 * character on the far side, not the construct.
 */
describe('Backspace/Delete at the edge of folded emphasis', () => {
  it('Backspace at the visual start of a bold word eats the character before it', () => {
    const doc = 'ab **bold** c';
    const view = mount(doc, doc.indexOf('bold'));

    press(view, 'Backspace');

    expect(view.state.doc.toString()).toBe('ab**bold** c');
    expect(view.state.selection.main.head).toBe('ab**'.length); // still at the visual start of "bold"
  });

  it('Backspace right after the closing marker eats the last visible character', () => {
    const doc = 'ab **bold** c';
    const view = mount(doc, doc.indexOf('** c') + 2);

    press(view, 'Backspace');

    expect(view.state.doc.toString()).toBe('ab **bol** c');
    expect(view.state.selection.main.head).toBe('ab **bol'.length);
  });

  it('Delete right before the opening marker eats the first visible character', () => {
    const doc = 'ab **bold** c';
    const view = mount(doc, doc.indexOf('**'));

    press(view, 'Delete');

    expect(view.state.doc.toString()).toBe('ab **old** c');
  });

  it('Delete at the visual end of a bold word eats the character after it', () => {
    const doc = 'ab **bold** c';
    const view = mount(doc, doc.indexOf('bold') + 4);

    press(view, 'Delete');

    expect(view.state.doc.toString()).toBe('ab **bold**c');
  });

  it('at the start of a bulleted bold line, Backspace takes the bullet back as a unit', () => {
    const doc = '- **bold**';
    const view = mount(doc, doc.indexOf('bold'));

    press(view, 'Backspace');

    expect(view.state.doc.toString()).toBe('**bold**'); // not "-**bold**"
  });
});

/**
 * The owner, 24.09.2026: "I cut out bold text — **** stayed". Once
 * nothing is left between a pair of markers the pair itself has no reason
 * to stay.
 */
describe('emptying a folded construct drops its markers', () => {
  it('Backspace on a one-letter bold word removes the "****" with it', () => {
    const doc = 'ab **x** c';
    const view = mount(doc, doc.indexOf('x') + 1);

    press(view, 'Backspace');

    expect(view.state.doc.toString()).toBe('ab  c');
    expect(view.state.selection.main.head).toBe('ab '.length);
  });

  it('deleting a selection that is exactly the bold text (cut) removes the markers', () => {
    const doc = 'ab **bold** c';
    const view = mount(doc, 0);
    const from = doc.indexOf('bold');
    view.dispatch({ selection: EditorSelection.range(from, from + 4) });

    view.dispatch(view.state.update({ changes: { from, to: from + 4 }, userEvent: 'delete.cut' }));

    expect(view.state.doc.toString()).toBe('ab  c');
  });

  it('nested markers go together', () => {
    const doc = 'ab ***x*** c';
    const view = mount(doc, doc.indexOf('x') + 1);

    press(view, 'Backspace');

    expect(view.state.doc.toString()).toBe('ab  c');
  });

  it('an emptied <mark> pair goes too', () => {
    const doc = 'ab <mark>x</mark> c';
    const view = mount(doc, doc.indexOf('x') + 1);

    press(view, 'Backspace');

    expect(view.state.doc.toString()).toBe('ab  c');
  });

  it('an emptied ==highlight== goes together with its colour attribute', () => {
    const doc = 'ab ==x=={.green} c';
    const view = mount(doc, doc.indexOf('x') + 1);

    press(view, 'Backspace');

    expect(view.state.doc.toString()).toBe('ab  c');
  });

  it('a mid-word Backspace changes nothing but the character', () => {
    const doc = 'ab **bold** c';
    const view = mount(doc, doc.indexOf('bold') + 2);

    press(view, 'Backspace');

    expect(view.state.doc.toString()).toBe('ab **bld** c');
  });
});

/**
 * The owner, 24.09.2026: "the caret is before a heading, Backspace — the
 * formatting is gone". The folded `## ` hides the fact that the caret sits
 * right after a space the heading needs.
 */
describe('Backspace at the visual start of a heading', () => {
  it('after the hidden marker, with a blank line above: pulls the heading up, intact', () => {
    const doc = '# Title\n\npara\n\n## Heading';
    const view = mount(doc, doc.indexOf('Heading'));

    press(view, 'Backspace');

    expect(view.state.doc.toString()).toBe('# Title\n\npara\n## Heading');
    expect(view.state.selection.main.head).toBe(view.state.doc.toString().indexOf('Heading'));
  });

  it('before the hidden marker: the same', () => {
    const doc = '# Title\n\npara\n\n## Heading';
    const view = mount(doc, doc.indexOf('## Heading'));

    press(view, 'Backspace');

    expect(view.state.doc.toString()).toBe('# Title\n\npara\n## Heading');
  });

  it('with text directly above: the heading becomes a paragraph, nothing is glued', () => {
    const doc = '# Title\n\npara\n## Heading';
    const view = mount(doc, doc.indexOf('Heading'));

    press(view, 'Backspace');

    expect(view.state.doc.toString()).toBe('# Title\n\npara\nHeading');
    expect(view.state.selection.main.head).toBe(view.state.doc.toString().indexOf('Heading'));
  });

  it('a bold word opening the heading hands over to the same rule', () => {
    const doc = '# Title\n\npara\n\n## **Bold** rest';
    const view = mount(doc, doc.indexOf('Bold'));

    press(view, 'Backspace');

    expect(view.state.doc.toString()).toBe('# Title\n\npara\n## **Bold** rest');
  });

  it('the page title on line 1 is left alone', () => {
    const doc = '# Title\n\npara';
    const view = mount(doc, '# '.length);

    press(view, 'Backspace');

    expect(view.state.doc.toString()).toBe(doc);
  });
});

describe('a plain typed URL (no [text](url) markup)', () => {
  it('Enter after it produces a clean next line, untouched', () => {
    const url = 'https://example.com';
    const view = mount(url, url.length);

    pressEnter(view);

    expect(view.state.doc.lines).toBe(2);
    expect(view.state.doc.line(1).text).toBe(url);
    expect(view.state.doc.line(2).text).toBe('');
  });
});
