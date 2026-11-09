/**
 * The provider-neutral agent loop: stream a model turn, run the tools it asked
 * for (all at once, through the same SDKCustomTool.execute the Cursor runtime
 * uses, so access control is the tools' own and unchanged), append the results
 * and repeat. It speaks the update vocabulary of the Cursor SDK (`text-delta`,
 * `partial-tool-call`, `turn-ended` with usage, ...) so runs.ts, runTiming.ts
 * and genProgress.ts do not know which provider a run went through.
 *
 * A ChatModel owns the transcript in its provider's own format and only ever
 * appends to it: earlier messages are never edited or dropped inside a run
 * (Claude rejects a request whose earlier turns changed after thinking blocks
 * were produced).
 */
import type { SDKCustomTool, SDKJsonValue } from '@cursor/sdk';
import type { AssistantRunMode } from '../../../shared/contracts.js';
import type { SdkUpdateLike } from '../genProgress.js';
import type { RunMilestone } from '../runTiming.js';
import { AssistantRunCancelledError, defaultIdleTimeoutMs, defaultTotalTimeoutMs } from './common.js';

/** Model turns with tools available before the one final request without tools. */
export const MAX_MODEL_TURNS: Record<AssistantRunMode, number> = { ask: 12, agent: 40 };
export const TOOL_RESULT_MAX_CHARS = 40_000;
export const TOOL_RESULT_BUDGET_CHARS = 600_000;

const TRUNCATED_RESPONSE_NOTE = 'The response was cut off because it reached the length limit of the model.';
const REFUSAL_MESSAGE = 'The model declined to answer this request. Try rephrasing it, or choose another model in the assistant settings.';
const LIMIT_NOTICE = 'The tool limit of this run has been reached, so no more tools can be called. Answer now from the results you already have and say plainly what is still missing.';
const BUDGET_OMITTED_NOTE = '[Omitted: this run has used up its budget for tool results. Answer from what you already have.]';

export interface ChatToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** What a ChatModel is created with: everything of the request that does not change within a run. */
export interface ChatModelSeed {
  system: { stable: string; volatile: string };
  /** Plain text of the earlier user turns, oldest first. Starts with a user message when not empty. */
  history: ChatHistoryMessage[];
  userMessage: string;
  /** Sorted by name, so the serialized request is deterministic. */
  tools: ChatToolDefinition[];
}

export type ChatDelta =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  /** `args` is everything received so far for this call, as raw text. */
  | { type: 'tool-args'; callId: string | null; name: string; args: string };

export interface ChatToolCall {
  id: string;
  name: string;
  input: unknown;
  /** Set when the arguments could not be parsed: the tool is not run and the model gets this as an error result. */
  invalid?: string;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

/** `pause`: the turn is not finished and the next request continues it. */
export type ChatStopReason = 'end' | 'tool_calls' | 'max_tokens' | 'pause' | 'refusal';

export interface ChatTurnResult {
  stop: ChatStopReason;
  toolCalls: ChatToolCall[];
  usage?: ChatUsage;
}

export interface ChatToolResult {
  callId: string;
  content: string;
  isError: boolean;
}

export interface ChatTurnRequest {
  /** False for the final request after a limit: the model must answer from what it has. */
  toolsEnabled: boolean;
  signal: AbortSignal;
  onDelta: (delta: ChatDelta) => void;
}

export interface ChatModel {
  streamTurn(request: ChatTurnRequest): Promise<ChatTurnResult>;
  /** Appends the results of ALL tool calls of the last turn. `notice` is extra text for the model after the results. */
  addToolResults(results: ChatToolResult[], notice?: string): void;
}

export interface AgentLoopOptions {
  model: ChatModel;
  tools: Record<string, SDKCustomTool>;
  runMode: AssistantRunMode;
  signal?: AbortSignal;
  totalTimeoutMs?: number;
  idleTimeoutMs?: number;
  onTextDelta?: (text: string) => void;
  onTool?: (name: string) => void;
  onUpdate?: (update: SdkUpdateLike) => void;
  onMilestone?: (milestone: RunMilestone) => void;
  /** A model request is about to start and nothing is visible yet. */
  onWaitingForModel?: () => void;
}

/** The tools as the model is told about them, in a stable order. */
export function chatToolDefinitions(tools: Record<string, SDKCustomTool>): ChatToolDefinition[] {
  return Object.entries(tools)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, tool]) => ({
      name,
      description: tool.description ?? name,
      inputSchema: (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
    }));
}

function truncationNote(originalLength: number, reason: string): string {
  return `\n\n[Truncated: only the start of this ${originalLength}-character tool result is shown (${reason}). Ask for a narrower part if you need more.]`;
}

