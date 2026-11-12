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
import { realToolName, type SdkUpdateLike } from './genProgress.js';
import type { RunMilestone, RunWarm, ToolTiming } from './runTiming.js';
import type { AssistantRunMode } from '../../shared/contracts.js';
import type { User } from '../../shared/contracts.js';
import type { AssistantConversationRow } from './store.js';
import { buildAssistantTools, type AssistantToolsHandle } from './tools.js';
import { prepareAssistantWorkspace, resolveAssistantStateDir, resolveConversationWorkspace } from './workspace.js';
import { ensureAssistantCursorPermissions } from './cursorCliConfig.js';
import { filterAssistantModels, parseAssistantModel } from './models.js';
import { AssistantRunCancelledError, defaultIdleTimeoutMs, defaultTotalTimeoutMs, withCap } from './runtime/common.js';
import { buildAssistantPromptParts } from './runtime/prompt.js';
import { closeTakenSlot, startWarmSlot, takeWarmSlot, warmEnabled, warmFingerprint, warmKey, type TakenWarmSlot, type WarmResource } from './warmSlots.js';

export { AssistantRunCancelledError };

export interface RunAssistantInput {
  /** The ai_runs row of this turn — the built-in tool report_unanswered_question writes against it. */
  runId: string;
  apiKey: string;
  /** The Cursor model of this run, from the route. Absent: the conversation's preference. */
  model?: string;
  user: User;
  conversation: AssistantConversationRow;
  message: string;
  currentPath: string | null;
  space: string | null;
  pageId: string | null;
  runMode: AssistantRunMode;
  /** Public sites: the published space an anonymous visitor's run is confined to (tools, workspace and prompt). */
  publicSpace?: string | null;
  signal?: AbortSignal;
  onRun?: (run: Run) => void;
  onEvent?: (event: SDKMessage) => void;
  onTextDelta?: (text: string) => void;
  onTool?: (name: string) => void;
  /** Every SDK delta update (text, thinking, partial tool call, token counter, step/turn markers…) — for progress and timing only. */
  onUpdate?: (update: SdkUpdateLike) => void;
  /** Setup milestones: tools built, SDK agent ready (created/resumed + reloaded), agent.send() returned. */
  onMilestone?: (milestone: RunMilestone) => void;
  /** Whether this run found a warm agent waiting (see warmSlots.ts): reported once, right after the slot was looked at. */
  onWarm?: (warm: RunWarm) => void;
  /** A tool's execute() finished (name, duration, whether it returned an error). */
  onToolFinished?: (timing: ToolTiming) => void;
  /** Deadline for the whole call (agent.send() + stream()). Defaults per runMode — see defaultTotalTimeoutMs. */
  totalTimeoutMs?: number;
  /** Reset on every delta/tool/thinking event — catches a run that's silently stuck rather than actively erroring, without forcing every Agent-mode run to fit inside one short total deadline. Default CURSOR_AGENT_IDLE_TIMEOUT_MS (600000 = 10 min). */
  idleTimeoutMs?: number;
}

/**
 * The only built-in tool family the model is offered: `mcp`, which carries the
 * in-process custom tools of tools.ts (the RBAC-checked Folio tools,
 * report_unanswered_question, read_skill). Everything else the Cursor agent
 * ships — shell, read, grep, glob, ls, edit, web fetch/search, subagents — is
 * OFF. The agent runs without an OS sandbox (see sandboxOptions below), so
 * those tools are not confined to the conversation workspace: with them the
 * model could read the git repositories of every space (and other users'
 * assistant state) straight from the server's disk, around the per-user access
 * checks of the Folio tools. A deny-list of shell names (cursorCliConfig.ts)
 * and a sentence in the system prompt are not a boundary; an allow-list of one
 * tool family is. Not persisted by the SDK: it must be passed on every
 * Agent.create AND Agent.resume (agentOptions below is used for both).
 */
export const ASSISTANT_BUILTIN_TOOLS: string[] = ['mcp'];

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

/** Never a provider-prefixed preference (`anthropic:...`): a run that fell back to Cursor from such a model uses `auto`. */
function cursorModelFor(input: Pick<RunAssistantInput, 'model' | 'conversation'>): string {
  const model = input.model ?? input.conversation.model;
  return parseAssistantModel(model).provider === 'cursor' ? model : 'auto';
}

