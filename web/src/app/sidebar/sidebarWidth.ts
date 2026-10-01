/** localStorage key for the persisted width — read/written via useLocalStorage in Sidebar.tsx. */
export const SIDEBAR_WIDTH_KEY = 'folio:sidebar-width';

export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 520;
export const SIDEBAR_DEFAULT_WIDTH = 280;

/** Arrow-key step for the keyboard-accessible resize handle. */
const KEYBOARD_STEP = 16;

/**
 * Clamps to the draggable [min, max] range. Used both live during a drag and
 * defensively wherever the persisted value is read — a stored width from
 * before min/max existed (or hand-edited localStorage) shouldn't be able to
 * render an unusably wide/narrow sidebar.
 */
export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
}

/**
 * Next width for a keydown on the resize handle, or null if the key isn't
 * one this handle responds to (caller should not preventDefault in that case).
 * Home/End jump straight to the ends, matching the native <input type=range> convention.
 */
export function nextWidthForKey(current: number, key: string): number | null {
  switch (key) {
    case 'ArrowLeft':
      return clampSidebarWidth(current - KEYBOARD_STEP);
    case 'ArrowRight':
      return clampSidebarWidth(current + KEYBOARD_STEP);
    case 'Home':
      return SIDEBAR_MIN_WIDTH;
    case 'End':
      return SIDEBAR_MAX_WIDTH;
    default:
      return null;
  }
}
