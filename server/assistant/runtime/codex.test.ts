// Codex is off by default (providerFlags.ts); these tests are about it switched on. Read at call time.
process.env.FOLIO_CODEX_ENABLED = '1';
/** The Codex runtime against a fake SDK thread: no CLI, no network, no database. */
import type { ThreadEvent } from '@openai/codex-sdk';
import { describe, expect, it, vi } from 'vitest';
import type { SdkUpdateLike } from '../genProgress.js';
import { AssistantRunCancelledError } from './common.js';
import {
  CODEX_AUTH_MESSAGE,
  CODEX_LIMIT_MESSAGE,
  CODEX_UNAVAILABLE_MESSAGE,
  buildCodexConfig,
  buildCodexPrompt,
  buildCodexThreadOptions,
  codexModelArg,
  createRunGuard,
  driveCodexThread,
  mapCodexError,
  type CodexThreadLike,
} from './codex.js';

const usage = { input_tokens: 1000, cached_input_tokens: 400, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 10 };
const message = (id: string, text: string, kind: ThreadEvent['type'] = 'item.updated'): ThreadEvent => ({ type: kind as 'item.updated', item: { id, type: 'agent_message', text } });

function threadOf(events: ThreadEvent[] | (() => AsyncGenerator<ThreadEvent>)): CodexThreadLike & { returned: boolean; signal?: AbortSignal; prompts: string[] } {
  const thread = {
    returned: false,
    prompts: [] as string[],
    signal: undefined as AbortSignal | undefined,
    async runStreamed(prompt: string, options?: { signal?: AbortSignal }) {
      thread.prompts.push(prompt);
      thread.signal = options?.signal;
      const source = typeof events === 'function' ? events() : (async function* () { yield* events; })();
      const wrapped: AsyncGenerator<ThreadEvent> = {
        next: () => source.next(),
        return: async (value?: unknown) => { thread.returned = true; return source.return(value as never); },
        throw: (error?: unknown) => source.throw(error),
        [Symbol.asyncIterator]() { return wrapped; },
      } as AsyncGenerator<ThreadEvent>;
      return { events: wrapped };
    },
  };
  return thread;
}

function run(events: ThreadEvent[] | (() => AsyncGenerator<ThreadEvent>), options: { signal?: AbortSignal; secrets?: string[]; totalTimeoutMs?: number; idleTimeoutMs?: number } = {}) {
  const updates: SdkUpdateLike[] = [];
  const text: string[] = [];
  const tools: string[] = [];
  const guard = createRunGuard({ signal: options.signal, totalTimeoutMs: options.totalTimeoutMs ?? 5_000, idleTimeoutMs: options.idleTimeoutMs ?? 5_000, runMode: 'ask' });
  const thread = threadOf(events);
  const result = driveCodexThread({
    thread,
    prompt: 'the prompt',
    guard,
    sink: { onTextDelta: (delta) => text.push(delta), onTool: (name) => tools.push(name), onUpdate: (update) => updates.push(update) },
    secrets: options.secrets,
    closeCapMs: 20,
  }).finally(() => guard.dispose());
  return { result, updates, text, tools, thread };
}

