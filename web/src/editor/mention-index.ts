/**
 * Who can be `@mentioned` in a space.
 *
 * The list is a team, not a directory — small, and it changes far more slowly
 * than a page is edited — so it is fetched once per space and kept for the
 * whole editor session: the decoration pass runs on every keystroke and has to
 * answer from memory. A failed request is retried later rather than cached as
 * "nobody", so a hiccup does not silently kill every pill on the page.
 */
import type { MentionableUser } from '@shared/contracts';

/** How long a failed load blocks the next attempt, so a 500 cannot become a loop. */
export const MENTION_RETRY_MS = 30_000;

interface CacheSlot {
  users: MentionableUser[];
  /** Lower-case handle -> display name, the shape the decoration pass needs. */
  names: Map<string, string>;
  pending: Promise<readonly MentionableUser[]> | null;
  loaded: boolean;
  /** When the last attempt failed; 0 means "never failed". */
  failedAt: number;
}

const cache = new Map<string, CacheSlot>();
const listeners = new Set<(space: string) => void>();

/**
 * Called once per space when its list lands. Decorations are cached by
 * position, so whoever draws pills has to be told to look again.
 */
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
  // be written as `@…` and would only pad the palette.
  const data = (await response.json()) as { users?: MentionableUser[] };
  return (data.users ?? []).filter((user) => typeof user?.username === 'string' && user.username);
}

/**
 * Resolves once this space's list has been loaded (or has failed recently
 * enough that we are still waiting out the retry delay).
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

/** Testing/navigation hook: drop everything so the next lookup refetches. */
export function clearMentionIndex(): void {
  cache.clear();
}
