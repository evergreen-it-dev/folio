/**
 * RunManager (runs.ts) — buffer/seq/replay/terminal-close, without touching
 * Cursor: `./cursorRuntime.js`'s `runCursorAssistant` is mocked so the test
 * controls exactly when the "agent" emits a delta and when it finishes,
 * instead of racing a real Cursor SDK call.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AssistantRunEvent } from '../../shared/contracts.js';

// A short ping interval ONLY for this file (runs.ts reads it once at module
// load — see its own comment on PING_INTERVAL_MS) so the ping-is-not-
// buffered assertion doesn't need a real 15s wait or fake timers fighting
// the real DB I/O the rest of this test relies on.
process.env.ASSISTANT_RUN_PING_INTERVAL_MS = '20';
// Same reasoning for the delta-coalescing window (deltaBatcher.ts, wired in
// via runs.ts's DELTA_BATCH_MS) — short enough that this test's waitUntil
// polling (5ms) actually observes a batched flush instead of timing out.
process.env.ASSISTANT_DELTA_BATCH_MS = '20';

interface CapturedRunOptions {
  onRun?: (run: { cancel: () => Promise<void> }) => void;
  onTextDelta?: (text: string) => void;
  onTool?: (name: string) => void;
  onEvent?: (event: unknown) => void;
}

const cursorMock = vi.hoisted(() => {
  let captured: CapturedRunOptions | null = null;
  let resolveRun: ((text: string) => void) | null = null;
  return {
    runCursorAssistant: vi.fn((opts: CapturedRunOptions) => {
      captured = opts;
      opts.onRun?.({ cancel: async () => {} });
      return new Promise<string>((resolve) => {
        resolveRun = resolve;
      });
    }),
    opts: () => captured!,
    resolve: (text: string) => resolveRun?.(text),
  };
});

vi.mock('./cursorRuntime.js', () => ({
  AssistantRunCancelledError: class AssistantRunCancelledError extends Error {},
  runCursorAssistant: cursorMock.runCursorAssistant,
}));

const { setUpTestSchema } = await import('../db/testSchema.js');
const authStore = await import('../auth/store.js');
const assistantStore = await import('./store.js');
const runs = await import('./runs.js');

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('RunManager (server/assistant/runs.ts)', () => {
  let teardownSchema: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });

  afterAll(async () => {
    await teardownSchema?.();
  });

  it('buffers status/delta/terminal events with seq, replays only seq > since, delivers to multiple subscribers, and never buffers ping', async () => {
    const user = await authStore.createUser({
      email: `assistant-runs-${Date.now()}@test.local`,
      name: 'Runs Tester',
      passwordHash: 'x',
      isAdmin: false,
    });
    const conversation = await assistantStore.insertConversation({
      userId: user.id,
      title: 'Test conversation',
      cursorAgentId: `agent-${Date.now()}`,
      model: 'auto',
    });

    const { runId, conversationId } = await runs.startRun({
      user,
      conversation,
      message: 'Hello',
      runMode: 'ask',
      currentPath: null,
      space: null,
      pageId: null,
      apiKey: 'test-key',
    });
    expect(conversationId).toBe(conversation.id);
    expect(cursorMock.runCursorAssistant).toHaveBeenCalledTimes(1);

    // Subscriber A: from the very start — replay gives it the 'starting' status immediately (seq 1).
    const eventsA: AssistantRunEvent[] = [];
    const unsubA = runs.subscribe(runId, 0, (event) => eventsA.push(event));
    expect(unsubA).not.toBeNull();
    expect(eventsA).toEqual([{ type: 'status', status: 'starting', seq: 1 }]);

    // Drive two deltas through the mocked "agent", back-to-back — runs.ts's
    // delta batching (deltaBatcher.ts) coalesces rapid deltas like this into
    // ONE `delta` event instead of two, same as a real token-cadence burst
    // (the "it writes one letter at a time" fix) would.
    cursorMock.opts().onTextDelta?.('Hello, ');
    cursorMock.opts().onTextDelta?.('world!');

    // Subscriber B joins mid-stream with since=1 — must skip the already-seen
    // 'starting' event and get only what came after it. The batched delta
    // hasn't flushed yet at subscribe time (it's on ASSISTANT_DELTA_BATCH_MS's
    // own timer), so it arrives a beat later as a LIVE event, not in the replay.
    const eventsB: AssistantRunEvent[] = [];
    const unsubB = runs.subscribe(runId, 1, (event) => eventsB.push(event));
    expect(unsubB).not.toBeNull();
    await waitUntil(() => eventsB.some((e) => e.type === 'delta'));
    // Filter out 'ping' — this file's short PING_INTERVAL_MS/DELTA_BATCH_MS
    // overrides (both 20ms, for fast waitUntil polling) can legitimately race
    // a ping into this window; pings are asserted separately below.
    expect(eventsB.filter((e) => e.type !== 'ping').map((e) => e.type)).toEqual(['status', 'delta']);
    expect(eventsB.filter((e) => e.type === 'delta').map((e: any) => e.text)).toEqual(['Hello, world!']);

    // Live ping: both current subscribers get it, but it must never land in the buffer.
    await waitUntil(() => eventsA.some((e) => e.type === 'ping') && eventsB.some((e) => e.type === 'ping'));

    // Resolve the "agent" run — RunManager should persist the assistant
    // message, flip status to 'done', and emit exactly one terminal event.
    // Wait for the 'complete' EVENT itself, not run.status flipping —
    // finishDone sets `status = 'done'` before its dbFinishRun await, well
    // before it actually emits `complete` a beat later; polling status alone
    // races (a ping, or the batched delta's own flush, can still be the
    // LAST thing in eventsA/eventsB at that earlier moment).
    cursorMock.resolve('Hello, world!');
    await waitUntil(() => eventsA.some((e) => e.type === 'complete'));

    expect(eventsA.at(-1)).toMatchObject({ type: 'complete', conversationId });
    expect(eventsB.at(-1)).toMatchObject({ type: 'complete', conversationId });
    unsubA?.();
    unsubB?.();

    // Late subscriber, after the run has settled: pure replay of the full
    // buffer (status starting → status writing → delta (batched) → complete),
    // ending in the same terminal event — and, crucially, no 'ping' in it,
    // even though live subscribers above definitely received at least one.
    const eventsC: AssistantRunEvent[] = [];
    const unsubC = runs.subscribe(runId, 0, (event) => eventsC.push(event));
    expect(eventsC.length).toBeGreaterThan(0);
    expect(eventsC.at(-1)).toMatchObject({ type: 'complete', conversationId });
    expect(eventsC.some((e) => e.type === 'ping')).toBe(false);
    // A terminal run's subscribe() is a no-op unsubscribe (nothing live left to detach from).
    expect(unsubC).toBeTruthy();

    // A subscriber asking for events strictly after the last one gets nothing.
    const lastSeq = eventsC.at(-1)!.type === 'ping' ? 0 : (eventsC.at(-1) as { seq: number }).seq;
    const eventsD: AssistantRunEvent[] = [];
    runs.subscribe(runId, lastSeq, (event) => eventsD.push(event));
    expect(eventsD).toEqual([]);
  });

  it('loadTerminalFromDb\'s reconstructed event always beats a reconnecting client\'s `since` — regression for "run finished, but its terminal event was lost across the reconnect"', async () => {
    // Reproduces the prod bug directly: a run that streamed well past seq 1
    // before the caller lost its subscription (e.g. a server restart, or the
    // 15-minute in-memory eviction) — loadTerminalFromDb is the ONLY thing
    // GET /runs/:runId/events has left to answer a reconnect with once
    // `runs.peek()` no longer finds it in memory, and previously stamped
    // that reconstruction with a hardcoded seq: 1. Any client whose `since`
    // was already >= 1 (i.e. almost every real run) then hit routes.ts's
    // `event.seq > since` gate, got a silently empty response instead of the
    // terminal event, and reconnected forever — this asserts the seq it
    // hands back is high enough that no realistic `since` can suppress it.
    const user = await authStore.createUser({
      email: `assistant-runs-historical-${Date.now()}@test.local`,
      name: 'Runs Tester 2',
      passwordHash: 'x',
      isAdmin: false,
    });
    const conversation = await assistantStore.insertConversation({
      userId: user.id,
      title: 'Test conversation 2',
      cursorAgentId: `agent-${Date.now()}-2`,
      model: 'auto',
    });

    const { runId } = await runs.startRun({
      user,
      conversation,
      message: 'Hello',
      runMode: 'ask',
      currentPath: null,
      space: null,
      pageId: null,
      apiKey: 'test-key',
    });

    // Drive several deltas so the run's own live seq climbs well past 1 —
    // exactly the "already saw plenty of real events" case the old hardcoded
    // seq: 1 got wrong.
    const events: AssistantRunEvent[] = [];
    runs.subscribe(runId, 0, (event) => events.push(event));
    cursorMock.opts().onTextDelta?.('One, ');
    cursorMock.opts().onTextDelta?.('two, ');
    cursorMock.opts().onTextDelta?.('three.');
    cursorMock.resolve('One, two, three.');
    // Wait for the terminal event itself (not just run.status flipping in
    // memory) — dbFinishRun's UPDATE only completes right before it's
    // emitted, and loadTerminalFromDb reads that same row straight back out.
    await waitUntil(() => events.some((e) => e.type === 'complete'));

    // loadTerminalFromDb reads straight from `ai_runs`, independent of
    // whether the run is still in the in-memory buffer — same data a
    // reconnect would see after eviction/restart. A client that already had
    // `since` up around the run's real live seq count (>= 5: starting +
    // 3 deltas + writing-status + complete) must still receive this event.
    const historical = await runs.loadTerminalFromDb(runId);
    expect(historical).not.toBeNull();
    expect(historical!.event.type).toBe('complete');
    if (historical!.event.type === 'ping') throw new Error('unreachable: loadTerminalFromDb never returns ping');
    expect(historical!.event.seq).toBeGreaterThan(5);
    // ...and comfortably beyond any real run's seq count, not just this one's.
    expect(historical!.event.seq).toBeGreaterThan(1_000_000);
  });
});
