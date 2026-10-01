/**
 * Collapsible reading-view sections. The structure itself (the
 * .folio-collapsible/-body/-stub wrapper, and the pre-counted "N hidden
 * blocks" stub) is baked into the rendered HTML string by the
 * rehypeCollapsibleSections pipeline plugin — see that file's docblock for
 * why. This module only ever toggles a class on elements that live inside a
 * dangerouslySetInnerHTML region, which React never reconciles into unless
 * the HTML string itself changes, so it can't conflict with React's own
 * management of the segment wrapper divs around that region.
 */

const COLLAPSED_KEY_PREFIX = 'folio:collapsed:';

/** Applies (or clears) the collapsed look for every section from a set of collapsed slugs; markdown.css shows the body or the stub based on this one class. */
export function applyCollapseState(container: HTMLElement, collapsedSlugs: ReadonlySet<string>): void {
  for (const section of Array.from(container.querySelectorAll<HTMLElement>('.folio-collapsible'))) {
    const slug = section.dataset.collapseSlug;
    section.classList.toggle('folio-collapsible--collapsed', !!slug && collapsedSlugs.has(slug));
  }
}

export function readCollapsedSlugs(pageId: string): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY_PREFIX + pageId);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? new Set(parsed.filter((v): v is string => typeof v === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

export function writeCollapsedSlugs(pageId: string, slugs: ReadonlySet<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY_PREFIX + pageId, JSON.stringify(Array.from(slugs)));
  } catch {
    // Storage full/unavailable — collapse state just won't persist across reloads.
  }
}