interface CursorAgentOptionsInput {
  apiKey: string;
  model: string;
  name: string;
  cwd: string;
  /** Omitted by the warm-up: a run always passes its own tools to send() (see the note at warmCursorConversation). */
  customTools?: AssistantToolsHandle['tools'];
}

function buildAgentOptions(input: CursorAgentOptionsInput) {
  return {
    apiKey: input.apiKey,
    model: modelSelection(input.model),
    name: input.name,
    mode: 'agent' as const,
    tools: ASSISTANT_BUILTIN_TOOLS,
    local: {
      cwd: input.cwd,
      settingSources: [],
      ...(input.customTools ? { customTools: input.customTools } : {}),
      // Same reasoning as the Hub original: the Cursor SDK's own sandbox
      // classifier can't currently be combined with in-process
      // custom-user-tools. Isolation is the per-conversation cwd plus the
      // RBAC-checked MCP tools themselves, not an OS sandbox.
      sandboxOptions: { enabled: false },
      autoReview: false,
    },
  };
}

/**
 * Everything the SDK agent of a conversation depends on: a warm agent is used by a run only when all of it is identical.
 * Not the title: it is only the agent's display name and changes after the first message (auto-title), which would
 * make every parked agent a miss.
 */
function cursorWarmFingerprint(input: Pick<RunAssistantInput, 'apiKey' | 'user' | 'conversation' | 'model'>): string {
  return warmFingerprint([
    input.apiKey,
    cursorModelFor(input),
    resolveConversationWorkspace(input.user.id, input.conversation.id),
    input.conversation.cursorAgentId,
  ]);
}

interface CursorWarmResource extends WarmResource {
  agent: SDKAgent;
}

/**
 * Warm-up of a conversation's Cursor agent, started when the user opens the assistant panel or switches conversation
 * in it: the per-conversation workspace, `Agent.create`/`Agent.resume` and `reload()` — the 1.5-4 s a run used to
 * spend before it could send. It sends NOTHING to the model (zero tokens).
 *
 * No tools handle is built here, on purpose. The SDK resolves a run's tools as `send(..., {local:{customTools}}) ??
 * agent options' customTools` (and the run's tool session is built from that value at send time), and the typings
 * say send-level tools replace the agent-level ones. runCursorAssistant always passes its own handle to send(), so a
 * warm agent never executes anything from its creation-time options; leaving them out also means no tool set with a
 * wrong run id or the wrong Ask/Agent scopes exists anywhere. The run still builds its real handle itself.
 *
 * Returns false when this conversation already has an equal warm slot (idempotent).
 */
export function warmCursorConversation(input: Pick<RunAssistantInput, 'apiKey' | 'user' | 'conversation' | 'model' | 'runMode' | 'currentPath' | 'space' | 'pageId'>): boolean {
  const fingerprint = cursorWarmFingerprint(input);
  return startWarmSlot(warmKey(input.user.id, input.conversation.id), fingerprint, async () => {
    const workspace = await prepareAssistantWorkspace({
      user: input.user,
      conversationId: input.conversation.id,
      runMode: input.runMode,
      currentPath: input.currentPath,
      space: input.space,
      pageId: input.pageId,
    });
    ensureAssistantCursorPermissions();
    const sdk = await configureSdk();
    const agent = await resumeOrCreateAgent(
      sdk,
      input.conversation.cursorAgentId,
      buildAgentOptions({ apiKey: input.apiKey, model: cursorModelFor(input), name: input.conversation.title ?? 'Folio AI', cwd: workspace.root }),
    );
    await agent.reload().catch(() => undefined);
    return { agent, close: () => withCap(Promise.resolve().then(() => agent.close()), 5_000) } satisfies CursorWarmResource;
  });
}

/** The cheap process-level part of the warm-up: the SDK module and its configuration. */
export async function warmCursorModules(): Promise<void> {
  await configureSdk();
}

