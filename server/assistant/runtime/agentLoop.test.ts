/** The provider-neutral loop against a scripted model: no network, no database. */
import type { SDKCustomTool } from '@cursor/sdk';
import { describe, expect, it, vi } from 'vitest';
import type { SdkUpdateLike } from '../genProgress.js';
import { MAX_MODEL_TURNS, runAgentLoop, TOOL_RESULT_BUDGET_CHARS, TOOL_RESULT_MAX_CHARS, validateToolInput, type ChatModel, type ChatToolResult, type ChatTurnRequest, type ChatTurnResult } from './agentLoop.js';
import { AssistantRunCancelledError } from './common.js';
import { buildReplayHistory, REPLAY_MAX_MESSAGES } from './history.js';

type Step = (request: ChatTurnRequest) => ChatTurnResult | Promise<ChatTurnResult>;

function scriptedModel(steps: Step[], fallback?: Step): ChatModel & { requests: ChatTurnRequest[]; added: Array<{ results: ChatToolResult[]; notice?: string }> } {
  const requests: ChatTurnRequest[] = [];
  const added: Array<{ results: ChatToolResult[]; notice?: string }> = [];
  return {
    requests,
    added,
    async streamTurn(request) {
      const step = steps[requests.length] ?? fallback;
      requests.push(request);
      if (!step) throw new Error('script exhausted');
      return step(request);
    },
    addToolResults(results, notice) {
      added.push({ results, notice });
    },
  };
}

const textTurn = (text: string): Step => ({ onDelta }) => {
  onDelta({ type: 'text', text });
  return { stop: 'end', toolCalls: [], usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 1 } };
};
const toolTurn = (...names: string[]): Step => () => ({
  stop: 'tool_calls',
  toolCalls: names.map((name, index) => ({ id: `call-${index}`, name, input: { value: index } })),
});
const tool = (execute: SDKCustomTool['execute'], inputSchema?: SDKCustomTool['inputSchema']): SDKCustomTool => ({ description: 'a tool', inputSchema, execute });

