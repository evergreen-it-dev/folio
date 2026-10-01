/**
 * The formatting toolbar's edits, checked as pure text transforms: what markers
 * go in, what comes back out when the same button is pressed twice, and where
 * the selection lands so the next keystroke is still inside the format.
 */
import { describe, expect, it } from 'vitest';
import {
  INLINE_MARKS,
  LINK_PLACEHOLDER,
  applyFormatEdit,
  formatActiveIn,
  highlightColorAt,
  highlightColorEdit,
  inlineFormatEdit,
  linkEdit,
  quoteEdit,
  runsOf,
  type InlineFormat,
} from './format';

/** Apply an edit and mark the resulting selection with «…» so it reads. */
function run(text: string, from: number, to: number, format: InlineFormat): string {
  const edit = inlineFormatEdit(text, from, to, format);
  const out = applyFormatEdit(text, edit);
  const { from: a, to: b } = edit.selection;
  return `${out.slice(0, a)}«${out.slice(a, b)}»${out.slice(b)}`;
}

describe('inlineFormatEdit', () => {
  it('writes the marker GFM (and GitHub) understands for each format', () => {
    expect(run('word', 0, 4, 'bold')).toBe('**«word»**');
    expect(run('word', 0, 4, 'italic')).toBe('*«word»*');
    expect(run('word', 0, 4, 'strike')).toBe('~~«word»~~');
    expect(run('word', 0, 4, 'code')).toBe('`«word»`');
  });

  it('uses <ins> for underline — markdown has no syntax and <u> is not allowed', () => {
    expect(INLINE_MARKS.underline).toEqual({ open: '<ins>', close: '</ins>' });
    expect(run('word', 0, 4, 'underline')).toBe('<ins>«word»</ins>');
  });

  it('uses ==…== for highlight (the owner: no HTML in the markdown), reading legacy <mark> too', () => {
    expect(INLINE_MARKS.highlight).toEqual({ open: '==', close: '==' });
    expect(run('word', 0, 4, 'highlight')).toBe('==«word»==');
    expect(run('a <mark>hi</mark> b', 2, 18, 'highlight')).toBe('a «hi» b');
    expect(run('a ==hi=={.green} b', 4, 6, 'highlight')).toBe('a «hi» b');
  });

  it('wraps only part of a line, leaving the rest alone', () => {
    expect(run('a word b', 2, 6, 'bold')).toBe('a **«word»** b');
  });

  it('unwraps when the markers are inside the selection', () => {
    expect(run('**word**', 0, 8, 'bold')).toBe('«word»');
  });

  it('unwraps when the markers are just outside the selection', () => {
    expect(run('**word**', 2, 6, 'bold')).toBe('«word»');
    expect(run('a <mark>hi</mark> b', 8, 10, 'highlight')).toBe('a «hi» b');
  });

  // The owner, 24.09.2026: "I selected a piece of bold, cmd+b — it did not take the bold off that part".
  describe('part of a run', () => {
    it('the tail: the run closes before it, whitespace stays outside the markers', () => {
      expect(run('**A sel** c', 4, 7, 'bold')).toBe('**A** «sel» c');
    });

    it('the head: the run opens after it', () => {
      expect(run('**sel A** c', 2, 5, 'bold')).toBe('«sel» **A** c');
    });

    it('the middle: the run is cut in two', () => {
      expect(run('**A sel B**', 4, 7, 'bold')).toBe('**A** «sel» **B**');
    });

    it('a selection with its own padding cuts between the words', () => {
      expect(run('**A sel B**', 3, 8, 'bold')).toBe('**A** «sel» **B**');
    });

    it('a caret inside the run closes and reopens it, so typing there is plain', () => {
      expect(run('**ab**', 3, 3, 'bold')).toBe('**a**«»**b**');
    });

    it('a caret at the visible end of the run just steps out of it', () => {
      expect(run('**ab** c', 4, 4, 'bold')).toBe('**ab**«» c');
    });

    it('works for the other formats too', () => {
      expect(run('~~A sel~~', 4, 7, 'strike')).toBe('~~A~~ «sel»');
      expect(run('<ins>A sel</ins>', 7, 10, 'underline')).toBe('<ins>A</ins> «sel»');
      expect(run('==A sel=={.green}', 4, 7, 'highlight')).toBe('==A=={.green} «sel»');
    });

    it('a triple-star run is not a bold run — no cutting inside ***x***', () => {
      expect(runsOf('***ab***', 'bold')).toEqual([]);
    });
  });

  it('reports the format as active anywhere in a run', () => {
    expect(formatActiveIn('a **bold** b', 5, 5, 'bold')).toBe(true);
    expect(formatActiveIn('a **bold** b', 4, 7, 'bold')).toBe(true);
    expect(formatActiveIn('a **bold** b', 0, 1, 'bold')).toBe(false);
    expect(formatActiveIn('a <mark>x</mark>', 9, 9, 'highlight')).toBe(true);
  });

  it('is its own inverse', () => {
    for (const format of ['bold', 'italic', 'underline', 'strike', 'code', 'highlight'] as const) {
      const marks = INLINE_MARKS[format];
      const wrapped = `${marks.open}word${marks.close}`;
      expect(applyFormatEdit(wrapped, inlineFormatEdit(wrapped, 0, wrapped.length, format))).toBe('word');
    }
  });

  it('leaves the caret between the markers when nothing is selected', () => {
    expect(run('', 0, 0, 'bold')).toBe('**«»**');
    expect(run('ab', 1, 1, 'code')).toBe('a`«»`b');
  });

  it('keeps the padding outside the markers — GFM would not read them otherwise', () => {
    expect(run('a word b', 1, 7, 'bold')).toBe('a **«word»** b');
  });

  it('clamps a selection that runs past the text', () => {
    expect(run('ab', -3, 99, 'italic')).toBe('*«ab»*');
  });
});

