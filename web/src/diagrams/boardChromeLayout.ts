/**
 * QA-3 finding №1 — where Folio's own board chrome is allowed to sit.
 *
 * BoardCanvas floats two of its own things over Excalidraw's canvas: the
 * export/mode row in the top-right corner and the save-state chip in the
 * bottom-right one. Excalidraw floats its own islands over that same canvas
 * — and it does so with a mix of anchoring rules:
 *
 *   - the tool island is CENTRED horizontally in the container, so its right
 *     edge moves with the container's width;
 *   - the library ("Library") trigger is anchored to the container's
 *     top-right corner — the exact corner our row claims;
 *   - the zoom cluster / help icon are anchored to the bottom corners;
 *   - below its own mobile breakpoint Excalidraw re-lays all of that out
 *     (tools move to a bottom bar, a vertical strip of buttons appears on
 *     the right edge).
 *
 * A CSS breakpoint cannot know any of that. The rule this module replaces
 * (`top-3 max-md:top-16` — one guess keyed off the *window* width) was wrong
 * in two separate ways, both measured in a real browser:
 *
 *   - on every laptop width from 1280 to ~1512 our row covered the right end
 *     of the centred tool island, so clicking "More tools" hit our
 *     "Fit to screen"/export button instead;
 *   - at EVERY width, our row sat exactly on top of Excalidraw's library
 *     trigger, making the whole Round 18 library feature unreachable by its
 *     own button (the click landed on our mode toggle).
 *
 * So we measure instead of guessing. Both functions below are pure geometry
 * over plain rects — no DOM, no React — precisely so the rule itself is
 * unit-testable; BoardCanvas does the (trivial) rect collecting and feeds
 * the result back as an inline `top`/`right`/`bottom`.
 *
 * QA-3 finding №2 (mobile, ROUND 1 — insufficient, see finding №3 below):
 * `.mobile-misc-tools-container` is a TALL strip running down the right
 * edge, not a short island in the top band. The very first version of this
 * rule only ever checked HORIZONTAL overlap and pushed the anchor below the
 * obstacle's bottom edge unconditionally — for a short island that clears it
 * by construction, but for a strip that runs most of the container's height,
 * "below its bottom edge" can be off-screen. Checking BOTH axes (below) is
 * the right fix for "does this obstacle apply at all", but it is not the
 * whole fix — see finding №3.
 *
 * QA-3 finding №3 (mobile, the actual fix): even once overlap is decided on
 * both axes, a strip pinned to the right edge and running most of the
 * container's height will, at 375px, still overlap the row's column no
 * matter how far down the row is pushed — the strip is simply taller than
 * the room the row has to move through. Pushing down forever either runs the
 * row off the bottom of the container (only the hard clamp below saves it,
 * and only by smashing it flush against the bottom edge, half covered) or,
 * on a taller obstacle still, does nothing at all once the clamp is
 * reached. Measured on the owner's own phone: the row ends up dangling in
 * the middle of an empty canvas, nowhere near either obstacle it was
 * supposedly dodging.
 *
 * The actual shape of the obstacle is the clue: a TALL, right-edge-PINNED
 * strip is not something you out-run vertically — Excalidraw put it there
 * specifically so nothing else can occupy that column for the height of the
 * strip. The only way clear of it is sideways. So `topOffsetClearing` runs
 * in two phases along two different axes, each internally identical in
 * shape to the single-axis algorithm this module has always used:
 *
 *   1. TOP phase — exactly the original rule, restricted to obstacles that
 *      are NOT a right-edge strip (isRightEdgeStrip below): push the row
 *      down, in ascending-`top` order, until it clears every one of them.
 *      Same invariant as always — see "why one pass is enough" below.
 *   2. RIGHT phase — using the row's now-FINAL vertical position (fixed for
 *      the rest of this call), the same treatment on the horizontal axis for
 *      obstacles that ARE a right-edge strip: push the row left, in
 *      descending-`left` order (nearest the row's own starting corner
 *      first — the horizontal mirror of "ascending top"), until it clears
 *      every one of them.
 *
 * Splitting into two phases over two disjoint obstacle sets, rather than one
 * interleaved pass that can move either axis per obstacle, is what keeps
 * this from oscillating or re-colliding:
 *
 *   - within phase 1, the usual argument holds unchanged: obstacles are
 *     visited nearest-first (ascending `top`), so pushing the row past one
 *     can only ever move it farther from every obstacle already ruled out,
 *     never back into one.
 *   - phase 2 can never re-collide the row with a phase-1 obstacle: an
 *     obstacle only lands in phase 1 at all when it is NOT a right-edge
 *     strip, and every phase-1 obstacle that actually pushed the row did so
 *     by moving the row's TOP past that obstacle's own bottom edge — a
 *     purely vertical fact that phase 2's purely horizontal pushes cannot
 *     undo. The row's vertical span is fixed for the whole of phase 2, so an
 *     obstacle already cleared vertically stays cleared no matter which
 *     column phase 2 ends up choosing.
 *   - within phase 2, the same nearest-first argument as phase 1 applies on
 *     the other axis: strips are visited nearest the row's own starting
 *     corner first (descending `left`, since the row starts flush against
 *     the container's right edge and only ever moves left), so pushing left
 *     past one can only move the row farther from a strip already cleared.
 *
 * Even so, a real device's obstacle strip can be taller (or the container
 * narrower) than the row has room to dodge through. So both phases, like
 * `bottomOffsetClearing`, hard-clamp their result: the row is never pushed
 * far enough to leave the container on either axis. Worst case it ends up
 * flush against an obstacle instead of clear of it — still visible beats
 * correctly hidden. With finding №3 fixed, this clamp is now the true
 * last resort it was always meant to be, not — as it was before this fix —
 * the only thing standing between the row and a strip more than half its
 * own height.
 *
 * `bottomOffsetClearing` (the save-state chip) does NOT get the same
 * sideways treatment. Not an oversight: every selector it actually reads
 * (EXCALIDRAW_BOTTOM_OBSTACLES below) is, by Excalidraw's own shipped CSS,
 * incapable of being a tall right-edge strip in the first place —
 * `.mobile-misc-tools-container` (the one strip this module knows about) is
 * exclusively a TOP-band obstacle and never appears in the bottom list; the
 * mobile `.App-bottom-bar > .Island` is `width:100%` (a full-width bar, not
 * a right-pinned column); and the desktop footer islands are short button
 * clusters. A vertical-only push already clears every real obstacle the
 * bottom chip can meet, so `bottomOffsetClearing` keeps its original single-
 * axis shape — see its own docblock.
 */

