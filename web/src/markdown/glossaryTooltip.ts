/**
 * The hover card for a glossary term (glossaryTerms.ts wraps every occurrence
 * in `<abbr class="folio-glossary-term" title="…">`).
 *
 * Why not just leave the browser's own `title` tooltip: the owner hovered a
 * term on prod and saw nothing (11.09). Native tooltips wait about a second,
 * need the pointer to sit still, and are invisible on touch — for a word
 * whose whole point is "what does this mean?", that reads as broken. So the
 * app draws its own: appears in 150ms, styled like the rest of the chrome,
 * and positioned against the VIEWPORT.
 *
 * `position: fixed` + a node appended to <body>, not an absolutely-positioned
 * child, for the reason this codebase has now hit three times (ui/Menu.tsx,
 * header/PagePresence.tsx): the page's scroll container is `overflow`-clipped,
 * and an absolutely-positioned tooltip inside prose gets sliced at its edge.
 *
 * The `title` attribute is MOVED to `data-glossary-title` on attach rather
 * than read in place, so the browser can't race us with its own tooltip on
 * the same element. It stays in the exported/shared HTML, where no JS of ours
 * runs and the native tooltip is the fallback — that is the whole reason the
 * pipeline emits a real `<abbr title>` instead of a bare span.
 */

const TERM_SELECTOR = '.folio-glossary-term';
const TITLE_DATA = 'glossaryTitle';
/** Long enough not to flash while the pointer crosses a paragraph, short enough to feel like an answer. */
const SHOW_DELAY_MS = 150;
/** Breathing room from the term and from the viewport edges. */
const GAP = 6;

function readDescription(el: HTMLElement): string | null {
  const stored = el.dataset[TITLE_DATA];
  if (stored) return stored;
  const title = el.getAttribute('title');
  if (!title) return null;
  // Move it: see the module docblock (no duplicate native tooltip).
  el.dataset[TITLE_DATA] = title;
  el.removeAttribute('title');
  return title;
}

function place(tip: HTMLElement, term: HTMLElement): void {
  const anchor = term.getBoundingClientRect();
  const box = tip.getBoundingClientRect();
  let left = anchor.left;
  left = Math.min(left, document.documentElement.clientWidth - box.width - GAP);
  left = Math.max(left, GAP);
  // Below the word, flipping above when there is no room down there.
  let top = anchor.bottom + GAP;
  if (top + box.height > document.documentElement.clientHeight - GAP) {
    top = Math.max(GAP, anchor.top - GAP - box.height);
  }
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
}

/**
 * Wires the hover card for every glossary term inside `container`. Returns the
 * teardown, so callers can hand it straight back from a React effect.
 */
export function attachGlossaryTooltips(container: HTMLElement): () => void {
  let tip: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const hide = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    tip?.remove();
    tip = null;
  };

  const show = (term: HTMLElement): void => {
    const description = readDescription(term);
    if (!description) return;
    hide();
    timer = setTimeout(() => {
      timer = null;
      const node = document.createElement('div');
      node.className = 'folio-glossary-tip';
      node.setAttribute('role', 'tooltip');
      node.textContent = description;
      document.body.appendChild(node);
      tip = node;
      place(node, term);
    }, SHOW_DELAY_MS);
  };

  const onOver = (event: Event): void => {
    const target = (event.target as HTMLElement | null)?.closest?.(TERM_SELECTOR);
    if (target instanceof HTMLElement) show(target);
  };
  const onOut = (event: Event): void => {
    const from = (event.target as HTMLElement | null)?.closest?.(TERM_SELECTOR);
    if (from) hide();
  };

  container.addEventListener('pointerover', onOver);
  container.addEventListener('pointerout', onOut);
  // Fixed coordinates go stale the moment anything moves under them — same
  // call ui/Menu.tsx makes: close rather than chase. Capture phase because
  // scroll doesn't bubble.
  window.addEventListener('scroll', hide, { capture: true });
  window.addEventListener('resize', hide);

  return () => {
    container.removeEventListener('pointerover', onOver);
    container.removeEventListener('pointerout', onOut);
    window.removeEventListener('scroll', hide, { capture: true });
    window.removeEventListener('resize', hide);
    hide();
  };
}
