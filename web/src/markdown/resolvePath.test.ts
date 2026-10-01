import { describe, expect, it } from 'vitest';
import { dirOf, isExternalUrl, isMarkdownPath, resolveRelativePath, splitFragment } from './resolvePath';

describe('dirOf', () => {
  it('returns "" for a root-level file', () => {
    expect(dirOf('index.md')).toBe('');
    expect(dirOf('onboarding.md')).toBe('');
  });

  it('returns the containing directory for a nested file', () => {
    expect(dirOf('architecture/index.md')).toBe('architecture');
    expect(dirOf('architecture/data-flow.md')).toBe('architecture');
    expect(dirOf('a/b/c.md')).toBe('a/b');
  });
});

describe('resolveRelativePath', () => {
  it('resolves a same-directory link', () => {
    expect(resolveRelativePath('architecture/index.md', './data-flow.md')).toBe('architecture/data-flow.md');
  });

  it('resolves ".." up to a sibling directory', () => {
    expect(resolveRelativePath('architecture/data-flow.md', '../onboarding.md')).toBe('onboarding.md');
  });

  it('resolves a bare relative path against the space root', () => {
    expect(resolveRelativePath('index.md', 'assets/logo.png')).toBe('assets/logo.png');
  });

  it('resolves nested asset paths (excalidraw board next to a page)', () => {
    expect(resolveRelativePath('architecture/data-flow.md', './assets/x.excalidraw.svg')).toBe(
      'architecture/assets/x.excalidraw.svg',
    );
  });

  it('collapses "." segments and repeated slashes', () => {
    expect(resolveRelativePath('a/b/index.md', './././c.md')).toBe('a/b/c.md');
  });

  it('clamps ".." at the space root instead of going negative', () => {
    expect(resolveRelativePath('index.md', '../../escape.md')).toBe('escape.md');
    expect(resolveRelativePath('a/index.md', '../../../escape.md')).toBe('escape.md');
  });

  it('treats a leading "/" as already relative to the space root', () => {
    expect(resolveRelativePath('architecture/data-flow.md', '/assets/logo.png')).toBe('assets/logo.png');
  });

  it('handles multiple ".." segments deep in a path', () => {
    expect(resolveRelativePath('a/b/c/page.md', '../../sibling.md')).toBe('a/sibling.md');
  });
});

describe('isExternalUrl', () => {
  it('flags absolute URLs with a scheme', () => {
    expect(isExternalUrl('https://example.com')).toBe(true);
    expect(isExternalUrl('http://example.com/x')).toBe(true);
    expect(isExternalUrl('mailto:a@example.com')).toBe(true);
  });

  it('flags protocol-relative URLs', () => {
    expect(isExternalUrl('//example.com/x')).toBe(true);
  });

  it('does not flag relative paths', () => {
    expect(isExternalUrl('./data-flow.md')).toBe(false);
    expect(isExternalUrl('../onboarding.md')).toBe(false);
    expect(isExternalUrl('assets/logo.png')).toBe(false);
    expect(isExternalUrl('#section')).toBe(false);
  });
});

describe('splitFragment', () => {
  it('splits off a hash', () => {
    expect(splitFragment('./x.md#section')).toEqual({ path: './x.md', hash: '#section' });
  });

  it('splits off a query string before the hash', () => {
    expect(splitFragment('./x.md?a=1#section')).toEqual({ path: './x.md', hash: '#section' });
  });

  it('returns the whole string as path when there is no hash/query', () => {
    expect(splitFragment('./x.md')).toEqual({ path: './x.md', hash: '' });
  });
});

describe('isMarkdownPath', () => {
  it('matches .md (case-insensitively)', () => {
    expect(isMarkdownPath('a/b.md')).toBe(true);
    expect(isMarkdownPath('a/b.MD')).toBe(true);
  });

  it('rejects non-markdown paths', () => {
    expect(isMarkdownPath('a/b.png')).toBe(false);
    expect(isMarkdownPath('a/b.excalidraw.svg')).toBe(false);
  });
});
