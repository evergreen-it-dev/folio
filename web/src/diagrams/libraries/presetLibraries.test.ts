import { describe, expect, it } from 'vitest';
import { getPresetLibraryItems, normalizeLibraryFile, presetItemId } from './presetLibraries';
import systemDesign from './system-design.excalidrawlib.json';
import architectureDiagramComponents from './architecture-diagram-components.excalidrawlib.json';
import postIt from './post-it.excalidrawlib.json';
import stickFigures from './stick-figures.excalidrawlib.json';

describe('presetItemId', () => {
  it('is deterministic for the same slug + index', () => {
    expect(presetItemId('system-design', 0)).toBe(presetItemId('system-design', 0));
  });

  it('differs by slug and by index', () => {
    expect(presetItemId('system-design', 0)).not.toBe(presetItemId('system-design', 1));
    expect(presetItemId('system-design', 0)).not.toBe(presetItemId('post-it', 0));
  });

  it('is namespaced so it can never collide with a real excalidraw.com library id', () => {
    // Real ids (both nanoid-style v2 ids and the ones libraries.excalidraw.com
    // mints) never contain a colon.
    expect(presetItemId('system-design', 0)).toContain(':');
  });
});

describe('normalizeLibraryFile — v1 input (bare elements-array-per-item)', () => {
  const v1File = { library: [[{ id: 'el-a', type: 'rectangle' }], [{ id: 'el-b', type: 'ellipse' }]] };

  it('wraps each entry with a deterministic id, published status, and the original elements untouched', () => {
    const result = normalizeLibraryFile('my-slug', v1File);
    expect(result).toEqual([
      { id: presetItemId('my-slug', 0), status: 'published', elements: [{ id: 'el-a', type: 'rectangle' }], created: 0 },
      { id: presetItemId('my-slug', 1), status: 'published', elements: [{ id: 'el-b', type: 'ellipse' }], created: 0 },
    ]);
  });

  it('never fabricates a `name` for a v1 item (the format carries none)', () => {
    const result = normalizeLibraryFile('my-slug', v1File);
    expect(result.every((item) => !('name' in item))).toBe(true);
  });

  it('is stable across repeated calls (required for merge-without-duplicates across reloads)', () => {
    expect(normalizeLibraryFile('my-slug', v1File)).toEqual(normalizeLibraryFile('my-slug', v1File));
  });
});

describe('normalizeLibraryFile — v2 input (already-wrapped items)', () => {
  const v2File = {
    libraryItems: [
      { id: 'real-id-1', status: 'published', elements: [{ id: 'el-a' }], created: 123, name: 'Slack' },
      { id: 'real-id-2', status: 'unpublished', elements: [{ id: 'el-b' }], created: 456 },
    ],
  };

  it('passes through the source id/status/created/name rather than regenerating them', () => {
    expect(normalizeLibraryFile('slug', v2File)).toEqual([
      { id: 'real-id-1', status: 'published', elements: [{ id: 'el-a' }], created: 123, name: 'Slack' },
      { id: 'real-id-2', status: 'unpublished', elements: [{ id: 'el-b' }], created: 456 },
    ]);
  });

  it('falls back to a deterministic id/status/created only when a v2 item is missing them', () => {
    const sparse = { libraryItems: [{ elements: [{ id: 'el-a' }] }] };
    expect(normalizeLibraryFile('slug', sparse)).toEqual([
      { id: presetItemId('slug', 0), status: 'published', elements: [{ id: 'el-a' }], created: 0 },
    ]);
  });
});

describe('normalizeLibraryFile — malformed input', () => {
  it('returns an empty array when the file has neither `library` nor `libraryItems`', () => {
    expect(normalizeLibraryFile('slug', {})).toEqual([]);
  });
});

describe('getPresetLibraryItems (real bundled files)', () => {
  const items = getPresetLibraryItems();

  it('concatenates every bundled file', () => {
    const systemDesignCount = (systemDesign as { library: unknown[] }).library.length;
    const architectureCount = (architectureDiagramComponents as { libraryItems: unknown[] }).libraryItems.length;
    const postItCount = (postIt as { library: unknown[] }).library.length;
    const stickFiguresCount = (stickFigures as { libraryItems: unknown[] }).libraryItems.length;
    expect(items.length).toBe(systemDesignCount + architectureCount + postItCount + stickFiguresCount);
    // Pin the counts too, so a future edit to one of the source files shows
    // up here rather than only as a silent total-count shift.
    expect([systemDesignCount, architectureCount, postItCount, stickFiguresCount]).toEqual([24, 11, 13, 9]);
  });

  it('every item has a unique, non-empty id', () => {
    const ids = items.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
  });

  it('every item is a valid v2 LibraryItem shape (status + non-empty elements)', () => {
    for (const item of items) {
      expect(['published', 'unpublished']).toContain(item.status);
      expect(Array.isArray(item.elements)).toBe(true);
      expect(item.elements.length).toBeGreaterThan(0);
    }
  });

  it('the native v2 file keeps its own human-readable names (e.g. "Slack")', () => {
    expect(items.some((item) => item.name === 'Slack')).toBe(true);
  });

  it('is cached — repeated calls return the same array reference', () => {
    expect(getPresetLibraryItems()).toBe(items);
  });
});
