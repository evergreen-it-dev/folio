import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import { remarkGlossaryTerms } from './glossaryTerms';
import { renderMarkdownToHtml } from './pipeline';

/** Runs just this plugin (plus GFM, for realistic table/link parsing) and stringifies the result — no sanitizer, so the sanitizer-survival check below is the one test that goes through the real pipeline instead. */
function render(markdown: string): string {
  const file = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkGlossaryTerms)
    .use(remarkRehype)
    .use(rehypeStringify)
    .processSync(markdown);
  return String(file);
}

const opts = { space: 'engineering', pagePath: 'notes/glossary.md' };

describe('remarkGlossaryTerms', () => {
  it('removes a standalone declaration from the output', () => {
    const html = render('*[Octopus]: An eight-armed sea animal\n');
    expect(html).not.toContain('An eight-armed sea animal');
    expect(html).not.toContain('Octopus');
    expect(html).not.toContain('*[');
  });

  it('strips only the declaration LINE, keeping ordinary text before/after it in the same paragraph', () => {
    const html = render(
      ['Plain text.', '*[Octopus]: An eight-armed sea animal', 'And more text.'].join('\n'),
    );
    expect(html).toContain('Plain text.');
    expect(html).toContain('And more text.');
    expect(html).not.toContain('*[');
    expect(html).not.toContain('An eight-armed sea animal');
  });

  it('wraps every later occurrence of a declared term in an <abbr>, preserving source casing', () => {
    const html = render(
      ['We have Octopus in the project. One more octopus and OCTOPUS.', '', '*[Octopus]: An eight-armed sea animal'].join(
        '\n',
      ),
    );
    expect(html).toContain('<abbr class="folio-glossary-term" title="An eight-armed sea animal">Octopus</abbr>');
    expect(html).toContain('<abbr class="folio-glossary-term" title="An eight-armed sea animal">octopus</abbr>');
    expect(html).toContain('<abbr class="folio-glossary-term" title="An eight-armed sea animal">OCTOPUS</abbr>');
  });

  it('matches only on word boundaries — never inside a longer word', () => {
    const html = render(
      ['Octopusoid is not a term, but Cat is a term.', '', '*[Cat]: A domestic animal'].join('\n'),
    );
    // "Cat" only lights up as its own word, not e.g. inside "Category" below.
    expect(html).toContain('<abbr class="folio-glossary-term" title="A domestic animal">Cat</abbr>');
    const secondHtml = render(['Category — a grouping, not a term.', '', '*[Cat]: A domestic animal'].join('\n'));
    expect(secondHtml).not.toContain('<abbr');
    expect(secondHtml).toContain('Category');
  });

  it('never lights up text inside inline code, fenced code, link text, or headings', () => {
    const html = render(
      [
        '# Octopus — a heading',
        '',
        '`Octopus` in code.',
        '',
        '```',
        'Octopus in a code block',
        '```',
        '',
        '[Octopus](https://example.com) as link text.',
        '',
        'And here Octopus is plain text.',
        '',
        '*[Octopus]: An eight-armed sea animal',
      ].join('\n'),
    );
    expect(html).toContain('<h1>Octopus — a heading</h1>');
    expect(html).toContain('<code>Octopus</code>');
    expect(html).toContain('Octopus in a code block');
    expect(html).toContain('<a href="https://example.com">Octopus</a>');
    // Only the one plain-text occurrence becomes an <abbr>.
    expect(html.match(/<abbr /g)?.length).toBe(1);
    expect(html).toContain('<abbr class="folio-glossary-term" title="An eight-armed sea animal">Octopus</abbr>');
  });

  it('prefers the longer term when one is a prefix of another', () => {
    const html = render(
      [
        'Our Octopus Prime is ready, and the plain Octopus is not.',
        '',
        '*[Octopus]: An eight-armed sea animal',
        '*[Octopus Prime]: An improved version of the octopus',
      ].join('\n'),
    );
    expect(html).toContain(
      '<abbr class="folio-glossary-term" title="An improved version of the octopus">Octopus Prime</abbr>',
    );
    expect(html).toContain('<abbr class="folio-glossary-term" title="An eight-armed sea animal">Octopus</abbr>');
    // The long match must not ALSO leave a nested/overlapping short match behind.
    expect(html).not.toContain('<abbr class="folio-glossary-term" title="An eight-armed sea animal">Octopus</abbr> Prime');
  });

  it('is a no-op when the page declares no terms', () => {
    const html = render('Just text without declarations.');
    expect(html).toBe('<p>Just text without declarations.</p>');
  });

  it('leaves an undeclared word alone even if it looks similar', () => {
    const html = render(['An Octopod is not an Octopus.', '', '*[Octopus]: An eight-armed sea animal'].join('\n'));
    expect(html).not.toContain('<abbr class="folio-glossary-term" title="An eight-armed sea animal">Octopod</abbr>');
    expect(html).toContain('<abbr class="folio-glossary-term" title="An eight-armed sea animal">Octopus</abbr>');
  });
});

describe('renderMarkdownToHtml: glossary terms survive rehype-sanitize', () => {
  it('keeps the abbr tag, its class, and its title attribute after sanitizing', () => {
    const html = renderMarkdownToHtml(
      ['Our Octopus is the pride of the team.', '', '*[Octopus]: An eight-armed sea animal'].join('\n'),
      opts,
    );
    expect(html).toContain('<abbr class="folio-glossary-term" title="An eight-armed sea animal">Octopus</abbr>');
  });

  it('the declaration itself never reaches the sanitized output', () => {
    const html = renderMarkdownToHtml('*[Octopus]: An eight-armed sea animal\n\nPlain text.', opts);
    expect(html).not.toContain('*[');
    expect(html).not.toContain('An eight-armed sea animal');
    expect(html).toContain('Plain text.');
  });
});

/**
 * The owner, 11.09: "we do it with an ending of up to 3 letters". Many
 * languages inflect, so the declared word is a stem, not an exact form. The
 * case forms of an inflected language are checked next door, in
 * glossaryTerms.inflection.test.ts.
 */
describe('inflection', () => {
  const DECL = '\n\n*[Octopus]: An eight-armed sea animal\n';

  it('catches endings of up to three letters', () => {
    const html = renderMarkdownToHtml(`Octopuses and an Octopusy day.${DECL}`, {} as never);
    expect(html.match(/folio-glossary-term/g)).toHaveLength(2);
    expect(html).toContain('>Octopuses</abbr>');
  });

  it('does not catch a longer root — the ending there is too long', () => {
    const html = renderMarkdownToHtml(`Octopuslike${DECL}`, {} as never);
    expect(html).not.toContain('folio-glossary-term');
  });

  it('the exact form keeps working too', () => {
    expect(renderMarkdownToHtml(`Octopus${DECL}`, {} as never)).toContain('>Octopus</abbr>');
  });
});
