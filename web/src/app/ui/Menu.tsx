import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useOutsideClick } from '../hooks';

export interface MenuProps {
  /** Icon/content of the toggle button. Omitted together with `anchorRef`: the menu then has no button of its own and is opened only through `open`. */
  trigger?: ReactNode;
  triggerLabel: string;
  align?: 'left' | 'right';
  className?: string;
  /** Replaces the toggle button's own classes (the header's text and 28px icon triggers). */
  triggerClassName?: string;
  /** Panel content; receives a `close()` callback to dismiss after an action. */
  children: (close: () => void) => ReactNode;
  /**
   * Controlled mode: the owner keeps the open state (the header opens Export,
   * Share… from its «⋯» menu). Uncontrolled when omitted, as before.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Where the panel is placed from when the menu's own button is absent or
   * not displayed (`hidden` at this width): the header passes its «⋯» button,
   * so a menu opened from an overflow row appears under that row's trigger.
   */
  anchorRef?: RefObject<HTMLElement | null>;
}

export interface MenuCoords {
  top: number;
  left: number;
}

const VIEWPORT_MARGIN = 8;

/**
 * Clamps the panel to stay fully inside the viewport: opens from the
 * trigger's `align` edge (left = extend rightward, right = extend
 * leftward), then clamps horizontally to the viewport edges and flips
 * above the trigger when it would overflow the bottom.
 */
export function positionMenu(triggerRect: DOMRect, panelRect: DOMRect, align: 'left' | 'right'): MenuCoords {
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;

  let left = align === 'right' ? triggerRect.right - panelRect.width : triggerRect.left;
  left = Math.min(left, viewportWidth - panelRect.width - VIEWPORT_MARGIN);
  left = Math.max(left, VIEWPORT_MARGIN);

  let top = triggerRect.bottom + 4;
  if (top + panelRect.height > viewportHeight - VIEWPORT_MARGIN) {
    const above = triggerRect.top - 4 - panelRect.height;
    top = above >= VIEWPORT_MARGIN ? above : Math.max(VIEWPORT_MARGIN, viewportHeight - panelRect.height - VIEWPORT_MARGIN);
  }

  return { top, left };
}

/**
 * Small icon-button popover menu, used for the tree row "add"/"more"
 * actions and the space switcher.
 *
 * The panel renders through a portal to document.body as `position: fixed`,
 * placed from the trigger's own getBoundingClientRect(). It used to render
 * inline as an `absolute` sibling of the trigger, which looked fine
 * everywhere except the sidebar: Shell's root has `overflow-hidden` (and
 * the tree nav adds its own `overflow-y-auto`, which per the CSS spec's
 * overflow-x/y coupling rule drags overflow-x along with it), and an
 * `overflow` ancestor clips `position: absolute` descendants that paint
 * outside its bounds *regardless of z-index* — that's what was cutting the
 * panel off at the sidebar's edge. `position: fixed` (used here) resolves
 * against the viewport directly, bypassing that ancestor chain entirely.
 */
const DEFAULT_TRIGGER_CLASS =
  'flex w-full min-w-0 items-center justify-center rounded-md p-1 text-neutral-600 hover:bg-neutral-200/70 hover:text-neutral-900 max-md:min-h-10 max-md:min-w-10 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-neutral-100';

/** The element a panel is placed from: the menu's own trigger while it is displayed, the anchor otherwise. */
function anchorElement(trigger: HTMLElement | null, anchor: HTMLElement | null | undefined): HTMLElement | null {
  if (trigger && trigger.getClientRects().length > 0) return trigger;
  return anchor ?? trigger;
}

