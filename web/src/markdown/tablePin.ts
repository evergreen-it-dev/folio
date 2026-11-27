/**
 * Per-viewer "pin" state of a tall table: pinned (the default) = the table
 * scrolls inside its own capped box with a sticky header row; unpinned = full
 * height, only the page scrolls. Shared by the reading view (tableFit.ts) and
 * the live-edit table widget so one choice means the same thing in both.
 *
 * Only the indices the viewer UNPINNED are stored (default is pinned), per
 * page, in localStorage. Never in markdown. Every access is guarded: storage
 * can throw (private window, blocked site data) and the table must still render.
 */

const PIN_KEY_PREFIX = 'folio:tablePin:';

/** Height above which a table gets its own inner scroller. Mirrored by the CSS
 * `max-height: 70vh` in markdown.css / editor.css. */
export const TABLE_MAX_HEIGHT_VH = 70;

export function readUnpinnedTables(pageId: string): Set<number> {
  if (!pageId) return new Set();
  try {
    const raw = localStorage.getItem(PIN_KEY_PREFIX + pageId);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? new Set(parsed.filter((v): v is number => typeof v === 'number')) : new Set();
  } catch {
    return new Set();
  }
}

export function writeUnpinnedTables(pageId: string, indices: ReadonlySet<number>): void {
  if (!pageId) return;
  try {
    if (indices.size === 0) localStorage.removeItem(PIN_KEY_PREFIX + pageId);
    else localStorage.setItem(PIN_KEY_PREFIX + pageId, JSON.stringify(Array.from(indices)));
  } catch {
    // The choice just won't outlive this session.
  }
}

export function isTablePinned(pageId: string, index: number): boolean {
  return !readUnpinnedTables(pageId).has(index);
}

/** Flips one table's pin and returns the new state (true = pinned). */
export function toggleTablePinned(pageId: string, index: number): boolean {
  const unpinned = readUnpinnedTables(pageId);
  const nowPinned = unpinned.has(index);
  if (nowPinned) unpinned.delete(index);
  else unpinned.add(index);
  writeUnpinnedTables(pageId, unpinned);
  return nowPinned;
}
