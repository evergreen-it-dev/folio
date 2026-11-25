// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { renderReader } from './view';
import en from './i18n/en.json';

const note = { id: 'p1', space: 'notes', title: 'Travel', markdown: '# Trip\n\nBring **water**.', savedAt: 1234 };

it('lists saved documents at the start URL and opens the selected snapshot read-only', () => {
  const root = document.createElement('main');
  renderReader(root, '/', [note], en, 'en');
  expect(root.querySelector('a[href="/s/notes/p/p1"]')?.textContent).toContain('Travel');
  renderReader(root, '/s/notes/p/p1', [note], en, 'en');
  expect(root.querySelector('article strong')?.textContent).toBe('water');
  expect(root.querySelector('textarea, [contenteditable]')).toBeNull();
});

it('keeps titles, frontmatter, embedded media and raw HTML out of an unrelated document view', () => {
  const root = document.createElement('main');
  const content = '---\ntags: [private-tag]\n---\n\nHello ![map](https://example.com/map.png)\n\n<iframe src="https://example.com"></iframe>';
  renderReader(root, '/s/notes/p/p1', [{ ...note, markdown: content }], en, 'en');
  expect(root.querySelector('img, iframe')).toBeNull();
  expect(root.textContent).toContain('map');
  expect(root.textContent).not.toContain('private-tag');
  renderReader(root, '/s/other/p/p1', [note], en, 'en');
  expect(root.textContent).not.toContain('Travel');
  expect(root.textContent).toContain(en.missing);
});
