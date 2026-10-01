import { describe, expect, it } from 'vitest';
import type { AssistantRunInfo } from '@shared/contracts';
import { heartbeatNeedsResync, isSameRunStillActive } from './runState';

function run(overrides: Partial<AssistantRunInfo> = {}): AssistantRunInfo {
  return {
    runId: 'run-1',
    conversationId: 'conv-1',
    runMode: 'ask',
    status: 'running',
    step: null,
    text: '',
    seq: 3,
    error: null,
    messageId: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    ...overrides,
  };
}

// isSameRunStillActive gates resyncAfterDisconnect's "reattach vs. render
// whatever the server ended up with" decision after a lost subscription
// (runState.tsx) — see its own doc comment for the "hung on Reconnecting…
// forever" bug this replaces.
describe('isSameRunStillActive', () => {
  it('is true for the same run, still running', () => {
    expect(isSameRunStillActive('run-1', run())).toBe(true);
  });

  it('is false when there is no active run at all (finished/cancelled/evicted)', () => {
    expect(isSameRunStillActive('run-1', null)).toBe(false);
  });

  it('is false for a DIFFERENT run — never reattach to the wrong one', () => {
    expect(isSameRunStillActive('run-1', run({ runId: 'run-2' }))).toBe(false);
  });

  it('is false once the run has left the running status, even if still the same id', () => {
    expect(isSameRunStillActive('run-1', run({ status: 'done' }))).toBe(false);
    expect(isSameRunStillActive('run-1', run({ status: 'error' }))).toBe(false);
    expect(isSameRunStillActive('run-1', run({ status: 'cancelled' }))).toBe(false);
  });
});

// Terminal-state guarantee (owner report, 22.09.2026): a SECOND "hangs
// again" report after the same-day loadTerminalFromDb seq fix — a run whose
// terminal event never reached the client even though the connection looked
// healthy (pings kept flowing, nothing ever threw). heartbeatNeedsResync is
// the decision runState.tsx's heartbeat effect polls on a timer, independent
// of the subscription's own health, to guarantee the panel eventually
// reconciles instead of sitting on "Stop" forever — see its own doc comment.
describe('heartbeatNeedsResync — terminal-state guarantee', () => {
  it('does NOT need a resync while the server agrees the same run is still running', () => {
    expect(heartbeatNeedsResync('run-1', run())).toBe(false);
  });

  it('needs a resync once the server says the run finished/errored/cancelled — the exact failure mode reported', () => {
    expect(heartbeatNeedsResync('run-1', run({ status: 'done' }))).toBe(true);
    expect(heartbeatNeedsResync('run-1', run({ status: 'error' }))).toBe(true);
    expect(heartbeatNeedsResync('run-1', run({ status: 'cancelled' }))).toBe(true);
  });

  it('needs a resync when the server has no active run at all (evicted, or genuinely gone)', () => {
    expect(heartbeatNeedsResync('run-1', null)).toBe(true);
  });

  it('needs a resync when the server is running a DIFFERENT run — never mistake someone else\'s progress for ours', () => {
    expect(heartbeatNeedsResync('run-1', run({ runId: 'run-2' }))).toBe(true);
  });
});
