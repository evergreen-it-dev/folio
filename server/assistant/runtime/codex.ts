/**
 * Codex through a personal ChatGPT subscription: the Codex CLI driven by
 * @openai/codex-sdk, one fresh thread per run.
 *
 * The model is boxed in on purpose. The CLI is a coding agent, so everything
 * that reaches the filesystem, a shell, the network or another product is
 * switched off: shell tools off, read-only sandbox, approvals never, no network,
 * no web search, an empty per-run working directory, and a private CODEX_HOME
 * that holds the user's auth.json for the run only. The ONLY tools it has are
 * those of the run's MCP endpoint (codexRunMcp.ts), i.e. exactly the record the
 * other providers get from buildAssistantTools. The child process runs with an
 * explicit minimal environment, so it sees none of the server's secrets.
 *
 * A run is stateless: the prompt carries the instructions, the plain-text
 * history of the conversation and the new message (the same parts every
 * provider uses); Codex's own thread resume is not used across user turns.
 */
import type { CodexOptions, ThreadEvent, ThreadOptions } from '@openai/codex-sdk';
import type { SDKMessage } from '@cursor/sdk';
import type { SdkUpdateLike } from '../genProgress.js';
import type { RunMilestone } from '../runTiming.js';
import {
  CODEX_BASE_CONFIG,
  CodexNotConnectedError,
  RUN_MCP_TOKEN_ENV,
  buildCodexChildEnv,
  codexShutdownSignal,
  resolveCodexBinary,
  withCodexAuth,
  type CodexAuthStore,
  type CodexRunDirs,
} from '../codexHome.js';
import { assertCodexEnabled } from '../providerFlags.js';
import { CodexUnavailableError, safeCliText } from '../codexLogin.js';
import { RUN_MCP_SERVER_NAME, openCodexRunMcp } from '../codexRunMcp.js';
import { codexAuthStore } from '../codexStore.js';
import * as assistantStore from '../store.js';
import { buildAssistantTools } from '../tools.js';
import { prepareAssistantWorkspace } from '../workspace.js';
import type { ChatHistoryMessage } from './agentLoop.js';
import { AssistantRunCancelledError, defaultIdleTimeoutMs, defaultTotalTimeoutMs, withCap } from './common.js';
import { buildReplayHistory, REPLAY_MAX_MESSAGES } from './history.js';
import { buildAssistantPromptParts } from './prompt.js';
import type { RunAssistantInput } from './types.js';

export const CODEX_AUTH_MESSAGE = 'Codex needs you to sign in again: open the assistant settings and reconnect your ChatGPT account.';
export const CODEX_LIMIT_MESSAGE = 'The ChatGPT plan limit for Codex has been reached. Try again later or choose another model.';
export const CODEX_UNAVAILABLE_MESSAGE = 'Codex is not available on this server.';

const MCP_STARTUP_TIMEOUT_SEC = 30;
const MCP_TOOL_TIMEOUT_SEC = 300;

/**
 * Codex features that give the model something other than the Folio tools. Shell and exec are the ones that
 * matter most (a read-only sandbox still lets a shell read the server's files); the rest are other tool
 * families of the CLI (connectors, browser and computer use, images, sub-agents, plugins, hooks).
 */
const DISABLED_FEATURES = [
  'shell_tool', 'unified_exec', 'apps', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use',
  'image_generation', 'view_image', 'multi_agent', 'plugins', 'remote_plugin', 'plugin_discovery_prefetch', 'plugin_sharing',
  'hooks', 'skill_search', 'skill_mcp_dependency_install', 'sleep_tool', 'tool_suggest', 'goals', 'code_mode_host',
  'in_app_browser', 'in_app_local_automation',
] as const;

/** The `model` argument: `default` means "do not pass one", so the CLI picks what the subscription allows. */
export function codexModelArg(modelId: string): string | undefined {
  const id = modelId.trim();
  return !id || id === 'default' ? undefined : id;
}

/** The CLI config of a run (flattened into `--config key=value` by the SDK). */
export function buildCodexConfig(mcp: { url: string; toolNames: string[] }): NonNullable<CodexOptions['config']> {
  return {
    ...CODEX_BASE_CONFIG,
    features: Object.fromEntries(DISABLED_FEATURES.map((name) => [name, false])),
    mcp_servers: {
      [RUN_MCP_SERVER_NAME]: {
        url: mcp.url,
        // The token reaches the CLI through the environment, never through the command line (visible to `ps`).
        bearer_token_env_var: RUN_MCP_TOKEN_ENV,
        // With approvals set to never the CLI refuses any MCP call that is not pre-approved; the set of tools is
        // limited by the endpoint itself and by enabled_tools.
        default_tools_approval_mode: 'approve',
        enabled_tools: mcp.toolNames,
        startup_timeout_sec: MCP_STARTUP_TIMEOUT_SEC,
        tool_timeout_sec: MCP_TOOL_TIMEOUT_SEC,
      },
    },
  };
}

