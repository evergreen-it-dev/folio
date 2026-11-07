/**
 * The one-time «we updated the design» tour (07.11.2026): where things moved
 * after the chrome redesign. Each step is anchored to an element by a
 * `data-tour="…"` attribute that the component owning that element carries;
 * a step whose anchor is not in the DOM (sidebar collapsed, right panel
 * hidden, a small screen) is skipped.
 */
export interface WhatsNewStep {
  id: string;
  /** CSS selector; the FIRST visible match is used. */
  selector: string;
  /** Key under `whatsNew.steps` in the `app` namespace. */
  i18nKey: 'search' | 'treeChevron' | 'pageActions' | 'properties' | 'rightPanel';
  /** Which side of the anchor its tag sits on (the tag's arrow points back at the anchor). */
  side: 'right' | 'left' | 'below' | 'belowLeft';
}

export const WHATS_NEW_STORAGE_KEY = 'folio:whats-new:2026-11-design';

/** Window event: `openWhatsNewTour()` dispatches it, and the mounted hint shows again. */
export const WHATS_NEW_OPEN_EVENT = 'folio:whats-new-open';

export const WHATS_NEW_STEPS: WhatsNewStep[] = [
  { id: 'search', selector: '[data-tour="search"]', i18nKey: 'search', side: 'right' },
  { id: 'tree-chevron', selector: '[data-tour="tree-chevron"]', i18nKey: 'treeChevron', side: 'right' },
  { id: 'page-actions', selector: '[data-tour="page-actions"]', i18nKey: 'pageActions', side: 'below' },
  { id: 'properties', selector: '[data-tour="properties"] button', i18nKey: 'properties', side: 'right' },
  { id: 'right-panel', selector: '[data-tour="graph-links"]', i18nKey: 'rightPanel', side: 'belowLeft' },
];

/** First match of `selector` that actually takes up space (display:none / hidden panels have a 0x0 rect). */
export function findVisibleAnchor(selector: string): HTMLElement | null {
  const nodes = document.querySelectorAll<HTMLElement>(selector);
  for (const el of Array.from(nodes)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el;
  }
  return null;
}

export function hasSeenWhatsNew(): boolean {
  try {
    return window.localStorage.getItem(WHATS_NEW_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function markWhatsNewSeen(): void {
  try {
    window.localStorage.setItem(WHATS_NEW_STORAGE_KEY, '1');
  } catch {
    // Storage unavailable: the tour may show again next load; harmless.
  }
}

/** Reopen the tour later (e.g. from a help menu), regardless of the «seen» flag. */
export function openWhatsNewTour(): void {
  window.dispatchEvent(new CustomEvent(WHATS_NEW_OPEN_EVENT));
}
