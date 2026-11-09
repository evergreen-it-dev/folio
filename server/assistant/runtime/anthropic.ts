/**
 * Claude through the Anthropic API, billed to the stored API key.
 *
 * The client is always built with that key and `authToken: null`: the SDK then
 * reads no ambient credential (ANTHROPIC_AUTH_TOKEN, an `ant` profile), which is
 * the guarantee that a run is API billing and can never ride on a subscription.
 *
 * The transcript is append-only: `response.content` goes back as received, and
 * all tool results of a turn go in one user message. The one documented
 * exception is `echoableContent` below.
 */
import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaContentBlock,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaTextBlockParam,
  BetaTool,
  BetaToolUseBlock,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { AssistantRunMode } from '../../../shared/contracts.js';
import type { ChatModel, ChatModelSeed, ChatToolCall, ChatToolResult, ChatTurnRequest, ChatTurnResult, ChatUsage } from './agentLoop.js';
import type { ProviderKeyVerdict } from './common.js';

const MAX_TOKENS = 64_000;
const VERIFY_TIMEOUT_MS = 20_000;
/** Consecutive re-issues of a turn whose tool arguments the SDK could not parse at all. */
const MAX_UNPARSEABLE_RETRIES = 2;
/** The server-side retry of a declined request. Claude Haiku 5.5 has no fallback model. */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const FALLBACK_MODELS: ReadonlySet<string> = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

function createClient(apiKey: string, extra: { maxRetries?: number; timeout?: number } = {}): Anthropic {
  return new Anthropic({ apiKey, authToken: null, ...extra });
}

function isUnparseableToolInput(error: unknown): boolean {
  return error instanceof Anthropic.AnthropicError && !(error instanceof Anthropic.APIError) && /Unable to parse tool parameter JSON/i.test(error.message);
}

/** Errors worded for `ai_runs.error` and the log. Cancelled requests pass through: the loop reports those itself. */
function mapAnthropicError(error: unknown): unknown {
  if (error instanceof Anthropic.APIUserAbortError) return error;
  if (error instanceof Anthropic.AuthenticationError) return new Error('Anthropic rejected the API key (HTTP 401)');
  if (error instanceof Anthropic.PermissionDeniedError) return new Error('Anthropic: this API key has no access to the model (HTTP 403)');
  if (error instanceof Anthropic.NotFoundError) return new Error('Anthropic: the model was not found (HTTP 404)');
  if (error instanceof Anthropic.RateLimitError) return new Error('Anthropic rate limit reached (HTTP 429)');
  if (error instanceof Anthropic.BadRequestError) return new Error(`Anthropic rejected the request (HTTP 400): ${error.message.slice(0, 500)}`);
  if (error instanceof Anthropic.InternalServerError) return new Error(`Anthropic is unavailable (HTTP ${error.status})`);
  if (error instanceof Anthropic.APIConnectionError) return new Error('Could not reach the Anthropic API');
  if (error instanceof Anthropic.APIError) return new Error(`Anthropic returned HTTP ${error.status ?? 'error'}`);
  return error;
}

/**
 * After a fallback that happened in the middle of the output, the API wants
 * the partial turn back without the declined model's thinking and tool calls:
 * everything before the last `fallback` block except text. Without a fallback
 * block the content goes back exactly as received.
 */
export function echoableContent(content: BetaContentBlock[]): BetaContentBlock[] {
  const boundary = content.map((block) => block.type as string).lastIndexOf('fallback');
  if (boundary < 0) return content;
  return content.filter((block, index) => index > boundary || block.type === 'text');
}

function usageOf(usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number | null; cache_read_input_tokens: number | null }): ChatUsage {
  return {
    inputTokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0),
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
  };
}

/** The strict reading of the arguments as they were streamed. The SDK's own parser is tolerant, so its object can be a silently truncated one. */
function toolCallFrom(block: BetaToolUseBlock, raw: string | undefined): ChatToolCall {
  if (raw === undefined || !raw.trim()) return { id: block.id, name: block.name, input: block.input };
  try {
    return { id: block.id, name: block.name, input: JSON.parse(raw) as unknown };
  } catch {
    return { id: block.id, name: block.name, input: {}, invalid: JSON.stringify({ INVALID_JSON: raw.slice(0, 2_000) }) };
  }
}

