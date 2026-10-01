import { describe, expect, it } from 'vitest';
import { deriveExportBasename, exportFilename } from './exportFilename';

describe('deriveExportBasename', () => {
  it('strips the board .excalidraw.svg suffix from a nested path', () => {
    expect(deriveExportBasename({ path: 'diagrams/my-flow.excalidraw.svg' })).toBe('my-flow');
  });

  it('strips a plain .svg suffix', () => {
    expect(deriveExportBasename({ path: 'my-flow.svg' })).toBe('my-flow');
  });

  it('strips a .md suffix (defensive — boards should never actually have one)', () => {
    expect(deriveExportBasename({ path: 'notes.md' })).toBe('notes');
  });

  it('works for a root-level path with no directory', () => {
    expect(deriveExportBasename({ path: 'architecture.excalidraw.svg' })).toBe('architecture');
  });

  it('keeps a path segment with no recognized extension as-is', () => {
    expect(deriveExportBasename({ path: 'diagrams/weird-name' })).toBe('weird-name');
  });

  it('falls back to title when path is absent', () => {
    expect(deriveExportBasename({ title: 'My Flow' })).toBe('My Flow');
  });

  it('falls back to title when path is an empty string', () => {
    expect(deriveExportBasename({ path: '', title: 'My Flow' })).toBe('My Flow');
  });

  it('falls back to the generic name when neither path nor title is usable', () => {
    expect(deriveExportBasename({})).toBe('board');
    expect(deriveExportBasename({ path: '', title: '' })).toBe('board');
  });

  it('falls back to title when path is only a directory separator (no basename)', () => {
    expect(deriveExportBasename({ path: '/', title: 'Fallback Title' })).toBe('Fallback Title');
  });

  it('keeps non-ASCII titles as-is — no transliteration, just sanitizing', () => {
    expect(deriveExportBasename({ title: 'Tableau récapitulatif' })).toBe('Tableau récapitulatif');
  });

  it('replaces filesystem-invalid characters in a title-derived name', () => {
    // '/' and ':' become '-'; the trailing '-' left by the replaced '?' is
    // then trimmed by the same leading/trailing cleanup that strips stray
    // whitespace, so only the internal separators survive.
    expect(deriveExportBasename({ title: 'Q1/Q2: Roadmap?' })).toBe('Q1-Q2- Roadmap');
  });

  it('collapses internal whitespace and trims leading/trailing dashes left over from sanitizing', () => {
    expect(deriveExportBasename({ title: '  spaced   out  ' })).toBe('spaced out');
    expect(deriveExportBasename({ title: '/leading and trailing/' })).toBe('leading and trailing');
  });

  it('prefers path over title when both are present', () => {
    expect(deriveExportBasename({ path: 'diagrams/real-slug.excalidraw.svg', title: 'Something Else' })).toBe(
      'real-slug',
    );
  });
});

describe('exportFilename', () => {
  it('appends the requested extension to the derived basename', () => {
    expect(exportFilename({ path: 'diagrams/my-flow.excalidraw.svg' }, 'png')).toBe('my-flow.png');
    expect(exportFilename({ path: 'diagrams/my-flow.excalidraw.svg' }, 'svg')).toBe('my-flow.svg');
  });

  it('uses the generic fallback name with the requested extension when nothing else is available', () => {
    expect(exportFilename({}, 'png')).toBe('board.png');
  });
});
