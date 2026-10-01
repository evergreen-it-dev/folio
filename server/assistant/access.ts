/**
 * AI assistant — the access gate for everything the assistant derives from the
 * navigation context a client sends with a run (`space`, `pageId`).
 *
 * Security review F-05: `space` used to travel from the request body to
 * agentContext.buildAgentContext with no user attached, so any signed-in user
 * who knew a private space's slug got that space's `.agent` rules written into
 * their conversation workspace and sent to the model provider. The rule now is
 * the one the rest of the API uses: a space may be read by a user whose
 * effective role there is viewer or better — an explicit `space_members` row,
 * or the implicit viewer of an instance-visible space (docs/spec-access.md
 * §2–§3; auth/session.ts's effectiveRole, which also yields nothing for a
 * disabled user). An instance admin without a membership reads nothing here,
 * same as everywhere else.
 *
 * This is called at every layer that could be reached without the one above
 * it: the routes (before any conversation is touched), RunManager.startRun,
 * prepareAssistantWorkspace (before the workspace directory exists) and
 * buildAgentContext (before a page of the space is read). Each re-checks on
 * its own instead of trusting its caller, so a future caller that forgets the
 * route check still cannot get past the workspace.
 */
import type { SpaceRole, User } from '../../shared/contracts.js';
import { badRequest, HttpError, notFound } from '../errors.js';
import { effectivePageRole, effectiveRole, roleAtLeast } from '../auth/session.js';
import * as storage from '../storage.js';
import type { PageIndexEntry } from '../storage.js';

/**
 * Throws 404 `space not found` unless `user` can read `space` (viewer+).
 * One status and one message for "no such space" AND "a space you cannot
 * see": unlike requireSpaceRole's 404-vs-403 split, an answer here must not
 * tell a caller which private slugs exist.
 */
export async function requireAssistantSpaceAccess(user: User, space: string): Promise<SpaceRole> {
  const role = await effectiveRole(user, space);
  if (!roleAtLeast(role, 'viewer')) throw notFound('space');
  return role as SpaceRole;
}

/** `getEntry` throws 400 for a synthetic `dir:` id; for this gate that is just "not a page". */
async function findPage(id: string): Promise<PageIndexEntry | undefined> {
  try {
    return await storage.getEntry(id);
  } catch (err) {
    if (err instanceof HttpError && err.status === 400) return undefined;
    throw err;
  }
}

/** The navigation context of a run, after it has passed the gate: blank values are `null`. */
export interface AssistantNavigation {
  space: string | null;
  pageId: string | null;
}

/**
 * Authorizes the client-supplied `space` / `pageId` of a run for `user`:
 *  - `space` (when given): the user can read it — see requireAssistantSpaceAccess;
 *  - `pageId` (when given): requires a `space`, and the page must exist, belong
 *    to that very space and be readable by the user (page-level access and the
 *    admin-only `.agent` folder included). A page id from another space, an
 *    unknown one and a hidden one are all the same 404 `page not found`.
 * Returns the normalized values to use from here on.
 */
export async function authorizeAssistantNavigation(
  user: User,
  input: { space?: string | null; pageId?: string | null },
): Promise<AssistantNavigation> {
  const space = input.space?.trim() || null;
  const pageId = input.pageId?.trim() || null;

  if (!space) {
    if (pageId) throw badRequest('pageId requires space');
    return { space: null, pageId: null };
  }
  await requireAssistantSpaceAccess(user, space);
  if (!pageId) return { space, pageId: null };

  const entry = await findPage(pageId);
  if (!entry || entry.space !== space || !roleAtLeast(await effectivePageRole(user, entry), 'viewer')) throw notFound('page');
  return { space, pageId };
}