export function createAnthropicChatModel(options: { apiKey: string; modelId: string; runMode: AssistantRunMode; seed: ChatModelSeed }): ChatModel {
  const { modelId, runMode, seed } = options;
  const client = createClient(options.apiKey);
  // Order matters for the prompt cache: tools (sorted), then the stable system
  // text with the breakpoint, then what changes from run to run.
  const system: BetaTextBlockParam[] = [
    { type: 'text', text: seed.system.stable, cache_control: { type: 'ephemeral' } },
    ...(seed.system.volatile ? [{ type: 'text' as const, text: seed.system.volatile }] : []),
  ];
  const tools: BetaTool[] = seed.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as unknown as BetaTool.InputSchema,
    eager_input_streaming: true,
  }));
  const messages: BetaMessageParam[] = [
    ...seed.history.map((row) => ({ role: row.role, content: row.content })),
    { role: 'user', content: seed.userMessage },
  ];
  const withFallback = FALLBACK_MODELS.has(modelId);

  const attemptTurn = async ({ toolsEnabled, signal, onDelta }: ChatTurnRequest): Promise<ChatTurnResult> => {
    const params: BetaMessageStreamParams = {
      model: modelId,
      max_tokens: MAX_TOKENS,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: runMode === 'ask' ? 'medium' : 'high' },
      system,
      tools,
      tool_choice: { type: toolsEnabled ? 'auto' : 'none' },
      messages,
      // A second breakpoint that follows the growing tail of the tool loop.
      cache_control: { type: 'ephemeral' },
      ...(withFallback ? { fallbacks: 'default' as const, betas: [FALLBACK_BETA] } : {}),
    };
    const stream = client.beta.messages.stream(params, { signal });
    const toolArgs = new Map<number, string>();
    const toolBlocks = new Map<number, { id: string; name: string }>();
    for await (const event of stream) {
      if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
        toolBlocks.set(event.index, { id: event.content_block.id, name: event.content_block.name });
        onDelta({ type: 'tool-args', callId: event.content_block.id, name: event.content_block.name, args: '' });
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          onDelta({ type: 'text', text: event.delta.text });
        } else if (event.delta.type === 'thinking_delta') {
          onDelta({ type: 'thinking', text: event.delta.thinking });
        } else if (event.delta.type === 'input_json_delta') {
          const args = (toolArgs.get(event.index) ?? '') + event.delta.partial_json;
          toolArgs.set(event.index, args);
          const block = toolBlocks.get(event.index);
          if (block) onDelta({ type: 'tool-args', callId: block.id, name: block.name, args });
        }
      }
    }
    const message = await stream.finalMessage();
    const usage = usageOf(message.usage);
    switch (message.stop_reason) {
      case 'refusal':
        return { stop: 'refusal', toolCalls: [], usage };
      case 'max_tokens':
      case 'model_context_window_exceeded':
        return { stop: 'max_tokens', toolCalls: [], usage };
      case 'pause_turn':
        messages.push({ role: 'assistant', content: echoableContent(message.content) });
        return { stop: 'pause', toolCalls: [], usage };
      case 'tool_use': {
        const rawByBlock = new Map<BetaContentBlock, string | undefined>(message.content.map((block, index) => [block, toolArgs.get(index)]));
        const content = echoableContent(message.content);
        messages.push({ role: 'assistant', content });
        const toolCalls = content.filter((block): block is BetaToolUseBlock => block.type === 'tool_use').map((block) => toolCallFrom(block, rawByBlock.get(block)));
        return { stop: 'tool_calls', toolCalls, usage };
      }
      default:
        return { stop: 'end', toolCalls: [], usage };
    }
  };

  return {
    async streamTurn(request) {
      // Text already shown from an attempt that died on an unparseable tool call: the re-issued turn usually opens with the same text.
      let shown = '';
      for (let attempt = 0; ; attempt += 1) {
        let seen = '';
        let diverged = false;
        const onDelta: ChatTurnRequest['onDelta'] = (delta) => {
          if (delta.type !== 'text') return request.onDelta(delta);
          seen += delta.text;
          if (shown === '' || diverged) return request.onDelta(delta);
          // Still repeating what was shown: stay quiet; the first text beyond it (or a different text) goes out.
          if (shown.startsWith(seen)) return undefined;
          if (seen.startsWith(shown)) {
            diverged = true;
            return request.onDelta({ type: 'text', text: seen.slice(shown.length) });
          }
          diverged = true;
          return request.onDelta({ type: 'text', text: seen });
        };
        try {
          const result = await attemptTurn({ ...request, onDelta });
          return result;
        } catch (error) {
          if (!isUnparseableToolInput(error)) throw mapAnthropicError(error);
          if (seen.length > shown.length || !shown.startsWith(seen)) shown = seen.startsWith(shown) ? seen : shown + seen;
          // The block never completed, so there is no tool_use id to answer: the turn is issued again.
          if (attempt >= MAX_UNPARSEABLE_RETRIES) throw new Error('Claude repeatedly produced tool arguments that could not be parsed');
        }
      }
    },
    addToolResults(results: ChatToolResult[], notice?: string) {
      messages.push({
        role: 'user',
        content: [
          ...results.map((result) => ({ type: 'tool_result' as const, tool_use_id: result.callId, content: result.content, ...(result.isError ? { is_error: true } : {}) })),
          ...(notice ? [{ type: 'text' as const, text: notice }] : []),
        ],
      });
    },
  };
}

export async function verifyAnthropicKey(apiKey: string): Promise<ProviderKeyVerdict> {
  try {
    await createClient(apiKey, { maxRetries: 1, timeout: VERIFY_TIMEOUT_MS }).models.list({ limit: 1 });
    return 'ok';
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) return 'rejected';
    return 'unavailable';
  }
}
