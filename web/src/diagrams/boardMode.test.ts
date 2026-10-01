// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOARD_MODE_KEY,
  COMPACT_VIEWPORT_QUERY,
  DEFAULT_BOARD_MODE,
  initialBoardMode,
  isCompactViewport,
  readStoredBoardMode,
  resolveViewModeEnabled,
  storeBoardMode,
} from './boardMode';

describe('readStoredBoardMode', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to "view" ("View") when nothing is stored', () => {
    expect(readStoredBoardMode()).toBe('view');
    expect(DEFAULT_BOARD_MODE).toBe('view');
  });

  it('respects a stored "edit" choice', () => {
    localStorage.setItem(BOARD_MODE_KEY, 'edit');
    expect(readStoredBoardMode()).toBe('edit');
  });

  it('respects a stored "view" choice explicitly (not just the default)', () => {
    localStorage.setItem(BOARD_MODE_KEY, 'view');
    expect(readStoredBoardMode()).toBe('view');
  });

  it('falls back to the given fallback for an unrecognized stored value', () => {
    localStorage.setItem(BOARD_MODE_KEY, 'source'); // an EditorMode value, not a BoardMode — must not leak across
    expect(readStoredBoardMode()).toBe('view');
    expect(readStoredBoardMode('edit')).toBe('edit');
  });

  it('falls back when storage.getItem throws (private browsing / disabled storage)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('storage disabled');
    });
    expect(() => readStoredBoardMode()).not.toThrow();
    expect(readStoredBoardMode()).toBe('view');
    vi.restoreAllMocks();
  });
});

describe('storeBoardMode', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists the choice under folio.board.mode, readable back by readStoredBoardMode', () => {
    storeBoardMode('edit');
    expect(localStorage.getItem(BOARD_MODE_KEY)).toBe('edit');
    expect(readStoredBoardMode()).toBe('edit');
  });

  it('round-trips back to "view" after having been set to "edit"', () => {
    storeBoardMode('edit');
    storeBoardMode('view');
    expect(readStoredBoardMode()).toBe('view');
  });

  it('does not throw when storage.setItem throws (quota exceeded / disabled storage)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded');
    });
    expect(() => storeBoardMode('edit')).not.toThrow();
  });

  it('writes nothing at all on a phone-sized viewport (Round 25b-1 §2, write side)', () => {
    storeBoardMode('view'); // desktop preference on record
    storeBoardMode('edit', true); // a one-off tap on a phone
    expect(localStorage.getItem(BOARD_MODE_KEY)).toBe('view');
  });
});

/**
 * Round 25b-1 §2 (owner, from a real iPhone): "The editing mode is inherited
 * from the desktop through localStorage: a person opens a board on the phone
 * and lands straight in editing". BOARD_MODE_KEY is one global
 * key shared by every screen, so the *stored* value is still whatever the
 * desktop wrote — it is the OPENING decision that has to ignore it here.
 */
describe('initialBoardMode', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('honours the stored preference on a desktop-sized viewport', () => {
    localStorage.setItem(BOARD_MODE_KEY, 'edit');
    expect(initialBoardMode(false)).toBe('edit');
  });

  it('always opens in "View" on a phone, even with "edit" inherited from the desktop', () => {
    localStorage.setItem(BOARD_MODE_KEY, 'edit');
    expect(initialBoardMode(true)).toBe(DEFAULT_BOARD_MODE);
    expect(initialBoardMode(true)).toBe('view');
    // ...and the stored desktop preference is left untouched, so going back
    // to a big screen still lands in edit mode.
    expect(readStoredBoardMode()).toBe('edit');
  });

  it('defaults to "view" on both when nothing is stored', () => {
    expect(initialBoardMode(false)).toBe('view');
    expect(initialBoardMode(true)).toBe('view');
  });
});

describe('isCompactViewport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('answers "desktop" where matchMedia does not exist at all (jsdom, SSR) instead of throwing', () => {
    expect(window.matchMedia).toBeUndefined(); // jsdom's baseline — the guard's real-world case
    expect(() => isCompactViewport()).not.toThrow();
    expect(isCompactViewport()).toBe(false);
  });

  it('asks matchMedia for Tailwind\'s own "below md" breakpoint', () => {
    const matchMedia = vi.fn(() => ({ matches: true }));
    vi.stubGlobal('matchMedia', matchMedia);
    expect(isCompactViewport()).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith(COMPACT_VIEWPORT_QUERY);
    expect(COMPACT_VIEWPORT_QUERY).toBe('(max-width: 767px)');
  });

  it('answers "desktop" when matchMedia itself throws', () => {
    vi.stubGlobal('matchMedia', () => {
      throw new Error('nope');
    });
    expect(isCompactViewport()).toBe(false);
  });
});

describe('resolveViewModeEnabled', () => {
  it('"edit" + editable load -> full editor (viewModeEnabled=false)', () => {
    expect(resolveViewModeEnabled('edit', true)).toBe(false);
  });

  it('"view" + editable load -> view mode (viewModeEnabled=true)', () => {
    expect(resolveViewModeEnabled('view', true)).toBe(true);
  });

  it('a non-editable load forces view mode regardless of the "edit" preference', () => {
    // A view-only share link (or any other non-editable load) must never be
    // widened into an editable Excalidraw just because localStorage happens
    // to hold 'edit' from some other board — permission always wins over
    // preference, same direction as PageEditor's readOnly override.
    expect(resolveViewModeEnabled('edit', false)).toBe(true);
  });

  it('a non-editable load stays in view mode for the "view" preference too', () => {
    expect(resolveViewModeEnabled('view', false)).toBe(true);
  });
});