describe('runAgentLoop', () => {
  it('runs a tool round trip and reports it in the Cursor update vocabulary', async () => {
    const execute = vi.fn(async () => 'tool output');
    const model = scriptedModel([
      ({ onDelta }) => {
        onDelta({ type: 'thinking', text: 'hmm' });
        onDelta({ type: 'tool-args', callId: 'call-0', name: 'read_page', args: '{"val' });
        return toolTurn('read_page')({ toolsEnabled: true, signal: new AbortController().signal, onDelta });
      },
      textTurn('Done.'),
    ]);
    const updates: SdkUpdateLike[] = [];
    const tools: string[] = [];
    const deltas: string[] = [];
    const milestones: string[] = [];

    const reply = await runAgentLoop({
      model,
      tools: { read_page: tool(execute) },
      runMode: 'ask',
      onUpdate: (update) => updates.push(update),
      onTool: (name) => tools.push(name),
      onTextDelta: (text) => deltas.push(text),
      onMilestone: (milestone) => milestones.push(milestone),
    });

    expect(reply).toBe('Done.');
    expect(execute).toHaveBeenCalledWith({ value: 0 }, { toolCallId: 'call-0' });
    expect(model.added).toEqual([{ results: [{ callId: 'call-0', content: 'tool output', isError: false }], notice: undefined }]);
    expect(tools).toEqual(['read_page']);
    expect(deltas).toEqual(['Done.']);
    expect(milestones).toEqual(['sent']);
    expect(updates.map((update) => update.type)).toEqual([
      'step-started', 'thinking-delta', 'partial-tool-call', 'tool-call-started', 'tool-call-completed', 'step-started', 'text-delta', 'turn-ended',
    ]);
    expect(updates.at(-1)).toEqual({ type: 'turn-ended', usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 1 } });
  });

  it('runs the tools of one turn concurrently and keeps their results in call order', async () => {
    let releaseFirst!: () => void;
    const secondStarted = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const model = scriptedModel([toolTurn('slow', 'fast'), textTurn('ok')]);
    await runAgentLoop({
      model,
      runMode: 'agent',
      tools: {
        // Finishes only after the second tool has started: sequential execution would deadlock here.
        slow: tool(async () => { await secondStarted; return 'slow result'; }),
        fast: tool(async () => { releaseFirst(); return 'fast result'; }),
      },
      idleTimeoutMs: 2_000,
    });
    expect(model.added[0]!.results.map((result) => result.content)).toEqual(['slow result', 'fast result']);
  });

  it('turns an abort during a model turn into AssistantRunCancelledError', async () => {
    const controller = new AbortController();
    const model = scriptedModel([
      ({ signal }) => new Promise<ChatTurnResult>((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('fetch aborted')));
        queueMicrotask(() => controller.abort());
      }),
    ]);
    await expect(runAgentLoop({ model, tools: {}, runMode: 'ask', signal: controller.signal })).rejects.toBeInstanceOf(AssistantRunCancelledError);
  });

  it('fails a run that stays silent past the idle deadline', async () => {
    const model = scriptedModel([() => new Promise<ChatTurnResult>(() => undefined)]);
    await expect(runAgentLoop({ model, tools: {}, runMode: 'ask', idleTimeoutMs: 20 })).rejects.toThrow(/idle for 20 ms/);
  });

  it('after the turn limit makes one final request without tools', async () => {
    const model = scriptedModel([], (request) => (request.toolsEnabled ? toolTurn('search')(request) : textTurn('Best effort answer.')(request)));
    const reply = await runAgentLoop({ model, tools: { search: tool(async () => 'found') }, runMode: 'ask' });
    expect(reply).toBe('Best effort answer.');
    expect(model.requests).toHaveLength(MAX_MODEL_TURNS.ask + 1);
    expect(model.requests.slice(0, -1).every((request) => request.toolsEnabled)).toBe(true);
    expect(model.requests.at(-1)!.toolsEnabled).toBe(false);
    expect(model.added.at(-1)!.notice).toMatch(/limit/i);
    expect(model.added.at(-2)!.notice).toBeUndefined();
  });

  it('caps one result, then the cumulative budget, and stops offering tools once it is spent', async () => {
    const count = Math.ceil(TOOL_RESULT_BUDGET_CHARS / TOOL_RESULT_MAX_CHARS) + 1;
    const model = scriptedModel([toolTurn(...Array.from({ length: count }, () => 'big')), textTurn('Enough.')]);
    await runAgentLoop({ model, tools: { big: tool(async () => 'x'.repeat(TOOL_RESULT_MAX_CHARS * 2)) }, runMode: 'agent', idleTimeoutMs: 5_000 });
    const contents = model.added[0]!.results.map((result) => result.content);
    expect(contents[0]!.length).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS);
    expect(contents[0]).toMatch(/\[Truncated:/);
    expect(contents.at(-1)).toMatch(/\[Omitted:/);
    expect(model.requests.at(-1)!.toolsEnabled).toBe(false);
  });

  it('never runs a tool whose arguments are broken or fail the schema', async () => {
    const execute = vi.fn(async () => 'ran');
    const model = scriptedModel([
      () => ({
        stop: 'tool_calls',
        toolCalls: [
          { id: 'a', name: 'strict', input: {}, invalid: '{"INVALID_JSON":"{oops"}' },
          { id: 'b', name: 'strict', input: { other: 1 } },
          { id: 'c', name: 'missing_tool', input: {} },
        ],
      }),
      textTurn('ok'),
    ]);
    await runAgentLoop({ model, tools: { strict: tool(execute, { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }) }, runMode: 'agent' });
    expect(execute).not.toHaveBeenCalled();
    expect(model.added[0]!.results.every((result) => result.isError)).toBe(true);
    expect(model.added[0]!.results[1]!.content).toContain('input.path is required');
  });

  it('does not run tools after max_tokens and ends with a clear message on a refusal', async () => {
    const execute = vi.fn(async () => 'ran');
    const truncated = scriptedModel([() => ({ stop: 'max_tokens', toolCalls: [{ id: 'a', name: 'edit', input: {} }] })]);
    await expect(runAgentLoop({ model: truncated, tools: { edit: tool(execute) }, runMode: 'agent' })).resolves.toMatch(/length limit/);
    expect(execute).not.toHaveBeenCalled();

    const refused = scriptedModel([() => ({ stop: 'refusal', toolCalls: [] })]);
    await expect(runAgentLoop({ model: refused, tools: {}, runMode: 'ask' })).resolves.toMatch(/declined to answer/);
  });
});

describe('validateToolInput', () => {
  it('accepts a matching alternative and reports the first problem otherwise', () => {
    const schema = { type: 'object', properties: { limit: { anyOf: [{ type: 'integer' }, { type: 'null' }] }, tags: { type: 'array', items: { enum: ['a', 'b'] } } } };
    expect(validateToolInput(schema, { limit: null, tags: ['a'] })).toBeNull();
    expect(validateToolInput(schema, { tags: ['c'] })).toContain('input.tags[0]');
  });
});

describe('buildReplayHistory', () => {
  const row = (role: 'user' | 'assistant', content: string) => ({ role, content });

  it('leaves out the message that started the run', () => {
    expect(buildReplayHistory([row('user', 'q1'), row('assistant', 'a1'), row('user', 'current')])).toEqual([row('user', 'q1'), row('assistant', 'a1')]);
  });

  it('keeps the newest messages and always starts with a user message', () => {
    const rows = Array.from({ length: REPLAY_MAX_MESSAGES + 5 }, (_, index) => row(index % 2 ? 'assistant' : 'user', `m${index}`));
    const history = buildReplayHistory([...rows, row('user', 'current')]);
    expect(history.length).toBeLessThanOrEqual(REPLAY_MAX_MESSAGES);
    expect(history.at(-1)!.content).toBe(`m${REPLAY_MAX_MESSAGES + 4}`);
    expect(history[0]!.role).toBe('user');
  });

  it('stops at the character budget from the newest side', () => {
    const big = 'x'.repeat(120_000);
    const history = buildReplayHistory([row('user', 'old'), row('assistant', big), row('user', big), row('assistant', 'newest'), row('user', 'current')]);
    expect(history).toEqual([row('user', big), row('assistant', 'newest')]);
  });
});
