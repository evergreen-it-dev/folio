// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryItems } from '@excalidraw/excalidraw/types';
import { LIBRARY_STORAGE_KEY, folioLibraryAdapter, mergeLibraryItemsById } from './libraryPersistence';
import { getPresetLibraryItems } from './presetLibraries';

function fakeItem(id: string): LibraryItems[number] {
  return { id, status: 'published', elements: [], created: 0 };
}

describe('mergeLibraryItemsById', () => {
  it('keeps every primary item, in order', () => {
    const primary = [fakeItem('a'), fakeItem('b')];
    expect(mergeLibraryItemsById(primary, [])).toEqual(primary);
  });

  it('appends secondary items not already present in primary', () => {
    const primary = [fakeItem('a')];
    const secondary = [fakeItem('b'), fakeItem('c')];
    expect(mergeLibraryItemsById(primary, secondary)).toEqual([fakeItem('a'), fakeItem('b'), fakeItem('c')]);
  });

  it('drops secondary items whose id already exists in primary — primary wins, no duplicate id in the output', () => {
    const primary = [fakeItem('a')];
    const secondary = [fakeItem('a'), fakeItem('b')];
    const result = mergeLibraryItemsById(primary, secondary);
    expect(result).toEqual([fakeItem('a'), fakeItem('b')]);
    expect(result.filter((item) => item.id === 'a')).toHaveLength(1);
  });
});

describe('folioLibraryAdapter', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('load() with nothing saved yet returns exactly the bundled presets', () => {
    const loaded = folioLibraryAdapter.load();
    expect(loaded.libraryItems).toEqual(getPresetLibraryItems());
  });

  it('save() then load() round-trips a user-added item alongside the presets', () => {
    const userItem = fakeItem('user-added-1');
    folioLibraryAdapter.save({ libraryItems: [...getPresetLibraryItems(), userItem] });

    const loaded = folioLibraryAdapter.load();
    expect(loaded.libraryItems).toContainEqual(userItem);
    expect(loaded.libraryItems.length).toBe(getPresetLibraryItems().length + 1);
  });

  it('re-saving the full merged set (as useHandleLibrary does on every library edit) never duplicates a preset', () => {
    // Simulates what actually happens end to end: useHandleLibrary persists
    // the *entire* current item list (presets included) back to storage
    // after any add/remove, not just the user's own delta.
    folioLibraryAdapter.save({ libraryItems: getPresetLibraryItems() });

    const loaded = folioLibraryAdapter.load();
    const ids = loaded.libraryItems.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(loaded.libraryItems).toEqual(getPresetLibraryItems());
  });

  it('a user library edit that drops one preset item does not resurrect it via load() re-merging it back in from the bundle', () => {
    // Documented behavior, not a bug: presets are re-injected by `primary`
    // on every load(), so "removing" one from the sidebar only lasts until
    // the next mount. Pinning this so a future change to that behavior is a
    // deliberate, visible edit to this test rather than a silent regression
    // either way.
    const withoutFirstPreset = getPresetLibraryItems().slice(1);
    folioLibraryAdapter.save({ libraryItems: withoutFirstPreset });

    const loaded = folioLibraryAdapter.load();
    expect(loaded.libraryItems).toEqual(getPresetLibraryItems());
  });

  it('load() tolerates corrupt JSON in the storage key (falls back to presets only)', () => {
    localStorage.setItem(LIBRARY_STORAGE_KEY, '{not valid json');
    expect(folioLibraryAdapter.load().libraryItems).toEqual(getPresetLibraryItems());
  });

  it('load() tolerates a non-array value in the storage key', () => {
    localStorage.setItem(LIBRARY_STORAGE_KEY, JSON.stringify({ not: 'an array' }));
    expect(folioLibraryAdapter.load().libraryItems).toEqual(getPresetLibraryItems());
  });

  describe('when localStorage.setItem throws (quota exceeded / disabled storage)', () => {
    beforeEach(() => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('quota exceeded');
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('save() does not throw', () => {
      expect(() => folioLibraryAdapter.save({ libraryItems: getPresetLibraryItems() })).not.toThrow();
    });
  });
});
