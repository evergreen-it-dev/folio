/**
 * In-memory index of a space's pages, used by the `[[` picker.
 *
 * The tree is small (one page per file) so it is fetched whole and kept for a
 * short while; the picker is a typeahead, and a half-minute-old list is a much
 * better trade than a request per keystroke.
 */
import type { TreeNode } from '@shared/contracts';

export interface PageEntry {
  id: string;
  title: string;
  /** Space-relative path, e.g. "architecture/data-flow.md". */
  path: string;
  kind: string;
}

/** How long a fetched tree stays usable before the next lookup refetches it. */
export const INDEX_TTL_MS = 30_000;

/**
 * Depth-first flatten. Synthetic "folder" nodes are grouping artefacts rather
 * than real pages, so they never reach the picker.
 */
export function flattenTree(nodes: readonly TreeNode[]): PageEntry[] {
  const out: PageEntry[] = [];
  const walk = (list: readonly TreeNode[]) => {
    for (const node of list) {
      if (node.kind !== 'folder' && node.path) {
        out.push({ id: node.id, title: node.title, path: node.path, kind: node.kind });
      }
      if (node.children?.length) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

interface CacheSlot {
  /** When `entries` were last successfully loaded; 0 means "never". */
  at: number;
  entries: PageEntry[];
  pending: Promise<PageEntry[]> | null;
}

const cache = new Map<string, CacheSlot>();

async function load(space: string): Promise<PageEntry[]> {
  const response = await fetch(`/api/spaces/${encodeURIComponent(space)}/tree`, {
    credentials: 'same-origin',
  });
  if (!response.ok) throw new Error(`tree request failed with ${response.status}`);
  const data = (await response.json()) as { tree?: TreeNode[] };
  return flattenTree(data.tree ?? []);
}

function slotFor(space: string): CacheSlot {
  let slot = cache.get(space);
  if (!slot) {
    slot = { at: 0, entries: [], pending: null };
    cache.set(space, slot);
  }
  return slot;
}

function refresh(slot: CacheSlot, space: string): Promise<PageEntry[]> {
  if (slot.pending) return slot.pending;
  slot.pending = load(space)
    .then((entries) => {
      slot.entries = entries;
      slot.at = Date.now();
      return entries;
    })
    .catch(() => {
      // Keep whatever we had; a failed refresh must not empty the picker.
      slot.at = Date.now();
      return slot.entries;
    })
    .finally(() => {
      slot.pending = null;
    });
  return slot.pending;
}

/**
 * Entries known right now, kicking off a background refresh when stale. Returns
 * the previous list rather than nothing while that runs, so the picker never
 * blinks empty mid-typing.
 */
export function pageIndex(space: string, now = Date.now()): PageEntry[] {
  const slot = slotFor(space);
  if (now - slot.at >= INDEX_TTL_MS) void refresh(slot, space);
  return slot.entries;
}

/** Resolves once the space has been loaded at least once. */
export function ensurePageIndex(space: string): Promise<PageEntry[]> {
  const slot = slotFor(space);
  if (slot.at === 0 || slot.pending) return refresh(slot, space);
  return Promise.resolve(slot.entries);
}

/** Testing/navigation hook: drop everything so the next lookup refetches. */
export function clearPageIndex(): void {
  cache.clear();
}