/** The structural subset of DOMRect these functions need — so tests can pass plain objects. */
export interface EdgeRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** How far our chrome is pushed from the container's top-right corner. */
export interface ChromeRowOffset {
  top: number;
  right: number;
}

/** Matches `right-3`/`top-3` (0.75rem): the corner inset our chrome uses when nothing is in its way. */
export const CHROME_EDGE_GAP = 12;

/**
 * Breathing room left between our chrome and an Excalidraw island it had to
 * step around. Smaller than CHROME_EDGE_GAP on purpose: this is a gap
 * between two floating controls, not a page margin.
 */
export const CHROME_ISLAND_GAP = 8;

/**
 * How much taller than our own row an obstacle has to be before it counts as
 * a "strip" to dodge sideways rather than a merely-a-bit-taller island to
 * step below (isRightEdgeStrip). 1.5x comfortably separates the two real
 * cases measured in the browser: the top toolbar (40px against a 28px
 * mobile row — ~1.4x, stays a "step below" obstacle) from the actual strip
 * (102px against the same 28px row — ~3.6x).
 */
const SIDE_STRIP_HEIGHT_RATIO = 1.5;

/**
 * Excalidraw's own floating UI in the TOP band, as the container-scoped
 * selectors its layout has published for years (these are the same class
 * names its public CSS themes hang off, checked against the installed
 * 0.18.1 in both its desktop and its mobile layout):
 *
 *   - `.App-menu_top__left`      — the hamburger menu (desktop)
 *   - `.App-toolbar-container`   — the centred tool island (desktop AND the
 *                                  mobile `.App-toolbar--mobile` variant)
 *   - `.layer-ui__wrapper__top-right` — the library trigger's own wrapper;
 *                                  it collapses to zero height in view mode,
 *                                  which the zero-size filter below drops
 *   - `.mobile-misc-tools-container` — the vertical strip of buttons
 *                                  Excalidraw pins to the right edge in its
 *                                  mobile layout (own CSS: `position:
 *                                  absolute; right: calc(<padding> * -1)` —
 *                                  i.e. flush against the edge by
 *                                  construction, not by coincidence)
 *
 * Anything that disappears from a future version simply stops contributing;
 * a missing selector can never make the result *wrong*, only less padded —
 * which is why this list is allowed to be a list rather than something
 * cleverer.
 */
