/**
 * AI assistant (Cursor SDK) — runs one turn through the Cursor Agent SDK.
 * Ported from a sibling project's server/assistant/cursor-runtime.ts, adapted
 * to Folio: no Express `Request` (tools.ts builds its in-process MCP tools
 * from `{ user, runMode }` instead of forwarding an HTTP request), and no
 * uploads/elementContext/personalization/systemAccess (see workspace.ts's
 * doc comment for why those Hub features have no Folio equivalent here).
 */
import { mkdir } from 'node:fs/promises';
import type { ModelSelection, Run, SDKAgent, SDKMessage } from '@cursor/sdk';
import type { AssistantRunMode } from '../../shared/contracts.js';
import type { User } from '../../shared/contracts.js';
import type { AssistantConversationRow } from './store.js';
import { buildAssistantTools } from './tools.js';
import { prepareAssistantWorkspace, resolveAssistantStateDir } from './workspace.js';
import { ensureAssistantCursorPermissions } from './cursorCliConfig.js';
import { filterAssistantModels } from './models.js';

export interface RunAssistantInput {
  /** The ai_runs row of this turn — the built-in tool report_unanswered_question writes against it. */
  runId: string;
  apiKey: string;
  user: User;
  conversation: AssistantConversationRow;
  message: string;
  currentPath: string | null;
  space: string | null;
  pageId: string | null;
  runMode: AssistantRunMode;
  signal?: AbortSignal;
  onRun?: (run: Run) => void;
  onEvent?: (event: SDKMessage) => void;
  onTextDelta?: (text: string) => void;
  onTool?: (name: string) => void;
  /** Deadline for the whole call (agent.send() + stream()). Defaults per runMode — see defaultTotalTimeoutMs. */
  totalTimeoutMs?: number;
  /** Reset on every delta/tool/thinking event — catches a run that's silently stuck rather than actively erroring, without forcing every Agent-mode run to fit inside one short total deadline. Default CURSOR_AGENT_IDLE_TIMEOUT_MS (600000 = 10 min). */
  idleTimeoutMs?: number;
}

export class AssistantRunCancelledError extends Error {
  constructor() {
    super('Cursor agent run cancelled');
    this.name = 'AssistantRunCancelledError';
  }
}

/** Ask is a single Q&A turn (default 300 s); Agent can chain many tool calls toward a goal and legitimately runs much longer (default 30 min) — see .env.example. */
function defaultTotalTimeoutMs(runMode: AssistantRunMode): number {
  if (runMode === 'agent') return Number(process.env.CURSOR_AGENT_TIMEOUT_MS_AGENT) || 1_800_000;
  return Number(process.env.CURSOR_AGENT_TIMEOUT_MS) || 300_000;
}

function modelSelection(model: string): ModelSelection {
  if (/^composer/i.test(model)) return { id: model, params: [{ id: 'fast', value: 'false' }] };
  return { id: model };
}

