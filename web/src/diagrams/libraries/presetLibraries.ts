/**
 * Round 18 — bundled default Excalidraw libraries.
 *
 * web/src/diagrams/libraries/*.excalidrawlib.json are real files exported
 * from excalidraw.com (or authored by hand) in one of the two formats the
 * .excalidrawlib spec has ever used:
 *
 *   v1 — `{ type, version: 1, library: ElementsArray[] }`. Each entry in
 *        `library` IS the elements array for one reusable item — there is
 *        no per-item wrapper, so v1 items have no id/status/created/name of
 *        their own at all.
 *   v2 — `{ type, version: 2, libraryItems: LibraryItem[] }`, where each
 *        LibraryItem is `{ id, status, elements, created, name? }` — the
 *        shape @excalidraw/excalidraw's own LibraryItems type expects.
 *
 * This module normalizes both into v2 LibraryItems so BoardCanvas can hand
 * them to useHandleLibrary's adapter (see libraryPersistence.ts) as one
 * uniform preset set, regardless of which format the source file happened
 * to ship in.
 */
import type { LibraryItem, LibraryItems } from '@excalidraw/excalidraw/types';
import systemDesign from './system-design.excalidrawlib.json';
import architectureDiagramComponents from './architecture-diagram-components.excalidrawlib.json';
import postIt from './post-it.excalidrawlib.json';
import stickFigures from './stick-figures.excalidrawlib.json';

/** Loosely-typed shape of a parsed .excalidrawlib file, before we know which version it is. */
interface RawLibraryFile {
  library?: unknown[];
  libraryItems?: unknown[];
}

/** Loosely-typed shape of one v2 libraryItems entry (or close enough to it) before validation. */
interface RawLibraryItem {
  id?: unknown;
  status?: unknown;
  elements?: unknown;
  created?: unknown;
  name?: unknown;
}

/**
 * One preset source: a stable slug (used only to derive deterministic ids
 * for v1 files — see presetItemId below) paired with the file's parsed JSON.
 * The slug is independent of the filename on disk so renaming a file on
 * disk can't silently change every id derived from it.
 */
const PRESET_SOURCES: ReadonlyArray<readonly [slug: string, file: RawLibraryFile]> = [
  ['system-design', systemDesign as RawLibraryFile],
  ['architecture-diagram-components', architectureDiagramComponents as RawLibraryFile],
  ['post-it', postIt as RawLibraryFile],
  // "Stick Figures" by Youri Tjang from libraries.excalidraw.com (the owner's request, 08.09.2026).
  ['stick-figures', stickFigures as RawLibraryFile],
];

/**
 * No real authorship timestamp exists for a v1 item (the format doesn't
 * carry one) or for a v2 item missing `created` — kept as a fixed constant
 * rather than `Date.now()` so normalizing the same file twice always
 * produces byte-identical output (required for the tests below, and
 * harmless in production since the library sidebar doesn't surface item
 * age anywhere).
 */
const FALLBACK_CREATED = 0;

/**
 * Deterministic id for an item normalized out of a v1 file, which has no
 * item-level id to preserve. Derived purely from the source slug + the
 * item's position in that file's `library` array, so re-normalizing on
 * every board load (see libraryPersistence.ts, which does exactly that)
 * always yields the same id for the same source item — required for the
 * "merge with the user's own items, no duplicates" step to be stable
 * across reloads instead of accumulating a fresh copy every time.
 *
 * Namespaced with a `folio-preset:` prefix so it can never collide with a
 * real excalidraw.com library item id (those are random nanoid-style
 * strings with no colons) or with anything a user pastes/imports.
 */
export function presetItemId(slug: string, index: number): string {
  return `folio-preset:${slug}:${index}`;
}

/** Reconstructs one validated v2 LibraryItem from loosely-typed JSON, applying `fallbackId` only when the source has no id of its own (i.e. it came from a v1 file). */
function toLibraryItem(raw: RawLibraryItem, fallbackId: string): LibraryItem {
  const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : fallbackId;
  const status = raw.status === 'unpublished' ? 'unpublished' : 'published';
  const created = typeof raw.created === 'number' ? raw.created : FALLBACK_CREATED;
  const item: LibraryItem = {
    id,
    status,
    // The source files are genuine exports from Excalidraw itself, so the
    // element payload is trusted as-is rather than deeply re-validated here
    // — same trust boundary BoardCanvas.tsx already applies to the page's
    // own saved scene (`doc.svg` -> loadFromBlob without re-checking every
    // element). Excalidraw's own restoreLibraryItems (invoked internally by
    // useHandleLibrary for every adapter.load()) still runs over this and
    // repairs/normalizes individual elements as needed.
    elements: (raw.elements ?? []) as LibraryItem['elements'],
    created,
  };
  if (typeof raw.name === 'string' && raw.name.length > 0) {
    item.name = raw.name;
  }
  return item;
}

/** Normalizes one parsed .excalidrawlib file (either version) into v2 LibraryItems. */
export function normalizeLibraryFile(slug: string, file: RawLibraryFile): LibraryItems {
  if (Array.isArray(file.libraryItems)) {
    // Already v2 — reconstruct (not just cast) each entry through
    // toLibraryItem so a malformed/partial item still gets a valid id and
    // status instead of silently carrying `undefined` through into
    // Excalidraw's library state.
    return file.libraryItems.map((raw, index) => toLibraryItem(raw as RawLibraryItem, presetItemId(slug, index)));
  }
  if (Array.isArray(file.library)) {
    // v1 — every entry is a bare elements array with no wrapper.
    return file.library.map((elements, index) =>
      toLibraryItem({ elements }, presetItemId(slug, index)),
    );
  }
  return [];
}

/** Drops later items whose id repeats an earlier one, keeping first-seen order. */
function dedupeById(items: LibraryItems): LibraryItems {
  const seen = new Set<string>();
  const result: LibraryItem[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

let cachedPresetItems: LibraryItems | null = null;

/**
 * All bundled preset libraries, normalized to v2 and concatenated in
 * PRESET_SOURCES order, with any accidental cross-file id collision
 * resolved by dropping the later duplicate (id generation is namespaced
 * per-file, so this is a defensive backstop, not an expected path).
 *
 * Pure and deterministic given the bundled JSON — cached after the first
 * call since normalizing ~48 items on every render/mount would be wasted
 * work otherwise.
 */
export function getPresetLibraryItems(): LibraryItems {
  if (!cachedPresetItems) {
    cachedPresetItems = dedupeById(PRESET_SOURCES.flatMap(([slug, file]) => normalizeLibraryFile(slug, file)));
  }
  return cachedPresetItems;
}
