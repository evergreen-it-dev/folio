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
 *  - buildAgentContext: DB-backed — finds every `.agent/**` page for a
 *    space (storage.listEntries is unfiltered; access control for WHO may
 *    ask for this lives in auth/session.ts and is irrelevant here — a run's
 *    own context assembly always sees the space's full `.agent` folder) and
 *    renders each one before handing the list to capAgentContext.
 */
import * as storage from '../storage.js';
import { isAgentPath } from '../agentPath.js';
import { pageSourceMarkdown } from '../export/markdown.js';

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
 * DB-backed: every `.agent/**` page in `space`, path-sorted, rendered via
 * pageSourceMarkdown and capped. `blob: ''` (pagesUsed 0) when the space has
 * no `.agent` folder at all — the common case, and the signal callers use to
 * skip the section entirely.
 */
export async function buildAgentContext(space: string, baseUrl: string): Promise<CappedAgentContext & { totalPages: number }> {
  const entries = (await storage.listEntries(space)).filter((e) => isAgentPath(e.relPath)).sort((a, b) => a.relPath.localeCompare(b.relPath));
  if (entries.length === 0) return { blob: '', pagesUsed: 0, truncated: false, totalPages: 0 };

  const pages: AgentContextPage[] = [];
  for (const entry of entries) {
    const source = await pageSourceMarkdown(entry, { baseUrl });
    pages.push({ path: entry.relPath, markdown: source.markdown });
  }
  return { ...capAgentContext(pages), totalPages: entries.length };
}
