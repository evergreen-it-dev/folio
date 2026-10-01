/** Trailing-edge debounce with cancel/flush. Framework-free so it can be unit-tested. */
export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  cancel(): void;
  flush(): void;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: A | null = null;

  const run = () => {
    timer = null;
    const args = pending;
    pending = null;
    if (args) fn(...args);
  };

  const debounced = ((...args: A) => {
    pending = args;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(run, ms);
  }) as Debounced<A>;

  debounced.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending = null;
  };

  debounced.flush = () => {
    if (timer === null) return;
    clearTimeout(timer);
    run();
  };

  return debounced;
}
