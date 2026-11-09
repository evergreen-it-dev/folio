/**
 * MiniMax through its OpenAI-compatible `chat/completions` endpoint. There is
 * no official Node SDK, and a key is a plain Bearer token.
 *
 * Quirks handled here: reasoning arrives as `reasoning_content` when
 * `reasoning_split` is set, but `<think>` tags can still appear in the text and
 * must be hidden even when a tag is split across two chunks; tool-call markup
 * can leak into the text when a request carries no tools; a call can succeed at
 * the HTTP level and carry the real error in `base_resp`; and a model sometimes
 * stops with its answer inside the reasoning.
 */
import type { ChatDelta, ChatModel, ChatModelSeed, ChatToolCall, ChatToolResult, ChatTurnRequest, ChatTurnResult, ChatUsage } from './agentLoop.js';
import type { ProviderKeyVerdict } from './common.js';

const DEFAULT_BASE_URL = 'https://api.minimax.io/v1';
const THINKING_SUFFIX = '-thinking';
const VERIFY_MODEL = 'MiniMax-M3';
const VERIFY_TIMEOUT_MS = 20_000;
const MAX_ERROR_DETAIL_CHARS = 300;
/** Codes of `base_resp.status_code` that mean the key itself is bad. */
const AUTH_STATUS_CODES = new Set([1004, 2049]);
/** Codes of `base_resp.status_code` that mean rate limits. */
const RATE_LIMIT_STATUS_CODES = new Set([1002, 1039, 2056]);

