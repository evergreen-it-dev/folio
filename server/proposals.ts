/**
 * Agent write mode and the review queue (migration 062, contract shared/proposals.ts).
 *
 * In a space set to `review`, a Markdown edit made by an AGENT — update_page and
 * create_page over MCP (external agents and the built-in assistant alike), PUT
 * /api/pages/:id with an API token — is not written. It lands here as a proposal;
 * an editor accepts it (the text is then applied through collab.editDocBody, the
 * path every direct write takes) or rejects it. Typing in the browser never comes
 * through here.
 *
 * Git: an accepted proposal is recorded under the REVIEWER's name (the editor who
 * pressed Accept is who published the text); who proposed it, and with which token,
 * stays in audit_log (proposal.created / proposal.accepted).
 *
 * The HTTP wrapper is server/proposalsRoutes.ts; the MCP tools call
 * submitProposal() from server/mcp.ts.
 */
import { createHash } from 'node:crypto';
import type { User } from '../shared/contracts.js';
import type { PageProposalDetail, PageProposalSummary, ProposalKind, ProposalStatus, AgentWriteMode } from '../shared/proposals.js';
import { recordAudit } from './audit.js';
import { isAgentPath } from './agentPath.js';
import * as session from './auth/session.js';
import * as collab from './collab.js';
import { query, queryOne } from './db/pool.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from './errors.js';
import * as gitSync from './gitSync.js';
import * as notifications from './notifications/dispatch.js';
import { spaceRoleSql } from './access/roleSql.js';
import { parseOwner } from '../shared/verification.js';
import * as storage from './storage.js';
import type { PageIndexEntry } from './storage.js';

/** Told to the agent (and to a model reading a tool result), so English. */
export const PROPOSED_MESSAGE =
  'The edit was sent for review and will be applied when an editor accepts it; there is no need to repeat it. Sending a new edit to the same page replaces this one while it is open.';

export function reviewRefusal(what: string): string {
  return `This space is in review mode: ${what} is not available to agents, because only Markdown page edits (update_page, create_page) can be sent for review so far. Ask a person to make this change, or ask a space admin to switch the space back to direct mode.`;
}

// ---------------------------------------------------------------------------
// The setting
// ---------------------------------------------------------------------------

export async function getAgentWriteMode(space: string): Promise<AgentWriteMode> {
  const row = await queryOne<{ agent_write_mode: AgentWriteMode }>('SELECT agent_write_mode FROM spaces WHERE slug = $1', [space]);
  return row?.agent_write_mode === 'review' ? 'review' : 'direct';
}

/** Slugs of every space in review mode: one query for the whole space list. */
export async function reviewModeSpaces(): Promise<Set<string>> {
  const rows = await query<{ slug: string }>("SELECT slug FROM spaces WHERE agent_write_mode = 'review'");
  return new Set(rows.map((r) => r.slug));
}

export async function setAgentWriteMode(space: string, mode: AgentWriteMode): Promise<AgentWriteMode> {
  const row = await queryOne<{ agent_write_mode: AgentWriteMode; previous: AgentWriteMode }>(
    `UPDATE spaces s SET agent_write_mode = $2
       FROM (SELECT agent_write_mode AS previous FROM spaces WHERE slug = $1) old
      WHERE s.slug = $1 RETURNING s.agent_write_mode, old.previous`,
    [space, mode],
  );
  if (!row) throw notFound('space');
  return row.previous;
}

/** REST: a token-authenticated request to something the review queue does not cover is refused in a review space. */
export async function assertTokenMayWriteDirect(space: string, what: string): Promise<void> {
  if ((await getAgentWriteMode(space)) === 'review') throw forbidden(reviewRefusal(what));
}

// ---------------------------------------------------------------------------
// Hash of a page's text
// ---------------------------------------------------------------------------

/** Line endings and surrounding blank space do not change a text's meaning, so they do not make a proposal stale. */
export function hashText(text: string): string {
  return createHash('sha256').update(collab.normalizeEol(text).trim()).digest('hex');
}

