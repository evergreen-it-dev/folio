import { describe, expect, it } from 'vitest';
import { extensionForKind, getPageSlugInfo, isValidSlug, newPageTitleKey, previewSlugPath } from './slugUtils';

describe('isValidSlug', () => {
  it('accepts lowercase letters, digits and hyphens, starting with a letter or digit', () => {
    expect(isValidSlug('setup')).toBe(true);
    expect(isValidSlug('a1')).toBe(true);
    expect(isValidSlug('getting-started-2')).toBe(true);
    expect(isValidSlug('9lives')).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(isValidSlug('')).toBe(false);
  });

  it('rejects a leading hyphen', () => {
    expect(isValidSlug('-setup')).toBe(false);
  });

  it('rejects uppercase letters', () => {
    expect(isValidSlug('Setup')).toBe(false);
  });

  it('rejects underscores, spaces and non-latin characters', () => {
    expect(isValidSlug('a_b')).toBe(false);
    expect(isValidSlug('a b')).toBe(false);
    expect(isValidSlug('héllo')).toBe(false);
  });
});

describe('extensionForKind / newPageTitleKey (round 26)', () => {
  it('maps every page kind to the extension SERVER stores it under', () => {
    expect(extensionForKind('doc')).toBe('.md');
    expect(extensionForKind('board')).toBe('.excalidraw.svg');
    expect(extensionForKind('table')).toBe('.table.md');
  });

  it('names the default title key per kind', () => {
    expect(newPageTitleKey('doc')).toBe('sidebar.newPage');
    expect(newPageTitleKey('board')).toBe('sidebar.newBoard');
    expect(newPageTitleKey('table')).toBe('sidebar.newTable');
  });
});

describe('getPageSlugInfo', () => {
  it('uses the basename (minus .md) for a plain doc page', () => {
    expect(getPageSlugInfo('guides/setup.md', 'doc')).toEqual({ slug: 'setup', isDirectoryIndex: false });
  });

  it('uses the containing directory name for an index.md page', () => {
    expect(getPageSlugInfo('guides/index.md', 'doc')).toEqual({ slug: 'guides', isDirectoryIndex: true });
  });

  it('uses the containing directory name for a README.md standing in as the index', () => {
    expect(getPageSlugInfo('guides/README.md', 'doc')).toEqual({ slug: 'guides', isDirectoryIndex: true });
  });

  it('handles a deeply nested plain page', () => {
    expect(getPageSlugInfo('a/b/c.md', 'doc')).toEqual({ slug: 'c', isDirectoryIndex: false });
  });

  it('strips .excalidraw.svg for a board page', () => {
    expect(getPageSlugInfo('assets/diagram.excalidraw.svg', 'board')).toEqual({ slug: 'diagram', isDirectoryIndex: false });
  });

  it('returns an empty slug for the space-root index (no directory segment to rename)', () => {
    expect(getPageSlugInfo('index.md', 'doc')).toEqual({ slug: '', isDirectoryIndex: true });
  });

  it('strips the WHOLE .table.md for a data table, not just the trailing .md', () => {
    expect(getPageSlugInfo('plans/weekly.table.md', 'table')).toEqual({ slug: 'weekly', isDirectoryIndex: false });
  });
});

describe('previewSlugPath', () => {
  it('replaces the basename for a plain doc page', () => {
    expect(previewSlugPath('guides/setup.md', 'doc', 'intro')).toBe('guides/intro.md');
  });

  it('replaces the containing directory segment for a directory-index page, keeping the index filename', () => {
    expect(previewSlugPath('guides/index.md', 'doc', 'tutorials')).toBe('tutorials/index.md');
  });

  it('keeps README.md as the filename when renaming a README-indexed directory', () => {
    expect(previewSlugPath('guides/README.md', 'doc', 'tutorials')).toBe('tutorials/README.md');
  });

  it('uses the board extension for a board page', () => {
    expect(previewSlugPath('assets/diagram.excalidraw.svg', 'board', 'flow')).toBe('assets/flow.excalidraw.svg');
  });

  it('replaces a root-level (no directory) plain page', () => {
    expect(previewSlugPath('onboarding.md', 'doc', 'welcome')).toBe('welcome.md');
  });

  it('keeps the .table.md double extension when renaming a data table', () => {
    expect(previewSlugPath('plans/weekly.table.md', 'table', 'sprint')).toBe('plans/sprint.table.md');
  });
});
