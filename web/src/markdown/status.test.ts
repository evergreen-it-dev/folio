import { describe, expect, it } from 'vitest';
import { renderMarkdownToHtml } from './pipeline';

const render = (md: string): string => renderMarkdownToHtml(md, { space: 's', pagePath: 'p.md' });

describe('status tag in reading mode', () => {
  it('renders :status[Text]{color=green} as a coloured badge span', () => {
    expect(render(':status[Selected]{color=green}')).toBe(
      '<p><span class="folio-status folio-status--green">Selected</span></p>',
    );
  });

  it('keeps the text as typed — upper case is the stylesheet\'s job', () => {
    const html = render('A :status[in progress]{color=blue} B');
    expect(html).toContain('>in progress</span>');
    expect(html).not.toContain('IN PROGRESS');
    expect(html).toContain('<p>A <span');
  });

  it('defaults to grey with no attribute, and for an unknown colour', () => {
    expect(render(':status[Plain]')).toContain('folio-status--grey');
    expect(render(':status[Odd]{color=mauve}')).toContain('folio-status--grey');
    expect(render(':status[Odd]{color=mauve}')).not.toContain('mauve');
  });

  it('reads every palette colour', () => {
    for (const color of ['grey', 'blue', 'green', 'yellow', 'red', 'purple']) {
      expect(render(`:status[x]{color=${color}}`)).toContain(`folio-status--${color}`);
    }
    expect(render(':status[x]{color="red"}')).toContain('folio-status--red');
  });

  it('shows escaped label characters verbatim', () => {
    const html = render(':status[a \\[b\\] \\*c\\*]{color=red}');
    expect(html).toContain('>a [b] *c*</span>');
  });

  it('works inside headings, list items and table cells', () => {
    expect(render('## Plan :status[Open]{color=yellow}')).toContain('folio-status--yellow');
    expect(render('- item :status[Done]{color=green}')).toContain('folio-status--green');
    expect(render('| a |\n| - |\n| :status[Done]{color=green} |')).toContain('folio-status--green');
  });

  it('leaves code alone and never prints the raw syntax for a real tag', () => {
    expect(render('`:status[x]{color=red}`')).toContain(':status[x]{color=red}');
    expect(render(':status[Done]{color=green}')).not.toContain(':status');
  });

  it('keeps an empty label as the text the author wrote', () => {
    expect(render('a :status[] b')).toContain(':status[]');
  });

  it('does not eat ordinary times or other colon text', () => {
    expect(render('at 15:16 today')).toContain('15:16');
    expect(render('see :status now')).toContain(':status');
  });
});

describe('status span inside raw HTML (a frozen Confluence table)', () => {
  it('survives the sanitizer with its classes', () => {
    const html = render('<table><tr><td colspan="2">h</td></tr><tr><td><span class="folio-status folio-status--red">STOP</span></td></tr></table>');
    expect(html).toContain('<span class="folio-status folio-status--red">STOP</span>');
  });
});