/** What the page says right now: the live room when one is open, else the file. */
export async function currentText(pageId: string): Promise<string> {
  return collab.isDocLive(pageId) ? (collab.getLiveText(pageId) ?? (await storage.readFreshDocBody(pageId))) : await storage.readFreshDocBody(pageId);
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface ProposalRow {
  id: string;
  space_slug: string;
  page_id: string | null;
  parent_path: string;
  title: string | null;
  dedupe_key: string;
  base_hash: string | null;
  markdown: string;
  author_id: string;
  author_name: string | null;
  token_id: string;
  source: 'mcp' | 'rest' | 'assistant';
  status: 'pending' | 'accepted' | 'rejected';
  reviewer_id: string | null;
  reviewer_name: string | null;
  review_comment: string | null;
  result_page_id: string | null;
  created_at: Date;
  updated_at: Date;
  decided_at: Date | null;
}

const SELECT = `SELECT p.*, a.name AS author_name, r.name AS reviewer_name
                  FROM page_proposals p
                  LEFT JOIN users a ON a.id = p.author_id
                  LEFT JOIN users r ON r.id = p.reviewer_id`;

async function loadRow(id: string): Promise<ProposalRow | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  return queryOne<ProposalRow>(`${SELECT} WHERE p.id = $1`, [id]);
}

export interface Submission {
  space: string;
  /** The page being changed; omit for a page that does not exist yet. */
  pageId?: string;
  parentPath?: string;
  title?: string;
  markdown: string;
  /** The bodyRevision the agent read. A proposal built on text that has changed since is refused, as a direct write is. */
  baseRevision?: string;
  author: User;
  tokenId: string;
  source: 'mcp' | 'rest' | 'assistant';
}

export interface SubmitResult {
  proposalId: string;
  /** True when an open proposal of the same token on the same page was replaced instead of a new one being added. */
  replaced: boolean;
}

function newPageKey(parentPath: string, title: string): string {
  return `new:${storage.normalizeDirParam(parentPath)}/${title.trim().toLowerCase()}`;
}

/**
 * Queues an edit. The same author with the same token proposing again for the same
 * page (or the same new page) REPLACES the open proposal — same row, same id — and
 * tells nobody again: reviewers were already told there is something to look at.
 */
export async function submitProposal(input: Submission): Promise<SubmitResult> {
  let title = input.title ?? '';
  let baseHash: string | null = null;
  let dedupeKey: string;
  if (input.pageId) {
    const entry = await storage.requireEntry(input.pageId);
    if (entry.kind !== 'doc') throw badRequest('only document pages can be sent for review');
    title = entry.title;
    const current = await currentText(entry.id);
    if (input.baseRevision !== undefined && collab.bodyRevision(current) !== input.baseRevision) throw new collab.RevisionConflictError(collab.bodyRevision(current));
    baseHash = hashText(current);
    dedupeKey = entry.id;
  } else {
    if (!title.trim()) throw badRequest('title is required');
    dedupeKey = newPageKey(input.parentPath ?? '', title);
  }

  const rows = await query<{ id: string; inserted: boolean }>(
    `INSERT INTO page_proposals (space_slug, page_id, parent_path, title, dedupe_key, base_hash, markdown, author_id, token_id, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (dedupe_key, author_id, token_id) WHERE status = 'pending'
     DO UPDATE SET markdown = EXCLUDED.markdown, base_hash = EXCLUDED.base_hash, title = EXCLUDED.title, source = EXCLUDED.source, updated_at = now()
     RETURNING id, (xmax = 0) AS inserted`,
    [input.space, input.pageId ?? null, storage.normalizeDirParam(input.parentPath ?? ''), title, dedupeKey, baseHash, input.markdown, input.author.id, input.tokenId, input.source],
  );
  const { id, inserted } = rows[0];

  recordAudit(input.author.id, 'proposal.created', id, {
    space: input.space,
    pageId: input.pageId ?? null,
    tokenId: input.tokenId,
    source: input.source,
    replaced: !inserted,
  });
  if (inserted) {
    // A failure of the bell never fails the write that was just queued.
    await announce(id, input).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[proposals] could not notify reviewers:', err);
    });
  }
  return { proposalId: id, replaced: !inserted };
}

/** The page's owner (a restricted page has one), else the admins of the space. */
/** Who owns the page: the `owner` property (shared/verification.ts), else the owner of a closed page. Empty when it has neither. */
async function pageOwnersOf(pageId: string): Promise<string[]> {
  const page = await queryOne<{ frontmatter: Record<string, unknown> | null }>('SELECT frontmatter FROM pages_index WHERE id = $1', [pageId]);
  const username = parseOwner(page?.frontmatter?.owner);
  if (username) {
    const user = await queryOne<{ id: string }>('SELECT id FROM users WHERE username = $1 AND NOT disabled AND NOT is_system', [username]);
    if (user) return [user.id];
  }
  const closed = await queryOne<{ owner_id: string }>('SELECT owner_id FROM page_access WHERE page_id = $1', [pageId]);
  return closed ? [closed.owner_id] : [];
}

