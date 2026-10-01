/**
 * Round 21 (DIAGRAMS) — the board's own "View | Edit" switch.
 *
 * This is deliberately a *separate* concept from the page editor's
 * source/live/reading modes (web/src/editor/index.tsx, EditorMode/MODE_KEY —
 * not this zone, not touched here): boards get their own storage key
 * ('folio.board.mode', global — same "one key, not scoped per page" choice
 * PageEditor already made for 'folio.editor.mode') and their own two-state
 * toggle, styled to match but implemented with this zone's own code.
 *
 * Kept as a plain, DOM-light module (localStorage aside) — no React — so the
 * default/persistence/resolution logic is unit-testable without mounting
 * anything, the same spirit as autosaveScheduler.ts next to it.
 */
export type BoardMode = 'view' | 'edit';

export const BOARD_MODE_KEY = 'folio.board.mode';

const MODES: readonly BoardMode[] = ['view', 'edit'];

/**
 * Default is 'view' ("View") per DEV-PLAN Round 21 — a board opens
 * read-only (pan/zoom only) until the user deliberately switches to
 * "Edit", mirroring the same round's reading-by-default change for
 * pages.
 */
export const DEFAULT_BOARD_MODE: BoardMode = 'view';

/** Reads the user's last-chosen board mode, validating the stored value against the known set. Falls back to `fallback` (default: 'view') if nothing is stored, the value is unrecognized, or storage is unavailable (private browsing, disabled storage). */
export function readStoredBoardMode(fallback: BoardMode = DEFAULT_BOARD_MODE): BoardMode {
  try {
    const stored = localStorage.getItem(BOARD_MODE_KEY);
    if (stored && (MODES as readonly string[]).includes(stored)) return stored as BoardMode;
  } catch {
    /* storage unavailable — just fall back, same as PageEditor's readStoredMode */
  }
  return fallback;
}

/**
 * Tailwind's own `md` breakpoint, spelled as a media query so this module
 * can answer "are we on a phone-sized screen?" without React or a class
 * name. Must stay in step with the `md:` utilities BoardCanvas uses for the
 * same split (Tailwind's `md` is min-width: 768px, so "below md" is 767px).
 */
export const COMPACT_VIEWPORT_QUERY = '(max-width: 767px)';

/** True on a phone-sized viewport. False (the safe, desktop-shaped answer) wherever matchMedia isn't available at all — jsdom, SSR. */
export function isCompactViewport(): boolean {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia(COMPACT_VIEWPORT_QUERY).matches;
  } catch {
    /* matchMedia present but unusable — treat as desktop, same spirit as readStoredBoardMode's storage fallback */
    return false;
  }
}

/**
 * Round 25b-1 §2 (owner, from a real iPhone): the mode a board OPENS in.
 *
 * On a desktop-sized viewport this is just the remembered preference. On a
 * phone it is always 'view', ignoring whatever the same person last chose at
 * their desk: BOARD_MODE_KEY is one global key shared by every screen, so
 * before this the owner opened a board on their phone and landed straight in
 * Excalidraw's edit mode — tiny handles, on-screen keyboard, nothing they
 * asked for. Entering edit mode on a phone must be a deliberate tap.
 *
 * `compact` is injected (defaulting to a live matchMedia read) so the rule
 * itself is testable without touching window.
 */
export function initialBoardMode(compact: boolean = isCompactViewport()): BoardMode {
  return compact ? DEFAULT_BOARD_MODE : readStoredBoardMode();
}

/**
 * Persists the user's choice for the next time any board is opened. Silently
 * a no-op if storage throws (quota/disabled) — the choice just won't survive
 * a reload — and a deliberate no-op on a phone-sized viewport: that's the
 * same one-global-key problem initialBoardMode() exists for, seen from the
 * writing side. A one-off "let me nudge this box on my phone" tap must not
 * become the mode every desktop board then opens in, exactly as the reverse
 * must not happen.
 */
export function storeBoardMode(mode: BoardMode, compact: boolean = isCompactViewport()): void {
  if (compact) return;
  try {
    localStorage.setItem(BOARD_MODE_KEY, mode);
  } catch {
    /* storage unavailable — the choice just won't persist */
  }
}

/**
 * The actual `viewModeEnabled` prop Excalidraw receives is never just the
 * toggle's raw value in isolation: a load that resolved as non-editable
 * (share-link view-only guest — see BoardCanvas's own load-state contract
 * for `editable`) must stay in view mode regardless of what's sitting in
 * localStorage, the same way PageEditor's `readOnly` prop already forces its
 * mode to 'reading' regardless of the stored choice. `editable` wins whenever
 * the two disagree; the toggle can only ever narrow permissions further
 * (edit -> view is always allowed when the underlying load *is* editable),
 * never widen them.
 */
export function resolveViewModeEnabled(boardMode: BoardMode, editable: boolean): boolean {
  return !editable || boardMode === 'view';
}
