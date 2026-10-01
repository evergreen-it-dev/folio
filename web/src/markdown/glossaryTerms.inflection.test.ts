import { describe, expect, it } from 'vitest';
import { renderMarkdownToHtml } from './pipeline';

/**
 * Case forms of an inflected language: Ukrainian declines nouns, so a term
 * declared in the nominative has to light up in the other cases too.
 */
describe('glossary terms: Ukrainian case forms', () => {
  const DECL = '\n\n*[Октопус]: Восьминіг англійською\n';

  it('catches case endings of up to three letters', () => {
    const html = renderMarkdownToHtml(`Октопуса, Октопусом, Октопусів.${DECL}`, {} as never);
    expect(html.match(/folio-glossary-term/g)).toHaveLength(3);
    expect(html).toContain('>Октопуса</abbr>');
    expect(html).toContain('>Октопусів</abbr>');
  });

  it('does not catch a longer root — the ending there is too long', () => {
    const html = renderMarkdownToHtml(`Октопусоподібний${DECL}`, {} as never);
    expect(html).not.toContain('folio-glossary-term');
  });

  it('the exact form keeps working too', () => {
    expect(renderMarkdownToHtml(`Октопус${DECL}`, {} as never)).toContain('>Октопус</abbr>');
  });
});
