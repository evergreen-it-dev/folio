/**
 * The visual viewport — the part of the page the person can actually see —
 * as a React hook, for surfaces that must stay inside it on a phone.
 *
 * DEV-PLAN Round 25b, item B (owner, from a real iPhone): an open on-screen
 * keyboard shrinks the VISUAL viewport, but neither `vh` units nor a
 * `height: 100%` chain notice — the layout viewport keeps its full height,
 * so anything pinned to the bottom of a full-height container (Excalidraw's
 * mobile tool bar, a modal's footer) ends up under the keyboard, and once
 * iOS has scrolled the visual viewport to reveal the focused field the
 * bottom of the layout is simply cut off. Emulated viewports in a desktop
 * browser never reproduce either half of that, which is why this stays a
 * measured, subscribed value rather than a media query.
 *
 * `null` where `window.visualViewport` does not exist (jsdom, old engines):
 * callers then keep their plain CSS layout.
 */
import { useEffect, useState } from 'react';

export interface VisualViewportBox {
  /** Visible height, in CSS px. */
  height: number;
  /** How far the visible area is scrolled down from the top of the layout viewport. */
  offsetTop: number;
  /** Height of the layout viewport (`window.innerHeight`) the visual one is cut out of. */
  layoutHeight: number;
}

/**
 * How much shorter than the layout viewport the visual one has to be before
 * it counts as "the keyboard is open". A browser's own collapsing address
 * bar moves the visual viewport by a few dozen pixels; the smallest phone
 * keyboard is well over 200.
 */
export const KEYBOARD_MIN_HEIGHT = 120;

export function isKeyboardOpen(box: VisualViewportBox | null): boolean {
  return box !== null && box.layoutHeight - box.height >= KEYBOARD_MIN_HEIGHT;
}

/**
 * The height a container whose top edge sits at `containerTop` (its
 * `getBoundingClientRect().top`, i.e. layout-viewport coordinates) may have
 * so that its bottom edge lands exactly on the visible area's bottom edge —
 * or `null` when the keyboard is closed and plain CSS should decide.
 * Clamped below so a container never collapses to nothing while the
 * keyboard covers most of a small screen.
 */
export function keyboardSafeHeight(box: VisualViewportBox | null, containerTop: number, minHeight = 160): number | null {
  if (!isKeyboardOpen(box) || box === null) return null;
  const visibleBottom = box.offsetTop + box.height;
  return Math.max(minHeight, Math.round(visibleBottom - containerTop));
}

function readBox(): VisualViewportBox | null {
  if (typeof window === 'undefined' || !window.visualViewport) return null;
  const vv = window.visualViewport;
  return { height: vv.height, offsetTop: vv.offsetTop, layoutHeight: window.innerHeight };
}

/** Subscribes to the visual viewport's `resize` and `scroll`; `null` where the API is missing. */
export function useVisualViewport(): VisualViewportBox | null {
  const [box, setBox] = useState<VisualViewportBox | null>(readBox);
  useEffect(() => {
    const vv = typeof window === 'undefined' ? null : window.visualViewport;
    if (!vv) return;
    const update = () => setBox(readBox());
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);
  return box;
}
