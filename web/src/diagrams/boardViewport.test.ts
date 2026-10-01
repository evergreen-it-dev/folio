// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createViewportPersister, readStoredViewport, storeViewport, type BoardViewport } from './boardViewport';

const VIEWPORT: BoardViewport = { scrollX: 12.5, scrollY: -40, zoom: 1.25 };

describe('readStoredViewport', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns null when nothing is stored for this page', () => {
    expect(readStoredViewport('board-1')).toBeNull();
  });

  it('round-trips a viewport written by storeViewport', () => {
    storeViewport('board-1', VIEWPORT);
    expect(readStoredViewport('board-1')).toEqual(VIEWPORT);
  });

  it('keys strictly per page — a viewport stored for one page never leaks into another', () => {
    storeViewport('board-1', VIEWPORT);
    expect(readStoredViewport('board-2')).toBeNull();
  });

  it('returns null for an empty pageId regardless of what else is stored', () => {
    storeViewport('board-1', VIEWPORT);
    expect(readStoredViewport('')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    localStorage.setItem('folio.board.viewport:board-1', 'not json{');
    expect(readStoredViewport('board-1')).toBeNull();
  });

  it.each([
    ['missing zoom', { scrollX: 1, scrollY: 2 }],
    ['non-finite scrollX', { scrollX: Infinity, scrollY: 2, zoom: 1 }],
    ['NaN zoom', { scrollX: 1, scrollY: 2, zoom: NaN }],
    ['zero zoom', { scrollX: 1, scrollY: 2, zoom: 0 }],
    ['negative zoom', { scrollX: 1, scrollY: 2, zoom: -1 }],
    ['string field', { scrollX: '1', scrollY: 2, zoom: 1 }],
  ])('returns null for a malformed stored shape (%s) — never feeds a broken viewport back to Excalidraw', (_label, bad) => {
    localStorage.setItem('folio.board.viewport:board-1', JSON.stringify(bad));
    expect(readStoredViewport('board-1')).toBeNull();
  });

  it('falls back to null when storage.getItem throws (private browsing / disabled storage)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('storage disabled');
    });
    expect(() => readStoredViewport('board-1')).not.toThrow();
    expect(readStoredViewport('board-1')).toBeNull();
    vi.restoreAllMocks();
  });
});

describe('storeViewport', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists under folio.board.viewport:<pageId>', () => {
    storeViewport('board-1', VIEWPORT);
    expect(localStorage.getItem('folio.board.viewport:board-1')).toBe(JSON.stringify(VIEWPORT));
  });

  it('is a no-op for an empty pageId — nothing stable to key it on', () => {
    storeViewport('', VIEWPORT);
    expect(localStorage.length).toBe(0);
  });

  it('does not throw when storage.setItem throws (quota exceeded / disabled storage)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded');
    });
    expect(() => storeViewport('board-1', VIEWPORT)).not.toThrow();
  });
});

describe('createViewportPersister', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not write immediately — only after delayMs of quiet', () => {
    const persister = createViewportPersister('board-1', 500);
    persister.notifyChange(VIEWPORT);
    expect(readStoredViewport('board-1')).toBeNull();
    vi.advanceTimersByTime(499);
    expect(readStoredViewport('board-1')).toBeNull();
    vi.advanceTimersByTime(1);
    expect(readStoredViewport('board-1')).toEqual(VIEWPORT);
  });

  it('coalesces a burst of notifyChange calls into a single write of the LAST value', () => {
    const persister = createViewportPersister('board-1', 500);
    persister.notifyChange({ scrollX: 1, scrollY: 1, zoom: 1 });
    vi.advanceTimersByTime(200);
    persister.notifyChange({ scrollX: 2, scrollY: 2, zoom: 1 });
    vi.advanceTimersByTime(200);
    persister.notifyChange(VIEWPORT);
    vi.advanceTimersByTime(500);
    expect(readStoredViewport('board-1')).toEqual(VIEWPORT);
  });

  it('flush() writes the pending viewport immediately and cancels the debounce timer', () => {
    const persister = createViewportPersister('board-1', 500);
    persister.notifyChange(VIEWPORT);
    persister.flush();
    expect(readStoredViewport('board-1')).toEqual(VIEWPORT);
    // The debounced timer was cancelled, not just raced — advancing past
    // where it would have fired must not write a second (redundant) time.
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    vi.advanceTimersByTime(1000);
    expect(setItemSpy).not.toHaveBeenCalled();
    setItemSpy.mockRestore();
  });

  it('flush(viewport) writes the given viewport even with nothing pending', () => {
    const persister = createViewportPersister('board-1', 500);
    persister.flush(VIEWPORT);
    expect(readStoredViewport('board-1')).toEqual(VIEWPORT);
  });

  it('flush() with nothing pending and no argument is a no-op', () => {
    const persister = createViewportPersister('board-1', 500);
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    persister.flush();
    expect(setItemSpy).not.toHaveBeenCalled();
    setItemSpy.mockRestore();
  });

  it('cancel() drops a pending change without ever writing it', () => {
    const persister = createViewportPersister('board-1', 500);
    persister.notifyChange(VIEWPORT);
    persister.cancel();
    vi.advanceTimersByTime(1000);
    expect(readStoredViewport('board-1')).toBeNull();
  });
});
