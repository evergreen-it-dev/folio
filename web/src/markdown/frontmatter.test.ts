import { describe, expect, it } from 'vitest';
import { stripFrontmatter } from './frontmatter';

describe('stripFrontmatter', () => {
  it('removes a leading frontmatter block', () => {
    // The regex's trailing \r?\n? eats exactly one newline after the closing
    // fence, so when the source has a blank-line separator (fence, blank,
    // body — the common case) one blank line remains before the body. That's
    // harmless: CommonMark ignores leading blank lines before a block.
    const md = '---\nicon: "📄"\n---\n\n# Title\n\nBody.\n';
    expect(stripFrontmatter(md)).toBe('\n# Title\n\nBody.\n');
  });

  it('removes a multi-key block, preserving key order is irrelevant here since the whole block goes', () => {
    const md = '---\nicon: "🎉"\ncover: "/a/abc/def.png"\ntitle: "Ignored"\n---\nBody only.\n';
    expect(stripFrontmatter(md)).toBe('Body only.\n');
  });

  it('leaves markdown with no frontmatter untouched', () => {
    const md = '# Title\n\nNo frontmatter here.\n';
    expect(stripFrontmatter(md)).toBe(md);
  });

  it('does not treat a mid-document thematic break as frontmatter', () => {
    const md = '# Title\n\nSome text.\n\n---\n\nMore text.\n';
    expect(stripFrontmatter(md)).toBe(md);
  });

  it('handles CRLF line endings', () => {
    const md = '---\r\nicon: "📄"\r\n---\r\n\r\n# Title\r\n';
    expect(stripFrontmatter(md)).toBe('\r\n# Title\r\n');
  });

  it('leaves an empty string untouched', () => {
    expect(stripFrontmatter('')).toBe('');
  });
});
