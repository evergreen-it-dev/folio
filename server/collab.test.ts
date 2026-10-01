import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDebouncedWriter } from './collab.js';

describe('createDebouncedWriter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('collapses repeated schedule() calls into a single run after the debounce window', async () => {
    let calls = 0;
    const writer = createDebouncedWriter(() => {
      calls++;
    }, 800);

    writer.schedule();
    vi.advanceTimersByTime(300);
    writer.schedule(); // each call resets the timer
    vi.advanceTimersByTime(300);
    writer.schedule();
    vi.advanceTimersByTime(799);
    expect(calls).toBe(0); // still within the window since the last schedule()

    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(1);
  });

  it('flush() cancels the pending timer and runs immediately, without a later double-fire', async () => {
    let calls = 0;
    const writer = createDebouncedWriter(() => {
      calls++;
    }, 800);

    writer.schedule();
    await writer.flush();
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(1); // the original timer must not have survived flush()
  });

  it('flush() with nothing scheduled still runs the writer once', async () => {
    let calls = 0;
    const writer = createDebouncedWriter(() => {
      calls++;
    }, 800);

    await writer.flush();
    expect(calls).toBe(1);
  });

  it('awaits an async writer function', async () => {
    const order: string[] = [];
    const writer = createDebouncedWriter(async () => {
      order.push('start');
      await Promise.resolve();
      order.push('end');
    }, 100);

    await writer.flush();
    expect(order).toEqual(['start', 'end']);
  });
});
