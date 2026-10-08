import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import {
  STATUS_COLORS,
  cleanStatusLabel,
  parseStatusAt,
  parseStatusAttrs,
  remarkStatusInText,
  resolveStatusColor,
  serializeStatus,
  statusClassNames,
  stripStatusDirectives,
} from './status.js';

describe('resolveStatusColor', () => {
  it('knows the six Confluence colours', () => {
    expect([...STATUS_COLORS]).toEqual(['grey', 'blue', 'green', 'yellow', 'red', 'purple']);
    for (const color of STATUS_COLORS) expect(resolveStatusColor(color)).toBe(color);
  });

  it('is case-insensitive and takes gray as grey', () => {
    expect(resolveStatusColor('GREEN')).toBe('green');
    expect(resolveStatusColor(' Red ')).toBe('red');
    expect(resolveStatusColor('gray')).toBe('grey');
  });

  it('falls back to grey for nothing and for anything unknown', () => {
    expect(resolveStatusColor(undefined)).toBe('grey');
    expect(resolveStatusColor(null)).toBe('grey');
    expect(resolveStatusColor('')).toBe('grey');
    expect(resolveStatusColor('magenta')).toBe('grey');
  });
});

describe('statusClassNames', () => {
  it('always carries the base class and the resolved colour', () => {
    expect(statusClassNames('green')).toEqual(['folio-status', 'folio-status--green']);
    expect(statusClassNames('nope')).toEqual(['folio-status', 'folio-status--grey']);
    expect(statusClassNames(undefined)).toEqual(['folio-status', 'folio-status--grey']);
  });
});

describe('parseStatusAttrs', () => {
  it('reads bare, double- and single-quoted values', () => {
    expect(parseStatusAttrs('color=green')).toBe('green');
    expect(parseStatusAttrs('color="blue"')).toBe('blue');
    expect(parseStatusAttrs("color='red'")).toBe('red');
    expect(parseStatusAttrs('colour=purple')).toBe('purple');
  });

  it('finds the colour among other attributes and says null when it is absent', () => {
    expect(parseStatusAttrs('.x color=yellow id=a')).toBe('yellow');
    expect(parseStatusAttrs('id=a')).toBeNull();
    expect(parseStatusAttrs(undefined)).toBeNull();
  });
});

describe('serializeStatus / parseStatusAt round trip', () => {
  it('writes grey without attributes and the others with color=', () => {
    expect(serializeStatus('Selected')).toBe(':status[Selected]');
    expect(serializeStatus('Selected', 'grey')).toBe(':status[Selected]');
    expect(serializeStatus('Selected', 'green')).toBe(':status[Selected]{color=green}');
  });

  it('stores the text as typed — no upper-casing', () => {
    expect(serializeStatus('In progress', 'blue')).toBe(':status[In progress]{color=blue}');
    expect(serializeStatus('PRÊT', 'green')).toBe(':status[PRÊT]{color=green}');
  });

  it('round-trips plain, accented and special-character labels', () => {
    for (const label of ['Selected', 'Prêt', 'a [b] c', 'x*y_z', 'back\\slash', 'a`b`', '<b>&amp;', '~~s~~']) {
      for (const color of STATUS_COLORS) {
        const source = serializeStatus(label, color);
        const parsed = parseStatusAt(source);
        expect(parsed, source).toEqual({ label, color, length: source.length });
      }
    }
  });

  it('collapses line breaks and runs of spaces in the label', () => {
    expect(cleanStatusLabel('  a \n b\t c ')).toBe('a b c');
    expect(serializeStatus('a\nb')).toBe(':status[a b]');
  });
});

describe('parseStatusAt', () => {
  it('parses with and without attributes, and measures the source', () => {
    expect(parseStatusAt(':status[Done]')).toEqual({ label: 'Done', color: 'grey', length: 13 });
    expect(parseStatusAt(':status[Done]{color=red} tail')).toEqual({ label: 'Done', color: 'red', length: ':status[Done]{color=red}'.length });
  });

  it('treats an unknown colour as grey and keeps the attribute in the length', () => {
    expect(parseStatusAt(':status[Done]{color=mauve}')).toEqual({ label: 'Done', color: 'grey', length: ':status[Done]{color=mauve}'.length });
  });

  it('only matches at the start, and not across a line break or an unclosed label', () => {
    expect(parseStatusAt('x :status[Done]')).toBeNull();
    expect(parseStatusAt(':status[Do\nne]')).toBeNull();
    expect(parseStatusAt(':status[Done')).toBeNull();
    expect(parseStatusAt(':state[Done]')).toBeNull();
  });
});

describe('stripStatusDirectives', () => {
  it('turns every tag into its text, for search and snippets', () => {
    expect(stripStatusDirectives('Level :status[Must have]{color=red} and :status[ok]')).toBe('Level Must have and ok');
    expect(stripStatusDirectives(':status[a \\[b\\]]{color=blue}')).toBe('a [b]');
  });

  it('leaves text without tags exactly as it was', () => {
    expect(stripStatusDirectives('15:16 and :other[x]{a=b}')).toBe('15:16 and :other[x]{a=b}');
  });
});

describe('remarkStatusInText (export pipelines, no remark-directive)', () => {
  const html = (md: string): string =>
    String(
      unified()
        .use(remarkParse)
        .use(remarkGfm)
        .use(remarkStatusInText)
        .use(remarkRehype)
        .use(rehypeStringify)
        .processSync(md),
    );

  it('renders the tag as a coloured span and keeps the surrounding text', () => {
    expect(html('Level: :status[Must have]{color=red} now')).toBe(
      '<p>Level: <span class="folio-status folio-status--red">Must have</span> now</p>',
    );
  });

  it('works inside a table cell and for two tags in one line', () => {
    const out = html('| a |\n| - |\n| :status[A]{color=green} :status[B] |');
    expect(out).toContain('<span class="folio-status folio-status--green">A</span>');
    expect(out).toContain('<span class="folio-status folio-status--grey">B</span>');
  });

  it('does not touch code', () => {
    const out = html('`:status[x]` and\n\n```\n:status[y]\n```');
    expect(out).not.toContain('folio-status');
  });
});
