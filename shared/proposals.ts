import { z } from 'zod';

/**
 * Agent write mode and the review queue ("On review"), migration 062.
 *
 * A space is in one of two modes. `direct` (default): an agent's edit lands at once.
 * `review`: an agent's edit to a Markdown page (update_page, create_page, PUT
 * /api/pages/:id with a token, the built-in assistant) becomes a PROPOSAL and the page
 * text does not change until an editor accepts it. A person typing in the browser is
 * never queued.
 *
 * `stale` is not stored: it is a pending proposal whose base text no longer matches the
 * page. Such a proposal can be accepted only together with the hash of the text the
 * reviewer actually saw the differences against (`currentHash`).
 */
export const agentWriteModeSchema = z.enum(['direct', 'review']);
export type AgentWriteMode = z.infer<typeof agentWriteModeSchema>;

/** PATCH /api/spaces/:space/agent-settings — space admin. */
export const updateAgentSettingsBodySchema = z.object({ agentWriteMode: agentWriteModeSchema });
export type UpdateAgentSettingsBody = z.infer<typeof updateAgentSettingsBodySchema>;

export const proposalStatusSchema = z.enum(['pending', 'stale', 'accepted', 'rejected']);
export type ProposalStatus = z.infer<typeof proposalStatusSchema>;

export const proposalKindSchema = z.enum(['update', 'create']);
export type ProposalKind = z.infer<typeof proposalKindSchema>;

export interface PageProposalSummary {
  id: string;
  space: string;
  kind: ProposalKind;
  /** The page being changed; null while a proposed page does not exist yet. */
  pageId: string | null;
  /** The page's title, or the proposed title for a new page. */
  title: string;
  /** Where a new page would be created (relative to the space root). */
  parentPath: string;
  status: ProposalStatus;
  authorId: string;
  authorName: string | null;
  /** Which token made it: an API token id, an OAuth grant id or 'assistant'. */
  tokenId: string;
  source: 'mcp' | 'rest' | 'assistant';
  reviewerName: string | null;
  reviewComment: string | null;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
  /** The page a 'create' proposal produced once accepted. */
  resultPageId: string | null;
}

export interface PageProposalDetail extends PageProposalSummary {
  /** The proposed body text. */
  markdown: string;
  /** The page text right now; null for a page that does not exist yet. */
  currentMarkdown: string | null;
  /** Hash of currentMarkdown: send it back to accept a stale proposal. Null for a new page. */
  currentHash: string | null;
}

/** GET /api/spaces/:space/proposals */
export interface ProposalListResponse {
  items: PageProposalSummary[];
  /** Open (pending + stale) proposals the caller may review. */
  pendingCount: number;
}

/** GET /api/pages/:id/proposals — the open proposals of one page (empty below editor). */
export interface PageProposalsResponse {
  items: PageProposalSummary[];
}

/**
 * POST /api/proposals/:id/decision — cookie session only: an API token (the agent
 * itself) can never accept its own proposal.
 */
export const decideProposalBodySchema = z.object({
  decision: z.enum(['accept', 'reject']),
  comment: z.string().trim().max(2_000).optional(),
  /** Required to accept a stale proposal: the currentHash of the detail the reviewer looked at. */
  currentHash: z.string().max(128).optional(),
});
export type DecideProposalBody = z.infer<typeof decideProposalBodySchema>;

/** What a token-authenticated write answers in review mode (HTTP 202; MCP structuredContent has the same fields). */
export interface ProposedResult {
  status: 'proposed';
  proposalId: string;
  message: string;
}

export const PROPOSAL_STALE_CODE = 'proposal_stale';