export function capText(text: string, limit: number, reason: string): string {
  if (text.length <= limit) return text;
  const note = truncationNote(text.length, reason);
  return `${text.slice(0, Math.max(0, limit - note.length))}${note}`;
}

/**
 * The checks that matter for tool arguments: the JSON type, required fields,
 * enum values and the same again for nested fields. With eager input streaming
 * the API no longer validates arguments, and a tolerant parser can turn broken
 * JSON into a truncated object that still parses. Unknown keywords are skipped:
 * the tool itself is the final judge of its input.
 */
export function validateToolInput(schema: unknown, value: unknown, path = 'input'): string | null {
  if (typeof schema !== 'object' || schema === null) return null;
  const spec = schema as Record<string, unknown>;
  const alternatives = (spec.anyOf ?? spec.oneOf) as unknown[] | undefined;
  if (Array.isArray(alternatives) && alternatives.length > 0) {
    const failures = alternatives.map((option) => validateToolInput(option, value, path));
    if (failures.every((failure) => failure !== null)) return failures[0] ?? null;
  }
  const types = typeof spec.type === 'string' ? [spec.type] : Array.isArray(spec.type) ? (spec.type as string[]) : null;
  if (types && !types.some((type) => matchesJsonType(type, value))) return `${path} must be ${types.join(' or ')}`;
  if (Array.isArray(spec.enum) && !spec.enum.some((allowed) => allowed === value)) return `${path} must be one of ${JSON.stringify(spec.enum)}`;
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of Array.isArray(spec.required) ? (spec.required as string[]) : []) {
      if (record[key] === undefined) return `${path}.${key} is required`;
    }
    const properties = (typeof spec.properties === 'object' && spec.properties !== null ? spec.properties : {}) as Record<string, unknown>;
    for (const [key, nested] of Object.entries(properties)) {
      if (record[key] === undefined) continue;
      const failure = validateToolInput(nested, record[key], `${path}.${key}`);
      if (failure) return failure;
    }
  }
  if (Array.isArray(value) && spec.items !== undefined) {
    for (let index = 0; index < value.length; index += 1) {
      const failure = validateToolInput(spec.items, value[index], `${path}[${index}]`);
      if (failure) return failure;
    }
  }
  return null;
}

function matchesJsonType(type: string, value: unknown): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    case 'array': return Array.isArray(value);
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    default: return true;
  }
}