function minimaxBaseUrl(): string {
  return (process.env.MINIMAX_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/** `MiniMax-M3-thinking` is a virtual id: the real model with thinking switched on. */
export function parseMinimaxModel(modelId: string): { model: string; thinking: boolean } {
  return modelId.endsWith(THINKING_SUFFIX) ? { model: modelId.slice(0, -THINKING_SUFFIX.length), thinking: true } : { model: modelId, thinking: false };
}

const HIDDEN_TAGS = [
  { open: '<think>', close: '</think>', reasoning: true },
  { open: '<minimax:tool_call>', close: '</minimax:tool_call>', reasoning: false },
  { open: '<tool_call>', close: '</tool_call>', reasoning: false },
] as const;

function partialSuffix(text: string, tag: string): number {
  for (let length = Math.min(tag.length - 1, text.length); length > 0; length -= 1) {
    if (text.endsWith(tag.slice(0, length))) return length;
  }
  return 0;
}

export interface MinimaxStreamFilter {
  /** Feed the next text chunk; returns the visible text and the reasoning found in it. */
  push: (chunk: string) => { text: string; reasoning: string };
  /** Text held back while waiting to see whether it starts a tag. An unclosed hidden block is dropped. */
  flush: () => string;
}

/** Removes hidden blocks from a text stream even when a tag is split across chunks; leading whitespace of the answer is dropped too. */
export function createMinimaxStreamFilter(): MinimaxStreamFilter {
  let inside: (typeof HIDDEN_TAGS)[number] | null = null;
  let pending = '';
  let emitted = false;
  const leadingTrim = (text: string): string => {
    if (emitted) return text;
    const trimmed = text.replace(/^\s+/, '');
    if (trimmed) emitted = true;
    return trimmed;
  };
  return {
    push(chunk) {
      pending += chunk;
      let text = '';
      let reasoning = '';
      while (pending) {
        if (inside) {
          const end = pending.indexOf(inside.close);
          if (end >= 0) {
            if (inside.reasoning) reasoning += pending.slice(0, end);
            pending = pending.slice(end + inside.close.length);
            inside = null;
            continue;
          }
          const hold = partialSuffix(pending, inside.close);
          if (inside.reasoning) reasoning += pending.slice(0, pending.length - hold);
          pending = pending.slice(pending.length - hold);
          break;
        }
        let next: { index: number; tag: (typeof HIDDEN_TAGS)[number] } | null = null;
        for (const tag of HIDDEN_TAGS) {
          const index = pending.indexOf(tag.open);
          if (index >= 0 && (!next || index < next.index)) next = { index, tag };
        }
        if (next) {
          text += pending.slice(0, next.index);
          pending = pending.slice(next.index + next.tag.open.length);
          inside = next.tag;
          continue;
        }
        const hold = Math.max(...HIDDEN_TAGS.map((tag) => partialSuffix(pending, tag.open)));
        text += pending.slice(0, pending.length - hold);
        pending = pending.slice(pending.length - hold);
        break;
      }
      return { text: leadingTrim(text), reasoning };
    },
    flush() {
      const rest = inside ? '' : pending;
      pending = '';
      return leadingTrim(rest);
    },
  };
}

interface MinimaxToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface MinimaxPayload {
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: MinimaxToolCallDelta[] };
    message?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  base_resp?: { status_code?: number; status_msg?: string };
  error?: { message?: string };
}

function redact(text: string, apiKey: string): string {
  return (apiKey ? text.split(apiKey).join('[redacted]') : text).slice(0, MAX_ERROR_DETAIL_CHARS);
}

/** Maps a failure to a message safe to store: never the key, and only a short excerpt of what the server said. */
function statusError(status: number, detail: string, apiKey: string): Error {
  if (status === 401 || status === 403) return new Error(`MiniMax rejected the API key (HTTP ${status})`);
  if (status === 429) return new Error('MiniMax rate limit reached (HTTP 429)');
  if (status >= 500) return new Error(`MiniMax is unavailable (HTTP ${status})`);
  return new Error(`MiniMax returned HTTP ${status}${detail ? `: ${redact(detail, apiKey)}` : ''}`);
}

function assertNoPayloadError(payload: MinimaxPayload, apiKey: string): void {
  const code = payload.base_resp?.status_code;
  if (code) {
    if (AUTH_STATUS_CODES.has(code)) throw new Error(`MiniMax rejected the API key (status ${code})`);
    if (RATE_LIMIT_STATUS_CODES.has(code)) throw new Error(`MiniMax rate limit reached (status ${code})`);
    throw new Error(`MiniMax error ${code}${payload.base_resp?.status_msg ? `: ${redact(payload.base_resp.status_msg, apiKey)}` : ''}`);
  }
  if (payload.error?.message) throw new Error(`MiniMax error: ${redact(payload.error.message, apiKey)}`);
}

/** One SSE line: the parsed frame, 'done' for [DONE], or null for anything else (comments, blank lines, a malformed frame). */
function parseSseLine(rawLine: string): MinimaxPayload | 'done' | null {
  const line = rawLine.replace(/\r$/, '');
  if (!line.startsWith('data:')) return null;
  const data = line.slice('data:'.length).trim();
  if (data === '[DONE]') return 'done';
  if (!data) return null;
  try {
    return JSON.parse(data) as MinimaxPayload;
  } catch {
    return null; // a malformed frame is skipped, the stream goes on
  }
}

async function* readSsePayloads(body: ReadableStream<Uint8Array>): AsyncGenerator<MinimaxPayload> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        // The last frame may come without a trailing newline.
        buffer += decoder.decode();
        const last = parseSseLine(buffer);
        if (last && last !== 'done') yield last;
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        const parsed = parseSseLine(line);
        if (parsed === 'done') return;
        if (parsed) yield parsed;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

interface MinimaxMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
}

interface AccumulatedToolCall {
  id: string;
  name: string;
  args: string;
}

/** The last non-empty line of the reasoning, for a model that stopped with its answer inside it. */
function answerFromReasoning(reasoning: string): string {
  return reasoning.split('\n').map((line) => line.trim()).filter(Boolean).at(-1) ?? '';
}

