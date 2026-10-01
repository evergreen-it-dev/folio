import { describe, expect, it } from 'vitest';
import { capAgentContext } from './agentContext.js';

describe('capAgentContext (pure — no DB)', () => {
  it('joins every page when everything fits under the cap', () => {
    const result = capAgentContext([
      { path: '.agent/tone.md', markdown: '# Tone\n\nBe concise.' },
      { path: '.agent/tools.md', markdown: '# Tools\n\nPrefer read_page over guessing.' },
    ]);
    expect(result.pagesUsed).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.blob).toContain('.agent/tone.md');
    expect(result.blob).toContain('.agent/tools.md');
    expect(result.blob).toContain('Be concise.');
    expect(result.blob).toContain('Prefer read_page over guessing.');
  });

  it('cuts at a page boundary once the cap is exceeded, never mid-page, and marks the truncation in the blob', () => {
    const pages = [
      { path: '.agent/a.md', markdown: 'x'.repeat(40) },
      { path: '.agent/b.md', markdown: 'y'.repeat(40) },
      { path: '.agent/c.md', markdown: 'z'.repeat(40) },
    ];
    const result = capAgentContext(pages, 80);

    expect(result.truncated).toBe(true);
    expect(result.pagesUsed).toBeGreaterThan(0);
    expect(result.pagesUsed).toBeLessThan(pages.length);
    expect(result.blob).toContain('TRUNCATED');

    // Every INCLUDED page is present byte-for-byte (never cut mid-page)...
    for (let i = 0; i < result.pagesUsed; i++) {
      expect(result.blob).toContain(pages[i].markdown);
    }
    // ...and nothing past the cut made it in at all.
    for (let i = result.pagesUsed; i < pages.length; i++) {
      expect(result.blob).not.toContain(pages[i].markdown);
    }
  });

  it('always includes the first page whole, even alone over the cap (never cuts the one thing that is there)', () => {
    const result = capAgentContext([{ path: '.agent/big.md', markdown: 'a'.repeat(500) }], 80);
    expect(result.pagesUsed).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.blob).toContain('a'.repeat(500));
  });

  it('empty input yields an empty blob with no truncation marker', () => {
    const result = capAgentContext([]);
    expect(result).toEqual({ blob: '', pagesUsed: 0, truncated: false });
  });
});