export function buildCodexThreadOptions(workDir: string, modelId: string): ThreadOptions {
  const model = codexModelArg(modelId);
  return {
    ...(model ? { model } : {}),
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    networkAccessEnabled: false,
    webSearchMode: 'disabled',
    skipGitRepoCheck: true,
    workingDirectory: workDir,
  };
}

/** The whole prompt of a run: instructions, where the user is, the earlier turns as plain text, then the new message. */
export function buildCodexPrompt(parts: { stable: string; volatile: string }, history: ChatHistoryMessage[], message: string): string {
  const sections = [parts.stable, parts.volatile];
  if (history.length > 0) {
    sections.push('## Earlier in this conversation', history.map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content}`).join('\n\n'));
  }
  sections.push('---', `User: ${message}`);
  return sections.join('\n\n');
}

// ---------- errors ----------

/** A failure of the CLI or the SDK as an error whose message is safe to show: the three cases a user can act on, else a short sanitised text. */
export function mapCodexError(error: unknown, secrets: string[] = []): Error {
  if (error instanceof CodexNotConnectedError || error instanceof CodexUnavailableError || error instanceof AssistantRunCancelledError) return error;
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) if (secret) message = message.split(secret).join('[redacted]');
  const lower = message.toLowerCase();
  if (/unauthori[sz]ed|not\s*logged\s*in|login required|\b401\b|invalid_grant|refresh token|token_expired|token expired|sign in again|log in again|codex login/.test(lower)) {
    return new Error(CODEX_AUTH_MESSAGE);
  }
  if (/usage limit|usage_limit|rate limit|rate_limit|\b429\b|quota|too many requests/.test(lower)) return new Error(CODEX_LIMIT_MESSAGE);
  if (/\benoent\b|unable to locate codex|missing optional dependency|exec format error|cannot execute binary/.test(lower)) return new Error(CODEX_UNAVAILABLE_MESSAGE);
  return new Error(`Codex failed: ${safeCliText(message, 240) || 'unknown error'}`);
}

// ---------- events ----------

export interface CodexRunSink {
  onTextDelta?: (text: string) => void;
  onTool?: (name: string) => void;
  onUpdate?: (update: SdkUpdateLike) => void;
}

/**
 * Turns the CLI's events into the callbacks of every other runtime. Text and
 * reasoning go out as increments even when the CLI re-sends an item's whole
 * text on each update; a tool is reported with the real name of the Folio tool.
 */
export function createCodexEventMapper(sink: CodexRunSink): {
  handle: (event: ThreadEvent) => void;
  reply: () => string;
  /** A `turn.failed`: the turn is over and lost, whatever came before. */
  failure: () => string | null;
  /** The last stream `error` event, e.g. "Reconnecting... 1/2": only fatal when the stream ends without `turn.completed`. */
  streamError: () => string | null;
  completed: () => boolean;
} {
  let reply = '';
  let failure: string | null = null;
  let streamError: string | null = null;
  let completed = false;
  const sent = new Map<string, number>();
  const startedTools = new Set<string>();

  const increment = (kind: 'text' | 'thinking', id: string, full: string): void => {
    const key = `${kind}:${id}`;
    const already = sent.get(key) ?? 0;
    if (full.length <= already) return;
    // Anything but an extension of what was sent is a rewrite: skipped, the next whole text carries on from the length.
    const delta = already === 0 ? full : full.slice(already);
    sent.set(key, full.length);
    if (kind === 'text') {
      reply += delta;
      sink.onUpdate?.({ type: 'text-delta', text: delta });
      sink.onTextDelta?.(delta);
    } else {
      sink.onUpdate?.({ type: 'thinking-delta', text: delta });
    }
  };

  const tool = (phase: 'started' | 'completed', id: string, name: string): void => {
    const toolCall = { type: 'mcp', args: { toolName: name } };
    if (!startedTools.has(id)) {
      startedTools.add(id);
      sink.onUpdate?.({ type: 'tool-call-started', callId: id, toolCall });
      sink.onTool?.(name);
    }
    if (phase === 'completed') sink.onUpdate?.({ type: 'tool-call-completed', callId: id, toolCall });
  };

  return {
    handle(event) {
      switch (event.type) {
        case 'turn.started':
          sink.onUpdate?.({ type: 'step-started' });
          break;
        case 'item.started':
        case 'item.updated':
        case 'item.completed': {
          const item = event.item;
          if (item.type === 'agent_message') increment('text', item.id, item.text);
          else if (item.type === 'reasoning') increment('thinking', item.id, item.text);
          else if (item.type === 'mcp_tool_call') {
            if (event.type === 'item.started') tool('started', item.id, item.tool);
            else if (event.type === 'item.completed' || item.status !== 'in_progress') tool('completed', item.id, item.tool);
          }
          // Shell, file and web items should never exist with those tools off; they are ignored, never run by us.
          break;
        }
        case 'turn.completed': {
          completed = true;
          const usage = event.usage;
          const cached = usage.cached_input_tokens ?? 0;
          sink.onUpdate?.({ type: 'turn-ended', usage: { inputTokens: Math.max(0, usage.input_tokens - cached), outputTokens: usage.output_tokens, cacheReadTokens: cached } });
          break;
        }
        case 'turn.failed':
          failure = event.error.message;
          break;
        case 'error':
          streamError = event.message;
          break;
        default:
          break;
      }
    },
    reply: () => reply,
    failure: () => failure,
    streamError: () => streamError,
    completed: () => completed,
  };
}

// ---------- the guard: abort and deadlines ----------

export interface RunGuard {
  signal: AbortSignal;
  isStopped: () => boolean;
  /** Why the run was stopped: cancelled, a deadline. */
  reason: () => Error | null;
  /** Settles like `work`, or rejects with the reason the run was stopped. */
  race: <T>(work: Promise<T>) => Promise<T>;
  bump: () => void;
  dispose: () => void;
}

/** The run's deadlines, the same as agentLoop's: one for the whole run and one that resets on every sign of life; plus the caller's abort. */
export function createRunGuard(options: { signal?: AbortSignal; totalTimeoutMs?: number; idleTimeoutMs?: number; runMode: RunAssistantInput['runMode'] }): RunGuard {
  const totalTimeoutMs = options.totalTimeoutMs ?? defaultTotalTimeoutMs(options.runMode);
  const idleTimeoutMs = options.idleTimeoutMs ?? defaultIdleTimeoutMs();
  const controller = new AbortController();
  let stopped = false;
  let stopReason: Error | null = null;
  let rejectStopped!: (error: Error) => void;
  const stoppedPromise = new Promise<never>((_, reject) => { rejectStopped = reject; });
  stoppedPromise.catch(() => undefined);
  const stop = (error: Error): void => {
    if (stopped) return;
    stopped = true;
    stopReason = error;
    controller.abort();
    rejectStopped(error);
  };
  const onAbort = (): void => stop(new AssistantRunCancelledError());
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });
  const totalTimer = setTimeout(() => stop(new Error(`Assistant run timed out after ${totalTimeoutMs} ms`)), totalTimeoutMs);
  let idleTimer: NodeJS.Timeout | undefined;
  const bump = (): void => {
    if (stopped) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stop(new Error(`Assistant run idle for ${idleTimeoutMs} ms`)), idleTimeoutMs);
  };
  bump();
  return {
    signal: controller.signal,
    isStopped: () => stopped,
    reason: () => stopReason,
    race: (work) => Promise.race([work, stoppedPromise]),
    bump,
    dispose: () => {
      clearTimeout(totalTimer);
      if (idleTimer) clearTimeout(idleTimer);
      options.signal?.removeEventListener('abort', onAbort);
    },
  };
}

/** The part of the SDK's Thread this runtime uses; a test passes a fake. */
export interface CodexThreadLike {
  runStreamed: (input: string, turnOptions?: { signal?: AbortSignal }) => Promise<{ events: AsyncIterable<ThreadEvent> }>;
}

export interface DriveOptions {
  thread: CodexThreadLike;
  prompt: string;
  guard: RunGuard;
  sink: CodexRunSink;
  onMilestone?: (milestone: RunMilestone) => void;
  onWaitingForModel?: () => void;
  /** Strings that must never appear in an error message (the run's MCP token). */
  secrets?: string[];
  /** How long closing the stream may take after the run ended (it kills the CLI child); default 3 s. */
  closeCapMs?: number;
}

/** Sends the prompt and consumes the event stream to its end; returns the reply. Aborting kills the CLI child (the SDK passes the signal to spawn). */
export async function driveCodexThread(options: DriveOptions): Promise<string> {
  const { guard } = options;
  const mapper = createCodexEventMapper(options.sink);
  let iterator: AsyncIterator<ThreadEvent> | undefined;
  try {
    options.onWaitingForModel?.();
    options.onMilestone?.('sent');
    const { events } = await guard.race(options.thread.runStreamed(options.prompt, { signal: guard.signal }));
    iterator = events[Symbol.asyncIterator]();
    for (;;) {
      const step = await guard.race(iterator.next());
      guard.bump();
      if (step.done) break;
      mapper.handle(step.value);
    }
  } catch (error) {
    if (guard.isStopped()) throw error;
    const reported = mapper.failure() ?? mapper.streamError();
    throw mapCodexError(reported ? new Error(reported) : error, options.secrets);
  } finally {
    // Closing the generator makes the SDK kill the child; the cap keeps a stuck one from holding the response.
    if (iterator?.return) await withCap(Promise.resolve(iterator.return()), options.closeCapMs ?? 3_000);
  }
  const failure = mapper.failure() ?? (mapper.completed() ? null : mapper.streamError());
  if (failure) throw mapCodexError(new Error(failure), options.secrets);
  const text = mapper.reply().trim();
  if (!text) throw new Error('The model returned an empty response');
  return text;
}

// ---------- the run ----------

type CodexCtor = new (options: CodexOptions) => { startThread: (options?: ThreadOptions) => CodexThreadLike };

export interface CodexRunDeps {
  store?: CodexAuthStore;
  /** Test seam: the SDK's Codex class. */
  loadCodex?: () => Promise<CodexCtor>;
  base?: string;
}

export async function runCodexAssistant(input: RunAssistantInput, deps: CodexRunDeps = {}): Promise<string> {
  assertCodexEnabled();
  const binary = resolveCodexBinary();
  if (!binary && !deps.loadCodex) throw new CodexUnavailableError();

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
  // The deadlines start only once this run holds the user's Codex lock; waiting behind another run is bounded separately.
  let guard: RunGuard | undefined;
  const stopSignal = AbortSignal.any([...(input.signal ? [input.signal] : []), codexShutdownSignal]);
  let mcp: ReturnType<typeof openCodexRunMcp> | undefined;
  try {
    const parts = buildAssistantPromptParts(workspace, input.runMode, input.message);
    // One more than the replay limit: the newest row is the message that started this run.
    const rows = await assistantStore.listRecentMessages(input.conversation.id, REPLAY_MAX_MESSAGES + 1);
    const prompt = buildCodexPrompt(parts, buildReplayHistory(rows), input.message);
    mcp = openCodexRunMcp(toolsHandle.tools);
    const endpoint = mcp;
    const toolNames = Object.keys(toolsHandle.tools).sort();

    return await withCodexAuth(input.user.id, deps.store ?? codexAuthStore(input.user.id), async (dirs: CodexRunDirs) => {
      const runGuard = createRunGuard({ signal: stopSignal, totalTimeoutMs: input.totalTimeoutMs, idleTimeoutMs: input.idleTimeoutMs, runMode: input.runMode });
      guard = runGuard;
      try {
        const loadCodex = deps.loadCodex ?? (async () => (await import('@openai/codex-sdk')).Codex as CodexCtor);
        const Codex = await runGuard.race(loadCodex());
        const client = new Codex({
          ...(binary ? { codexPathOverride: binary } : {}),
          env: buildCodexChildEnv(dirs, { [RUN_MCP_TOKEN_ENV]: endpoint.token }),
          config: buildCodexConfig({ url: endpoint.url, toolNames }),
        });
        const thread = client.startThread(buildCodexThreadOptions(dirs.work, input.route.modelId));
        input.onMilestone?.('agent-ready');
        return await driveCodexThread({
          thread,
          prompt,
          guard: runGuard,
          sink: { onTextDelta: input.onTextDelta, onTool: input.onTool, onUpdate: input.onUpdate },
          onMilestone: input.onMilestone,
          // runs.ts shows "thinking" for this message; only its type is read.
          onWaitingForModel: () => input.onEvent?.({ type: 'thinking' } as SDKMessage),
          secrets: [endpoint.token],
        });
      } finally {
        runGuard.dispose();
      }
    }, { signal: stopSignal, base: deps.base });
  } catch (error) {
    // Whatever surfaced while the run was being stopped (an abort of the lock wait, a killed child), the cause is the stop.
    if (guard?.reason()) throw guard.reason();
    if (stopSignal.aborted) throw new AssistantRunCancelledError();
    throw error;
  } finally {
    mcp?.close();
    await withCap(toolsHandle.close(), 5_000);
  }
}
