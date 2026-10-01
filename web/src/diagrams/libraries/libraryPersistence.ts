/**
 * Round 18 — persistence adapter for useHandleLibrary (the board's "Browse
 * libraries" flow: a redirect back from libraries.excalidraw.com with
 * #addLibrary=<url> in the hash, or the sidebar's own add/remove actions).
 *
 * Mirrors the reference excalidraw-app's own LocalData.libraryAdapter
 * pattern (a plain `{ load, save }` object passed as `opts.adapter`):
 *   - `load()` is the hook's hydration source on mount AND the
 *     reconciliation baseline it re-reads before every save (see
 *     useHandleLibrary's internals — it calls adapter.load() with
 *     source:"save" first, diffs the in-memory add/remove against that,
 *     then calls adapter.save() with the merged result). We don't branch on
 *     `source`; both cases want the same "presets + whatever's stored"
 *     view.
 *   - `save()` persists the resulting full item list as-is, no reshaping —
 *     required by the adapter contract (LibraryPersistenceAdapter.save's
 *     own doc comment: "persist to the database as is").
 *
 * The three bundled .excalidrawlib files (presetLibraries.ts) are folded in
 * on every load() rather than written once up front, so a browser that has
 * never touched this localStorage key still sees them immediately, and a
 * future addition/edit to the bundled set reaches every existing user
 * without a migration step. Merge is by LibraryItem.id, and preset ids are
 * deterministic (see presetLibraries.ts), so re-merging the same presets
 * against a localStorage copy of themselves (which is exactly what happens
 * once the user's first library edit round-trips them through `save`) is a
 * no-op rather than producing a duplicate entry.
 */
import type { LibraryItems } from '@excalidraw/excalidraw/types';
import { getPresetLibraryItems } from './presetLibraries';

/** Round 18's own key, namespaced per the zone's localStorage convention (see web/src/i18n's `folio:lang`). */
export const LIBRARY_STORAGE_KEY = 'folio:excalidraw-library';

/** Reads the user's own previously-saved library items. Never throws — a missing key, disabled storage (private mode), or corrupt JSON all just mean "nothing saved yet". */
function readStoredItems(): LibraryItems {
  try {
    const raw = localStorage.getItem(LIBRARY_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LibraryItems) : [];
  } catch {
    return [];
  }
}

/** Best-effort write — a full/blocked localStorage (quota, private mode, disabled storage) shouldn't break editing, so failures are swallowed rather than surfaced. */
function writeStoredItems(items: LibraryItems): void {
  try {
    localStorage.setItem(LIBRARY_STORAGE_KEY, JSON.stringify(items));
  } catch {
    // ignore
  }
}

/**
 * Merges `primary` and `secondary` by LibraryItem.id: every `primary` item
 * is kept (in order), followed by any `secondary` item whose id isn't
 * already covered. Used with presets as `primary` so they sort first and
 * consistently in the library sidebar.
 */
export function mergeLibraryItemsById(primary: LibraryItems, secondary: LibraryItems): LibraryItems {
  const seen = new Set(primary.map((item) => item.id));
  const rest = secondary.filter((item) => !seen.has(item.id));
  return [...primary, ...rest];
}

/**
 * useHandleLibrary's `opts.adapter`. Deliberately a plain object (not typed
 * against @excalidraw/excalidraw's own LibraryPersistenceAdapter) — that
 * interface isn't part of the package's public type exports in this
 * version (only reachable via an internal dist path), so we rely on
 * structural typing against useHandleLibrary's own parameter type instead
 * of reaching into the package's internals for a name.
 */
export const folioLibraryAdapter = {
  load(): { libraryItems: LibraryItems } {
    return { libraryItems: mergeLibraryItemsById(getPresetLibraryItems(), readStoredItems()) };
  },
  save(libraryData: { libraryItems: LibraryItems }): void {
    writeStoredItems(libraryData.libraryItems);
  },
};