export const EXCALIDRAW_TOP_OBSTACLES = [
  '.App-menu_top__left',
  '.App-toolbar-container',
  '.layer-ui__wrapper__top-right',
  '.mobile-misc-tools-container',
] as const;

/**
 * Same idea for the BOTTOM band: the zoom/undo cluster and the help icon on
 * desktop (`.layer-ui__wrapper__footer-left` / `-right`), and the whole tool
 * island Excalidraw moves down there in its mobile layout
 * (`.App-bottom-bar .Island`). The full-width `.App-bottom-bar` wrapper
 * itself is deliberately NOT in this list — it spans the entire canvas
 * height and would push the chip off-screen; only the island inside it is a
 * real obstacle. None of these three is ever a tall right-edge strip (see
 * the module docblock's closing paragraph), which is why
 * `bottomOffsetClearing` stays single-axis.
 */
export const EXCALIDRAW_BOTTOM_OBSTACLES = [
  '.layer-ui__wrapper__footer-left',
  '.layer-ui__wrapper__footer-right',
  '.App-bottom-bar .Island',
] as const;

/** Zero-area rects are Excalidraw's way of saying "this slot is empty right now" (view mode collapses its top-right wrapper exactly like this). */
function isVisible(rect: EdgeRect): boolean {
  return rect.right > rect.left && rect.bottom > rect.top;
}

/** The left/right subset overlapsHorizontally actually needs — so a not-yet-final anchor position can be checked without inventing a fake top/bottom for it. */
interface HorizontalSpan {
  left: number;
  right: number;
}

/** Two spans share some horizontal range — the axis a vertical-only push never changes. */
function overlapsHorizontally(a: HorizontalSpan, b: HorizontalSpan): boolean {
  return b.right > a.left && b.left < a.right;
}

/** Two rects share some vertical range — checked against the anchor's CURRENT (possibly already-pushed) position. */
function overlapsVertically(top: number, bottom: number, obstacle: EdgeRect): boolean {
  return obstacle.bottom > top && obstacle.top < bottom;
}

/**
 * Is `obstacle` Excalidraw's mobile side strip (`.mobile-misc-tools-
 * container`) rather than a short island that merely shares its corner?
 * Two independent checks, both against the CONTAINER rather than the
 * anchor, so a short island that happens to sit near the same corner — the
 * library trigger, e.g. — is never misclassified:
 *
 *   - pinned flush to the container's right edge (within one
 *     CHROME_ISLAND_GAP of it) — Excalidraw's own CSS puts this strip there
 *     with `right: calc(<padding> * -1)`, i.e. touching or past the edge,
 *     unlike the centred tool island or the corner-anchored (but not
 *     edge-flush) library trigger;
 *   - clearly taller than our own row (SIDE_STRIP_HEIGHT_RATIO) — the ratio
 *     is what keeps a merely-a-bit-taller island (the toolbar) out of this
 *     branch; see SIDE_STRIP_HEIGHT_RATIO's own comment for the measured
 *     numbers that picked 1.5x.
 */
function isRightEdgeStrip(obstacle: EdgeRect, containerRight: number, anchorHeight: number, gap: number): boolean {
  const pinnedToRightEdge = containerRight - obstacle.right <= gap;
  const muchTallerThanRow = obstacle.bottom - obstacle.top >= anchorHeight * SIDE_STRIP_HEIGHT_RATIO;
  return pinnedToRightEdge && muchTallerThanRow;
}

/**
 * How far our own top-right chrome row has to sit from the container's
 * top-right corner — both down from the top and in from the right — so it
 * clears every obstacle standing in its way. Returns `{top: base, right:
 * base}` (the plain corner inset) when nothing is in the way, and never
 * pushes `anchor` far enough to leave [containerTop, containerBottom] or
 * [containerLeft, containerRight] on its own axis — see the module docblock
 * for the two-phase rule and why it doesn't oscillate.
 */
