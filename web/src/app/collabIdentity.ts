/**
 * Shared piece of collab-awareness identity: editor/collab.ts,
 * diagrams/boardCollab.ts and tables/collab/useTableCollab.ts each open a
 * y-websocket session and publish `{ name, color, colorLight }` into that
 * session's awareness under the `user` field — that shape is what a
 * neighbour's cursor/selection renders. Historically all three only ever
 * minted a random anonymous identity (`anonUser()`), stored per-browser in
 * localStorage, with no idea a signed-in user could exist — hence a logged-in
 * person showing up to collaborators as "Gentle Lynx". This module is the
 * ONE place that decides what a signed-in user's identity looks like there,
 * so the three call sites stay in sync instead of drifting.
 *
 * Lives in app/ rather than editor/ specifically so diagrams/boardCollab.ts
 * can use it too: that module's own docblock explains why it refuses to
 * import from editor/ (editor/ already imports diagrams/, so the reverse
 * edge would be a cycle). app/auth/AuthProvider.tsx's own import chain
 * (api.ts, i18n, roles, SetupScreen, LoginScreen) never reaches editor/ or
 * diagrams/, and editor/ and diagrams/ already import other app/ modules
 * elsewhere — so this adds no cycle in either direction.
 */
import { useQuery } from '@tanstack/react-query';
import type { User } from '@shared/contracts';
import { api } from './api';

/**
 * Round (page presence): `id` and `username` are ADDITIONS to this shape,
 * not a replacement — every existing reader of a peer's awareness `user`
 * field (board cursors in diagrams/boardCollab.ts, cell highlights in
 * tables/collab/awareness.ts) only ever looked at `name`/`color`/
 * `colorLight`, so those two keep working unmodified against a neighbour on
 * either the old or the new bundle. Both new fields are OPTIONAL: an
 * anonymous guest (anonUser() in editor/collab.ts and diagrams/boardCollab.ts)
 * has neither a real `id` nor a `username` and simply omits them — see
 * app/presence.ts's reducePagePresence for how that absence is handled
 * (dedup falls back to the awareness clientId).
 */
export interface CollabIdentity {
  /** Signed-in user's id — absent for an anonymous share-link guest. */
  id?: string;
  name: string;
  /** @handle, when the signed-in user has set one. */
  username?: string;
  color: string;
  colorLight: string;
}

/**
 * Tiny, stable string hash (djb2 variant) — not for security, just needs to
 * spread ordinary user ids reasonably evenly across a small palette and, for
 * the same input, always land on the same index.
 */
function hashToIndex(input: string, modulo: number): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return Math.abs(hash) % modulo;
}

/**
 * The awareness identity for a SIGNED-IN user: their real `name`, falling
 * back to `@username` when `name` is empty (and to the empty name itself if
 * even that isn't set — schema requires a non-empty name on creation, so
 * this only matters for odd historical data). The colour is derived
 * deterministically from `user.id` rather than randomised — unlike the
 * anonymous identity, a real person should be the same colour to every
 * collaborator, in every browser, even after clearing localStorage.
 *
 * `palette` is the CALLER's own PALETTE array — editor/collab.ts and
 * diagrams/boardCollab.ts each keep an independent copy of the same colours
 * (see boardCollab.ts's docblock for why), and tables/collab/useTableCollab.ts
 * reuses editor's. Taking it as a parameter means this module doesn't need
 * its own third copy, and the colour always comes from the palette actually
 * in use at that call site.
 */
export function resolveAuthedIdentity(user: Pick<User, 'id' | 'name' | 'username'>, palette: readonly string[]): CollabIdentity {
  const name = user.name.trim() ? user.name : user.username ? `@${user.username}` : user.name;
  const color = palette[hashToIndex(user.id, palette.length)];
  return { id: user.id, name, username: user.username || undefined, color, colorLight: `${color}33` };
}

/**
 * Fix/share-identity: the signed-in user, resolved directly via
 * GET /api/auth/state — works BOTH inside `<AuthProvider>` (same
 * `['auth', 'state']` query key, so React Query just hands back its already
 * -cached result, no extra fetch) and OUTSIDE it, on a public route like
 * `/share/:token`, where `useAuthOptional()` always reads `null` because
 * `<AuthProvider>` itself never mounts there — see AuthProvider.tsx's own
 * docblock: it renders a hard login wall in place of its children whenever
 * there's no session, which is exactly what a genuinely anonymous share
 * visitor must NOT hit. This hook is the "ask without gating" alternative:
 * a share-link visitor who ALSO happens to be logged in (the common case —
 * a teammate opens a link they were sent while still signed in to Folio)
 * gets their real identity back; a genuine anonymous guest gets `null`,
 * same as `useAuthOptional()?.user` today. QueryClientProvider wraps the
 * whole app including `/share/*` (see App.tsx), so this is safe to call
 * from any collab hook regardless of which side of the AuthProvider gate
 * it renders on.
 *
 * Three-way result — `undefined` is a real, distinct state, not "no user":
 * the query hasn't settled yet, so a caller that needs to choose between
 * "anonymous" and "signed in" (rather than just falling back to anonymous
 * meanwhile, as the identity call sites below do) should wait for it to
 * become `null` or a `User` before deciding. `isError` collapses straight to
 * `null` rather than leaving callers stuck on `undefined` forever if
 * /api/auth/state itself is unreachable — degrading to "treat as anonymous"
 * is the same failure mode an actually-logged-out visitor already produces.
 */
export function useOptionalSessionUser(): User | null | undefined {
  const { data, isError } = useQuery({ queryKey: ['auth', 'state'], queryFn: api.getAuthState });
  if (isError) return null;
  return data?.user;
}
