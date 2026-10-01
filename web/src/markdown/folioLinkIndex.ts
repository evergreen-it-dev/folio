/**
 * Resolve-and-cache half of "a pasted Folio URL renders as a page link" —
 * see folioLinks.ts for the pure detection half this builds on. Same shape
 * and same reasoning as mentionIndex.ts (a module-level cache, plain
 * `fetch`, not react-query — this has to work wherever `<Markdown>` is
 * mounted, including EDITOR's detached hover-preview root with no ambient
 * QueryClientProvider), kept as a separate cache/module rather than folded
 * into it: a mention resolves a `@handle` against ONE space's member list,
 * this resolves an arbitrary `{space, kind, id|path}` ref, a different key
 * shape entirely.
 *
 * Deliberately reuses EXISTING endpoints (owner ask: no new endpoint) —
 * `GET /api/pages/:id` for a `kind: 'page'` ref (exactly what TreeRow's own
 * "Copy link" id came from), `GET /api/resolve?space&path` for
 * `kind: 'dir'` (path `''` for the space root — see its own doc comment in
 * server/routes.ts: "an EMPTY path means the root of this space"), the very
 * same two calls link-preview.tsx already makes for the editor's hover-card.
 *
 * `kind: 'space'` is resolved differently (round 22.09.2026, owner report
 * with a screenshot): `/api/resolve?space&path=` 404s whenever the space has
 * no root index/README page (`storage.resolve()`, server/storage.ts,
 * throws `notFound('page')`), which permanently failed EVERY such space
 * link. And even when a root page exists, its title isn't what a link to
 * the SPACE should read as — the owner wants the space's own name. So a
 * space ref is resolved from `GET /api/spaces` (`SpaceInfo[]`, filtered to
 * the caller's memberships) by matching `slug`, not through `/api/resolve`
 * at all. That list is fetched at most ONCE per page load (`spacesPromise`
 * below) and shared by every space ref on the page, same spirit as
 * mentionIndex.ts's one-fetch-per-space cache. A space missing from the
 * list (not a member) falls through to the same "failed" degradation as
 * any other ref — never a new/different failure mode.
 *
 * A ref the viewer cannot see, or that no longer exists, must degrade to
 * the plain URL — never an error or an empty label (owner ask) — so a
 * failure is cached as "give up" rather than surfaced or retried forever.
 */
import type { PageMeta, SpaceInfo } from '@shared/contracts';
import { folioLinkKey, folioLinkNavPath, type FolioLinkRef } from './folioLinks';

export interface ResolvedFolioLink {
  title: string;
  icon?: string;
  /** The in-app route to navigate to on click — see folioLinkNavPath. */
  navPath: string;
}

/** `GET /api/spaces` fetched at most once per page load and shared by every `kind: 'space'` ref — see this module's doc comment. Reset by clearFolioLinkIndex() for tests. */
let spacesPromise: Promise<SpaceInfo[]> | null = null;

function loadSpaces(): Promise<SpaceInfo[]> {
  if (!spacesPromise) {
    spacesPromise = fetch('/api/spaces', { credentials: 'same-origin' }).then(async (res) => {
      if (!res.ok) throw new Error(`spaces list unavailable (${res.status})`);
      const body = (await res.json()) as { spaces: SpaceInfo[] };
      return body.spaces;
    });
  }
  return spacesPromise;
}

const resolved = new Map<string, ResolvedFolioLink>();
/** Refs that 401/403/404'd or otherwise failed — permanently left as the plain URL, never retried (this cache is per-page-load anyway; a hard reload gets a clean slate, same as mentionIndex's retry backoff being moot once the tab is gone). */
const failed = new Set<string>();
const pending = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

/** Called once a ref settles (resolved OR failed), so a render that showed the raw URL knows to ask again. */
export function onFolioLinkSettled(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** What is known right now, without touching the network — undefined for "not yet resolved (or never will be)". */
export function resolvedFolioLink(ref: FolioLinkRef): ResolvedFolioLink | undefined {
  return resolved.get(folioLinkKey(ref));
}

/** Whether `ref` has already been tried and given up on — lets the caller stop asking. */
export function folioLinkFailed(ref: FolioLinkRef): boolean {
  return failed.has(folioLinkKey(ref));
}

async function load(ref: FolioLinkRef): Promise<ResolvedFolioLink> {
  if (ref.kind === 'page') {
    const res = await fetch(`/api/pages/${encodeURIComponent(ref.id)}`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`page ${ref.id} unresolved (${res.status})`);
    const meta = (await res.json()) as PageMeta;
    return { title: meta.title, icon: meta.icon, navPath: folioLinkNavPath(ref) };
  }
  if (ref.kind === 'space') {
    // Not `/api/resolve` — see this module's doc comment: that 404s whenever
    // the space has no root index/README, and its root page's title isn't
    // what a space link should read as anyway. `GET /api/spaces` is already
    // filtered to the caller's memberships, so a space the viewer isn't in
    // simply isn't in the list — falls through to the `undefined` below and
    // degrades to the plain URL exactly like any other unresolved ref.
    const spaces = await loadSpaces();
    const space = spaces.find((s) => s.slug === ref.space);
    if (!space) throw new Error(`space ${ref.space} not found or not a member`);
    return { title: space.name, navPath: folioLinkNavPath(ref) };
  }
  // Only 'dir' reaches here now ('page' and 'space' return above).
  const query = `space=${encodeURIComponent(ref.space)}&path=${encodeURIComponent(ref.path)}`;
  const res = await fetch(`/api/resolve?${query}`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`${ref.kind} ${ref.path} unresolved (${res.status})`);
  const meta = (await res.json()) as PageMeta | null;
  if (!meta) throw new Error(`${ref.kind} ${ref.path} not found`);
  return { title: meta.title, icon: meta.icon, navPath: folioLinkNavPath(ref) };
}

/**
 * Fires the resolve (unless already resolved/failed/in flight for this exact
 * ref), notifying listeners when it settles. Fire-and-forget by design — the
 * rehype plugin that calls this runs inside a pure `useMemo` (index.tsx), so
 * it cannot itself await anything; the caller re-renders via
 * `onFolioLinkSettled` instead, same pattern as mentionsVersion in
 * index.tsx.
 */
export function ensureFolioLinkResolved(ref: FolioLinkRef): void {
  const key = folioLinkKey(ref);
  if (resolved.has(key) || failed.has(key) || pending.has(key)) return;

  const promise = load(ref)
    .then((entry) => {
      resolved.set(key, entry);
    })
    .catch(() => {
      failed.add(key);
    })
    .finally(() => {
      pending.delete(key);
      for (const listener of listeners) listener();
    });
  pending.set(key, promise);
}

/** Testing hook: drop everything so the next lookup re-fetches. */
export function clearFolioLinkIndex(): void {
  resolved.clear();
  failed.clear();
  pending.clear();
  spacesPromise = null;
}
