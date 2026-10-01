import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Stars } from '@shared/contracts';
import { api } from '../app/api';
import { decideFavoriteWrites, seedFavorites, toggleFavorite } from './favorites';

/**
 * Deliberately its OWN cache key, not app/stars.ts's STARS_KEY — even
 * though both ultimately read the same GET /api/me/stars response (one
 * extra, harmless redundant fetch when both hooks are mounted at once).
 * Found live: SERVER's PUT /api/me/stars/emoji/:char stores exactly (and
 * only) the characters explicitly toggled — it has no notion of
 * DEFAULT_EMOJI_FAVORITES, which is a client-only display fallback. So the
 * first-ever toggle from a fresh (server-empty) list optimistically expands
 * to "defaults + the new pick" locally, but the server's own response after
 * that PUT reports back just the one character. Sharing app/stars.ts's key
 * would mean that feature's OWN invalidations (starring a page, etc.) could
 * refetch and silently narrow the emoji list back down to the server's
 * literal (shorter) truth mid-session — a dedicated key rules that out
 * entirely rather than chasing it case by case.
 */
const EMOJI_FAVORITES_QUERY_KEY = ['emoji-favorites'] as const;

/**
 * Emoji favorites (round 6). Deliberately context-free: no useNavigate, no
 * useAuth, nothing from app/'s own React providers — this is exactly why
 * web/src/emoji/ exists as a standalone module (like markdown/), so
 * editor/ can use the same picker + favorites without pulling in the app
 * shell's router/auth context. It *does* use app/api.ts's plain `api`
 * client (a context-free fetch wrapper, not a hook) and @tanstack/react-query
 * (an ambient provider already present wherever this mounts, same as
 * editor/'s own code already assumes) — both fine per the coordinator's
 * explicit call on this.
 *
 * Optimistic toggle, deliberately never reconciled back against the server
 * response — neither on success nor on error. On error (most commonly a
 * 404 while SERVER's emoji-kind endpoints are still queued/rolling out)
 * that's exactly "toggles local-only (no crash)". On *success* it's the
 * fix for the mismatch described above: invalidating-and-refetching right
 * after a successful PUT would immediately snap a nicely-seeded 13-item
 * optimistic list down to the server's narrower literal state. The
 * optimistic value already reflects the user's intent correctly; the PUT
 * exists to best-effort persist it, not to be re-pulled as more
 * authoritative than what we just computed. (A fresh page load's initial
 * fetch is unaffected by any of this — it simply seeds from whatever the
 * server reports at that moment, same as always.)
 *
 * Materialization (round-6 follow-up, coordinator sign-off): the first
 * toggle while the server's own list is still empty/absent doesn't just
 * PUT the one clicked emoji — decideFavoriteWrites (favorites.ts) works out
 * the *whole* resulting set and every write in it fires here, once, via
 * Promise.allSettled (order doesn't matter — every write is an independent
 * single-emoji PUT, so partial completion is safe to leave partial). Once
 * the server has anything at all, every later toggle is back to the normal
 * single write. `onPartialFailure` — optional, since this module stays
 * context-free — fires at most once per materialization, and only for a
 * genuine *partial* failure (some writes landed, some didn't); a total
 * failure (e.g. the endpoint 404ing because it hasn't shipped) stays fully
 * silent, same "local-only, no crash" contract as a normal single toggle.
 * Either way the optimistic list is never reverted.
 */
export function useEmojiFavorites(onPartialFailure?: () => void, options?: { enabled?: boolean }) {
  const queryClient = useQueryClient();
  // `enabled: false` is for the one caller that knows there is no session to
  // ask about — an anonymous share-link editor, where GET /api/me/stars only
  // ever 401s. Favourites are per-user, so the seeded default list is exactly
  // right for a guest; nothing degrades.
  const enabled = options?.enabled ?? true;
  const { data, isLoading } = useQuery({ queryKey: EMOJI_FAVORITES_QUERY_KEY, queryFn: api.getStars, enabled });
  const favorites = seedFavorites(data?.emojis);

  const toggle = useMutation({
    mutationFn: async ({ writes }: { emoji: string; starred: boolean; writes: ReturnType<typeof decideFavoriteWrites> }) => {
      const results = await Promise.allSettled(writes.map((w) => api.setEmojiStar(w.emoji, w.starred)));
      const failures = results.filter((r) => r.status === 'rejected').length;
      return { failures, total: writes.length };
    },
    onMutate: async ({ emoji, starred }) => {
      await queryClient.cancelQueries({ queryKey: EMOJI_FAVORITES_QUERY_KEY });
      queryClient.setQueryData<Stars>(EMOJI_FAVORITES_QUERY_KEY, (current) => {
        const base = seedFavorites(current?.emojis);
        return { spaces: [], pages: [], ...current, emojis: toggleFavorite(base, emoji, starred) };
      });
    },
    onSuccess: ({ failures, total }) => {
      const isPartialFailure = failures > 0 && failures < total;
      if (isPartialFailure) onPartialFailure?.();
    },
    // No onError/revert on purpose — see docblock above. mutationFn itself
    // never throws (Promise.allSettled swallows individual rejections), so
    // onError here would only fire for something outside our control (e.g.
    // a synchronous bug) — nothing to special-case.
  });

  return {
    favorites,
    isLoading,
    isFavorite: (emoji: string) => favorites.includes(emoji),
    toggleFavorite: (emoji: string) => {
      const starred = !favorites.includes(emoji);
      const current = queryClient.getQueryData<Stars>(EMOJI_FAVORITES_QUERY_KEY);
      const writes = decideFavoriteWrites(current?.emojis, emoji, starred);
      toggle.mutate({ emoji, starred, writes });
    },
  };
}
