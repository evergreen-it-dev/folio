/**
 * Per-viewer viewport (pan/zoom) memory for a board — owner report: "a
 * default fit to screen mode is missing — so that the whole scheme fits, and/or
 * saving the zoom". Both halves are handled together (see BoardCanvas.tsx
 * for the wiring): if this module has a saved viewport for the page, it wins
 * on open; if it doesn't (first time this browser opens this board, or
 * storage was cleared), BoardCanvas fits the scene to the screen instead.
 *
 * The board's *content* (elements/appState needed to actually render the
 * scene) lives in the page's own svg file on disk — see BoardCanvas's
 * load-state contract docblock. Where the viewer happened to be
 * scrolled/zoomed to is deliberately NOT part of that: it's a purely
 * personal, ephemeral reading preference, not shared document state. Writing
 * it to the file would mean one person's pan/zoom produces a git diff for
 * everyone and silently overwrites whatever anyone else last saw — so, same
 * as boardMode.ts's View/Edit choice (global) and
 * markdown/collapsible.ts's collapsed-section state (per-page), this lives in
 * localStorage only. Keyed per page, same shape of key as
 * collapsible.ts's readCollapsedSlugs/writeCollapsedSlugs (prefix + pageId) —
 * a board's viewport isn't a single shared preference the way the view/edit
 * toggle is, so it can't reuse boardMode.ts's one global key. No code is
 * shared with either module (both are outside this zone or deliberately kept
 * separate); this file just repeats the same shape.
 */

export interface BoardViewport {
  scrollX: number;
  scrollY: number;
  /** Excalidraw's `appState.zoom.value` — a plain number here, re-branded back to NormalizedZoomValue at the call site in BoardCanvas.tsx (this module has no dependency on excalidraw's types). */
  zoom: number;
}

const VIEWPORT_KEY_PREFIX = 'folio.board.viewport:';

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Reads the last-saved pan/zoom for this page. Returns null if nothing is
 * stored, storage is unavailable (private browsing / disabled storage), the
 * stored JSON is malformed, or any field is missing/non-finite/non-positive
 * zoom — never a value that could feed a broken viewport back into
 * Excalidraw. `pageId` may legitimately be '' (BoardCanvasProps allows a
 * caller without a real id up front); that's treated as "nothing to key on",
 * not an error.
 */
export function readStoredViewport(pageId: string): BoardViewport | null {
  if (!pageId) return null;
  try {
    const raw = localStorage.getItem(VIEWPORT_KEY_PREFIX + pageId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BoardViewport> | null;
    if (
      parsed &&
      isFiniteNumber(parsed.scrollX) &&
      isFiniteNumber(parsed.scrollY) &&
      isFiniteNumber(parsed.zoom) &&
      parsed.zoom > 0
    ) {
      return { scrollX: parsed.scrollX, scrollY: parsed.scrollY, zoom: parsed.zoom };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Persists the viewer's current pan/zoom for next time they open this page.
 * Silently a no-op if storage throws (quota/disabled) or `pageId` is falsy —
 * the viewport just won't persist across reloads either way.
 */
export function storeViewport(pageId: string, viewport: BoardViewport): void {
  if (!pageId) return;
  try {
    localStorage.setItem(VIEWPORT_KEY_PREFIX + pageId, JSON.stringify(viewport));
  } catch {
    /* storage unavailable — the viewport just won't persist across reloads */
  }
}

export interface ViewportPersister {
  /** Call on every viewport-bearing onChange; coalesces a burst (continuous pan/zoom drag) into a single write after `delayMs` of quiet, same "trailing debounce" idea as autosaveScheduler.ts. */
  notifyChange(viewport: BoardViewport): void;
  /** Writes immediately: the given viewport if provided, else whatever's still pending from the last notifyChange. No-op if neither is available. Best-effort unmount/mode-switch hook, same shape as autosaveScheduler's flush(). */
  flush(viewport?: BoardViewport): void;
  /** Drops any pending write without saving. */
  cancel(): void;
}

/**
 * Debounced writer around storeViewport. Deliberately simpler than
 * autosaveScheduler.ts: that one skips saves whose scene "version" hasn't
 * actually moved (pan/zoom-only changes are exactly what it exists to
 * ignore); here a pan/zoom notification IS the change being saved, so
 * there's no version gate — every notifyChange is real, only bursts of them
 * get coalesced.
 */
export function createViewportPersister(pageId: string, delayMs: number): ViewportPersister {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: BoardViewport | null = null;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function notifyChange(viewport: BoardViewport): void {
    pending = viewport;
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      if (pending) storeViewport(pageId, pending);
      pending = null;
    }, delayMs);
  }

  function flush(viewport?: BoardViewport): void {
    clearTimer();
    const toSave = viewport ?? pending;
    pending = null;
    if (toSave) storeViewport(pageId, toSave);
  }

  function cancel(): void {
    clearTimer();
    pending = null;
  }

  return { notifyChange, flush, cancel };
}