/** `highlightColorEdit` with the same «…» notation. */
function paint(text: string, from: number, to: number, color: Parameters<typeof highlightColorEdit>[3]): string {
  const edit = highlightColorEdit(text, from, to, color);
  const out = applyFormatEdit(text, edit);
  const { from: a, to: b } = edit.selection;
  return `${out.slice(0, a)}«${out.slice(a, b)}»${out.slice(b)}`;
}

describe('highlightColorEdit', () => {
  it('wraps plain text with the colour, yellow written plain', () => {
    expect(paint('word', 0, 4, 'green')).toBe('==«word»=={.green}');
    expect(paint('word', 0, 4, 'yellow')).toBe('==«word»==');
    expect(paint('word', 0, 4, null)).toBe('==«word»==');
  });

  it('recolours the run the selection is in', () => {
    expect(paint('a ==hi== b', 4, 6, 'red')).toBe('a ==«hi»=={.red} b');
    expect(paint('a ==hi=={.red} b', 5, 5, 'blue')).toBe('a ==h«»i=={.blue} b');
  });

  it('recolours only the selected part of a run, keeping the rest in its own colour', () => {
    expect(paint('==A sel B=={.green}', 4, 7, 'red')).toBe('==A=={.green} ==«sel»=={.red} ==B=={.green}');
  });

  it('turns a legacy <mark> run into ==…==', () => {
    expect(paint('<mark>hi</mark>', 6, 8, 'teal')).toBe('==«hi»=={.teal}');
  });

  it('tells which colour the selection sits in', () => {
    expect(highlightColorAt('a ==hi=={.red} b', 5, 5)).toBe('red');
    expect(highlightColorAt('a ==hi== b', 5, 5)).toBeNull();
    expect(highlightColorAt('a <mark>hi</mark> b', 9, 9)).toBeNull();
    expect(highlightColorAt('plain', 2, 2)).toBeUndefined();
  });
});

describe('quoteEdit', () => {
  const apply = (text: string, from: number, to: number) =>
    applyFormatEdit(text, quoteEdit(text, from, to));

  it('quotes the line the caret is on', () => {
    expect(apply('one\ntwo', 1, 1)).toBe('> one\ntwo');
  });

  it('quotes every line the selection touches', () => {
    expect(apply('one\ntwo\nthree', 1, 9)).toBe('> one\n> two\n> three');
  });

  it('does not reach into a line the selection only ends at', () => {
    expect(apply('one\ntwo', 0, 4)).toBe('> one\ntwo');
  });

  it('unquotes when every covered line is already quoted', () => {
    expect(apply('> one\n> two', 0, 11)).toBe('one\ntwo');
  });

  it('quotes the rest when only some lines are quoted', () => {
    expect(apply('> one\ntwo', 0, 9)).toBe('> > one\n> two');
  });

  it('keeps the selection over the same text', () => {
    const edit = quoteEdit('one', 0, 3);
    expect(applyFormatEdit('one', edit).slice(edit.selection.from, edit.selection.to)).toBe('one');
  });
});

/** Same «…» notation as `run`, for the link edit. */
function link(text: string, from: number, to: number): string {
  const edit = linkEdit(text, from, to);
  const out = applyFormatEdit(text, edit);
  const { from: a, to: b } = edit.selection;
  return `${out.slice(0, a)}«${out.slice(a, b)}»${out.slice(b)}`;
}

describe('linkEdit', () => {
  it('wraps a selected word and hands the author the target to type', () => {
    expect(link('word', 0, 4)).toBe(`[word](«${LINK_PLACEHOLDER.url}»)`);
  });

  it('treats a selected URL as the target and asks for the label instead', () => {
    expect(link('https://folio.test/a', 0, 20)).toBe(
      `[«${LINK_PLACEHOLDER.text}»](https://folio.test/a)`,
    );
    // Relative and in-page targets count too.
    expect(link('/s/eng/p/1', 0, 10)).toBe(`[«${LINK_PLACEHOLDER.text}»](/s/eng/p/1)`);
    expect(link('#heading', 0, 8)).toBe(`[«${LINK_PLACEHOLDER.text}»](#heading)`);
  });

  it('drops a whole placeholder in when nothing is selected', () => {
    expect(link('', 0, 0)).toBe(`[«${LINK_PLACEHOLDER.text}»](${LINK_PLACEHOLDER.url})`);
  });

  it('never puts the brackets around the selection padding', () => {
    expect(link('a word b', 1, 7)).toBe(`a [word](«${LINK_PLACEHOLDER.url}») b`);
  });

  it('leaves a sentence with a colon in it alone — that is a label, not a URL', () => {
    expect(link('note: this', 0, 10)).toBe(`[note: this](«${LINK_PLACEHOLDER.url}»)`);
  });
});