export async function runCursorAssistant(input: RunAssistantInput): Promise<string> {
  // The warm slot is taken SYNCHRONOUSLY, before the first await: of two parallel runs of one conversation only
  // one gets it. Whatever happens next, a taken slot is closed in the outer finally (or its agent by the run).
  const slotKey = warmKey(input.user.id, input.conversation.id);
  const fingerprint = cursorWarmFingerprint(input);
  const taken: TakenWarmSlot | null = takeWarmSlot(slotKey);
  const fingerprintMatches = taken !== null && taken.fingerprint === fingerprint;
  let warmReady: Promise<CursorWarmResource | null> | null = fingerprintMatches ? (taken.ready as Promise<CursorWarmResource | null>) : null;
  let warmState: RunWarm = warmEnabled() ? 'miss' : 'off';
  let warmUsed = false;
  // Set only when the run ended 'finished' with a reply: then the agent is parked for the next message instead of closed.
  let parkable = false;
  try {
    if (taken && !fingerprintMatches) await closeTakenSlot(taken);
    const workspace = await prepareAssistantWorkspace({
      user: input.user,
      conversationId: input.conversation.id,
      runMode: input.runMode,
      currentPath: input.currentPath,
      space: input.space,
      pageId: input.pageId,
      publicSpace: input.publicSpace ?? null,
    });
    const toolsHandle = await buildAssistantTools(input.user, input.runMode, {
      runId: input.runId,
      conversationId: input.conversation.id,
      space: input.space,
      pageId: input.pageId,
      publicSpace: input.publicSpace ?? null,
      onToolFinished: input.onToolFinished,
    });
    input.onMilestone?.('tools-ready');
    try {
      ensureAssistantCursorPermissions();
      const sdk = await configureSdk();
      const agentOptions = buildAgentOptions({
        apiKey: input.apiKey,
        model: cursorModelFor(input),
        name: input.conversation.title ?? 'Folio AI',
        cwd: workspace.root,
        customTools: toolsHandle.tools,
      });
      const warm = warmReady ? await warmReady : null;
      warmReady = null;
      if (warm) {
        warmUsed = true;
        warmState = 'hit';
      }
      input.onWarm?.(warmState);
      const agent = warm ? warm.agent : await resumeOrCreateAgent(sdk, input.conversation.cursorAgentId, agentOptions);
      try {
        // A warm agent was reloaded when the panel opened.
        if (!warmUsed) await agent.reload().catch(() => undefined);
        input.onMilestone?.('agent-ready');
        // The context is inlined into the prompt: every extra file read is a
        // separate model turn (the first run spent 8-10 read/glob calls before
        // its first action). Skills stay files: they are large and each is
        // needed for its own topic only.
        const prompt = buildAssistantPromptParts(workspace, input.runMode, input.message).cursorPrompt;
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
        const idleTimeoutMs = input.idleTimeoutMs ?? defaultIdleTimeoutMs();
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
              try {
                input.onUpdate?.(update as SdkUpdateLike);
              } catch {
                // progress/timing must never break the run
              }
              if (update.type === 'text-delta') input.onTextDelta?.(update.text);
              if (update.type === 'tool-call-started') input.onTool?.(realToolName(update.toolCall.type, (update.toolCall as { args?: unknown }).args));
            },
          }),
          deadline,
        ]);
        runRef = run;
        input.onMilestone?.('sent');
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
        parkable = true;
        return reply;
      } finally {
        // A finished run parks its agent in the warm slot of this conversation (same fingerprint, normal TTL and cap),
        // so the follow-up message skips resume and reload too. Nothing is sent: zero tokens. Public-site runs and
        // ASSISTANT_WARM=0 do not park; if the key already has a slot, ours is closed instead. Every other ending
        // (cancelled, failed, timed out, hung) closes the agent: close() after a cancelled or hung run may wait for it
        // — do not hold the HTTP response hostage: give it ~5 s and let go.
        const parked =
          parkable &&
          !input.publicSpace &&
          warmEnabled() &&
          startWarmSlot(slotKey, fingerprint, async () => ({ agent, close: () => withCap(Promise.resolve().then(() => agent.close()), 5_000) }) satisfies CursorWarmResource);
        if (!parked) await withCap(Promise.resolve().then(() => agent.close()), 5_000);
      }
    } finally {
      await withCap(toolsHandle.close(), 5_000);
    }
  } finally {
    // A taken warm agent the run never reached (setup failed first): do not leave it running.
    if (warmReady) await withCap(warmReady.then((warm) => warm?.close()), 5_000);
  }
}
