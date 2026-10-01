import { describe, expect, it } from 'vitest';
import { dirname, formatLinkTarget, normalizeRelative, relativePath, resolveAssetSrc } from './paths';

describe('dirname', () => {
  it('returns the directory of a space-relative path', () => {
    expect(dirname('architecture/data-flow.md')).toBe('architecture');
    expect(dirname('a/b/c/index.md')).toBe('a/b/c');
    expect(dirname('index.md')).toBe('');
    expect(dirname('')).toBe('');
  });
});

describe('normalizeRelative', () => {
  it('collapses . and .. segments', () => {
    expect(normalizeRelative('a/b/../c.png')).toBe('a/c.png');
    expect(normalizeRelative('a/./b.png')).toBe('a/b.png');
    expect(normalizeRelative('a/b/../../c.png')).toBe('c.png');
  });
});

describe('resolveAssetSrc', () => {
  it('resolves relative sources against the page directory', () => {
    expect(resolveAssetSrc('img/flow.png', 'eng', 'architecture/data-flow.md')).toBe(
      '/files/eng/architecture/img/flow.png',
    );
    expect(resolveAssetSrc('./flow.png', 'eng', 'architecture/data-flow.md')).toBe(
      '/files/eng/architecture/flow.png',
    );
    expect(resolveAssetSrc('../assets/flow.png', 'eng', 'architecture/data-flow.md')).toBe(
      '/files/eng/assets/flow.png',
    );
  });

  it('handles pages at the space root', () => {
    expect(resolveAssetSrc('logo.svg', 'eng', 'index.md')).toBe('/files/eng/logo.svg');
  });

  // QA-3: an edit share link renders for a guest with no session, and /files
  // answers 401 without the token — live mode showed an empty image.
  it('appends the share token so a session-free guest can load the asset', () => {
    expect(resolveAssetSrc('img/flow.png', 'eng', 'architecture/data-flow.md', 'tok en/1')).toBe(
      '/files/eng/architecture/img/flow.png?share=tok%20en%2F1',
    );
    expect(resolveAssetSrc('logo.svg', 'eng', 'index.md', 'abc')).toBe('/files/eng/logo.svg?share=abc');
  });

  it('leaves already-absolute sources alone even for a share guest', () => {
    expect(resolveAssetSrc('https://example.com/a.png', 'eng', 'x.md', 'abc')).toBe('https://example.com/a.png');
  });

  it('leaves absolute and root-relative sources alone', () => {
    expect(resolveAssetSrc('https://example.com/a.png', 'eng', 'x.md')).toBe('https://example.com/a.png');
    expect(resolveAssetSrc('//cdn.example.com/a.png', 'eng', 'x.md')).toBe('//cdn.example.com/a.png');
    expect(resolveAssetSrc('/files/other/a.png', 'eng', 'x.md')).toBe('/files/other/a.png');
    expect(resolveAssetSrc('data:image/png;base64,AAA', 'eng', 'x.md')).toBe('data:image/png;base64,AAA');
  });

  it('unwraps pointy-bracket sources and ignores empty ones', () => {
    expect(resolveAssetSrc('<a b.png>', 'eng', 'x.md')).toBe('/files/eng/a b.png');
    expect(resolveAssetSrc('   ', 'eng', 'x.md')).toBe('');
  });
});

describe('relativePath', () => {
  it('links to a sibling in the same directory', () => {
    expect(relativePath('architecture/index.md', 'architecture/data-flow.md')).toBe('data-flow.md');
  });

  it('links down into a subdirectory', () => {
    expect(relativePath('index.md', 'architecture/data-flow.md')).toBe('architecture/data-flow.md');
    expect(relativePath('a/b.md', 'a/deep/c.md')).toBe('deep/c.md');
  });

  it('walks up to reach a page nearer the root', () => {
    expect(relativePath('architecture/data-flow.md', 'onboarding.md')).toBe('../onboarding.md');
    expect(relativePath('a/b/c/page.md', 'a/target.md')).toBe('../../target.md');
  });

  it('walks up and back down across branches', () => {
    expect(relativePath('a/b/c.md', 'a/x/y.md')).toBe('../x/y.md');
    expect(relativePath('a/b/c.md', 'q/w.md')).toBe('../../q/w.md');
  });

  it('handles root-level pages on both sides', () => {
    expect(relativePath('index.md', 'onboarding.md')).toBe('onboarding.md');
    expect(relativePath('', 'onboarding.md')).toBe('onboarding.md');
  });

  it('links a page to itself by bare filename', () => {
    expect(relativePath('a/b.md', 'a/b.md')).toBe('b.md');
  });

  it('returns an empty string for an empty target', () => {
    expect(relativePath('index.md', '')).toBe('');
  });
});

describe('formatLinkTarget', () => {
  it('leaves ordinary paths bare', () => {
    expect(formatLinkTarget('architecture/data-flow.md')).toBe('architecture/data-flow.md');
    expect(formatLinkTarget('Übersicht.md')).toBe('Übersicht.md');
  });

  it('wraps paths that would break the link syntax', () => {
    expect(formatLinkTarget('New board.md')).toBe('<New board.md>');
    expect(formatLinkTarget('a(1).md')).toBe('<a(1).md>');
  });
});
