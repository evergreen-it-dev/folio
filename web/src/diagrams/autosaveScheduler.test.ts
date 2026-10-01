import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAutosaveScheduler } from './autosaveScheduler';

afterEach(() => {
  vi.useRealTimers();
});

describe('createAutosaveScheduler', () => {
  it('debounces rapid changes into a single save after the delay elapses', () => {
    vi.useFakeTimers();
    let version = 1;
    const save = vi.fn();
    const scheduler = createAutosaveScheduler({ delayMs: 1500, getVersion: () => version, save });

    version = 2;
    scheduler.notifyChange();
    vi.advanceTimersByTime(1000);
    version = 3;
    scheduler.notifyChange(); // resets the debounce window
    vi.advanceTimersByTime(1000);
    expect(save).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('skips saving entirely when the scene version has not moved since the last save', () => {
    vi.useFakeTimers();
    const version = 5;
    const save = vi.fn();
    const scheduler = createAutosaveScheduler({
      delayMs: 1500,
      getVersion: () => version,
      save,
      initialVersion: 5,
    });

    scheduler.notifyChange(); // same version as initialVersion: no-op
    vi.advanceTimersByTime(2000);
    expect(save).not.toHaveBeenCalled();
  });

  it('cancels a pending save if the version reverts to the last-saved baseline (e.g. undo)', () => {
    vi.useFakeTimers();
    let version = 1;
    const save = vi.fn();
    const scheduler = createAutosaveScheduler({
      delayMs: 1500,
      getVersion: () => version,
      save,
      initialVersion: 1,
    });

    version = 2;
    scheduler.notifyChange();
    version = 1; // undo back to the saved baseline
    scheduler.notifyChange();
    vi.advanceTimersByTime(2000);
    expect(save).not.toHaveBeenCalled();
  });

  it('flush saves immediately when a change is pending and updates the baseline', () => {
    vi.useFakeTimers();
    let version = 1;
    const save = vi.fn();
    const scheduler = createAutosaveScheduler({
      delayMs: 1500,
      getVersion: () => version,
      save,
      initialVersion: 1,
    });

    version = 2;
    scheduler.notifyChange();
    scheduler.flush();
    expect(save).toHaveBeenCalledTimes(1);

    // Nothing new pending: a second flush must not save again.
    scheduler.flush();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('flush is a no-op when nothing has changed', () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const scheduler = createAutosaveScheduler({ delayMs: 1500, getVersion: () => 1, save, initialVersion: 1 });

    scheduler.flush();
    expect(save).not.toHaveBeenCalled();
  });

  it('cancel clears a pending save without invoking it', () => {
    vi.useFakeTimers();
    let version = 1;
    const save = vi.fn();
    const scheduler = createAutosaveScheduler({ delayMs: 1500, getVersion: () => version, save });

    version = 2;
    scheduler.notifyChange();
    scheduler.cancel();
    vi.advanceTimersByTime(3000);
    expect(save).not.toHaveBeenCalled();
  });
});
