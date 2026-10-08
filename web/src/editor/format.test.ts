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

  it('uses ++…++ for underline (the owner, 08.10.2026: no HTML tags in the markdown)', () => {
    expect(INLINE_MARKS.underline).toEqual({ open: '++', close: '++' });
    expect(run('word', 0, 4, 'underline')).toBe('++«word»++');
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
      expect(run('++A sel++', 4, 7, 'underline')).toBe('++A++ «sel»');
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

describe('underline (++text++)', () => {
  const U = 'underline' as const;
  /** Select `needle` (first occurrence at or after `after`) and press U. */
  const press = (text: string, needle: string, after = 0): string => {
    const from = text.indexOf(needle, after);
    return run(text, from, from + needle.length, U);
  };

  it('wraps a plain word and takes it off again on the second press', () => {
    expect(press('a word b', 'word')).toBe('a ++«word»++ b');
    expect(press('a ++word++ b', 'word')).toBe('a «word» b');
  });

  it('goes INSIDE bold when the selection is the bold text: **++x++**', () => {
    expect(press('**word**', 'word')).toBe('**++«word»++**');
  });

  it('goes inside bold when the selection starts on the hidden opening ** (what live-mode dragging gives)', () => {
    // `**Ongoing Goal #1** rest`, selected from the `**` to the visible end of the bold text: the bug that wrote <ins>**…</ins>**.
    const text = '**Ongoing Goal #1** rest';
    expect(run(text, 0, '**Ongoing Goal #1'.length, U)).toBe('**++«Ongoing Goal #1»++** rest');
  });

  it('goes inside bold when the selection ends on the hidden closing **', () => {
    const text = 'x **Ongoing Goal #1** rest';
    expect(run(text, 4, text.indexOf(' rest'), U)).toBe('x **++«Ongoing Goal #1»++** rest');
  });

  it('wraps the whole bold run when the selection holds it entirely', () => {
    expect(run('a **bold** b', 0, 12, U)).toBe('++«a **bold** b»++');
    expect(press('a **bold** b', '**bold**')).toBe('a ++«**bold**»++ b');
  });

  it('never crosses: a selection that ends past a bold run is cut at its markers', () => {
    expect(press('**a b** c', 'b** c')).toBe('**a ++«b++** ++c»++');
  });

  it('never crosses italic, strike or bold-italic either', () => {
    expect(run('*Ongoing x* rest', 0, '*Ongoing x'.length, U)).toBe('*++«Ongoing x»++* rest');
    expect(run('~~Ongoing x~~ rest', 0, '~~Ongoing x'.length, U)).toBe('~~++«Ongoing x»++~~ rest');
    expect(run('***Ongoing x*** rest', 0, '***Ongoing x'.length, U)).toBe('***++«Ongoing x»++*** rest');
  });

  it('puts ++ outside bold when the selection takes the bold whole, and inside when it is a part of it', () => {
    expect(press('**a b c**', 'b')).toBe('**a ++«b»++ c**');
  });

  it('a part of an underline run is cut out of it, whitespace staying outside the markers', () => {
    expect(press('++A sel B++', 'sel')).toBe('++A++ «sel» ++B++');
    expect(press('++A sel++', 'sel')).toBe('++A++ «sel»');
    expect(press('++sel A++', 'sel')).toBe('«sel» ++A++');
  });

  it('a selection that holds the markers takes the whole run off', () => {
    expect(run('a ++word++ b', 2, 10, U)).toBe('a «word» b');
    expect(run('**++word++**', 0, 12, U)).toBe('«**word**»');
  });

  it('merges separate runs when the selection spans them and something plain', () => {
    expect(run('++a++ b ++c++', 0, 13, U)).toBe('++«a b c»++');
    expect(run('++ab++ cd', 3, 9, U)).toBe('++«ab cd»++');
  });

  it('takes underline off several adjacent runs selected together', () => {
    expect(run('++a++ ++b++', 0, 11, U)).toBe('«a b»');
  });

  it('a caret inside a run cuts it; at a visible edge it steps out; outside it opens a pair', () => {
    expect(run('++ab++', 3, 3, U)).toBe('++a++«»++b++');
    expect(run('++ab++ c', 4, 4, U)).toBe('++ab++«» c');
    expect(run('ab', 1, 1, U)).toBe('a++«»++b');
  });

  it('wraps inline code and links whole instead of cutting them', () => {
    expect(press('a `code` b', 'ode')).toBe('a ++«`code`»++ b');
    expect(press('see [label](https://x.y) now', 'abel')).toBe('see ++«[label](https://x.y)»++ now');
  });

  it('does not read C++ or a lone ++ as an underline run', () => {
    expect(runsOf('C++ and C++ rock', 'underline')).toEqual([]);
    expect(runsOf('a ++ b ++ c', 'underline')).toEqual([]);
    expect(formatActiveIn('C++ and C++ rock', 5, 7, U)).toBe(false);
    expect(runsOf('`++x++` and ++y++', 'underline').map((r) => [r.innerFrom, r.innerTo])).toEqual([[14, 15]]);
  });

  it('reports the state by the run, including a caret on its markers', () => {
    expect(formatActiveIn('a ++word++ b', 6, 6, U)).toBe(true);
    expect(formatActiveIn('a ++word++ b', 2, 10, U)).toBe(true);
    expect(formatActiveIn('a ++word++ b', 0, 1, U)).toBe(false);
    expect(formatActiveIn('**++word++**', 5, 5, U)).toBe(true);
    expect(formatActiveIn('++a++ ++b++', 0, 11, U)).toBe(true);
  });

  describe('old <ins>/<u> pairs (pages from before ++)', () => {
    it('are read as underline runs', () => {
      expect(formatActiveIn('a <ins>x</ins> b', 8, 8, U)).toBe(true);
      expect(formatActiveIn('a <u>x</u> b', 6, 6, U)).toBe(true);
      expect(runsOf('a <ins>x</ins>', 'underline')[0].legacy).toBe(true);
    });

    it('lose their tags when the selection holds them, or the text they wrap', () => {
      expect(run('a <ins>word</ins> b', 2, 17, U)).toBe('a «word» b');
      expect(press('a <ins>word</ins> b', 'word')).toBe('a «word» b');
      expect(press('a <u>word</u> b', 'word')).toBe('a «word» b');
    });

    it('a part of one is cut out of it, the leftovers coming out as ++', () => {
      expect(press('<ins>A sel B</ins>', 'sel')).toBe('++A++ «sel» ++B++');
    });

    it('a crossed pair <ins>**x</ins>** goes whole — the leftover could only cross again', () => {
      const text = '<ins>**Ongoing Goal #1</ins>** rest';
      expect(press(text, 'Goal')).toBe('**Ongoing «Goal» #1** rest');
      // caret
      const at = text.indexOf('Goal');
      expect(applyFormatEdit(text, inlineFormatEdit(text, at, at, U))).toBe('**Ongoing Goal #1** rest');
    });

    it('turning underline ON over text that touches a legacy pair merges them into one ++ run', () => {
      expect(run('<ins>ab</ins> cd', 6, 16, U)).toBe('++«ab cd»++');
    });

    it('selecting the crossed line and pressing U once more writes a clean nested pair', () => {
      const text = '<ins>**Ongoing Goal #1</ins>** rest';
      // not covered by the crossed run entirely (` rest` is plain): ON, merged, cut at the bold markers.
      expect(run(text, 0, text.length, U)).toBe('++«**Ongoing Goal #1** rest»++');
    });
  });

  it('is applied identically to a table cell value (same pure edit)', () => {
    const edit = inlineFormatEdit('**x** y', 2, 3, U);
    expect(applyFormatEdit('**x** y', edit)).toBe('**++x++** y');
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
