import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeAllWarmSlots, startWarmSlot, takeWarmSlot, warmEnabled, warmSlotCount, type WarmResource } from './warmSlots.js';

function resource(closed: string[], name: string): WarmResource {
  return { close: async () => void closed.push(name) };
}

describe('warm slots', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.ASSISTANT_WARM_TTL_MS = '1000';
    process.env.ASSISTANT_WARM_MAX = '2';
  });
  afterEach(async () => {
    await closeAllWarmSlots();
    vi.useRealTimers();
    delete process.env.ASSISTANT_WARM_TTL_MS;
    delete process.env.ASSISTANT_WARM_MAX;
    delete process.env.ASSISTANT_WARM;
  });

  it('closes a slot nobody took when the TTL expires', async () => {
    const closed: string[] = [];
    startWarmSlot('u:a', 'fp', async () => resource(closed, 'a'));
    await vi.advanceTimersByTimeAsync(999);
    expect(closed).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(closed).toEqual(['a']);
    expect(warmSlotCount()).toBe(0);
  });

  it('is idempotent for an equal fingerprint and replaces (closing the old one) for another', async () => {
    const closed: string[] = [];
    expect(startWarmSlot('u:a', 'fp1', async () => resource(closed, 'first'))).toBe(true);
    expect(startWarmSlot('u:a', 'fp1', async () => resource(closed, 'dup'))).toBe(false);
    expect(startWarmSlot('u:a', 'fp2', async () => resource(closed, 'second'))).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toEqual(['first']);
    expect(warmSlotCount()).toBe(1);
  });

  it('caps the number of slots and evicts (and closes) the oldest', async () => {
    const closed: string[] = [];
    startWarmSlot('u:1', 'f', async () => resource(closed, '1'));
    startWarmSlot('u:2', 'f', async () => resource(closed, '2'));
    startWarmSlot('u:3', 'f', async () => resource(closed, '3'));
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toEqual(['1']);
    expect(warmSlotCount()).toBe(2);
  });

  it('hands a slot to exactly one taker and stops its TTL timer', async () => {
    const closed: string[] = [];
    startWarmSlot('u:a', 'fp', async () => resource(closed, 'a'));
    const first = takeWarmSlot('u:a');
    const second = takeWarmSlot('u:a');
    expect(first?.fingerprint).toBe('fp');
    expect(second).toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    expect(closed).toEqual([]);
  });

  it('a failed warm-up leaves no slot and never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    startWarmSlot('u:a', 'fp', async () => {
      throw new Error('boom');
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(warmSlotCount()).toBe(0);
    warn.mockRestore();
  });

  it('ASSISTANT_WARM is on unless 0 or false', () => {
    expect(warmEnabled()).toBe(true);
    for (const off of ['0', 'false', 'FALSE']) {
      process.env.ASSISTANT_WARM = off;
      expect(warmEnabled()).toBe(false);
    }
    process.env.ASSISTANT_WARM = '1';
    expect(warmEnabled()).toBe(true);
  });
});
