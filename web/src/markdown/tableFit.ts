/**
 * Reading-view fit/scroll toggle for wide tables. The wrapper/button
 * structure is baked into the rendered HTML string by rehypeWrapTables
 * (tables.ts) — this module only ever measures and toggles classes/an
 * aria-label on elements living inside a dangerouslySetInnerHTML region,
 * same reasoning (and same safety-from-React-reconciliation) as
 * collapsible.ts.
 *
 * Two functions, but ALWAYS called together, in this order, from ONE effect
 * in index.tsx — never measureWideTables alone on one dependency change and
 * applyTableFitState alone on another. See index.tsx's own comment on that
 * effect for the full story: react-dom compares dangerouslySetInnerHTML's
 * `{ __html }` wrapper by object reference, not by the string inside it, so
 * an unstable reference there (verified directly against this project's
 * React/react-dom build with a MutationObserver — an easy mistake to
 * reintroduce, not a permanent guarantee) would silently reset every
 * wrapper's `--wide`/`--fit` classes back to their pristine baked state on
 * ANY re-render, including one a click on THIS toggle causes. A
 * measure-only-on-fresh-render effect would have no way to notice that and
 * the click would appear to do nothing. Measuring fresh on every call here
 * costs nothing perceptible and is correct either way: whatever would
 * invalidate a stale measurement also reverts the table to auto layout, so
 * "measuring while already fixed" never happens as long as measure always
 * runs immediately before apply, in the same pass.
 *
 *  - measureWideTables: reads each wrapper's NATURAL (auto-layout)
 *    scrollWidth/clientWidth and records the verdict as the
 *    `folio-table-wrap--wide` class.
 *
 *  - applyTableFitState: reads the `--wide` class measureWideTables just set
 *    plus the per-table override set (indices where the reader chose
 *    "scroll") to decide `--fit` and the button's aria-label.
 *
 * A table is only ever offered the toggle at all when it's actually wide;
 * markdown.css hides `.folio-table-toggle` entirely unless its wrapper
 * carries `--wide`, so a narrow table (already fits, nothing to switch)
 * never shows a control for it — see that file's own comment.
 */

const SCROLL_KEY_PREFIX = 'folio:tableScroll:';

/** Marks each toggleable `.folio-table-wrap` inside `container` as wide
 * (would overflow in its natural, auto table-layout) or not. Skips a wrap
 * with no `[data-table-toggle]` button entirely (a `folio-table-sized`
 * table — tables.ts never gives one a toggle, see its own doc comment) —
 * `--wide` would be meaningless there: nothing reads it without a button to
 * show or hide. Callers must always follow this with applyTableFitState, in
 * the same synchronous pass — see this file's own doc comment for why
 * measuring on its own, cached across renders, is not safe here. */
export function measureWideTables(container: HTMLElement): void {
  for (const button of Array.from(container.querySelectorAll<HTMLElement>('[data-table-toggle]'))) {
    const wrap = button.closest<HTMLElement>('.folio-table-wrap');
    if (!wrap) continue;
    const wide = wrap.scrollWidth > wrap.clientWidth;
    wrap.classList.toggle('folio-table-wrap--wide', wide);
  }
}

/** Labels for the toggle button's accessible name, describing the ACTION a
 * click takes (mirrors .folio-collapse-toggle's own "Collapse section",
 * which names the action, not the current state) — resolved by the caller
 * via i18next's `useTranslation('markdown')` so this stays a pure DOM
 * function with no i18n dependency of its own. */
export interface TableToggleLabels {
  /** Shown while the table is fit — the click switches it to scroll. */
  switchToScroll: string;
  /** Shown while the table is scrolling — the click switches it to fit. */
  switchToFit: string;
}

/** Applies `folio-table-wrap--fit` (and the matching aria-label) to every
 * toggleable table in `container`, from the already-recorded `--wide` class
 * (see measureWideTables) and `scrollOverrides` — the 0-based table indices
 * (tables.ts's TableIndexCursor) for which the reader explicitly chose
 * scroll over the default fit. A table that isn't wide is left alone: no
 * `--fit` either way, since there is nothing to fit. */
export function applyTableFitState(
  container: HTMLElement,
  scrollOverrides: ReadonlySet<number>,
  labels: TableToggleLabels,
): void {
  for (const button of Array.from(container.querySelectorAll<HTMLButtonElement>('[data-table-toggle]'))) {
    const wrap = button.closest<HTMLElement>('.folio-table-wrap');
    if (!wrap) continue;
    const index = Number(button.dataset.tableToggle);
    const wide = wrap.classList.contains('folio-table-wrap--wide');
    const fit = wide && !scrollOverrides.has(index);
    wrap.classList.toggle('folio-table-wrap--fit', fit);
    button.setAttribute('aria-label', fit ? labels.switchToScroll : labels.switchToFit);
  }
}

export function readTableScrollOverrides(pageId: string): Set<number> {
  try {
    const raw = localStorage.getItem(SCROLL_KEY_PREFIX + pageId);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? new Set(parsed.filter((v): v is number => typeof v === 'number')) : new Set();
  } catch {
    return new Set();
  }
}

export function writeTableScrollOverrides(pageId: string, indices: ReadonlySet<number>): void {
  try {
    localStorage.setItem(SCROLL_KEY_PREFIX + pageId, JSON.stringify(Array.from(indices)));
  } catch {
    // Storage full/unavailable — the toggle just won't persist across reloads.
  }
}
