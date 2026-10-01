import { DEFAULT_EMOJI_FAVORITES } from '@shared/contracts';

/**
 * The favorites list to actually show: the user's own saved list once it
 * has anything in it, the twelve defaults otherwise — covers both "never
 * customized" (server has no `emojis` field / the round-6 endpoints
 * haven't shipped yet) and "customized down to nothing" (an explicit empty
 * array), per the coordinator's exact wording: "seeded with
 * DEFAULT_EMOJI_FAVORITES when server list empty/absent". Applied at read
 * time (not just once at initial fetch) so removing the last favorite
 * falls back to the defaults immediately rather than leaving a blank row.
 */
export function seedFavorites(emojis: string[] | undefined): string[] {
  return emojis && emojis.length > 0 ? emojis : [...DEFAULT_EMOJI_FAVORITES];
}

/**
 * Pure toggle: appends to the end if turning a favorite on and it isn't
 * already present, removes it (wherever it sits) if turning off. Idempotent
 * under retries — toggling to a state the list is already in is a no-op
 * (returns the same reference), same convention as app/stars.ts's
 * applyStarToggle.
 */
export function toggleFavorite(favorites: readonly string[], emoji: string, starred: boolean): string[] {
  const has = favorites.includes(emoji);
  if (has === starred) return favorites as string[];
  return starred ? [...favorites, emoji] : favorites.filter((existing) => existing !== emoji);
}

export interface FavoriteWrite {
  emoji: string;
  starred: boolean;
}

/**
 * What to actually PUT for one toggle action, given the server's *own*
 * current list (not the seeded/displayed one). Coordinator's answer to the
 * flagged product question: defaults must materialize on first
 * customization, not just the one clicked emoji — otherwise the twelve
 * defaults the user sees are a client-side illusion that vanishes the
 * instant the server's list becomes non-empty (this is exactly the bug
 * found live in the previous round).
 *
 * - Server list empty/absent (the display is currently showing the seeded
 *   defaults, not a real server list): persist the WHOLE resulting set —
 *   one `starred: true` write per emoji in `toggleFavorite(seedFavorites(...),
 *   emoji, starred)` — so the server actually ends up holding what's shown.
 *   A removal doesn't need its own write here: it was never on the (empty)
 *   server to begin with, so simply not including it in the materialized
 *   set is enough.
 * - Server list non-empty (already materialized/customized): the normal
 *   single write, unchanged.
 *
 * Note this re-triggers whenever the server list *becomes* empty again —
 * removing the last favorite and then adding a different one re-materializes
 * defaults+1, not just the one item. Accepted behavior (coordinator sign-off),
 * documented rather than special-cased away.
 */
export function decideFavoriteWrites(serverEmojis: string[] | undefined, emoji: string, starred: boolean): FavoriteWrite[] {
  if (serverEmojis && serverEmojis.length > 0) {
    return [{ emoji, starred }];
  }
  const materialized = toggleFavorite(seedFavorites(serverEmojis), emoji, starred);
  return materialized.map((e) => ({ emoji: e, starred: true }));
}
