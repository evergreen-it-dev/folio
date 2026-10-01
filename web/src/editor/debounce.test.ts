import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { debounce } from './debounce';

describe('debounce', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs once, with the last arguments, after the delay', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 300);

    debounced('a');
    debounced('b');
    debounced('c');
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(299);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('c');
  });

  it('restarts the timer on every call', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 300);

    debounced(1);
    vi.advanceTimersByTime(200);
    debounced(2);
    vi.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledWith(2);
  });

  it('drops the pending call when cancelled', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 300);

    debounced('x');
    debounced.cancel();
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('flush runs a pending call immediately and only once', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 300);

    debounced('x');
    debounced.flush();
    expect(fn).toHaveBeenCalledWith('x');

    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('flush is a no-op when nothing is pending', () => {
    const fn = vi.fn();
    debounce(fn, 300).flush();
    expect(fn).not.toHaveBeenCalled();
  });

  it('can be reused after firing', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced('first');
    vi.advanceTimersByTime(100);
    debounced('second');
    vi.advanceTimersByTime(100);

    expect(fn.mock.calls).toEqual([['first'], ['second']]);
  });
});