describe('driveCodexThread', () => {
  it('turns cumulative text into increments and reports reasoning, tools and usage like the other runtimes', async () => {
    const mcp = (status: 'in_progress' | 'completed') => ({ id: 't1', type: 'mcp_tool_call' as const, server: 'folio', tool: 'search_pages', arguments: {}, status });
    const { result, updates, text, tools } = run([
      { type: 'thread.started', thread_id: 'th' },
      { type: 'turn.started' },
      { type: 'item.updated', item: { id: 'r1', type: 'reasoning', text: 'Think' } },
      { type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: 'Thinking it over' } },
      { type: 'item.started', item: mcp('in_progress') },
      { type: 'item.completed', item: mcp('completed') },
      message('m1', 'Hel', 'item.started'),
      message('m1', 'Hello wor'),
      message('m1', 'Hello world', 'item.completed'),
      message('m2', 'Second.', 'item.completed'),
      { type: 'turn.completed', usage },
    ]);
    expect(await result).toBe('Hello worldSecond.');
    expect(text).toEqual(['Hel', 'lo wor', 'ld', 'Second.']);
    expect(tools).toEqual(['search_pages']);
    expect(updates.map((update) => update.type)).toEqual([
      'step-started', 'thinking-delta', 'thinking-delta', 'tool-call-started', 'tool-call-completed',
      'text-delta', 'text-delta', 'text-delta', 'text-delta', 'turn-ended',
    ]);
    expect(updates.filter((update) => update.type === 'thinking-delta').map((update) => update.text)).toEqual(['Think', 'ing it over']);
    expect(updates.find((update) => update.type === 'tool-call-started')).toMatchObject({ callId: 't1', toolCall: { type: 'mcp', args: { toolName: 'search_pages' } } });
    expect(updates.find((update) => update.type === 'turn-ended')).toMatchObject({ usage: { inputTokens: 600, outputTokens: 50, cacheReadTokens: 400 } });
  });

  it('reports a tool that only ever completes, and ignores shell and file items', async () => {
    const { result, tools, updates } = run([
      { type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'cat auth.json', aggregated_output: '', status: 'failed' } },
      { type: 'item.completed', item: { id: 't9', type: 'mcp_tool_call', server: 'folio', tool: 'list_spaces', arguments: {}, status: 'completed' } },
      message('m1', 'Done.', 'item.completed'),
    ]);
    expect(await result).toBe('Done.');
    expect(tools).toEqual(['list_spaces']);
    expect(updates.map((update) => update.type)).toEqual(['tool-call-started', 'tool-call-completed', 'text-delta']);
  });

  it('fails with a clear sign-in message on an auth error, and a plan-limit message on a quota error', async () => {
    await expect(run([{ type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized: token_expired' } }]).result).rejects.toThrow(CODEX_AUTH_MESSAGE);
    await expect(run([{ type: 'error', message: 'You have hit your usage limit. Try again in 3 hours.' }]).result).rejects.toThrow(CODEX_LIMIT_MESSAGE);
  });

  it('maps an exit of the CLI with a message of the SDK, never leaking the token', async () => {
    const failing = async function* (): AsyncGenerator<ThreadEvent> { throw new Error('Codex Exec exited with code 1: boom run-token-123 eyJhbGciOi.eyJzdWIiOi.c2ln'); };
    const error = await run(failing, { secrets: ['run-token-123'] }).result.catch((e: Error) => e);
    expect((error as Error).message).toBe('Codex failed: Codex Exec exited with code 1: boom [redacted] [redacted]');
  });

  it('keeps a finished answer when a reconnect notice came before turn.completed, but fails on turn.failed or a stream that ends after an error', async () => {
    const reconnect: ThreadEvent = { type: 'error', message: 'Reconnecting... 1/2' };
    await expect(run([{ type: 'turn.started' }, reconnect, message('m1', 'Done.', 'item.completed'), { type: 'turn.completed', usage }]).result).resolves.toBe('Done.');
    await expect(run([reconnect, message('m1', 'Partial', 'item.completed'), { type: 'turn.failed', error: { message: 'boom' } }]).result).rejects.toThrow('Codex failed: boom');
    await expect(run([message('m1', 'Partial', 'item.completed'), reconnect]).result).rejects.toThrow('Reconnecting');
  });

  it('fails on an empty reply', async () => {
    await expect(run([{ type: 'turn.completed', usage }]).result).rejects.toThrow('empty response');
  });

  it('kills the child (closes the stream, aborts the signal) and throws the cancel error when the run is aborted', async () => {
    const controller = new AbortController();
    const hanging = async function* (): AsyncGenerator<ThreadEvent> {
      yield { type: 'turn.started' };
      await new Promise(() => undefined);
    };
    const { result, thread } = run(hanging, { signal: controller.signal });
    await vi.waitFor(() => expect(thread.prompts).toHaveLength(1));
    controller.abort();
    await expect(result).rejects.toBeInstanceOf(AssistantRunCancelledError);
    expect(thread.signal?.aborted).toBe(true);
  });

  it('stops a silent run after the idle deadline', async () => {
    const hanging = async function* (): AsyncGenerator<ThreadEvent> { await new Promise(() => undefined); };
    await expect(run(hanging, { idleTimeoutMs: 30 }).result).rejects.toThrow('idle for 30 ms');
    await expect(run(hanging, { totalTimeoutMs: 30 }).result).rejects.toThrow('timed out after 30 ms');
  });
});

describe('mapCodexError', () => {
  it('names the three cases a user can act on', () => {
    expect(mapCodexError(new Error('Not logged in')).message).toBe(CODEX_AUTH_MESSAGE);
    expect(mapCodexError(new Error('HTTP 429 Too Many Requests')).message).toBe(CODEX_LIMIT_MESSAGE);
    expect(mapCodexError(new Error('spawn /x/codex ENOENT')).message).toBe(CODEX_UNAVAILABLE_MESSAGE);
    expect(mapCodexError(new Error('Unable to locate Codex CLI binaries')).message).toBe(CODEX_UNAVAILABLE_MESSAGE);
  });
});

describe('what the model is given', () => {
  it('has the shell and the other tool families off, the sandbox read-only, no network, no web, an empty directory', () => {
    const config = buildCodexConfig({ url: 'http://127.0.0.1:4870/internal/assistant-run/abc/mcp', toolNames: ['a', 'b'] });
    expect(config.features).toMatchObject({ shell_tool: false, unified_exec: false, apps: false, browser_use: false, computer_use: false, multi_agent: false, plugins: false, view_image: false });
    expect(Object.values(config.features as Record<string, unknown>).every((value) => value === false)).toBe(true);
    expect(config.cli_auth_credentials_store).toBe('file');
    expect(Object.keys(config.mcp_servers as object)).toEqual(['folio']);
    expect(config.mcp_servers).toEqual({
      folio: {
        url: 'http://127.0.0.1:4870/internal/assistant-run/abc/mcp',
        bearer_token_env_var: 'FOLIO_RUN_MCP_TOKEN',
        default_tools_approval_mode: 'approve',
        enabled_tools: ['a', 'b'],
        startup_timeout_sec: 30,
        tool_timeout_sec: 300,
      },
    });
    // The token itself is never part of the config (which is a command line).
    expect(JSON.stringify(config)).not.toMatch(/token":"/);

    expect(buildCodexThreadOptions('/run/work', 'default')).toEqual({
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      networkAccessEnabled: false,
      webSearchMode: 'disabled',
      skipGitRepoCheck: true,
      workingDirectory: '/run/work',
    });
  });

  it('passes no model for `default` and a named model as it is', () => {
    expect(codexModelArg('default')).toBeUndefined();
    expect(codexModelArg('')).toBeUndefined();
    expect(buildCodexThreadOptions('/w', 'default')).not.toHaveProperty('model');
    expect(buildCodexThreadOptions('/w', 'some-model').model).toBe('some-model');
  });

  it('builds the whole prompt of a stateless run from the shared parts and the replayed history', () => {
    expect(buildCodexPrompt({ stable: 'STABLE', volatile: 'VOLATILE' }, [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }], 'Next?')).toBe(
      'STABLE\n\nVOLATILE\n\n## Earlier in this conversation\n\nUser: Hi\n\nAssistant: Hello\n\n---\n\nUser: Next?',
    );
    expect(buildCodexPrompt({ stable: 'S', volatile: 'V' }, [], 'Q')).toBe('S\n\nV\n\n---\n\nUser: Q');
  });
});
