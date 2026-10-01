/**
 * Debounces board-change bursts into a single save call, and skips saving
 * entirely when the scene "version" hasn't moved since the last save (e.g.
 * the change was viewport pan/zoom or selection-only, which still fires
 * Excalidraw's onChange but doesn't touch element content).
 *
 * Pure — no DOM globals beyond setTimeout/clearTimeout — so it's unit
 * testable with vitest fake timers without a browser/jsdom environment.
 */

export interface AutosaveScheduler {
  /** Call on every scene-change notification (e.g. Excalidraw's onChange). */
  notifyChange(): void;
  /** Save immediately if a change is pending; no-op otherwise. Best-effort unmount hook. */
  flush(): void;
  /** Cancel any pending debounced save without saving. */
  cancel(): void;
}

export interface AutosaveSchedulerOptions {
  /** Debounce delay in ms (spec requires >= 1500). */
  delayMs: number;
  /** Cheap, synchronous read of the current scene version, e.g. getSceneVersion(elements). */
  getVersion: () => number;
  /** Perform the actual save (export + PUT). Errors are the caller's responsibility. */
  save: () => void;
  /** Version to treat as already-saved, e.g. the freshly-loaded scene's version. */
  initialVersion?: number;
}

export function createAutosaveScheduler({
  delayMs,
  getVersion,
  save,
  initialVersion,
}: AutosaveSchedulerOptions): AutosaveScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSavedVersion: number | null = initialVersion ?? null;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function runSave(): void {
    lastSavedVersion = getVersion();
    save();
  }

  function notifyChange(): void {
    const version = getVersion();
    if (version === lastSavedVersion) {
      // Nothing structural changed (or the user undid back to the saved
      // baseline) — drop any pending save instead of writing a no-op.
      clearTimer();
      return;
    }
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      runSave();
    }, delayMs);
  }

  function flush(): void {
    const wasPending = timer !== null;
    clearTimer();
    if (!wasPending) return;
    if (getVersion() === lastSavedVersion) return;
    runSave();
  }

  function cancel(): void {
    clearTimer();
  }

  return { notifyChange, flush, cancel };
}