/** What a tool returned, as the text the model gets and whether it is an error. */
export function normalizeToolOutput(output: unknown): { content: string; isError: boolean } {
  if (typeof output === 'string') return { content: output, isError: false };
  if (typeof output === 'object' && output !== null && Array.isArray((output as { content?: unknown }).content)) {
    const parts = (output as { content: Array<{ type?: string; text?: string }> }).content;
    const content = parts.filter((part) => part.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n');
    return { content, isError: (output as { isError?: unknown }).isError === true };
  }
  return { content: JSON.stringify(output) ?? '', isError: false };
}

/** Runs the whole turn sequence and returns the reply text (all turns together, as the Cursor SDK's result is). */
export async function runAgentLoop(options: AgentLoopOptions): Promise<string> {
  const { model, tools, runMode, signal } = options;
  const totalTimeoutMs = options.totalTimeoutMs ?? defaultTotalTimeoutMs(runMode);
  const idleTimeoutMs = options.idleTimeoutMs ?? defaultIdleTimeoutMs();

  const controller = new AbortController();
  let stopped = false;
  let rejectStopped!: (error: Error) => void;
  const stoppedPromise = new Promise<never>((_, reject) => {
    rejectStopped = reject;
  });
  stoppedPromise.catch(() => undefined);
  const stop = (error: Error): void => {
    if (stopped) return;
    stopped = true;
    controller.abort();
    rejectStopped(error);
  };

  const onAbort = (): void => stop(new AssistantRunCancelledError());
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });

  // Same contract as the Cursor runtime: one deadline for the whole run, plus
  // an idle deadline that resets on every sign of life.
  const totalTimer = setTimeout(() => stop(new Error(`Assistant run timed out after ${totalTimeoutMs} ms`)), totalTimeoutMs);
  let idleTimer: NodeJS.Timeout | undefined;
  const bumpIdle = (): void => {
    if (stopped) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stop(new Error(`Assistant run idle for ${idleTimeoutMs} ms`)), idleTimeoutMs);
  };

  const emit = (update: SdkUpdateLike): void => {
    if (stopped) return;
    try {
      options.onUpdate?.(update);
    } catch {
      // progress/timing must never break the run
    }
  };
  const race = <T>(work: Promise<T>): Promise<T> => Promise.race([work, stoppedPromise]);

  let reply = '';
  const appendReply = (text: string): void => {
    if (stopped || !text) return;
    reply += text;
    emit({ type: 'text-delta', text });
    options.onTextDelta?.(text);
  };

  const runTool = async (call: ChatToolCall): Promise<ChatToolResult> => {
    const toolCall = { type: 'mcp', args: { toolName: call.name } };
    emit({ type: 'tool-call-started', callId: call.id, toolCall });
    if (!stopped) options.onTool?.(call.name);
    bumpIdle();
    try {
      const failure = (content: string): ChatToolResult => ({ callId: call.id, content, isError: true });
      if (call.invalid) return failure(call.invalid);
      const tool = tools[call.name];
      if (!tool) return failure(`Unknown tool: ${call.name}`);
      const problem = validateToolInput(tool.inputSchema, call.input);
      if (problem) return failure(JSON.stringify({ INVALID_INPUT: problem, received: call.input }));
      const output = await tool.execute(call.input as Record<string, SDKJsonValue>, { toolCallId: call.id });
      const { content, isError } = normalizeToolOutput(output);
      return { callId: call.id, content: content || '(no output)', isError };
    } catch (error) {
      return { callId: call.id, content: error instanceof Error ? error.message : 'tool call failed', isError: true };
    } finally {
      bumpIdle();
      emit({ type: 'tool-call-completed', callId: call.id, toolCall });
    }
  };

  const maxTurns = MAX_MODEL_TURNS[runMode];
  let budget = TOOL_RESULT_BUDGET_CHARS;
  let turns = 0;
  let toolsEnabled = true;

  try {
    bumpIdle();
    for (;;) {
      if (stopped) await stoppedPromise;
      turns += 1;
      options.onWaitingForModel?.();
      if (turns === 1) options.onMilestone?.('sent');

      // `step-started` waits for the first sign of the model so that the time-to-first-delta in runTiming stays real.
      let turnStarted = false;
      const announceTurn = (): void => {
        if (turnStarted) return;
        turnStarted = true;
        emit({ type: 'step-started' });
      };

      const turn = await race(model.streamTurn({
        toolsEnabled,
        signal: controller.signal,
        onDelta: (delta) => {
          if (stopped) return;
          bumpIdle();
          announceTurn();
          if (delta.type === 'text') appendReply(delta.text);
          else if (delta.type === 'thinking') emit({ type: 'thinking-delta', text: delta.text });
          else emit({ type: 'partial-tool-call', callId: delta.callId, toolCall: { type: 'mcp', args: { toolName: delta.name, partialArgs: delta.args } } });
        },
      }));
      bumpIdle();
      announceTurn();
      if (turn.usage) emit({ type: 'turn-ended', usage: turn.usage });

      if (turn.stop === 'refusal') {
        appendReply(reply ? `\n\n${REFUSAL_MESSAGE}` : REFUSAL_MESSAGE);
        break;
      }
      if (turn.stop === 'max_tokens') {
        // Tool arguments cut off at the limit can still parse: such a turn's tools are never run.
        appendReply(reply ? `\n\n${TRUNCATED_RESPONSE_NOTE}` : TRUNCATED_RESPONSE_NOTE);
        break;
      }
      if (!toolsEnabled) break;
      if (turn.stop === 'pause') {
        if (turns >= maxTurns) toolsEnabled = false;
        continue;
      }
      if (turn.stop !== 'tool_calls' || turn.toolCalls.length === 0) break;

      const executed = await race(Promise.all(turn.toolCalls.map(runTool)));
      const results = executed.map((result) => {
        const capped = capText(result.content, TOOL_RESULT_MAX_CHARS, `a single result is limited to ${TOOL_RESULT_MAX_CHARS} characters`);
        if (budget <= 0) return { ...result, content: BUDGET_OMITTED_NOTE };
        const content = capText(capped, budget, 'this run has used up its budget for tool results');
        budget = content.length < capped.length ? 0 : budget - content.length;
        return { ...result, content };
      });
      const atLimit = turns >= maxTurns || budget <= 0;
      model.addToolResults(results, atLimit ? LIMIT_NOTICE : undefined);
      if (atLimit) toolsEnabled = false;
    }
  } finally {
    clearTimeout(totalTimer);
    if (idleTimer) clearTimeout(idleTimer);
    signal?.removeEventListener('abort', onAbort);
  }

  const text = reply.trim();
  if (!text) throw new Error('The model returned an empty response');
  return text;
}
