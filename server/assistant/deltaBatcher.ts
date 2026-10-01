/**
 * Coalesces an assistant run's `onTextDelta` calls into ~50–100ms frames
 * before they become NDJSON events (owner report, 22.09.2026: "it writes
 * literally one letter at a time").
 *
 * PROVEN cause (see runs.test.ts's coalescing test, and the report): the
 * Cursor SDK's own `onDelta` fires once per token — often a handful of
 * characters — and runs.ts used to call `emit()` for EVERY one of those,
 * which in turn made routes.ts do one `reply.raw.write()` (one TCP chunk)
 * per token, and the client turn each into its own `setStreamText` call —
 * i.e. a full React re-render per token. For a ~1000-character reply at a
 * typical few-dozen-ms-per-token cadence that's 150-300+ writes/renders
 * instead of the ~10-20 a human eye actually needs to see "smooth".
 *
 * This batcher sits between onTextDelta and runs.ts's emit(): text is
 * buffered and flushed on a timer, so many small deltas become one bigger
 * one. `flush()` is exposed so callers can force out whatever's pending
 * before a non-delta event (status/tool) or the run's terminal event, so
 * ordering is never scrambled and no trailing text is ever dropped.
 *
 * Takes an injectable `schedule`/`cancel` pair (defaulting to
 * `setTimeout`/`clearTimeout`) purely so this is unit-testable without real
 * timers — a test can pass a fake scheduler and flush deterministically.
 */
export interface DeltaBatcher {
  /** Appends text to the pending buffer; schedules a flush if none is pending yet. */
  push(text: string): void;
  /** Flushes any pending text NOW (synchronously calls onFlush if there's something buffered). Safe to call with nothing pending (no-op). */
  flush(): void;
  /** Cancels any pending timer and drops the buffer without flushing — for a run that's being torn down mid-batch (e.g. cancelled before its idle timer fires). */
  dispose(): void;
}

export interface DeltaBatcherOptions {
  /** How long to wait after the FIRST buffered chunk before flushing — the "frame" length. */
  intervalMs: number;
  onFlush: (text: string) => void;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export function createDeltaBatcher({
  intervalMs,
  onFlush,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
}: DeltaBatcherOptions): DeltaBatcher {
  let buffer = '';
  let timer: unknown = null;

  function flush(): void {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
    if (buffer.length === 0) return;
    const text = buffer;
    buffer = '';
    onFlush(text);
  }

  function push(text: string): void {
    if (text.length === 0) return;
    buffer += text;
    // Timer already pending: this chunk rides along with whatever flushes next
    // (the frame's length is measured from the FIRST chunk in it, not reset
    // per chunk — otherwise a fast steady stream would never flush at all).
    if (timer === null) {
      timer = schedule(() => {
        timer = null;
        flush();
      }, intervalMs);
    }
  }

  function dispose(): void {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
    buffer = '';
  }

  return { push, flush, dispose };
}
