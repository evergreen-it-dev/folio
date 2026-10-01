import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';

/**
 * Round 26 (DATA TABLES) — a panel pinned to an arbitrary element.
 *
 * app/ui/Menu.tsx already does trigger+panel+clamp, but it OWNS its trigger
 * (it renders the button itself, with the sidebar's icon-button styling).
 * The cases here can't use that: the anchor is a grid cell that
 * react-datasheet-grid renders, or a toolbar button that already exists. So
 * this takes an anchor ref and supplies only the panel.
 *
 * Same three hard-won rules as Menu/Modal, and for the same reasons:
 *   1. portal to document.body — an `overflow` ancestor (the grid's own
 *      scroll container, very much including here) clips `position: absolute`
 *      descendants regardless of z-index, and a `backdrop-filter` ancestor
 *      makes itself the containing block even for `position: fixed`;
 *   2. `position: fixed` + measure-then-place in a layout effect, so it is
 *      positioned before paint and never flashes at the wrong spot;
 *   3. clamp into the viewport, flipping above the anchor when it would
 *      overflow the bottom.
 *
 * Unlike Menu this REPOSITIONS on scroll instead of dismissing: a cell
 * editor that vanishes because the grid scrolled a pixel under the mouse
 * would be maddening, whereas a sidebar dropdown closing is fine.
 *
 * ─── NESTING (owner-reported bug, round 26 follow-up) ────────────────────
 * Panels nest: the Filter panel is one, and the "Choose a value" option
 * picker inside one of its rules is ANOTHER one. Both portal to
 * document.body, so the outer panel's `contains(target)` check said "that
 * click was outside me" and the whole Filter panel vanished the instant you
 * picked a value. Same story for the bulk "set the value" popover.
 *
 * The fix is the context below: every panel registers a containment test
 * with its PARENT panel (context crosses portals, because it follows the
 * React tree rather than the DOM tree), and the test is recursive, so a
 * grandparent recognises a click in a grandchild too. Consequences:
 *   · click inside a nested picker  → nobody closes;
 *   · click in the parent's own body → only the nested picker closes;
 *   · click outside everything      → every layer closes;
 *   · Escape                        → innermost layer only, one per press.
 */

const MARGIN = 8;

/** `(target) => true` when the click landed in this panel or any it opened. */
type ContainsTest = (target: Node) => boolean;

/** Supplied by an open panel to whatever panels its own content opens. */
const PanelNesting = createContext<((test: ContainsTest) => () => void) | null>(null);

export interface AnchoredPanelProps {
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
  /** Match the anchor's width — right for cell editors, wrong for menus. */
  matchWidth?: boolean;
  className?: string;
  label?: string;
  /**
   * Focused once the panel is actually on screen. Use this instead of
   * `autoFocus` on the field — see the effect below for why `autoFocus`
   * cannot work inside this component.
   */
  initialFocusRef?: RefObject<HTMLElement | null>;
}

interface Coords {
  top: number;
  left: number;
  minWidth?: number;
}

function place(anchor: DOMRect, panel: DOMRect, matchWidth: boolean): Coords {
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const width = matchWidth ? Math.max(anchor.width, panel.width) : panel.width;

  let left = anchor.left;
  left = Math.min(left, vw - width - MARGIN);
  left = Math.max(left, MARGIN);

  let top = anchor.bottom + 2;
  if (top + panel.height > vh - MARGIN) {
    const above = anchor.top - 2 - panel.height;
    top = above >= MARGIN ? above : Math.max(MARGIN, vh - panel.height - MARGIN);
  }
  return { top, left, minWidth: matchWidth ? anchor.width : undefined };
}

