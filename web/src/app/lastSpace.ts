/**
 * "Where was I" — the space slug the user last had open, so leaving the
 * space shell and coming back doesn't dump them somewhere else.
 *
 * The bug this exists for (owner, 11.09): every route outside the space
 * shell — /admin/access, /trash — offers a "back" link to `/`, and `/` is
 * RootRedirect, which sent everyone to `spaces[0]`. Open a page in your
 * fourth space, go to settings, come back: you land in the FIRST space, with
 * no hint that anything moved. The redirect wasn't wrong so much as
 * uninformed; it had no idea where you came from.
 *
 * Deliberately localStorage rather than a React context: the value has to
 * outlive a full page load (a bookmarked `/`, a reload, tomorrow morning),
 * which no in-memory channel does. It is a NAVIGATION convenience holding a
 * slug the user just visited — never an access decision: RootRedirect only
 * honours it when the slug is still in the spaces list the SERVER returned
 * for this user, so a revoked (or renamed, or deleted) space quietly falls
 * back to the old behaviour instead of bouncing anyone into a 404 or a
 * space they can no longer open.
 */

const LAST_SPACE_KEY = 'folio:last-space';

/** Records the space the user is currently in. Safe to call on every render path — storage failures (private mode, disabled site data) are non-events. */
export function rememberLastSpace(slug: string): void {
  if (!slug) return;
  try {
    localStorage.setItem(LAST_SPACE_KEY, slug);
  } catch {
    // storage unavailable — the redirect just falls back to the first space
  }
}

/** The last space slug seen, or null when there is none / storage is unavailable. Callers MUST check it against the user's real space list before navigating. */
export function readLastSpace(): string | null {
  try {
    return localStorage.getItem(LAST_SPACE_KEY) || null;
  } catch {
    return null;
  }
}
