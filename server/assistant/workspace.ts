/**
 * AI assistant (Cursor SDK) — per-conversation filesystem workspace. Ported
 * from a sibling project's server/assistant/workspace.ts, simplified per this
 * round's instructions: no uploads/outputs/personalization/system-access (no
 * Folio equivalent of that project's file attachments or per-system read/write
 * toggles — the assistant's only external surface is the in-process MCP
 * tools from tools.ts). No secrets (API key, cookies) are ever written into
 * this directory — the Cursor SDK gets the key in memory only
 * (cursorRuntime.ts).
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AssistantRunMode } from '../../shared/contracts.js';
import type { User } from '../../shared/contracts.js';
import { SERVER_PORT } from '../../shared/contracts.js';
import { REPOS_DIR, requireEntry, toPageMeta, resolve } from '../storage.js';
import { effectivePageRole, roleAtLeast } from '../auth/session.js';
import { publicUrlOrOrigin } from '../publicUrl.js';
import { buildAgentContext } from './agentContext.js';

const DATA_DIR = path.dirname(REPOS_DIR);
const PROMPTS_DIR = path.join(process.cwd(), 'server', 'assistant', 'prompts');
const SKILLS_DIR = path.join(process.cwd(), 'server', 'assistant', 'skills');

const FALLBACK_SYSTEM_PROMPT = 'You are Folio AI, the assistant built into Folio, a git-native wiki. Answer briefly, relying only on the data obtained through the available tools. Answer in the language the user writes in.';

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

export function resolveAssistantWorkspaceRoot(): string {
  return process.env.CURSOR_AGENT_WORKSPACE_ROOT || path.join(DATA_DIR, 'assistant', 'workspaces');
}

export function resolveAssistantStateDir(): string {
  return process.env.CURSOR_AGENT_STATE_DIR || path.join(DATA_DIR, 'assistant', 'state');
}

export function resolveConversationWorkspace(userId: string, conversationId: string): string {
  return path.join(resolveAssistantWorkspaceRoot(), shortHash(userId), shortHash(conversationId));
}

export async function loadAssistantSystemPrompt(): Promise<string> {
  try {
    return (await readFile(path.join(PROMPTS_DIR, 'system.md'), 'utf8')).trim() || FALLBACK_SYSTEM_PROMPT;
  } catch {
    return FALLBACK_SYSTEM_PROMPT;
  }
}

async function loadFolioContext(): Promise<string> {
  try {
    return (await readFile(path.join(PROMPTS_DIR, 'folio-context.md'), 'utf8')).trim();
  } catch {
    return '';
  }
}

/** Copies every server/assistant/skills/<name>/SKILL.md into <root>/.cursor/skills/<name>/SKILL.md. A skill directory the SKILLS round hasn't populated yet (no SKILL.md there) is skipped, not an error — this module must not fail just because a sibling round is still in flight. */
async function syncAssistantSkills(root: string): Promise<void> {
  const destination = path.join(root, '.cursor', 'skills');
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  let names: string[] = [];
  try {
    names = (await readdir(SKILLS_DIR, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return; // server/assistant/skills/ doesn't exist yet
  }
  for (const name of names) {
    const src = path.join(SKILLS_DIR, name, 'SKILL.md');
    try {
      const destDir = path.join(destination, name);
      await mkdir(destDir, { recursive: true });
      await copyFile(src, path.join(destDir, 'SKILL.md'));
    } catch {
      // SKILL.md not written yet for this skill — skip it, don't fail the workspace.
    }
  }
}

export interface AssistantWorkspaceContext {
  user: User;
  conversationId: string;
  runMode: AssistantRunMode;
  currentPath: string | null;
  space: string | null;
  pageId: string | null;
}

export interface PreparedAssistantWorkspace {
  root: string;
  systemPrompt: string;
  /** The content of `.folio/context/folio-context.md` — inlined into the prompt so that the agent does not spend a turn reading it. */
  folioContext: string;
  /** The content of `.folio/runtime/current-context.md` — inlined the same way. */
  runtimeContext: string;
  /**
   * `.agent/**` rules pages for `context.space`, already assembled/capped
   * (server/assistant/agentContext.ts) — '' when the space has none, or
   * `context.space` itself is null. Present for BOTH Ask and Agent runs:
   * this function doesn't branch on runMode at all, so a run started in
   * either mode always gets the same admin-authored rules (owner spec,
   * 21.09.2026).
   */
  agentRules: string;
}

function workspaceMarkdown(context: AssistantWorkspaceContext): string {
  return [
    '# Folio AI workspace',
    '',
    'This directory is isolated for one conversation.',
    '',
    '## Layout',
    '',
    '- `.folio/context/folio-context.md` — a reference on Folio data and API.',
    '- `.folio/runtime/current-context.md` — the current mode, space and page of the user.',
    '- `.cursor/skills/` — working instructions for the available tools.',
    '- `scratch/` — temporary drafts.',
    '',
    `Conversation id: \`${context.conversationId}\``,
    '',
  ].join('\n');
}

async function runtimeContextMarkdown(context: AssistantWorkspaceContext): Promise<string> {
  const lines = [
    '# Current context of the conversation',
    '',
    `- Mode: \`${context.runMode === 'agent' ? 'AGENT — changes are allowed only when the user asks for them directly' : 'ASK — read only, no changes'}\``,
    `- Space: ${context.space ? `\`${context.space}\`` : 'not determined'}`,
    `- Current path in Folio: \`${context.currentPath ?? '/'}\``,
    `- Interface language: \`${context.user.lang ?? 'unknown'}\``,
  ];

  // Which page is open? `/s/:space/p/:id` sends pageId; the space home
  // (`/s/:space`) and folder listings (`/s/:space/d/<dir>`) send none, yet the
  // user IS looking at a page there (the root index.md / the folder's index) —
  // resolve it server-side so the agent always knows where it is.
  let pageId = context.pageId;
  if (!pageId && context.space) {
    try {
      const folderMatch = context.currentPath ? /^\/s\/[^/]+\/d\/(.+)$/.exec(context.currentPath) : null;
      const dir = folderMatch ? decodeURIComponent(folderMatch[1]).replace(/\/+$/, '') : '';
      const isSpaceRoute = !!context.currentPath && /^\/s\/[^/]+\/?$/.test(context.currentPath);
      if (isSpaceRoute || folderMatch) pageId = (await resolve(context.space, dir)).id;
    } catch {
      // no resolvable page for this route — the block below is simply omitted
    }
  }

  if (pageId) {
    try {
      const entry = await requireEntry(pageId);
      const role = await effectivePageRole(context.user, entry);
      if (roleAtLeast(role, 'viewer')) {
        const meta = toPageMeta(entry);
        // Where a NEW child page of the current page would go: the directory
        // an index page owns, or the "<stem>/" claimed dir next to a leaf file.
        const parentPath = entry.isIndex
          ? entry.relPath.replace(/\/?index\.md$/i, '').replace(/\/?README\.md$/i, '')
          : entry.relPath.replace(/\.(table\.md|excalidraw\.svg|md)$/i, '');
        lines.push(
          '- The page that is open now (WORK WITHIN IT unless the user said otherwise):',
          `  - id: \`${meta.id}\` — pass exactly this id to read_page / update_page`,
          `  - title: ${meta.title}`,
          `  - path: \`${meta.path}\``,
          `  - kind: \`${meta.kind}\``,
          `  - parentPath for new child pages: \`${parentPath}\``,
        );
      }
    } catch {
      // the page was not found or is not available — just leave the block out
    }
  }

  lines.push('', 'These values are navigation context only. Get live facts through the tools.', '');
  return lines.join('\n');
}

/**
 * No incoming HTTP request is available this far down (a run is a
 * server-side task, not tied to one connection — see runs.ts's own doc
 * comment), so this can't reuse routes.ts's request-derived origin the way
 * export/routes.ts does. PUBLIC_URL is set in every real deployment; the
 * localhost fallback only ever matters for a dev/test run.
 */
function assistantBaseUrl(): string {
  return publicUrlOrOrigin(`http://localhost:${process.env.PORT || SERVER_PORT}`);
}

/**
 * `.agent/**` rules for `space`, capped and ready to inline — '' when there
 * is no space (a conversation not opened from inside one) or the space has
 * no `.agent` folder at all. Failure here must never break a run over an
 * admin's rules page (e.g. mid-scan): falls back to '' with a warning,
 * same defensiveness as loadFolioContext's own try/catch above.
 */
async function agentRulesMarkdown(space: string | null): Promise<string> {
  if (!space) return '';
  try {
    const built = await buildAgentContext(space, assistantBaseUrl());
    return built.blob;
  } catch (err) {
    console.warn(`assistant workspace: failed to assemble .agent context for space "${space}":`, err instanceof Error ? err.message : err);
    return '';
  }
}

/**
 * Creates a minimal per-conversation workspace directory. No API key, cookie
 * or other secret is ever written here — those reach the Cursor SDK in
 * memory only (see cursorRuntime.ts).
 */
export async function prepareAssistantWorkspace(context: AssistantWorkspaceContext): Promise<PreparedAssistantWorkspace> {
  const root = resolveConversationWorkspace(context.user.id, context.conversationId);
  const contextDir = path.join(root, '.folio', 'context');
  const runtimeDir = path.join(root, '.folio', 'runtime');
  await Promise.all([
    mkdir(contextDir, { recursive: true }),
    mkdir(runtimeDir, { recursive: true }),
    mkdir(path.join(root, 'scratch'), { recursive: true }),
  ]);

  const [systemPrompt, folioContext, runtimeMarkdown, agentRules] = await Promise.all([
    loadAssistantSystemPrompt(),
    loadFolioContext(),
    runtimeContextMarkdown(context),
    agentRulesMarkdown(context.space),
  ]);
  await syncAssistantSkills(root);

  await Promise.all([
    writeFile(path.join(root, '.folio', 'WORKSPACE.md'), workspaceMarkdown(context), 'utf8'),
    writeFile(path.join(contextDir, 'folio-context.md'), `${folioContext}\n`, 'utf8'),
    writeFile(path.join(runtimeDir, 'current-context.md'), runtimeMarkdown, 'utf8'),
    // Written even when empty — an admin who just added the space's first
    // .agent page shouldn't need to guess why a stale file lingers.
    writeFile(path.join(contextDir, 'agent-rules.md'), `${agentRules}\n`, 'utf8'),
  ]);

  return { root, systemPrompt, folioContext, runtimeContext: runtimeMarkdown, agentRules };
}