async function spaceAdminsOf(space: string): Promise<string[]> {
  const admins = await query<{ id: string }>(
    `SELECT u.id FROM users u WHERE u.disabled = false AND NOT u.is_system AND ${spaceRoleSql('u.id', '$1')} = 'admin'`,
    [space],
  );
  return admins.map((a) => a.id);
}

async function announce(proposalId: string, input: Submission): Promise<void> {
  const payload = {
    proposalId,
    proposalKind: input.pageId ? 'update' : 'create',
    pageTitle: input.title,
    authorId: input.author.id,
    authorName: input.author.name,
  };
  // A page that does not exist yet has no page to check the reader against: the
  // space is the unit (deliverToSpace), so a proposal to create a page is not lost.
  if (!input.pageId) {
    await notifications.deliverToSpace(await spaceAdminsOf(input.space), 'proposal_pending', input.space, { ...payload, pageTitle: input.title });
    return;
  }
  // The owner first; an owner who is gone or can no longer read the page leaves the proposal with the space's admins.
  const told = await notifications.deliverToPage(await pageOwnersOf(input.pageId), 'proposal_pending', input.pageId, payload);
  if (told.length === 0) await notifications.deliverToPage(await spaceAdminsOf(input.space), 'proposal_pending', input.pageId, payload);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** May `user` review (see, accept, reject) this proposal. Page-level restrictions and `.agent/**` apply. */
async function mayReview(user: User, row: ProposalRow): Promise<boolean> {
  if (session.isSystemUser(user)) return false;
  if (!session.roleAtLeast(await session.effectiveRole(user, row.space_slug), 'editor')) return false;
  const pageId = row.page_id ?? row.result_page_id;
  const entry = pageId ? await storage.getEntry(pageId) : undefined;
  if (row.page_id) {
    // The page may be gone (trashed): a space editor can still reject the proposal.
    if (!entry) return true;
    return session.roleAtLeast(await session.effectivePageRole(user, entry), 'editor');
  }
  if (isAgentPath(row.parent_path) && !(await session.canAdministerSpace(user, row.space_slug))) return false;
  return true;
}

async function currentHashOf(row: ProposalRow): Promise<string | null | undefined> {
  if (!row.page_id) return null;
  const entry = await storage.getEntry(row.page_id);
  if (!entry || entry.kind !== 'doc') return undefined;
  return hashText(await currentText(entry.id));
}

async function summarize(row: ProposalRow, known?: { hash: string | null | undefined }): Promise<PageProposalSummary> {
  let status: ProposalStatus = row.status;
  if (row.status === 'pending' && row.page_id) {
    const hash = known ? known.hash : await currentHashOf(row);
    if (hash === undefined || hash !== row.base_hash) status = 'stale';
  }
  const entry = row.page_id ? await storage.getEntry(row.page_id) : undefined;
  return {
    id: row.id,
    space: row.space_slug,
    kind: (row.page_id ? 'update' : 'create') satisfies ProposalKind,
    pageId: row.page_id,
    title: entry?.title ?? row.title ?? '',
    parentPath: row.parent_path,
    status,
    authorId: row.author_id,
    authorName: row.author_name,
    tokenId: row.token_id,
    source: row.source,
    reviewerName: row.reviewer_name,
    reviewComment: row.review_comment,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
    resultPageId: row.result_page_id,
  };
}

/** Open proposals (pending, stale) of a space the caller may review, newest first; or the decided ones. */
export async function listProposals(user: User, space: string, which: 'open' | 'decided' = 'open'): Promise<PageProposalSummary[]> {
  const rows = await query<ProposalRow>(
    `${SELECT} WHERE p.space_slug = $1 AND p.status ${which === 'open' ? "= 'pending'" : "<> 'pending'"} ORDER BY p.updated_at DESC LIMIT 200`,
    [space],
  );
  const out: PageProposalSummary[] = [];
  for (const row of rows) if (await mayReview(user, row)) out.push(await summarize(row));
  return out;
}

export async function listPageProposals(user: User, entry: PageIndexEntry): Promise<PageProposalSummary[]> {
  if (!session.roleAtLeast(await session.effectivePageRole(user, entry), 'editor')) return [];
  const rows = await query<ProposalRow>(`${SELECT} WHERE p.page_id = $1 AND p.status = 'pending' ORDER BY p.updated_at DESC`, [entry.id]);
  const out: PageProposalSummary[] = [];
  for (const row of rows) if (await mayReview(user, row)) out.push(await summarize(row));
  return out;
}

export async function getProposal(user: User, id: string): Promise<PageProposalDetail> {
  const row = await loadRow(id);
  if (!row || !(await mayReview(user, row))) throw notFound('proposal');
  const hash = await currentHashOf(row);
  const summary = await summarize(row, { hash });
  const current = row.page_id && hash !== undefined ? await currentText(row.page_id) : null;
  return { ...summary, markdown: row.markdown, currentMarkdown: current, currentHash: hash ?? null };
}

// ---------------------------------------------------------------------------
// Deciding
// ---------------------------------------------------------------------------

export interface Decision {
  decision: 'accept' | 'reject';
  comment?: string;
  /** For a stale proposal: the currentHash of the detail the reviewer was shown. */
  currentHash?: string;
}

export async function decideProposal(reviewer: User, id: string, decision: Decision): Promise<PageProposalDetail> {
  const row = await loadRow(id);
  if (!row || !(await mayReview(reviewer, row))) throw notFound('proposal');
  if (row.status !== 'pending') throw conflict('this proposal has already been decided');

  if (decision.decision === 'accept' && row.page_id) {
    const hash = await currentHashOf(row);
    if (hash === undefined) throw conflict('the page no longer exists; reject this proposal');
    if (hash !== row.base_hash && decision.currentHash !== hash) {
      // The page has changed since the proposal: it can be accepted only by someone who was shown the differences.
      throw new HttpError(409, 'The page changed after this proposal was made: review the differences against the current text before accepting.', 'proposal_stale');
    }
  }

  // Claim the row first: two reviewers pressing the button at once apply the text once.
  const claimed = await queryOne<{ id: string }>(
    `UPDATE page_proposals SET status = $2, reviewer_id = $3, review_comment = $4, decided_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'pending' RETURNING id`,
    [id, decision.decision === 'accept' ? 'accepted' : 'rejected', reviewer.id, decision.comment?.trim() || null],
  );
  if (!claimed) throw conflict('this proposal has already been decided');

  let resultPageId: string | null = null;
  if (decision.decision === 'accept') {
    try {
      resultPageId = await applyAccepted(reviewer, row);
    } catch (err) {
      await query("UPDATE page_proposals SET status = 'pending', reviewer_id = NULL, review_comment = NULL, decided_at = NULL WHERE id = $1", [id]);
      throw err;
    }
    if (resultPageId) await query('UPDATE page_proposals SET result_page_id = $2 WHERE id = $1', [id, resultPageId]);
  }

  recordAudit(reviewer.id, decision.decision === 'accept' ? 'proposal.accepted' : 'proposal.rejected', id, {
    space: row.space_slug,
    pageId: row.page_id ?? resultPageId,
    authorId: row.author_id,
    tokenId: row.token_id,
    source: row.source,
  });

  await tellAuthor(reviewer, row, decision, resultPageId ?? row.page_id).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[proposals] could not notify the author:', err);
  });
  return getProposal(reviewer, id);
}

