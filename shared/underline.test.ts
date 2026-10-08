import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import { remarkUnderline } from './underline';

const html = (md: string): string =>
  String(
    unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkUnderline)
      .use(remarkRehype)
      .use(rehypeStringify)
      .processSync(md),
  ).trim();

const roundTrip = (md: string): string =>
  String(unified().use(remarkParse).use(remarkGfm).use(remarkUnderline).use(remarkStringify).processSync(md)).trim();

describe('remarkUnderline: ++text++', () => {
  it('turns a ++pair++ into <ins>', () => {
    expect(html('a ++under++ b')).toBe('<p>a <ins>under</ins> b</p>');
  });

  it('nests with bold, italic and strike in any order', () => {
    expect(html('**++x++**')).toBe('<p><strong><ins>x</ins></strong></p>');
    expect(html('++**x**++')).toBe('<p><ins><strong>x</strong></ins></p>');
    expect(html('*++x++*')).toBe('<p><em><ins>x</ins></em></p>');
    expect(html('++*x*++')).toBe('<p><ins><em>x</em></ins></p>');
    expect(html('~~++x++~~')).toBe('<p><del><ins>x</ins></del></p>');
    expect(html('++~~x~~++')).toBe('<p><ins><del>x</del></ins></p>');
    expect(html('**a ++b++ c**')).toBe('<p><strong>a <ins>b</ins> c</strong></p>');
    expect(html('++a **b** c++')).toBe('<p><ins>a <strong>b</strong> c</ins></p>');
  });

  it('works next to punctuation like the other delimiters', () => {
    expect(html('(++x++).')).toBe('<p>(<ins>x</ins>).</p>');
    expect(html('**++Growth #2++**. Rest')).toBe('<p><strong><ins>Growth #2</ins></strong>. Rest</p>');
  });

  it('leaves programming-style plus signs alone', () => {
    expect(html('C++ and C++ rock')).toBe('<p>C++ and C++ rock</p>');
    expect(html('i++ then j++')).toBe('<p>i++ then j++</p>');
    expect(html('a + b ++ c')).toBe('<p>a + b ++ c</p>');
    expect(html('+++x+++')).toBe('<p>+++x+++</p>');
    expect(html('++ x ++')).toBe('<p>++ x ++</p>');
  });

  it('does not touch a list marker or code', () => {
    expect(html('+ item')).toBe('<ul>\n<li>item</li>\n</ul>');
    expect(html('`++x++`')).toBe('<p><code>++x++</code></p>');
  });

  it('round-trips through markdown', () => {
    for (const md of ['a ++under++ b', '**++x++**', '++**x**++', '++a *b* c++', '~~++x++~~']) {
      expect(roundTrip(md)).toBe(md);
    }
  });

  it('escapes a literal ++ pair so it does not turn into an underline on the way back', () => {
    const out = roundTrip('a \\++x\\++ b');
    expect(html(out)).toBe('<p>a ++x++ b</p>');
  });
});
