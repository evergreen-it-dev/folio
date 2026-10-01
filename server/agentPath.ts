/**
 * `.agent/` — a per-space folder of ordinary markdown pages that tell the AI
 * assistant how to behave IN THIS SPACE (owner spec, 21.09.2026). Content
 * lives as normal pages, in git, like everything else — the only thing
 * special about it is access (space admins + instance admins only, invisible
 * to everyone else, everywhere) and that it's injected into every assistant
 * run for the space (server/assistant/agentContext.ts).
 *
 * This module is the ONE place that knows the folder's name and shape, so
 * every access-control checkpoint (storage.ts's scan exception,
 * auth/session.ts's page-role checks, pageAccess.ts's readable-id query,
 * search.ts, mcp.ts's reimplemented checks) agrees on exactly the same rule.
 * A path is "agent" only at the space's CONTENT ROOT — `notes/.agent/x.md`
 * is just a dotfile some other feature already skips, not this folder.
 */

import { AGENT_FOLDER } from '../shared/contracts.js';

export { AGENT_FOLDER };

/** True for the `.agent` page/folder itself and everything nested under it. */
export function isAgentPath(relPath: string): boolean {
  return relPath === AGENT_FOLDER || relPath.startsWith(`${AGENT_FOLDER}/`);
}