/** @cursor/sdk requires Node >= 22.13 (its own package.json engines field) — checked up front so a stale local dev process gets a clear 503 instead of an opaque dynamic-import failure. */
export function cursorRuntimeAvailable(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

let configuredStateDir: string | null = null;

async function loadCursorSdk() {
  if (!cursorRuntimeAvailable()) throw new Error('Cursor SDK requires Node.js 22.13 or newer');
  return import('@cursor/sdk');
}

async function configureSdk(): Promise<Awaited<ReturnType<typeof loadCursorSdk>>> {
  const sdk = await loadCursorSdk();
  const stateDir = resolveAssistantStateDir();
  if (configuredStateDir !== stateDir) {
    await mkdir(stateDir, { recursive: true });
    sdk.Cursor.configure({
      local: { useHttp1ForAgent: true, store: new sdk.JsonlLocalAgentStore(stateDir) },
    });
    configuredStateDir = stateDir;
  }
  return sdk;
}

export async function verifyCursorApiKey(apiKey: string): Promise<{ apiKeyName: string; email: string | null }> {
  const { Cursor } = await loadCursorSdk();
  const user = await Cursor.me({ apiKey });
  return { apiKeyName: user.apiKeyName, email: user.userEmail ?? null };
}

export async function listCursorModels(apiKey: string): Promise<Array<{ id: string; label: string; description: string | null }>> {
  const { Cursor } = await loadCursorSdk();
  const models = await Cursor.models.list({ apiKey });
  return filterAssistantModels(
    models.map((model) => ({ id: model.id, label: model.displayName || model.id, description: model.description ?? null })),
  );
}

async function resumeOrCreateAgent(
  sdk: Awaited<ReturnType<typeof loadCursorSdk>>,
  agentId: string,
  options: Parameters<typeof sdk.Agent.create>[0],
): Promise<SDKAgent> {
  try {
    return await sdk.Agent.resume(agentId, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/not found/i.test(message)) throw error;
  }
  try {
    return await sdk.Agent.create({ ...options, agentId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/unique constraint|SQLITE_CONSTRAINT|agents\.agent_id/i.test(message)) throw error;
    return sdk.Agent.resume(agentId, options);
  }
}

export async function runCursorAssistant(input: RunAssistantInput): Promise<string> {
  const workspace = await prepareAssistantWorkspace({
    user: input.user,
    conversationId: input.conversation.id,
    runMode: input.runMode,
    currentPath: input.currentPath,
    space: input.space,
    pageId: input.pageId,
  });
  const toolsHandle = await buildAssistantTools(input.user, input.runMode, {
    runId: input.runId,
    conversationId: input.conversation.id,
    space: input.space,
    pageId: input.pageId,
  });
  ensureAssistantCursorPermissions();
  const sdk = await configureSdk();
  const agentOptions = {
    apiKey: input.apiKey,
    model: modelSelection(input.conversation.model),
    name: input.conversation.title ?? 'Folio AI',
    mode: 'agent' as const,
    local: {
      cwd: workspace.root,
      settingSources: [],
      customTools: toolsHandle.tools,
      // Same reasoning as the Hub original: the Cursor SDK's own sandbox
      // classifier can't currently be combined with in-process
      // custom-user-tools. Isolation is the per-conversation cwd plus the
      // RBAC-checked MCP tools themselves, not an OS sandbox.
      sandboxOptions: { enabled: false },
      autoReview: false,
    },
  };
  try {
    const agent = await resumeOrCreateAgent(sdk, input.conversation.cursorAgentId, agentOptions);
    try {
      await agent.reload().catch(() => undefined);
      // The context is inlined into the prompt: every extra file read is a
      // separate model turn (the first run spent 8-10 read/glob calls before
      // its first action). Skills stay files: they are large and each is
      // needed for its own topic only.
      const prompt = [
        workspace.systemPrompt,
        '',
        // Owner spec (21.09.2026): `.agent/**` rules pages, admin-authored
        // per space — prepended right after the base system prompt (before
        // Folio's own reference material) so they read as instructions the
        // model must follow, not background it may skim. Present for Ask
        // AND Agent alike — workspace.agentRules never depends on runMode.
        // Omitted entirely when the space has no `.agent` folder, so a
        // space without rules sees no empty section at all.
        ...(workspace.agentRules ? ['## The .agent rules of this space', '', workspace.agentRules, ''] : []),
        '## Folio context',
        '',
        workspace.folioContext,
        '',
        '## Current context',
        '',
        workspace.runtimeContext,
        '',
        '## Skills',
        '',
        'Working instructions are in `.cursor/skills/<name>/SKILL.md`. Read ONLY the file the task needs, once per conversation:',
        '- `folio-mcp` — the list of tools and the rules for writing (read before the first change to data);',
        '- `folio-content` — the syntax of Folio pages (before creating or editing markdown);',
        '- `folio-boards` — the `sketch` DSL for whiteboards (before create_board/update_board);',
        '- `folio-tables` — data tables (before folio_table_*).',
        'Simple read-only questions need no skills — call the tool straight away.',
        '',
        `Mode of this run: ${input.runMode === 'ask' ? 'ASK — read only, no changes in Folio' : 'AGENT — changes are allowed only when the user asks for them directly'}.`,
        '',
        '---',
        '',
        `User: ${input.message}`,
      ].join('\n');
      // One deadline for the WHOLE turn, agent.send() included: in the first
      // run the timer started only after send, and a hung run held the HTTP
      // request for 1000+ s instead of 300. Plus a separate idle deadline
      // (05.09.2026): the total timeout no longer has to be short for Agent
      // mode (which may legitimately take 30 min), so idle is the one that
      // catches a run that hung SILENTLY (no delta/tool/thinking event at
      // all) rather than failed actively; it resets on every such event.
      let totalTimer: NodeJS.Timeout | undefined;
      let idleTimer: NodeJS.Timeout | undefined;
      let runRef: Run | null = null;
      const totalTimeoutMs = input.totalTimeoutMs ?? defaultTotalTimeoutMs(input.runMode);
      const idleTimeoutMs = input.idleTimeoutMs ?? (Number(process.env.CURSOR_AGENT_IDLE_TIMEOUT_MS) || 600_000);
      let rejectDeadline!: (err: Error) => void;
      const deadline = new Promise<never>((_, reject) => {
        rejectDeadline = reject;
      });
      const failDeadline = (err: Error): void => {
        runRef?.cancel().catch(() => undefined);
        rejectDeadline(err);
      };
      totalTimer = setTimeout(() => failDeadline(new Error(`Cursor agent timed out after ${totalTimeoutMs} ms`)), totalTimeoutMs);
      const bumpIdle = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => failDeadline(new Error(`Cursor agent idle for ${idleTimeoutMs} ms`)), idleTimeoutMs);
      };
      bumpIdle();
      const run = await Promise.race([
        agent.send(prompt, {
          local: { customTools: toolsHandle.tools },
          onDelta: ({ update }) => {
            bumpIdle();
            if (update.type === 'text-delta') input.onTextDelta?.(update.text);
            if (update.type === 'tool-call-started') input.onTool?.(update.toolCall.type);
          },
        }),
        deadline,
      ]);
      runRef = run;
      input.onRun?.(run);
      const abort = () => void run.cancel().catch(() => undefined);
      if (input.signal?.aborted) abort();
      input.signal?.addEventListener('abort', abort, { once: true });
      const streamPromise = (async () => {
        if (run.supports('stream')) {
          for await (const event of run.stream()) {
            bumpIdle();
            input.onEvent?.(event);
          }
        }
        return run.wait();
      })();
      const result = await Promise.race([streamPromise, deadline]).finally(() => {
        if (totalTimer) clearTimeout(totalTimer);
        if (idleTimer) clearTimeout(idleTimer);
        input.signal?.removeEventListener('abort', abort);
      });
      if (result.status === 'cancelled') throw new AssistantRunCancelledError();
      if (result.status !== 'finished') throw new Error(result.error?.message ?? `Cursor agent run ${result.status}`);
      const reply = result.result?.trim();
      if (!reply) throw new Error('Cursor agent returned an empty response');
      return reply;
    } finally {
      // close() after a cancelled or hung run may wait for it — do not hold
      // the HTTP response hostage: give it ~5 s and let go.
      await withCap(Promise.resolve().then(() => agent.close()), 5_000);
    }
  } finally {
    await withCap(toolsHandle.close(), 5_000);
  }
}

async function withCap(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    work.catch(() => undefined),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}
