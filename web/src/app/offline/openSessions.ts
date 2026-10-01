/**
 * Which pages have an editor or board session open in THIS tab right now.
 *
 * The sync engine flushes server pages that were left with unsynced edits
 * (dirtyDocs.ts) through a headless session of its own — but a page that is
 * open syncs itself, through the very Y.Doc and y-indexeddb database the
 * engine would otherwise open a second time (and then delete from under the
 * live session). A session registers here for as long as it lives; the
 * engine leaves registered pages alone.
 */
const open = new Map<string, number>();

/** Returns the release function. Reference-counted: a page can be open in more than one view. */
export function registerOpenSession(pageId: string): () => void {
  open.set(pageId, (open.get(pageId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (open.get(pageId) ?? 1) - 1;
    if (left <= 0) open.delete(pageId);
    else open.set(pageId, left);
  };
}

export function isSessionOpen(pageId: string): boolean {
  return open.has(pageId);
}

/** Tests only. */
export function resetOpenSessionsForTests(): void {
  open.clear();
}
