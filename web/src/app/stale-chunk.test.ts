// @vitest-environment jsdom
/**
 * A tab left open across a deploy fails to load a hashed chunk with one of a
 * handful of browser-specific messages — see stale-chunk.ts's doc comment
 * for the full story. These pin: which messages count as "stale chunk", that
 * an ordinary error does not, and that the reload guard fires exactly once
 * per tab (a real, persistent 404 must stop retrying and let the caller show
 * its own error text instead of reloading forever).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConnectivityForTests } from './offline/connectivity';
import { clearStaleChunkReloadFlag, isStaleChunkError, quietImport, tryReloadForStaleChunk } from './stale-chunk';

describe('isStaleChunkError', () => {
  it('recognizes every known browser wording', () => {
    expect(isStaleChunkError(new Error('Failed to fetch dynamically imported module: https://folio.example/assets/x.js'))).toBe(true);
    expect(isStaleChunkError(new Error('error loading dynamically imported module'))).toBe(true);
    expect(isStaleChunkError(new TypeError('Importing a module script failed'))).toBe(true);
    expect(isStaleChunkError(new Error('Unable to preload CSS for /assets/x.css'))).toBe(true);
    // A bare string (not wrapped in an Error) is accepted too — callers pass
    // both shapes (mermaid.render()'s rejection, vite:preloadError's payload).
    expect(isStaleChunkError('Failed to fetch dynamically imported module')).toBe(true);
  });

  it('does not fire on an ordinary error', () => {
    expect(isStaleChunkError(new Error('Parse error on line 3'))).toBe(false);
    expect(isStaleChunkError(new TypeError('Cannot read properties of undefined'))).toBe(false);
    expect(isStaleChunkError(undefined)).toBe(false);
    expect(isStaleChunkError(null)).toBe(false);
  });
});

describe('tryReloadForStaleChunk', () => {
  let reloadSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessionStorage.clear();
    reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload: reloadSpy },
      writable: true,
    });
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  it('does nothing for a non-stale-chunk error', () => {
    expect(tryReloadForStaleChunk(new Error('boom'))).toBe(false);
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('reloads once for a stale-chunk error, then refuses a second time', () => {
    const err = new Error('Failed to fetch dynamically imported module');
    expect(tryReloadForStaleChunk(err)).toBe(true);
    expect(reloadSpy).toHaveBeenCalledTimes(1);

    // Same tab, same session — the flag is still set, so a second failure
    // (the reload didn't help — a real outage) must NOT loop.
    expect(tryReloadForStaleChunk(err)).toBe(false);
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  // The owner, 29.09.2026: creating a board offline took the whole app off
  // the screen — the chunk could not be fetched, this guard read that as a
  // stale bundle and reloaded into the browser's "no internet" page.
  it('never reloads while offline: the chunk is unreachable, not stale', () => {
    const err = new Error('Failed to fetch dynamically imported module');
    resetConnectivityForTests({ state: 'offline' });
    expect(tryReloadForStaleChunk(err)).toBe(false);
    expect(reloadSpy).not.toHaveBeenCalled();
    // …and the one reload this tab is allowed is still available once back online.
    resetConnectivityForTests();
    expect(tryReloadForStaleChunk(err)).toBe(true);
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('a background import that fails reloads nobody and rejects nothing', async () => {
    resetConnectivityForTests();
    const err = new Error('Failed to fetch dynamically imported module');
    const result = await quietImport(async () => {
      // What vite:preloadError's listener would do while the import is in flight.
      expect(tryReloadForStaleChunk(err)).toBe(false);
      throw err;
    });
    expect(result).toBeUndefined();
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('clearing the flag (a successful app load) allows a future reload again', () => {
    const err = new Error('Failed to fetch dynamically imported module');
    expect(tryReloadForStaleChunk(err)).toBe(true);
    clearStaleChunkReloadFlag();
    expect(tryReloadForStaleChunk(err)).toBe(true);
    expect(reloadSpy).toHaveBeenCalledTimes(2);
  });
});
