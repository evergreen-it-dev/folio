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
 * Security review F-02: `resolveShareScope` is the ONE place that decides a
 * share's page set, and every public consumer reads `collected` from it
 * rather than walking the tree again — the JSON payload and its `?page=`
 * (server/routes.ts), the Markdown link (./routes.ts), the link-preview meta
 * (server/shareMeta.ts), the collab WebSocket admission (server/collab.ts,
 * via `shareGrantsPage`) and the raw-file route (server/fileAccess.ts, which
 * serves a guest only these pages' files and what they reference).
 *
 * The policy: a subtree share never includes a page that is not open to the
 * whole space (pageAccess.restrictedPageIds — a `page_access` row, or a
 * `.agent/**` page), nor anything below such a page. A restricted page can
 * be shared only by its own explicit link: the token's root is always in the
 * set (creating the link already required editor rights on it). Nothing is
 * stored with the token, so the set follows the page-access state at every
 * request — restricting a page after the link was created removes it, and
 * its subtree, at the next request.
 */
import * as shares from '../shares.js';
import type { ResolvedShare } from '../shares.js';
import * as storage from '../storage.js';
import type { PageIndexEntry } from '../storage.js';
import * as pageAccess from '../pageAccess.js';
import { collectForExport, type CollectedSubtree } from './collect.js';

export interface ShareScope {
  share: ResolvedShare;
  /** The page the token names. */
  root: PageIndexEntry;
  /** Root alone, or root + its unrestricted subtree when the token carries includeChildren. */
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
  const pruned = share.includeChildren ? await pageAccess.restrictedPageIds(root.space) : undefined;
  return { share, root, collected: await collectForExport(root, share.includeChildren, undefined, undefined, pruned) };
}

/** True when `pageId` is the token's own page, or — with includeChildren — an unrestricted descendant of it per the index (see the module doc). */
export async function shareGrantsPage(token: string, pageId: string): Promise<boolean> {
  const scope = await resolveShareScope(token);
  return scope ? scope.collected.ids.has(pageId) : false;
}
