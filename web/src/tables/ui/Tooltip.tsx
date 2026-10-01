import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Round 26 (DATA TABLES) — hover/focus popover for the column header's ⓘ.
 *
 * WHY NOT `title=""`: spec §2.3 wants the column's `description` shown as
 * multi-line text PLUS the option list rendered as coloured swatch + value +
 * per-option description (the Confluence behaviour). A native tooltip is
 * single-line-ish, unstyled, ~1s delayed, cannot hold markup, and is
 * invisible to touch and to keyboard users entirely. DEV-PLAN R26 calls this
 * out explicitly as something this zone has to build.
 *
 * Positioning follows ui/Menu.tsx's proven approach rather than inventing a
 * second one: render through a portal to document.body as `position: fixed`
 * (so no `overflow` or `backdrop-filter` ancestor can clip it — see Menu's
 * and Modal's docblocks for the two separate real bugs behind that rule),
 * measure in a layout effect, then clamp to the viewport.
 *
 * Opens on hover AND on focus, closes on blur/leave/Escape, and is exposed
 * via aria-describedby so a screen reader announces it with the trigger.
 */

const MARGIN = 8;
const GAP = 6;

export interface TooltipProps {
  /** Tooltip body. Multi-line and rich content are the point. */
  content: ReactNode;
  children: ReactNode;
  className?: string;
  /** Widen for option lists; default suits a sentence or two. */
  wide?: boolean;
}

interface Coords {
  top: number;
  left: number;
}

function place(trigger: DOMRect, panel: DOMRect): Coords {
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;

  let left = trigger.left + trigger.width / 2 - panel.width / 2;
  left = Math.min(left, vw - panel.width - MARGIN);
  left = Math.max(left, MARGIN);

  // Prefer below; flip above when it would overflow the bottom edge.
  let top = trigger.bottom + GAP;
  if (top + panel.height > vh - MARGIN) {
    const above = trigger.top - GAP - panel.height;
    top = above >= MARGIN ? above : Math.max(MARGIN, vh - panel.height - MARGIN);
  }
  return { top, left };
}

export function Tooltip({ content, children, className, wide }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<Coords | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const id = useId();

  const close = useCallback(() => setOpen(false), []);

  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (trigger && panel) {
      setCoords(place(trigger.getBoundingClientRect(), panel.getBoundingClientRect()));
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKey);
    // Capture phase: scroll doesn't bubble, and the grid scrolls inside its
    // own container — without capture the tooltip would hang in mid-air.
    window.addEventListener('scroll', close, { capture: true });
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, { capture: true });
      window.removeEventListener('resize', close);
    };
  }, [open, close]);

  return (
    <span
      ref={triggerRef}
      className={`inline-flex ${className ?? ''}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={close}
      onFocus={() => setOpen(true)}
      onBlur={close}
      aria-describedby={open ? id : undefined}
    >
      {children}
      {open &&
        createPortal(
          <div
            ref={panelRef}
            id={id}
            role="tooltip"
            style={{
              position: 'fixed',
              top: coords?.top ?? 0,
              left: coords?.left ?? 0,
              // Rendered but invisible on the first pass so it can be
              // measured; revealed once positioned, so it never flashes at
              // the wrong spot. Same trick as ui/Menu.tsx.
              visibility: coords ? 'visible' : 'hidden',
            }}
            className={`pointer-events-none z-[70] rounded-lg border border-neutral-200 bg-white px-3 py-2 text-xs leading-relaxed whitespace-pre-line text-neutral-700 shadow-lg dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 ${
              wide ? 'max-w-sm' : 'max-w-xs'
            }`}
          >
            {content}
          </div>,
          document.body,
        )}
    </span>
  );
}