/** Writes the accepted text through the path every direct write takes. Returns the id of a page that was created. */
async function applyAccepted(reviewer: User, row: ProposalRow): Promise<string | null> {
  const space = row.space_slug;
  gitSync.recordEditor(space, { name: reviewer.name, email: reviewer.email });
  if (row.page_id) {
    await collab.editDocBody(row.page_id, row.markdown);
    gitSync.noteActivity(space);
    recordAudit(reviewer.id, 'page.updated', row.page_id, { source: 'proposal', proposalId: row.id, authorId: row.author_id, tokenId: row.token_id });
    return null;
  }
  const title = row.title ?? '';
  const meta = await storage.createPage({ space, parentPath: row.parent_path, title, kind: 'doc' });
  if (row.markdown.trim()) {
    const { icon, cover, body } = storage.splitLeadingFrontmatter(row.markdown);
    await collab.editDocBody(meta.id, storage.ensureLeadingTitle(body, title), icon, cover);
  }
  gitSync.noteActivity(space);
  recordAudit(reviewer.id, 'page.created', meta.id, { source: 'proposal', proposalId: row.id, authorId: row.author_id, tokenId: row.token_id });
  return meta.id;
}

async function tellAuthor(reviewer: User, row: ProposalRow, decision: Decision, pageId: string | null): Promise<void> {
  if (row.author_id === reviewer.id) return;
  const payload = {
    proposalId: row.id,
    decision: decision.decision === 'accept' ? 'accepted' : 'rejected',
    pageTitle: row.title ?? '',
    reviewerName: reviewer.name,
    ...(decision.comment?.trim() ? { excerpt: decision.comment.trim().slice(0, 300) } : {}),
  };
  if (pageId && (await storage.getEntry(pageId))) await notifications.deliverToPage([row.author_id], 'proposal_decided', pageId, payload);
  else await notifications.deliverToSpace([row.author_id], 'proposal_decided', row.space_slug, payload);
}