export function topOffsetClearing(
  anchor: EdgeRect,
  obstacles: readonly EdgeRect[],
  container: EdgeRect,
  base: number = CHROME_EDGE_GAP,
  gap: number = CHROME_ISLAND_GAP,
): ChromeRowOffset {
  const anchorHeight = anchor.bottom - anchor.top;
  const anchorWidth = anchor.right - anchor.left;
  const visible = obstacles.filter(isVisible);
  const strips = visible.filter((o) => isRightEdgeStrip(o, container.right, anchorHeight, gap));
  const verticalObstacles = visible.filter((o) => !strips.includes(o));

  // Phase 1: straight down, exactly the original single-axis rule, over the
  // non-strip obstacles only. Ascending `top` — see the module docblock.
  let top = base;
  for (const obstacle of [...verticalObstacles].sort((a, b) => a.top - b.top)) {
    if (!overlapsHorizontally(anchor, obstacle)) continue;
    if (!overlapsVertically(container.top + top, container.top + top + anchorHeight, obstacle)) continue;
    top = obstacle.bottom - container.top + gap;
  }
  const maxTop = Math.max(0, container.bottom - container.top - anchorHeight);
  top = Math.min(top, maxTop);

  // Phase 2: sideways, over the strip obstacles only, against the row's now
  // fixed vertical span. Descending `left` — the horizontal mirror of
  // "ascending top" (the row starts flush against the right edge and only
  // ever moves left) — see the module docblock.
  let right = base;
  const rowTop = container.top + top;
  const rowBottom = rowTop + anchorHeight;
  for (const strip of [...strips].sort((a, b) => b.left - a.left)) {
    const currentRight = container.right - right;
    const currentLeft = currentRight - anchorWidth;
    if (!overlapsHorizontally({ left: currentLeft, right: currentRight }, strip)) continue;
    if (!overlapsVertically(rowTop, rowBottom, strip)) continue;
    right = container.right - strip.left + gap;
  }
  const maxRight = Math.max(0, container.right - container.left - anchorWidth);
  right = Math.min(right, maxRight);

  return { top, right };
}

/**
 * The mirror image for a bottom-anchored control: how far above the
 * container's bottom edge it has to sit to clear the islands in its column,
 * hard-clamped the same way as topOffsetClearing's TOP phase. Stays
 * single-axis (a plain number, not a {top,right} pair) — see the module
 * docblock's closing paragraph for why none of EXCALIDRAW_BOTTOM_OBSTACLES
 * can be a tall right-edge strip in the first place.
 */
export function bottomOffsetClearing(
  anchor: EdgeRect,
  obstacles: readonly EdgeRect[],
  container: EdgeRect,
  base: number = CHROME_EDGE_GAP,
  gap: number = CHROME_ISLAND_GAP,
): number {
  const anchorHeight = anchor.bottom - anchor.top;
  let offset = base;
  // Descending `bottom`: the anchor starts near the container's bottom edge,
  // so the obstacles nearest THAT edge are the ones it can reach first —
  // the mirror image of topOffsetClearing's ascending-`top` order.
  const ordered = [...obstacles].filter(isVisible).sort((a, b) => b.bottom - a.bottom);
  for (const obstacle of ordered) {
    if (!overlapsHorizontally(anchor, obstacle)) continue;
    if (!overlapsVertically(container.bottom - offset - anchorHeight, container.bottom - offset, obstacle)) continue;
    offset = container.bottom - obstacle.top + gap;
  }
  const maxOffset = Math.max(0, container.bottom - container.top - anchorHeight);
  return Math.min(offset, maxOffset);
}

/**
 * Reads the live rects of Excalidraw's own floating UI out of `container`
 * (BoardCanvas's own wrapper, which the <Excalidraw> subtree lives inside).
 * Split out from the maths above only so the DOM half stays in one small,
 * obvious place; the selectors are scoped to the container so a second board
 * elsewhere on the page could never leak into this one's measurement.
 */
export function collectObstacleRects(container: Element, selectors: readonly string[]): EdgeRect[] {
  const rects: EdgeRect[] = [];
  for (const selector of selectors) {
    for (const element of container.querySelectorAll(selector)) {
      const { top, right, bottom, left } = element.getBoundingClientRect();
      rects.push({ top, right, bottom, left });
    }
  }
  return rects;
}