export function AnchoredPanel({
  anchorRef,
  onClose,
  children,
  matchWidth,
  className,
  label,
  initialFocusRef,
}: AnchoredPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<Coords | null>(null);

  // Panels this one has opened. A Set of tests rather than of nodes so the
  // recursion is free: a child's test already covers ITS children.
  const nestedRef = useRef<Set<ContainsTest>>(new Set());
  const registerNested = useCallback((test: ContainsTest) => {
    nestedRef.current.add(test);
    return () => {
      nestedRef.current.delete(test);
    };
  }, []);

  /** Inside this panel, or inside anything it opened, at any depth. */
  const containsDeep = useCallback((target: Node) => {
    if (panelRef.current?.contains(target)) return true;
    for (const test of nestedRef.current) if (test(target)) return true;
    return false;
  }, []);

  const registerWithParent = useContext(PanelNesting);
  useEffect(() => {
    if (!registerWithParent) return;
    return registerWithParent(containsDeep);
  }, [registerWithParent, containsDeep]);

  useLayoutEffect(() => {
    function measure() {
      const anchor = anchorRef.current;
      const panel = panelRef.current;
      if (anchor && panel) {
        setCoords(place(anchor.getBoundingClientRect(), panel.getBoundingClientRect(), matchWidth ?? false));
      }
    }
    measure();
    // Capture phase — scroll events don't bubble, and the interesting
    // scroller here is the grid's inner container, not the window.
    window.addEventListener('scroll', measure, { capture: true });
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, { capture: true });
      window.removeEventListener('resize', measure);
    };
  }, [anchorRef, matchWidth]);

  /*
   * Why `autoFocus` on a field inside this panel does NOT work, and this does.
   *
   * React applies `autoFocus` during the commit that MOUNTS the panel. At that
   * moment `coords` is still null, so the wrapper below renders with
   * `visibility: hidden` (rule 2 of the docblock: measure, then place, so the
   * panel never flashes at the wrong spot). A browser refuses to focus a
   * `visibility: hidden` element, so the call was a silent no-op and focus
   * stayed on whatever opened the panel — "Add a column" opened with the
   * name field unfocused and the typed name went nowhere.
   *
   * So focus AFTER the measuring layout effect has produced coords, i.e. once
   * the panel is genuinely visible. Once only: a scroll re-measures and sets
   * coords again, and stealing focus back on every scroll would be worse than
   * not focusing at all.
   */
  const focusedRef = useRef(false);
  useEffect(() => {
    if (!coords || focusedRef.current) return;
    focusedRef.current = true;
    initialFocusRef?.current?.focus();
  }, [coords, initialFocusRef]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      // Innermost first: while this panel has a picker of its own open, that
      // picker owns the Escape. Its handler runs on the same document node,
      // so stopPropagation() there can't silence us — this check can.
      if (nestedRef.current.size > 0) return;
      event.stopPropagation();
      onClose();
    }
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (containsDeep(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    }
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [onClose, anchorRef, containsDeep]);

  /*
   * Keep the grid's keyboard out of this panel's text fields.
   *
   * react-datasheet-grid listens for `keydown` on `document` and, whenever it
   * has an active cell, acts on keys we very much want for ourselves:
   * Backspace/Delete clears the cell selection AND calls preventDefault (so a
   * typo in a panel input could not be erased at all), Ctrl+A selects the
   * whole grid instead of the text, Ctrl+D duplicates rows, and any printable
   * character starts editing the cell behind the popover. There is no target
   * check in that handler and no prop to disable it.
   *
   * `document.body` is the seam. React delegates a portal's own handlers to
   * the portal container — this panel's container, i.e. body — and registers
   * them during the commit that mounts us, before this effect. Same node,
   * same phase, so React's listeners have already run by the time this one
   * fires: the panel's own key handling (OptionPicker's Enter, ColorPicker's
   * arrows) still works, and `document` never sees the event.
   */
  useEffect(() => {
    function isolate(event: KeyboardEvent) {
      if (!containsDeep(event.target as Node)) return;
      event.stopPropagation();
    }
    document.body.addEventListener('keydown', isolate);
    return () => document.body.removeEventListener('keydown', isolate);
  }, [containsDeep]);

  return createPortal(
    <div
      ref={panelRef}
      aria-label={label}
      style={{
        position: 'fixed',
        top: coords?.top ?? 0,
        left: coords?.left ?? 0,
        minWidth: coords?.minWidth,
        visibility: coords ? 'visible' : 'hidden',
      }}
      className={`z-[65] rounded-lg border border-neutral-200 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-900 ${className ?? ''}`}
    >
      {/* Anything this panel's content opens registers with US, not with our
          own parent — that is what makes the containment test recursive. */}
      <PanelNesting.Provider value={registerNested}>{children}</PanelNesting.Provider>
    </div>,
    document.body,
  );
}
