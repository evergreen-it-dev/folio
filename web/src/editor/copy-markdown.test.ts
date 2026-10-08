import { describe, expect, it } from 'vitest';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { FolioHighlight } from './highlight-syntax';
import { FolioUnderline } from './underline-syntax';
import { FolioStatus } from './status-syntax';
import { noSetextHeadings } from './markdown-setup';
import { markdownForRange } from './copy-markdown';

/**
 * `‹` and `›` mark the selection exactly as a mouse drag over the *visible* text
 * would leave it: in Live edit the folded markers sit outside it.
 */
function copy(marked: string): string {
  const from = marked.indexOf('‹');
  const source = marked.replace('‹', '');
  const to = source.indexOf('›');
  const doc = source.replace('›', '');
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage, extensions: [FolioHighlight, FolioUnderline, FolioStatus, noSetextHeadings] })],
  });
  return markdownForRange(state, from, to);
}

describe('copy in Live edit keeps inline formatting', () => {
  it('the owner case: bold + highlight inside a numbered item', () => {
    expect(copy('2. **==‹SELECTED›==** Transfer')).toBe('**==SELECTED==**');
  });

  it('bold, italic (both marks), strikethrough, highlight, code', () => {
    expect(copy('a **‹bold›** b')).toBe('**bold**');
    expect(copy('a *‹ital›* b')).toBe('*ital*');
    expect(copy('a _‹ital›_ b')).toBe('_ital_');
    expect(copy('a ~~‹gone›~~ b')).toBe('~~gone~~');
    expect(copy('a ==‹lit›== b')).toBe('==lit==');
    expect(copy('a `‹code›` b')).toBe('`code`');
  });

  it('keeps the highlight colour attribute', () => {
    expect(copy('a ==‹lit›=={.green} b')).toBe('==lit=={.green}');
    expect(copy('a **==‹lit›=={.red}** b')).toBe('**==lit=={.red}**');
  });

  it('a partial selection of a bold word is wrapped on its own', () => {
    expect(copy('a **b‹ol›d** c')).toBe('**ol**');
    expect(copy('a `b‹ol›d` c')).toBe('`ol`');
  });

  it('moves whitespace outside the delimiters of a partial copy', () => {
    expect(copy('**foo‹ bar›**')).toBe(' **bar**');
    expect(copy('**‹foo ›bar**')).toBe('**foo** ');
    expect(copy('**foo‹ ›bar**')).toBe(' ');
  });

  it('a selection that runs out of the construct takes only the missing marker', () => {
    expect(copy('a **bo‹ld** and› c')).toBe('**ld** and');
    expect(copy('a ‹plain and **bo›ld** c')).toBe('plain and **bo**');
    expect(copy('‹x **a** y›')).toBe('x **a** y');
  });

  it('nested constructs: outer markers wrap inner ones', () => {
    expect(copy('**a ‹b ~~c~~› d**')).toBe('**b ~~c~~**');
    expect(copy('**a ~~‹c›~~ d**')).toBe('**~~c~~**');
    expect(copy('***‹x›***')).toBe('***x***');
  });

  it('links: the selected label brings the whole link', () => {
    expect(copy('see [‹the docs›](https://e.com/a) now')).toBe('[the docs](https://e.com/a)');
    expect(copy('see [the ‹docs›](https://e.com/a) now')).toBe('[docs](https://e.com/a)');
    expect(copy('see [**‹b›**](https://e.com) now')).toBe('[**b**](https://e.com)');
    expect(copy('see ‹[a](u)› now')).toBe('[a](u)');
  });

  it('status badges come whole, with their colour', () => {
    expect(copy('x ‹:status[Done]{color=green}› y')).toBe(':status[Done]{color=green}');
    expect(copy('**x ‹:status[Done]{color=green}› y**')).toBe('**:status[Done]{color=green}**');
  });

  it('underline ++text++, alone, nested and partial', () => {
    expect(copy('a ++‹under›++ b')).toBe('++under++');
    expect(copy('a ++un‹der›line++ b')).toBe('++der++');
    expect(copy('a **++‹x›++** b')).toBe('**++x++**');
    expect(copy('a ++**‹x›**++ b')).toBe('++**x**++');
    expect(copy('a ++‹x y›++ b')).toBe('++x y++');
    expect(copy('++foo‹ bar›++')).toBe(' ++bar++');
  });

  it('legacy <ins> / <mark> pairs, including partial selections', () => {
    expect(copy('a <ins>‹under›</ins> b')).toBe('<ins>under</ins>');
    expect(copy('a <mark>‹hl›</mark> b')).toBe('<mark>hl</mark>');
    expect(copy('a <ins>un‹der›line</ins> b')).toBe('<ins>der</ins>');
    expect(copy('a <ins>**‹b›**</ins>')).toBe('<ins>**b**</ins>');
  });

  it('plain text and code fences are untouched', () => {
    expect(copy('a ‹plain› b')).toBe('plain');
    expect(copy('```\n‹**not bold**›\n```')).toBe('**not bold**');
  });

  it('a selection covering whole constructs is just the source', () => {
    expect(copy('a ‹**bold** and ==hl==› b')).toBe('**bold** and ==hl==');
  });
});

describe('copy in Live edit keeps block prefixes when the whole line is selected', () => {
  it('list items', () => {
    expect(copy('- ‹item one›')).toBe('- item one');
    expect(copy('‹1. item one›')).toBe('1. item one');
    expect(copy('- ‹[ ] todo›')).toBe('- [ ] todo');
    expect(copy('- a\n  - ‹nested›\n- c')).toBe('  - nested');
  });

  it('headings', () => {
    expect(copy('## ‹Title›')).toBe('## Title');
    expect(copy('### ‹**Bold** title›')).toBe('### **Bold** title');
  });

  it('a partial selection inside a line stays bare', () => {
    expect(copy('- item ‹one›')).toBe('one');
    expect(copy('- ‹item› one')).toBe('item');
    expect(copy('## ‹Ti›tle')).toBe('Ti');
  });

  it('several lines carry the prefix of the first one too', () => {
    expect(copy('- ‹one\n- two›')).toBe('- one\n- two');
    expect(copy('## ‹Head\ntext› more')).toBe('## Head\ntext');
  });

  it('the whole formatted line, whichever ends the markers sit at', () => {
    expect(copy('- **‹bold›**')).toBe('- **bold**');
    expect(copy('‹2. **==SELECTED==** Transfer›')).toBe('2. **==SELECTED==** Transfer');
    expect(copy('2. **==‹SELECTED==** Transfer›')).toBe('**==SELECTED==** Transfer');
  });
});
