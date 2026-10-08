import { describe, expect, it } from 'vitest';
import { migrateLegacyUnderline } from './underline-migrate';
import { runsOf } from './format';

const migrate = (md: string): string => migrateLegacyUnderline(md).markdown;

describe('migrateLegacyUnderline (<ins>/<u> -> ++, dry-run material)', () => {
  it('rewrites a plain pair', () => {
    expect(migrate('a <ins>word</ins> b')).toBe('a ++word++ b');
    expect(migrate('a <u>word</u> b')).toBe('a ++word++ b');
    expect(migrateLegacyUnderline('a <ins>word</ins> b').converted).toBe(1);
  });

  it('keeps padding outside the marks', () => {
    expect(migrate('a<ins> word </ins>b')).toBe('a ++word++ b');
  });

  it('nests correctly pairs that wrap or sit inside bold', () => {
    expect(migrate('<ins>**word**</ins>')).toBe('++**word**++');
    expect(migrate('**<ins>word</ins>**')).toBe('**++word++**');
  });

  it('un-crosses <ins>**x</ins>** (the pair the old toolbar wrote over bold)', () => {
    expect(migrate('<ins>**Ongoing Vision-Level-Goal #1</ins>** minimum 70K$/month')).toBe(
      '**++Ongoing Vision-Level-Goal #1++** minimum 70K$/month',
    );
    expect(migrate('**<ins>Growth Vision-Level-Goal #2</ins>**. rest')).toBe('**++Growth Vision-Level-Goal #2++**. rest');
    expect(migrate('x **a <ins>b** c</ins> d')).toBe('x **a ++b++** ++c++ d');
  });

  it('handles several pairs and nested ones on one line', () => {
    expect(migrate('<ins>a</ins> and <u>b</u>')).toBe('++a++ and ++b++');
    expect(migrate('<ins>a <u>b</u> c</ins>')).toBe('++a b c++');
  });

  it('is a fixed point: running it again changes nothing', () => {
    for (const md of ['<ins>**x</ins>** y', 'a <u>b</u>', '**<ins>x</ins>**', '<ins>a <u>b</u> c</ins>']) {
      const once = migrate(md);
      expect(migrate(once)).toBe(once);
      expect(runsOf(once, 'underline').some((run) => run.legacy)).toBe(false);
    }
  });

  it('leaves code, fences, lone tags and unparseable rewrites alone', () => {
    const code = 'see `<ins>x</ins>` here';
    expect(migrate(code)).toBe(code);
    const fenced = '```html\n<ins>x</ins>\n```';
    expect(migrate(fenced)).toBe(fenced);
    const lone = '<ins>never closed';
    const result = migrateLegacyUnderline(lone);
    expect(result.markdown).toBe(lone);
    expect(result.unpaired).toBe(1);
    // `foo++.bar++` would not parse as an underline: kept as it was, and counted.
    const tricky = migrateLegacyUnderline('foo<ins>.bar</ins>');
    expect(tricky.markdown).toBe('foo<ins>.bar</ins>');
    expect(tricky.skipped).toBe(1);
  });

  it('works line by line through a document, table cells included', () => {
    const doc = ['# T', '', '| a | b |', '| --- | --- |', '| <ins>x</ins> | **<u>y</u>** |', '', 'tail <ins>z</ins>'].join('\n');
    expect(migrate(doc)).toBe(
      ['# T', '', '| a | b |', '| --- | --- |', '| ++x++ | **++y++** |', '', 'tail ++z++'].join('\n'),
    );
  });
});
