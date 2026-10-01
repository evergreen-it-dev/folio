import { useEffect, useState } from 'react';

/**
 * Round 26 (DATA TABLES) — the phone breakpoint for spec §14's mobile rules
 * (Filter/Sort/Hide become a bottom-sheet, the row panel goes full-screen,
 * cell editing routes through the row panel instead of inline inputs).
 *
 * Kept in step with Tailwind's `md` (768px), which is the breakpoint the
 * rest of the app's `max-md:` classes already use — and mirrors
 * editor/index.tsx's own COMPACT_QUERY hook rather than inventing a second
 * convention. Live-updating, so rotating a phone re-lays-out without a
 * reload.
 */
const MOBILE_QUERY = '(max-width: 767.98px)';

function matches(): boolean {
  // No matchMedia (jsdom, SSR) means desktop. That is the deliberate
  // default: the desktop layout is the richer one, and every non-phone
  // visit should get it — the same call editor/index.tsx documents.
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(MOBILE_QUERY).matches;
}

export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(matches);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(MOBILE_QUERY);
    const sync = () => setMobile(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  return mobile;
}
