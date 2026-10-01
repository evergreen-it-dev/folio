/**
 * Share links (round 8): unauthenticated view/edit access to exactly one
 * page via a bare random token in a URL — no session, no RBAC, scoped to
 * that single page_id only, never a whole space.
 *
 * Tokens are stored PLAINTEXT (not hashed, unlike sessions/api_tokens): a
 * share link is closer to "a resource you can list and manage" than "a
 * password" — GET /api/pages/:id/shares needs to keep showing the full
 * shareable URL (which embeds the token) every time it's listed, not just
 * once at creation the way a PAT is.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { ShareLinkInfo, ShareLinkMode } from '../shared/contracts.js';
import { query, queryOne } from './db/pool.js';
import { publicUrlOrOrigin } from './publicUrl.js';

interface ShareLinkRow {
  id: string;
  token: string;
  page_id: string;
  mode: ShareLinkMode;
  created_by: string;
  created_by_name: string; // joined from users.name
  created_at: string;
  revoked_at: string | null;
  /** Round 23 (migration 017): the subtree flag, stored on the token itself. */
  include_children: boolean;
}

/** PUBLIC_URL (scheme-normalized — see publicUrl.ts) if set; otherwise falls back to the caller-supplied request origin (round 8: "URL built from PUBLIC_URL, fallback request origin"). */
function shareUrl(token: string, originFallback: string): string {
  return `${publicUrlOrOrigin(originFallback)}/share/${token}`;
}

function rowToInfo(row: ShareLinkRow, originFallback: string): ShareLinkInfo {
  const url = shareUrl(row.token, originFallback);
  return {
    id: row.id,
    mode: row.mode,
    url,
    // Round 23 (EXPORT-SERVER wave): GET /share/:token.md — same token, raw markdown.
    mdUrl: `${url}.md`,
    createdAt: new Date(row.created_at).toISOString(),
    createdBy: row.created_by_name,
    // Round 23: `share_links.include_children` (migration 017). Both meanings of
    // the flag (a human browsing the subtree, an agent/export collating it into
    // one document) read it from here — see server/export/shareScope.ts.
    includeChildren: row.include_children,
  };
}

const SHARE_SELECT = `SELECT sl.*, u.name AS created_by_name FROM share_links sl JOIN users u ON u.id = sl.created_by`;

export async function listSharesForPage(pageId: string, originFallback: string): Promise<ShareLinkInfo[]> {
  const rows = await query<ShareLinkRow>(`${SHARE_SELECT} WHERE sl.page_id = $1 AND sl.revoked_at IS NULL ORDER BY sl.created_at`, [pageId]);
  return rows.map((r) => rowToInfo(r, originFallback));
}

export async function createShareLink(
  pageId: string,
  createdBy: string,
  mode: ShareLinkMode,
  originFallback: string,
  /** Round 23: default false keeps every existing caller's meaning ("this one page") unchanged. */
  includeChildren = false,
): Promise<ShareLinkInfo> {
  const token = randomBytes(16).toString('hex');
  await query('INSERT INTO share_links (id, token, page_id, mode, created_by, include_children) VALUES ($1, $2, $3, $4, $5, $6)', [
    randomUUID(),
    token,
    pageId,
    mode,
    createdBy,
    includeChildren,
  ]);
  const row = await queryOne<ShareLinkRow>(`${SHARE_SELECT} WHERE sl.token = $1`, [token]);
  return rowToInfo(row!, originFallback);
}

export interface ResolvedShare {
  id: string;
  pageId: string;
  mode: ShareLinkMode;
  /** Round 23: whether this token's grant extends to the page's whole subtree. */
  includeChildren: boolean;
}

/** Resolves a raw token to its page + mode. undefined for unknown OR revoked (same non-distinguishing treatment as an unknown session/PAT). */
export async function resolveShareToken(token: string): Promise<ResolvedShare | undefined> {
  const row = await queryOne<{ id: string; page_id: string; mode: ShareLinkMode; include_children: boolean }>(
    'SELECT id, page_id, mode, include_children FROM share_links WHERE token = $1 AND revoked_at IS NULL',
    [token],
  );
  return row ? { id: row.id, pageId: row.page_id, mode: row.mode, includeChildren: row.include_children } : undefined;
}

export interface ShareForRevoke {
  createdBy: string;
  pageId: string;
}

/** For the DELETE route's own creator-or-space-admin authorization check. */
export async function getShareForRevoke(id: string): Promise<ShareForRevoke | undefined> {
  const row = await queryOne<{ created_by: string; page_id: string }>(
    'SELECT created_by, page_id FROM share_links WHERE id = $1 AND revoked_at IS NULL',
    [id],
  );
  return row ? { createdBy: row.created_by, pageId: row.page_id } : undefined;
}

/**
 * Round 23 follow-up: `include_children` is EDITABLE on a live token.
 *
 * It used to be write-once (set at creation, never changed), and that turned
 * the creation checkbox into a trap: it sits below an already-created link,
 * so ticking it looks like it applies to that link when in fact it only
 * affected the next one created. The owner hit exactly this — ticked the box,
 * fetched `/share/<token>.md`, got one page.
 *
 * Widening a token's scope this way is a real access change (the link is
 * already in someone's hands), so the route gates it the same as revoke:
 * creator or space admin only.
 */
export async function setShareIncludeChildren(id: string, includeChildren: boolean): Promise<void> {
  await query('UPDATE share_links SET include_children = $2 WHERE id = $1 AND revoked_at IS NULL', [id, includeChildren]);
}

/** Soft revoke — the row stays (auditable), just no longer resolvable. */
export async function revokeShare(id: string): Promise<void> {
  await query('UPDATE share_links SET revoked_at = now() WHERE id = $1', [id]);
}
