import { describe, expect, it } from 'vitest';
import { markdownToHtml } from './print.js';

describe('print: ++underline++', () => {
  it('renders ++text++ as <ins>, nested with bold, and keeps legacy tags and C++', async () => {
    const html = await markdownToHtml('a ++u++ **++b++** and <ins>old</ins> and C++ ok');
    expect(html).toContain('a <ins>u</ins>');
    expect(html).toContain('<strong><ins>b</ins></strong>');
    expect(html).toContain('<ins>old</ins>');
    expect(html).toContain('C++ ok');
  });
});
