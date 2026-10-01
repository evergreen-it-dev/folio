import { useEffect } from 'react';
import { useLocalStorage } from './hooks';

export interface RecentPage {
  space: string;
  id: string;
  title: string;
  icon?: string;
  visitedAt: string; // ISO
}

const RECENTS_KEY = 'folio:recents';
const MAX_RECENTS = 15;

/**
 * Pure reducer: records a visit, moving it to the front and deduping by
 * (space, id) — a page re-visited later should jump back to the top, not
 * appear twice. Caps at MAX_RECENTS. Cross-space by design (DEV-PLAN: the
 * quick switcher's "Recent" spans every space, not just the current one).
 */
export function addRecent(list: RecentPage[], entry: Omit<RecentPage, 'visitedAt'>, visitedAt: string = new Date().toISOString()): RecentPage[] {
  const deduped = list.filter((r) => !(r.space === entry.space && r.id === entry.id));
  return [{ ...entry, visitedAt }, ...deduped].slice(0, MAX_RECENTS);
}

export function useRecents() {
  return useLocalStorage<RecentPage[]>(RECENTS_KEY, []);
}

/** Records a visit on mount/whenever the page identity changes — call from PageView/PageContent once the page has loaded. */
export function useRecordRecentVisit(page: { space: string; id: string; title: string; icon?: string } | undefined) {
  const [, setRecents] = useRecents();
  useEffect(() => {
    if (!page) return;
    setRecents((prev) => addRecent(prev, page));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page?.space, page?.id, page?.title, page?.icon]);
}
