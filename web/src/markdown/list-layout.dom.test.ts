// @vitest-environment jsdom
/**
 * Reading-mode lists: a loose item's content is wrapped in a block <p>, and an
 * `inside` marker used to sit on a line of its own above that paragraph ("1."
 * alone, its text underneath). The marker now hangs outside the item, so it
 * shares the first line with the paragraph in tight and loose lists alike.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import i18next from 'i18next';
import { renderMarkdownToHtml } from './pipeline';
import css from './markdown.css?raw';
import './i18n/register';

beforeAll(async () => {
  await i18next.changeLanguage('en');
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
});

afterEach(() => document.body.replaceChildren());

function mount(markdown: string): HTMLElement {
  const host = document.createElement('div');
  host.className = 'folio-markdown';
  host.innerHTML = renderMarkdownToHtml(markdown, { space: 's', pagePath: 'a.md' });
  document.body.appendChild(host);
  return host;
}

const position = (el: Element) => getComputedStyle(el).listStylePosition;

describe('reading-mode list layout', () => {
  it('wraps a loose item in a paragraph, as the renderer always did', () => {
    const host = mount('1. one\n\n2. two\n');
    expect(host.querySelector('ol > li > p')).not.toBeNull();
  });

  it('hangs the marker outside, so it shares a line with the first paragraph', () => {
    for (const source of ['1. one\n\n2. two\n', '1. one\n2. two\n', '- one\n\n- two\n', '- one\n- two\n']) {
      const host = mount(source);
      const list = host.querySelector('ol, ul')!;
      expect(position(list), source).toBe('outside');
      host.remove();
    }
  });

  it('keeps that at every nesting level and when the list starts at 3', () => {
    const host = mount('3. a\n\n   - b\n\n     - c\n\n4. d\n');
    expect(host.querySelector('ol')!.getAttribute('start')).toBe('3');
    for (const list of host.querySelectorAll('ol, ul')) expect(position(list)).toBe('outside');
  });

  it('renders a lone dash as an empty list item, exactly as CommonMark does', () => {
    // Content, not a bug: a `-` line is an empty bullet. Reading shows it as one.
    const host = mount('-\n\n## Heading\n');
    const items = host.querySelectorAll('ul > li');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toBe('');
    expect(host.querySelector('h2')?.textContent).toContain('Heading');
  });
});
