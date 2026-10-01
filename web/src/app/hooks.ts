import { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import { matchPath, useLocation } from 'react-router';

function readLocalStorage<T>(key: string, initial: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? initial : (JSON.parse(raw) as T);
  } catch {
    return initial;
  }
}

/**
 * localStorage-backed state, JSON-serialized. Falls back to `initial` if the
 * stored value is missing/corrupt.
 *
 * Re-reads whenever `key` itself changes, not just on mount: a lazy
 * useState initializer only runs once, but a component using this with a
 * computed key (e.g. `folio:expanded:${space}` in PageTree) can stay
 * mounted across a change in that key — react-router keeps the same Shell
 * subtree mounted across a space switch, since only the `:space` param
 * changes — and without this the value would stay stuck on whichever key
 * was active when the component first mounted.
 */
export function useLocalStorage<T>(key: string, initial: T): [T, (value: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => readLocalStorage(key, initial));

  useEffect(() => {
    setValue(readLocalStorage(key, initial));
    // `initial` deliberately excluded: callers typically pass a fresh
    // literal (e.g. `[]`) each render, which would otherwise re-run this
    // (harmlessly, but pointlessly) on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const setAndStore = (next: T | ((prev: T) => T)) => {
    setValue((prev) => {
      const resolved = typeof next === 'function' ? (next as (prev: T) => T)(prev) : next;
      try {
        localStorage.setItem(key, JSON.stringify(resolved));
      } catch {
        // Storage full/unavailable (private mode, quota) — state still updates in-memory.
      }
      return resolved;
    });
  };

  return [value, setAndStore];
}

/** Debounces a fast-changing value; the returned value only updates `delayMs` after the last change. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/**
 * Sets document.title while mounted, restoring the previous title on unmount.
 * Split into two effects deliberately: a title change must not trigger the
 * "restore" cleanup (that only belongs to the final unmount), or the title
 * would flicker back to the pre-mount value on every update in place (e.g.
 * a live rename) before the new title lands.
 */
export function useDocumentTitle(title: string | undefined) {
  useEffect(() => {
    document.title = title ? `${title} · Folio` : 'Folio';
  }, [title]);

  useEffect(() => {
    const original = document.title;
    return () => {
      document.title = original;
    };
  }, []);
}

/**
 * The `:id` from the URL when it matches /s/:space/p/:id, else undefined.
 *
 * Why this exists instead of just calling useParams(): Shell renders
 * <Sidebar> directly (as a sibling of <Outlet/>), not through the outlet, so
 * it sits in the *shallower* RouteContext established for the `/s/:space`
 * layout route itself — react-router only merges a descendant route's own
 * params (like the `p/:id` child's `:id`) into the RouteContext it builds
 * *inside* <Outlet/>, one level deeper than Shell/Sidebar/Header live. Calling
 * useParams() from Sidebar therefore always sees `id: undefined`, even on
 * `/s/:space/p/:id` — silently breaking active-row highlighting. Matching
 * against the live location sidesteps that context depth entirely.
 *
 * Keep the pattern below in sync with the `p/:id` route in App.tsx.
 */
export function useActivePageId(): string | undefined {
  const { pathname } = useLocation();
  return matchPath('/s/:space/p/:id', pathname)?.params.id;
}

/**
 * The folder path from the URL when it matches /s/:space/d/*, else
 * undefined — same rationale and Shell/Sidebar RouteContext caveat as
 * useActivePageId above, for folder-listing rows (which have no real page
 * id to match against). Keep in sync with the `d/*` route in App.tsx.
 */
export function useActiveFolderPath(): string | undefined {
  const { pathname } = useLocation();
  return matchPath('/s/:space/d/*', pathname)?.params['*'];
}

/**
 * Fires `onOutside` on any pointerdown outside every ref in `refs` (e.g.
 * closing a popover). `refs` only needs to be stable in *contents*, not
 * identity — `.current` is read live when the event fires, not captured up
 * front, so passing a fresh array literal each render is fine.
 */
export function useOutsideClick(refs: Array<RefObject<HTMLElement | null>>, onOutside: () => void) {
  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (refs.some((ref) => ref.current?.contains(target))) return;
      onOutside();
    }
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
    // Deliberately excludes `refs`: see docblock above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onOutside]);
}
