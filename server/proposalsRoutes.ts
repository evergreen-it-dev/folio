/**
 * The HTTP wrapper of server/proposals.ts: the agent write mode of a space and
 * its review queue (contract: shared/proposals.ts).
 *
 *   PATCH /api/spaces/:space/agent-settings   space admin -> { slug, agentWriteMode }
 *   GET   /api/spaces/:space/proposals        editor+ -> ProposalListResponse (?status=decided for the history)
 *   GET   /api/pages/:id/proposals            editor+ on the page -> PageProposalsResponse
 *   GET   /api/proposals/:id                  a reviewer of it -> PageProposalDetail
 *   POST  /api/proposals/:id/decision         a reviewer, COOKIE SESSION ONLY -> PageProposalDetail
 *
 * Deciding is never available to an API token: the agent that made a proposal
 * must not be able to accept it with the same token.
 */
import type { FastifyInstance } from 'fastify';
import { decideProposalBodySchema, updateAgentSettingsBodySchema, type PageProposalsResponse, type ProposalListResponse } from '../shared/proposals.js';
import { recordAudit } from './audit.js';
import * as session from './auth/session.js';
import { assertNotDemo } from './demo.js';
import * as proposals from './proposals.js';
import { parseBody } from './validate.js';

export function registerProposalRoutes(app: FastifyInstance): void {
  app.patch('/api/spaces/:space/agent-settings', async (request) => {
    assertNotDemo('Changing the agent write mode');
    const { space } = request.params as { space: string };
    await session.requireSpaceRole(request, space, 'admin');
    session.requireWriteScope(request);
    const body = parseBody(updateAgentSettingsBodySchema, request.body);
    const previous = await proposals.setAgentWriteMode(space, body.agentWriteMode);
    recordAudit(request.authUser!.id, 'space.agent_settings', space, { agentWriteMode: body.agentWriteMode, previous });
    return { slug: space, agentWriteMode: body.agentWriteMode };
  });

  app.get('/api/spaces/:space/proposals', async (request): Promise<ProposalListResponse> => {
    const { space } = request.params as { space: string };
    const { status } = request.query as { status?: string };
    await session.requireSpaceRole(request, space, 'editor');
    const user = request.authUser!;
    const items = await proposals.listProposals(user, space, status === 'decided' ? 'decided' : 'open');
    return { items, pendingCount: status === 'decided' ? (await proposals.listProposals(user, space)).length : items.length };
  });

  app.get('/api/pages/:id/proposals', async (request): Promise<PageProposalsResponse> => {
    const { id } = request.params as { id: string };
    const entry = await session.requirePageRole(request, id, 'viewer');
    return { items: await proposals.listPageProposals(request.authUser!, entry) };
  });

  app.get('/api/proposals/:id', async (request) => {
    const { id } = request.params as { id: string };
    return proposals.getProposal(request.authUser!, id);
  });

  app.post('/api/proposals/:id/decision', async (request) => {
    const { id } = request.params as { id: string };
    session.requireCookieAuth(request);
    const body = parseBody(decideProposalBodySchema, request.body);
    return proposals.decideProposal(request.authUser!, id, body);
  });
}
