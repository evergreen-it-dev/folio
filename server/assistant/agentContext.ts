/**
 * `.agent/**` context assembly — owner spec (21.09.2026): every page dropped
 * into a space's `.agent/` folder describes how the AI assistant should
 * behave IN THAT SPACE, and gets injected into the system context of EVERY
 * assistant run for that space (Ask and Agent alike — see workspace.ts's
 * prepareAssistantWorkspace, which calls buildAgentContext below
 * unconditionally, before runMode is ever consulted).
 *
 * Reuses server/export/markdown.ts's `pageSourceMarkdown` — the exact
 * function the share/export path already uses to turn ONE page into
 * markdown (live CRDT content when a doc is being edited live, board
 * structure YAML, table-to-markdown) — instead of writing a third
 * serializer. This module only adds the policy on top: which pages, in what
 * order, and how the whole set gets capped.
 *
 * Split in two on purpose:
 *  - capAgentContext: PURE (no I/O) — joins already-rendered pages into one
 *    blob, cut at a PAGE BOUNDARY the moment `maxChars` would be exceeded
 *    (never mid-page), with an explicit truncation marker embedded in the
 *    blob itself (never silent — same convention export/limits.ts's own
 *    byte cap uses). This is what agentContext.test.ts exercises directly,
 *    with no database involved.
 *  - buildAgentContext: DB-backed — finds the `.agent/**` pages of a space
 *    that THE GIVEN USER may have injected and renders each one before
 *    handing the list to capAgentContext. It takes the user and checks, on
 *    its own, that they can read the space (security review F-05: it used to
 *    take a bare space slug from the client, so anyone who knew a private
 *    space's slug got its rules). Which pages count is spelled out on the
 *    function itself.
 */
import * as storage from '../storage.js';
import { isAgentPath } from '../agentPath.js';
import { pageSourceMarkdown } from '../export/markdown.js';
import * as pageAccess from '../pageAccess.js';
import type { User } from '../../shared/contracts.js';
import { requireAssistantSpaceAccess } from './access.js';

/** ~60 000 characters — owner spec's cap on the injected blob. */
export const AGENT_CONTEXT_MAX_CHARS = 60_000;

const SEPARATOR = '\n\n---\n\n';

export interface AgentContextPage {
  /** Space-relative path, e.g. ".agent/tone.md" — marked above the page's own rendered markdown so the assistant knows which rules page said what. */
  path: string;
  markdown: string;
}

export interface CappedAgentContext {
  /** '' when there is nothing to inject — callers skip the section entirely rather than sending an empty one. */
  blob: string;
  /** Pages actually included after the cap. */
  pagesUsed: number;
  truncated: boolean;
}

/**
 * Pure: joins `pages` (already rendered, in the order they should appear —
 * callers pass them path-sorted) into one blob. The FIRST page always goes
 * in whole, same "never cut the one thing that's there" reasoning
 * export/markdown.ts's own byte cap uses; only a page AFTER the first can be
 * the one that doesn't fit, so the cut always lands exactly on a page
 * boundary.
 */
export function capAgentContext(pages: readonly AgentContextPage[], maxChars: number = AGENT_CONTEXT_MAX_CHARS): CappedAgentContext {
  if (pages.length === 0) return { blob: '', pagesUsed: 0, truncated: false };

  const sections: string[] = [];
  let used = 0;
  let truncated = false;

  for (const page of pages) {
    const section = `<!-- ${page.path} -->\n\n${page.markdown.trim()}`;
    const cost = section.length + (sections.length > 0 ? SEPARATOR.length : 0);
    if (sections.length > 0 && used + cost > maxChars) {
      truncated = true;
      break;
    }
    sections.push(section);
    used += cost;
  }

  let blob = sections.join(SEPARATOR);
  if (truncated) {
    blob += `\n\n<!-- folio-agent-rules: TRUNCATED at ~${maxChars} characters — ${sections.length} of ${pages.length} page(s) included -->`;
  }
  return { blob, pagesUsed: sections.length, truncated };
}

/**
 * DB-backed: the `.agent/**` pages of `space` that `user` may have injected,
 * path-sorted, rendered via pageSourceMarkdown and capped. `blob: ''`
 * (pagesUsed 0) when there are none — the common case, and the signal callers
 * use to skip the section entirely.
 *
 * Throws 404 `space not found` (before reading a single page) when `user`
 * cannot read `space` — an explicit membership, or the implicit viewer of an
 * instance-visible space; see ./access.ts.
 *
 * Which pages: the rules are meant for every member of the space, not only for
 * the admins who can open the `.agent` folder (docs/FEATURES.md: they are
 * mixed into every run of the space; the assistant is the one place a plain
 * member meets that text). So the folder's admin-only gate
 * (session.effectivePageRole) is deliberately NOT applied — `includeAgent:
 * true` below. What IS applied is page-level access: an `.agent` page
 * restricted to named people is skipped for everyone else, exactly as a
 * restricted ordinary page is hidden from them.
 */
export async function buildAgentContext(user: User, space: string, baseUrl: string): Promise<CappedAgentContext & { totalPages: number }> {
  await requireAssistantSpaceAccess(user, space);
  const readable = await pageAccess.readablePageIds(user.id, space, true);
  const entries = (await storage.listEntries(space))
    .filter((e) => isAgentPath(e.relPath) && readable.has(e.id))
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
  if (entries.length === 0) return { blob: '', pagesUsed: 0, truncated: false, totalPages: 0 };

  const pages: AgentContextPage[] = [];
  for (const entry of entries) {
    const source = await pageSourceMarkdown(entry, { baseUrl });
    pages.push({ path: entry.relPath, markdown: source.markdown });
  }
  return { ...capAgentContext(pages), totalPages: entries.length };
}
