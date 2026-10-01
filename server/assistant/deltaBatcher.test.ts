/**
 * Pure test for the streaming batching/coalescing decision (owner report,
 * 22.09.2026: "it writes one letter at a time"). No timers, no DB, no Fastify — a
 * fake `schedule`/`cancel` pair makes every flush deterministic: a test
 * calls the captured callback itself instead of waiting on a real clock.
 */
import { describe, expect, it } from 'vitest';
import { createDeltaBatcher } from './deltaBatcher.js';

/** A fake scheduler: `schedule` captures the callback instead of arming a real timer; a test fires it by calling `fire()`. Mirrors setTimeout/clearTimeout's shape exactly so createDeltaBatcher doesn't know the difference. */
function fakeScheduler() {
  let pending: { id: number; fn: () => void } | null = null;
  let nextId = 1;
  return {
    schedule: (fn: () => void, _ms: number): unknown => {
      const id = nextId++;
      pending = { id, fn };
      return id;
    },
    cancel: (handle: unknown): void => {
      if (pending && pending.id === handle) pending = null;
    },
    /** Invokes the currently-armed timer callback, as if it fired — throws if nothing is pending (a test bug, not a batcher bug). */
    fire: (): void => {
      if (!pending) throw new Error('fakeScheduler.fire(): no timer armed');
      const { fn } = pending;
      pending = null;
      fn();
    },
    isArmed: (): boolean => pending !== null,
  };
}

describe('createDeltaBatcher', () => {
  it('coalesces several pushes within one frame into a single flush', () => {
    const flushes: string[] = [];
    const { schedule, cancel, fire, isArmed } = fakeScheduler();
    const batcher = createDeltaBatcher({ intervalMs: 75, onFlush: (text) => flushes.push(text), schedule, cancel });

    batcher.push('Hel');
    batcher.push('lo, ');
    batcher.push('world!');
    expect(flushes).toEqual([]); // nothing flushed yet — still inside the frame
    expect(isArmed()).toBe(true);

    fire(); // the frame's timer elapses
    expect(flushes).toEqual(['Hello, world!']); // ONE flush, concatenated — not 3
  });

  it('a push after a flush starts a NEW frame (does not reuse the old timer)', () => {
    const flushes: string[] = [];
    const { schedule, cancel, fire, isArmed } = fakeScheduler();
    const batcher = createDeltaBatcher({ intervalMs: 75, onFlush: (text) => flushes.push(text), schedule, cancel });

    batcher.push('first');
    fire();
    expect(flushes).toEqual(['first']);
    expect(isArmed()).toBe(false);

    batcher.push('second');
    expect(isArmed()).toBe(true);
    fire();
    expect(flushes).toEqual(['first', 'second']);
  });

  it('flush() forces out whatever is pending immediately, without waiting for the timer', () => {
    const flushes: string[] = [];
    const { schedule, cancel, isArmed } = fakeScheduler();
    const batcher = createDeltaBatcher({ intervalMs: 75, onFlush: (text) => flushes.push(text), schedule, cancel });

    batcher.push('urgent');
    batcher.flush();
    expect(flushes).toEqual(['urgent']);
    expect(isArmed()).toBe(false); // the timer that would have fired later is cancelled, not left dangling
  });

  it('flush() with nothing buffered is a no-op (does not call onFlush with an empty string)', () => {
    const flushes: string[] = [];
    const { schedule, cancel } = fakeScheduler();
    const batcher = createDeltaBatcher({ intervalMs: 75, onFlush: (text) => flushes.push(text), schedule, cancel });

    batcher.flush();
    expect(flushes).toEqual([]);
  });

  it('dispose() drops the buffer and cancels the timer WITHOUT flushing', () => {
    const flushes: string[] = [];
    const { schedule, cancel, isArmed } = fakeScheduler();
    const batcher = createDeltaBatcher({ intervalMs: 75, onFlush: (text) => flushes.push(text), schedule, cancel });

    batcher.push('discarded');
    batcher.dispose();
    expect(flushes).toEqual([]);
    expect(isArmed()).toBe(false);

    // A push after dispose starts fresh, same as if the batcher were new.
    batcher.push('kept');
    batcher.flush();
    expect(flushes).toEqual(['kept']);
  });

  it('MEASUREMENT: coalescing cuts a typical per-token stream from ~1 flush/token to ~1 flush per frame', () => {
    // Models the actual "it writes one letter at a time" shape: the Cursor SDK's
    // onDelta fires once per token (avg 4 chars/token here, a realistic
    // token size), and — before this batcher existed — runs.ts's emit()
    // turned EVERY one of those into its own NDJSON write + client re-render.
    const TOTAL_CHARS = 1000;
    const CHARS_PER_TOKEN = 4;
    const TOKEN_COUNT = TOTAL_CHARS / CHARS_PER_TOKEN; // 250 — the BEFORE event/render count
    const INTERVAL_MS = 75;
    const MS_PER_TOKEN = 20; // ~50 tokens/sec, a plausible LLM streaming cadence

    const { schedule, cancel, fire, isArmed } = fakeScheduler();
    const flushes: string[] = [];
    const batcher = createDeltaBatcher({ intervalMs: INTERVAL_MS, onFlush: (text) => flushes.push(text), schedule, cancel });

    // Simulate wall-clock time advancing token by token, firing the fake
    // timer whenever enough simulated time has passed since it was armed.
    let simulatedMs = 0;
    let armedAt = -1;
    for (let i = 0; i < TOKEN_COUNT; i++) {
      batcher.push('a'.repeat(CHARS_PER_TOKEN));
      if (armedAt === -1) armedAt = simulatedMs;
      simulatedMs += MS_PER_TOKEN;
      if (isArmed() && simulatedMs - armedAt >= INTERVAL_MS) {
        fire();
        armedAt = -1;
      }
    }
    batcher.flush(); // trailing partial frame

    const AFTER = flushes.length;
    expect(flushes.join('')).toHaveLength(TOTAL_CHARS); // no text lost or duplicated
    // BEFORE (no batching): 250 emit()/write()/setState calls for this reply.
    // AFTER (75ms frames @ ~20ms/token, ~3-4 tokens/frame): ~60-70 flushes.
    expect(AFTER).toBeLessThan(TOKEN_COUNT / 3); // at least a 3x reduction
    expect(AFTER).toBeGreaterThan(50); // and still frequent enough to look "streamed", not dumped
  });
});
