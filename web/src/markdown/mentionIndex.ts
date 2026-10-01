/**
 * Cache for GET /api/spaces/:space/mentionable, shared by every `<Markdown>`
 * currently mounted for a given space.
 *
 * A plain fetch with a module-level cache, not react-query: `<Markdown>` has
 * to work wherever it is mounted, including EDITOR's own detached React root
 * for the internal-link hover-preview card and the live html-widget (see
 * `mountReact` in editor/react-host.ts) — neither carries an ambient
 * `QueryClientProvider`, so a `useQuery` call there would throw. This matches
 * this module's own established precedent (see PageTree.tsx's docblock, and
 * index.tsx's relative-link click handler, both a raw fetch for the same
 * reason) rather than DEV-PLAN's literal "react-query" wording — the actual
 * requirement, "don't repeat the request on every render", is what this
 * cache exists to satisfy: a space's list is fetched once and shared by
 * every consumer for as long as the page lives.
 *
 * Deliberately independent of editor/mention-index.ts (same shape, separate
 * cache) — SHELL/MARKDOWN and EDITOR own their own zones per DEV-PLAN, and
 * the two run on different lifetimes anyway (one editing session vs.
 * however many reading views/previews happen to be mounted at once). A
 * failed request backs off for MENTION_RETRY_MS rather than being cached as
 * "nobody", so one hiccup can't blank every pill on the page for the rest of
 * the session.
 */
import type { MentionableUser } from '@shared/contracts';

export const MENTION_RETRY_MS = 30_000;

interface CacheSlot {
  users: MentionableUser[];
  /** Lower-case handle -> display name, the shape rehypeMentions' lookup needs. */
  names: Map<string, string>;
  pending: Promise<readonly MentionableUser[]> | null;
  loaded: boolean;
  /** When the last attempt failed; 0 means "never failed". */
  failedAt: number;
}

const cache = new Map<string, CacheSlot>();
const listeners = new Set<(space: string) => void>();

/** Called once per space when its list lands, so anything holding stale "unknown" answers knows to ask again. */
export function onMentionsLoaded(listener: (space: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function slotFor(space: string): CacheSlot {
  let slot = cache.get(space);
  if (!slot) {
    slot = { users: [], names: new Map(), pending: null, loaded: false, failedAt: 0 };
    cache.set(space, slot);
  }
  return slot;
}

async function load(space: string): Promise<MentionableUser[]> {
  const response = await fetch(`/api/spaces/${encodeURIComponent(space)}/mentionable`, {
    credentials: 'same-origin',
  });
  if (!response.ok) throw new Error(`mentionable request failed with ${response.status}`);
  // The endpoint answers `{ users: [...] }`; anything without a handle cannot
  // be written as `@…` and would only ever fail every lookup.
  const data = (await response.json()) as { users?: MentionableUser[] };
  return (data.users ?? []).filter((user) => typeof user?.username === 'string' && user.username);
}

/**
 * Resolves once this space's list has been loaded (or has failed recently
 * enough that we are still waiting out the retry delay). Callers that only
 * care about firing the fetch (not its result) can ignore the return value —
 * `mentionName` below reads straight from the cache once it settles.
 */
export function ensureMentionIndex(
  space: string,
  now = Date.now(),
): Promise<readonly MentionableUser[]> {
  const slot = slotFor(space);
  if (slot.loaded) return Promise.resolve(slot.users);
  if (slot.pending) return slot.pending;
  if (slot.failedAt && now - slot.failedAt < MENTION_RETRY_MS) return Promise.resolve(slot.users);

  slot.pending = load(space)
    .then((users) => {
      slot.users = users;
      slot.names = new Map(users.map((user) => [user.username.toLowerCase(), user.name]));
      slot.loaded = true;
      slot.failedAt = 0;
      for (const listener of listeners) listener(space);
      return slot.users;
    })
    .catch(() => {
      slot.failedAt = Date.now();
      return slot.users; // stay silent: mentions are decoration, not content
    })
    .finally(() => {
      slot.pending = null;
    });
  return slot.pending;
}

/** What is known right now, without touching the network. */
export function mentionIndex(space: string): readonly MentionableUser[] {
  return cache.get(space)?.users ?? [];
}

/**
 * Display name for a handle, or undefined when this space has never heard of
 * it — an unknown `@foo` stays ordinary text, exactly as it is stored.
 */
export function mentionName(space: string, handle: string): string | undefined {
  return cache.get(space)?.names.get(handle.toLowerCase());
}

/** Testing hook: drop everything so the next lookup refetches. */
export function clearMentionIndex(): void {
  cache.clear();
}
