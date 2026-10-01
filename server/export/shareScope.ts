/**
 * Round 23 (EXPORT), R23 addendum 2 points 2 and 3 — what one share token
 * actually grants once `includeChildren` exists.
 *
 * Before this round a token meant exactly one page id. It can now mean "this
 * page AND its subtree", and the spec is emphatic about how that membership
 * is decided: "membership in the subtree by the index, not by a prefix of the
 * path string (otherwise `foo-bar.md` slips under a share of `foo`)". Everything here therefore
 * goes through collect.ts, which goes through storage.getSubtree — no path
 * string is ever compared.
 *
 * `shareGrantsPage` is the reusable predicate. `GET /share/:token.md` uses it
 * implicitly (it collates exactly the granted set); the `/files/:space/*`
 * hook in server/index.ts — which today widens a token to its whole space by
 * a deliberate, documented round-8 tradeoff — can be narrowed onto it later
 * with a one-line change, which is why it is exported from here rather than
 * inlined into the route.
 */
import * as shares from '../shares.js';
import type { ResolvedShare } from '../shares.js';
import * as storage from '../storage.js';
import type { PageIndexEntry } from '../storage.js';
import { collectForExport, type CollectedSubtree } from './collect.js';

export interface ShareScope {
  share: ResolvedShare;
  /** The page the token names. */
  root: PageIndexEntry;
  /** Root alone, or root + subtree when the token carries includeChildren. */
  collected: CollectedSubtree;
}

/**
 * undefined for an unknown OR revoked token (the existing non-distinguishing
 * treatment — a revoked link must break instantly and look exactly like one
 * that never existed) and for a token whose page has since been deleted.
 */
export async function resolveShareScope(token: string): Promise<ShareScope | undefined> {
  const share = await shares.resolveShareToken(token);
  if (!share) return undefined;
  const root = await storage.getEntry(share.pageId);
  if (!root) return undefined;
  return { share, root, collected: await collectForExport(root, share.includeChildren) };
}

/** True when `pageId` is the token's own page, or — with includeChildren — a real descendant of it per the index. */
export async function shareGrantsPage(token: string, pageId: string): Promise<boolean> {
  const scope = await resolveShareScope(token);
  return scope ? scope.collected.ids.has(pageId) : false;
}