export function createMinimaxChatModel(options: { apiKey: string; modelId: string; seed: ChatModelSeed }): ChatModel {
  const { apiKey, seed } = options;
  const { model, thinking } = parseMinimaxModel(options.modelId);
  const baseUrl = minimaxBaseUrl();
  const tools = seed.tools.map((tool) => ({
    type: 'function' as const,
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }));
  const messages: MinimaxMessage[] = [
    { role: 'system', content: [seed.system.stable, seed.system.volatile].filter(Boolean).join('\n\n') },
    ...seed.history.map((row) => ({ role: row.role, content: row.content })),
    { role: 'user', content: seed.userMessage },
  ];

  const streamTurn = async ({ toolsEnabled, signal, onDelta }: ChatTurnRequest): Promise<ChatTurnResult> => {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        reasoning_split: true,
        thinking: { type: thinking ? 'enabled' : 'disabled' },
        ...(toolsEnabled && tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
      }),
      signal,
    });
    if (!response.ok) throw statusError(response.status, await response.text().catch(() => ''), apiKey);
    if (!response.body) throw new Error('MiniMax returned an empty body');

    const filter = createMinimaxStreamFilter();
    let visible = '';
    let reasoning = '';
    let finishReason: string | null = null;
    let usage: ChatUsage | undefined;
    const calls = new Map<number, AccumulatedToolCall>();
    const showText = (text: string): void => {
      if (!text) return;
      visible += text;
      onDelta({ type: 'text', text });
    };
    const showReasoning = (text: string): void => {
      if (!text) return;
      reasoning += text;
      onDelta({ type: 'thinking', text });
    };
    const emitToolArgs = (call: AccumulatedToolCall): ChatDelta => ({ type: 'tool-args', callId: call.id || null, name: call.name, args: call.args });

    for await (const payload of readSsePayloads(response.body)) {
      assertNoPayloadError(payload, apiKey);
      if (payload.usage) {
        usage = {
          inputTokens: payload.usage.prompt_tokens ?? 0,
          outputTokens: payload.usage.completion_tokens ?? 0,
          cacheReadTokens: payload.usage.prompt_tokens_details?.cached_tokens ?? 0,
        };
      }
      const choice = payload.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta;
      if (delta?.reasoning_content) showReasoning(delta.reasoning_content);
      if (delta?.content) {
        const split = filter.push(delta.content);
        showReasoning(split.reasoning);
        showText(split.text);
      }
      for (const fragment of delta?.tool_calls ?? []) {
        const index = fragment.index ?? calls.size;
        const call = calls.get(index) ?? { id: '', name: '', args: '' };
        if (fragment.id) call.id = fragment.id;
        if (fragment.function?.name) call.name = fragment.function.name;
        if (fragment.function?.arguments) call.args += fragment.function.arguments;
        calls.set(index, call);
        if (call.name) onDelta(emitToolArgs(call));
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
    showText(filter.flush());

    // A stream that just stops (a dropped connection) is not a finished answer.
    if (!finishReason) throw new Error('MiniMax ended the response before it was complete');
    if (finishReason === 'length') return { stop: 'max_tokens', toolCalls: [], usage };
    if (finishReason === 'content_filter') return { stop: 'refusal', toolCalls: [], usage };

    const ordered = [...calls.entries()].sort(([left], [right]) => left - right).map(([, call]) => call).filter((call) => call.name);
    if (ordered.length === 0) {
      if (!visible) showText(answerFromReasoning(reasoning));
      return { stop: 'end', toolCalls: [], usage };
    }

    const toolCalls: ChatToolCall[] = ordered.map((call, index) => {
      const id = call.id || `call_${index}`;
      call.id = id;
      if (!call.args.trim()) return { id, name: call.name, input: {} };
      try {
        return { id, name: call.name, input: JSON.parse(call.args) as unknown };
      } catch {
        return { id, name: call.name, input: {}, invalid: JSON.stringify({ INVALID_JSON: call.args.slice(0, 2_000) }) };
      }
    });
    messages.push({
      role: 'assistant',
      content: visible,
      tool_calls: ordered.map((call, index) => ({
        id: call.id,
        type: 'function',
        // Arguments that could not be parsed go back as an empty object: the error result says what was wrong.
        function: { name: call.name, arguments: toolCalls[index]?.invalid ? '{}' : call.args || '{}' },
      })),
    });
    return { stop: 'tool_calls', toolCalls, usage };
  };

  return {
    streamTurn,
    addToolResults(results: ChatToolResult[], notice?: string) {
      for (const result of results) messages.push({ role: 'tool', tool_call_id: result.callId, content: result.content });
      if (notice) messages.push({ role: 'user', content: notice });
    },
  };
}

/** A one-token request: the only check that proves the key reaches the model on every account type. */
export async function verifyMinimaxKey(apiKey: string): Promise<ProviderKeyVerdict> {
  try {
    const response = await fetch(`${minimaxBaseUrl()}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: VERIFY_MODEL, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) return 'rejected';
    if (response.status === 429) return 'ok';
    if (!response.ok) return 'unavailable';
    const payload = (await response.json().catch(() => ({}))) as MinimaxPayload;
    const code = payload.base_resp?.status_code;
    if (code && AUTH_STATUS_CODES.has(code)) return 'rejected';
    if (code && !RATE_LIMIT_STATUS_CODES.has(code)) return 'unavailable';
    return 'ok';
  } catch {
    return 'unavailable';
  }
}