export function Menu({ trigger, triggerLabel, align = 'left', className, triggerClassName, children, open: openProp, onOpenChange, anchorRef }: MenuProps) {
  const [openState, setOpenState] = useState(false);
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : openState;
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const controlledRef = useRef(controlled);
  controlledRef.current = controlled;
  const openRef = useRef(open);
  openRef.current = open;
  // Stable (the outside-click hook re-subscribes on identity change). Reports
  // only real changes: a closed controlled menu must not answer every click on
  // the page with onOpenChange(false) — the header's other surfaces share one
  // open-state, and that call would close whichever of them is open.
  const [setOpen] = useState(() => (next: boolean) => {
    if (openRef.current === next) return;
    if (!controlledRef.current) setOpenState(next);
    onOpenChangeRef.current?.(next);
  });
  const [coords, setCoords] = useState<MenuCoords | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const wasOpenRef = useRef(false);

  const [dismiss] = useState(() => () => setOpen(false));
  useOutsideClick([triggerRef, panelRef], dismiss);

  // Measure-then-position: the panel has to actually exist in the DOM
  // (rendered invisibly) before its real size is known, so this runs in a
  // layout effect — synchronously after the DOM update but before the
  // browser paints, so there's no visible flash at the wrong spot.
  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    const anchorEl = anchorElement(triggerRef.current, anchorRef?.current);
    const panelEl = panelRef.current;
    if (anchorEl && panelEl) {
      setCoords(positionMenu(anchorEl.getBoundingClientRect(), panelEl.getBoundingClientRect(), align));
    }
  }, [open, align, anchorRef]);

  // Portaling moves the panel to the end of <body>, so it's no longer the
  // trigger's next DOM sibling and Tab would no longer naturally reach it.
  // Move focus in once positioned, and back to the trigger on every close
  // (Escape, outside click, scroll/resize dismissal, or an item selected),
  // so keyboard behavior doesn't regress versus the old inline layout.
  useEffect(() => {
    if (open && coords) {
      const panel = panelRef.current;
      if (panel && !panel.contains(document.activeElement)) panel.focus();
    }
  }, [open, coords]);

  useEffect(() => {
    if (wasOpenRef.current && !open) anchorElement(triggerRef.current, anchorRef?.current)?.focus();
    wasOpenRef.current = open;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    function handleDismiss(event: Event) {
      // A long space switcher scrolls inside the menu itself. Capture-phase
      // listening is still needed for ancestor scrolls, but the menu's own
      // scroll area must not dismiss the surface the user is navigating.
      const target = event.target;
      if (target instanceof Node && panelRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener('keydown', handleKey);
    // Scroll events don't bubble, so this needs the capture phase to see
    // scrolling in any ancestor (e.g. the tree's own overflow-y-auto).
    // Repositioning live isn't worth the complexity here — closing is enough.
    window.addEventListener('scroll', handleDismiss, { capture: true });
    window.addEventListener('resize', handleDismiss);
    return () => {
      document.removeEventListener('keydown', handleKey);
      window.removeEventListener('scroll', handleDismiss, { capture: true });
      window.removeEventListener('resize', handleDismiss);
    };
  }, [open]);

  const panel =
    open &&
    createPortal(
      <div
        ref={panelRef}
        role="menu"
        tabIndex={-1}
        style={{
          position: 'fixed',
          top: coords?.top ?? 0,
          left: coords?.left ?? 0,
          visibility: coords ? 'visible' : 'hidden',
        }}
        // z-[80]: above every floating surface, including the Folio AI panel (z-[70]) —
        // at z-[60] the history dropdown opened BEHIND that panel and looked dead.
        className="z-[80] min-w-[190px] rounded-lg border border-neutral-200 bg-white p-1 shadow-lg outline-none dark:border-neutral-700 dark:bg-neutral-900"
      >
        {children(() => setOpen(false))}
      </div>,
      document.body,
    );

  // No button of its own: opened only through `open`, placed from `anchorRef`.
  if (trigger === undefined) return panel || null;

  return (
    <div className={`relative ${className ?? ''}`}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={triggerLabel}
        title={triggerLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        // Round 14 QA fix ("long space name flows under the star/gear
        // buttons"): this button used to have no explicit width, so as a
        // plain inline-block it sized itself via shrink-to-fit around
        // `trigger`'s content — for a nowrap-then-truncate child, min-content
        // and max-content are the same (nothing can wrap), so shrink-to-fit
        // can never go narrower than the FULL untruncated text no matter how
        // small an ancestor (e.g. SpaceSwitcher's `min-w-0 flex-1` wrapper)
        // says this should be. w-full instead resolves against that
        // wrapper's own already-constrained width, completing the min-w-0
        // chain so the truncate below actually has something to truncate
        // against. max-md:min-h/w-10: touch-target floor for icon-only
        // triggers (Sidebar toolbar, share/user menus, …) — a no-op once
        // content (e.g. SpaceSwitcher's/UserMenu's own row) is already bigger.
        className={triggerClassName ?? DEFAULT_TRIGGER_CLASS}
      >
        {trigger}
      </button>
      {panel}
    </div>
  );
}

export interface MenuItemProps {
  icon?: ReactNode;
  children: ReactNode;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
  /** Tooltip — e.g. why the item is disabled. */
  title?: string;
  /** Called when the item appears (the menu opened) and when it is pointed at: warm up what selecting it loads. */
  onPreload?: () => void;
}

export function MenuItem({ icon, children, onSelect, destructive, disabled, title, onPreload }: MenuItemProps) {
  useEffect(() => {
    onPreload?.(); // once, when the menu opens
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      title={title}
      onPointerEnter={onPreload}
      onFocus={onPreload}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onSelect();
      }}
      className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent dark:hover:bg-neutral-800 ${
        destructive ? 'text-red-600 dark:text-red-400' : ''
      }`}
    >
      {icon}
      <span className="truncate">{children}</span>
    </button>
  );
}
