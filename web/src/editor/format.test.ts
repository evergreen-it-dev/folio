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
  linkOverSelectionEdit,
  pastedUrl,
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

describe('pastedUrl', () => {
  it('accepts exactly one http(s) URL, ignoring the whitespace around it', () => {
    expect(pastedUrl('https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c');
    expect(pastedUrl('  http://localhost:4871/x\n')).toBe('http://localhost:4871/x');
    expect(pastedUrl('HTTPS://EXAMPLE.COM')).toBe('HTTPS://EXAMPLE.COM');
  });

  it('keeps what the markdown package used to link: www. gets https://, mailto: stays', () => {
    expect(pastedUrl('www.example.com/a')).toBe('https://www.example.com/a');
    expect(pastedUrl('mailto:a@example.com')).toBe('mailto:a@example.com');
  });

  it('refuses anything that is not a lone URL', () => {
    expect(pastedUrl('')).toBeNull();
    expect(pastedUrl('example.com')).toBeNull();
    expect(pastedUrl('www.example.com and more')).toBeNull();
    expect(pastedUrl('mailto:someone')).toBeNull();
    expect(pastedUrl('ftp://example.com/file')).toBeNull();
    expect(pastedUrl('https://')).toBeNull();
    expect(pastedUrl('see https://example.com')).toBeNull();
    expect(pastedUrl('https://example.com and more')).toBeNull();
    expect(pastedUrl('https://example.com/a\nhttps://example.com/b')).toBeNull();
    expect(pastedUrl('<https://example.com>')).toBeNull();
    expect(pastedUrl('[a](https://example.com)')).toBeNull();
  });
});

describe('linkOverSelectionEdit', () => {
  const URL = 'https://example.com/page';

  /** The text after the edit, or null when the paste must stay a plain replacement. */
  function pasteOver(text: string, selected: string, url = URL): string | null {
    const from = text.indexOf(selected);
    const edit = linkOverSelectionEdit(text, from, from + selected.length, url);
    return edit ? applyFormatEdit(text, edit) : null;
  }

  it('turns the selection into [selection](url) and leaves the caret after it', () => {
    const text = 'call 02/10 now';
    const edit = linkOverSelectionEdit(text, 5, 10, URL)!;
    const out = applyFormatEdit(text, edit);
    expect(out).toBe(`call [02/10](${URL}) now`);
    expect(edit.selection.from).toBe(edit.selection.to);
    expect(out.slice(0, edit.selection.from)).toBe(`call [02/10](${URL})`);
  });

  it('keeps formatting the selection fully contains', () => {
    expect(pasteOver('a **bold** b', '**bold**')).toBe(`a [**bold**](${URL}) b`);
    expect(pasteOver('a ==hot== b', '==hot==')).toBe(`a [==hot==](${URL}) b`);
    expect(pasteOver('a `x` b', '`x`')).toBe(`a [\`x\`](${URL}) b`);
    expect(pasteOver('a **bold** b', 'bold')).toBe(`a **[bold](${URL})** b`);
    expect(pasteOver('a **two words** b', 'two')).toBe(`a **[two](${URL}) words** b`);
  });

  it('widens a selection that stops at the visible edge of a run over the hidden marker', () => {
    // A cell shows `a bold word` without the stars: selecting "a bold" there
    // hands over the offsets of `a **bold`, one marker short of the run's end.
    const text = 'a **bold** word';
    expect(applyFormatEdit(text, linkOverSelectionEdit(text, 0, 8, URL)!)).toBe(`[a **bold**](${URL}) word`);
    expect(applyFormatEdit(text, linkOverSelectionEdit(text, 4, 15, URL)!)).toBe(`a [**bold** word](${URL})`);
    expect(applyFormatEdit('a `x` b', linkOverSelectionEdit('a `x` b', 0, 4, URL)!)).toBe(`[a \`x\`](${URL}) b`);
    // Only the inside of the run (no marker needed) stays inside it.
    expect(applyFormatEdit(text, linkOverSelectionEdit(text, 4, 8, URL)!)).toBe(`a **[bold](${URL})** word`);
  });

  it('keeps the padding of the selection outside the brackets', () => {
    expect(pasteOver('a word b', ' word ')).toBe(`a [word](${URL}) b`);
  });

  it('writes an address with a parenthesis in the <…> form, like every other link target', () => {
    const url = 'https://en.wikipedia.org/wiki/Folio_(book)';
    expect(pasteOver('see Folio now', 'Folio', url)).toBe(`see [Folio](<${url}>) now`);
  });

  it('starts after a list marker, a task box, a quote or a heading mark', () => {
    expect(linkOverSelectionEdit('- 02/10', 0, 7, URL)).toMatchObject({
      changes: [{ from: 2, to: 7, insert: `[02/10](${URL})` }],
    });
    expect(pasteOver('• item one', '• item one')).toBe(`• [item one](${URL})`);
    expect(pasteOver('  2. item', '  2. item')).toBe(`  2. [item](${URL})`);
    expect(pasteOver('[ ] todo', '[ ] todo')).toBe(`[ ] [todo](${URL})`);
    expect(pasteOver('> quoted', '> quoted')).toBe(`> [quoted](${URL})`);
    expect(pasteOver('## Title', '## Title')).toBe(`## [Title](${URL})`);
    // A selection that never leaves the marker has no words to link.
    expect(linkOverSelectionEdit('- item', 0, 2, URL)).toBeNull();
  });

  it('works on the selected line of a multi-line cell value', () => {
    const value = '• first\n• second line\n• third';
    expect(pasteOver(value, 'second line')).toBe(`• first\n• [second line](${URL})\n• third`);
  });

  it('stays a plain replacement when nothing useful is selected', () => {
    expect(linkOverSelectionEdit('word', 2, 2, URL)).toBeNull();
    expect(linkOverSelectionEdit('a   b', 1, 4, URL)).toBeNull();
  });

  it('stays a plain replacement over several lines', () => {
    expect(pasteOver('one\ntwo', 'one\ntwo')).toBeNull();
    expect(pasteOver('• one\n• two', 'one\n• two')).toBeNull();
  });

  it('stays a plain replacement when the selection is itself an address', () => {
    expect(pasteOver('see https://example.com/old now', 'https://example.com/old')).toBeNull();
    expect(pasteOver('see www.example.com now', 'www.example.com')).toBeNull();
  });

  it('never nests links: inside, around or across an existing link or image', () => {
    const text = 'a [label](https://example.com/x) b ![alt](/img.png) c';
    expect(pasteOver(text, 'label')).toBeNull();
    expect(pasteOver(text, '[label](https://example.com/x)')).toBeNull();
    expect(pasteOver(text, 'a [label')).toBeNull();
    expect(pasteOver(text, 'x) b')).toBeNull();
    expect(pasteOver(text, 'alt')).toBeNull();
    expect(pasteOver(text, '![alt](/img.png)')).toBeNull();
    expect(pasteOver(text, 'a [label](https://example.com/x) b')).toBeNull();
    // ...but words next to them are fine.
    expect(pasteOver(text, ' b ')).toBe(`a [label](https://example.com/x) [b](${URL}) ![alt](/img.png) c`);
  });

  it('recognises a link whose destination is in <…> form or holds parentheses', () => {
    expect(pasteOver('a [t](<https://example.com/a(1)>) b', 't')).toBeNull();
    expect(pasteOver('a [t](https://example.com/a_(1)) b', 't')).toBeNull();
  });

  it('leaves an autolink, a bare address and a raw HTML anchor alone', () => {
    expect(pasteOver('a <https://example.com/x> b', 'example')).toBeNull();
    expect(pasteOver('a https://example.com/x b', 'example')).toBeNull();
    expect(pasteOver('a <a href="/x">label</a> b', 'label')).toBeNull();
  });

  it('stays a plain replacement inside inline code, or across its backticks', () => {
    expect(pasteOver('run `npm test` now', 'npm')).toBeNull();
    expect(pasteOver('run `npm test` now', '`npm')).toBeNull();
    expect(pasteOver('run `npm test` now', 'run `npm')).toBeNull();
    expect(pasteOver('run ``a ` b`` now', 'b')).toBeNull();
  });

  it('stays a plain replacement when the link would straddle an emphasis pair', () => {
    expect(pasteOver('a **bold** b', '**bol')).toBeNull();
    expect(pasteOver('a **bold** b', 'a **bo')).toBeNull();
    expect(pasteOver('a **bold** b', 'ld** b')).toBeNull();
    expect(pasteOver('a **bold** b', 'bold*')).toBeNull();
  });

  it('stays a plain replacement when a stray bracket would end the label early', () => {
    expect(pasteOver('a ] b', ']')).toBeNull();
    expect(pasteOver('a [ b', '[')).toBeNull();
    expect(pasteOver('a back\\ b', 'back\\')).toBeNull();
    expect(pasteOver('a [x] b', '[x]')).toBe(`a [[x]](${URL}) b`);
  });
});
