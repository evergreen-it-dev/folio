// @vitest-environment jsdom
/**
 * QA-3 finding №1. Two things are pinned here:
 *
 *   1. the geometry rule itself (pure, no DOM) — reproduced against the
 *      REAL measurements taken in a browser at the widths the finding named,
 *      so a future "simplification" back to a CSS breakpoint fails loudly;
 *   2. that we read Excalidraw's rects from inside our own container only.
 *
 * QA-3 finding №3 adds a second axis: `topOffsetClearing` now returns
 * `{top, right}`, not a bare number, because a tall obstacle pinned to the
 * container's right edge (Excalidraw's mobile `.mobile-misc-tools-
 * container`) has to be dodged sideways, not chased downward — see
 * boardChromeLayout.ts's module docblock for the full story and the
 * two-phase rule that replaces the old single-axis one.
 */
import { describe, expect, it } from 'vitest';
import {
  CHROME_EDGE_GAP,
  CHROME_ISLAND_GAP,
  EXCALIDRAW_BOTTOM_OBSTACLES,
  EXCALIDRAW_TOP_OBSTACLES,
  bottomOffsetClearing,
  collectObstacleRects,
  topOffsetClearing,
  type EdgeRect,
} from './boardChromeLayout';

/** Shorthand for the {top,right,bottom,left} shape, in the same order getBoundingClientRect reports it. */
const rect = (left: number, top: number, width: number, height: number): EdgeRect => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});

// Measured in Chrome on the real app, 1440x900 with the app sidebar open,
// board in "Edit". The canvas container starts at y=100.
const CONTAINER_TOP = 100;
const CONTAINER_BOTTOM = 900;
const CONTAINER_1440 = rect(0, CONTAINER_TOP, 1440, CONTAINER_BOTTOM - CONTAINER_TOP);
const CHROME_ROW_1440 = rect(1086, 112, 342, 30);
const TOOL_ISLAND_1440 = rect(585, 116, 550, 44);
const LIBRARY_TRIGGER_1440 = rect(1167, 116, 257, 36);
const HAMBURGER_1440 = rect(296, 116, 36, 36);

// Mobile-shaped container (375px wide) for the QA-3 finding №2/№3 cases —
// same CONTAINER_TOP/CONTAINER_BOTTOM as above, just narrower, so the tall
// strip's own right edge (338+37=375) really does land flush against it.
const CONTAINER_MOBILE = rect(0, CONTAINER_TOP, 375, CONTAINER_BOTTOM - CONTAINER_TOP);

describe('topOffsetClearing', () => {
  it('leaves the plain corner inset when nothing shares the row\'s column (view mode: no islands at all)', () => {
    expect(topOffsetClearing(CHROME_ROW_1440, [], CONTAINER_1440)).toEqual({
      top: CHROME_EDGE_GAP,
      right: CHROME_EDGE_GAP,
    });
  });

  it('ignores an island that is nowhere near the row horizontally (the top-left hamburger)', () => {
    expect(topOffsetClearing(CHROME_ROW_1440, [HAMBURGER_1440], CONTAINER_1440)).toEqual({
      top: CHROME_EDGE_GAP,
      right: CHROME_EDGE_GAP,
    });
  });

  it('ignores a collapsed, zero-height slot — that is how Excalidraw spells "empty" in view mode', () => {
    const collapsed = rect(1167, 116, 257, 0);
    expect(topOffsetClearing(CHROME_ROW_1440, [collapsed], CONTAINER_1440)).toEqual({
      top: CHROME_EDGE_GAP,
      right: CHROME_EDGE_GAP,
    });
  });

  it('drops the row below the centred tool island once the two overlap (the 1280-1512 laptop bug)', () => {
    // island bottom 160, container top 100 -> 60 below the container's top edge, + gap
    expect(topOffsetClearing(CHROME_ROW_1440, [TOOL_ISLAND_1440], CONTAINER_1440)).toEqual({
      top: 60 + CHROME_ISLAND_GAP,
      right: CHROME_EDGE_GAP,
    });
  });

  it('drops the row below the library trigger even on a wide screen where the tool island is far away', () => {
    // 1920px: the island no longer reaches our column, but the library
    // trigger is corner-anchored and always does — this is the half of the
    // finding that made Excalidraw's own library button unclickable at EVERY
    // width, not just on laptops. It is NOT flush against the edge (16px
    // short of it), so it's still a plain "step below" obstacle, not a
    // sideways-dodge one.
    const container1920 = rect(0, CONTAINER_TOP, 1920, CONTAINER_BOTTOM - CONTAINER_TOP);
    const rowAt1920 = rect(1566, 112, 342, 30);
    const islandAt1920 = rect(825, 116, 550, 44);
    const libraryAt1920 = rect(1647, 116, 257, 36);
    expect(topOffsetClearing(rowAt1920, [islandAt1920], container1920)).toEqual({
      top: CHROME_EDGE_GAP,
      right: CHROME_EDGE_GAP,
    });
    expect(topOffsetClearing(rowAt1920, [islandAt1920, libraryAt1920], container1920)).toEqual({
      top: 52 + CHROME_ISLAND_GAP,
      right: CHROME_EDGE_GAP,
    });
  });

  it('QA-3 finding №3: a short-ish top island still pushes the row down, but a genuinely tall strip flush with the right edge pushes it SIDEWAYS instead of chasing it further down', () => {
    // 375px in edit mode: Excalidraw stacks a top island (not flush with the
    // edge, only ~1.4x our row's height — a "step below" obstacle) and a
    // tall vertical strip flush against the right edge (~3.6x our row's
    // height — a "dodge sideways" obstacle). This is the owner's own repro,
    // reproduced with the container's origin at (0,100) instead of the real
    // (0,133) — the offsets this module computes only depend on distances,
    // never on the container's absolute position, so the numbers below are
    // identical to the literal browser measurements in the next test.
    const compactRow = rect(335, 112, 28, 28);
    const mobileIsland = rect(25, 116, 325, 40);
    const tallStrip = rect(338, 180, 37, 102);
    const expected = { top: 64, right: 45 };
    expect(topOffsetClearing(compactRow, [mobileIsland, tallStrip], CONTAINER_MOBILE)).toEqual(expected);
    // order must not matter — phase 1 and phase 2 each re-sort their own
    // (disjoint) obstacle set regardless of input order
    expect(topOffsetClearing(compactRow, [tallStrip, mobileIsland], CONTAINER_MOBILE)).toEqual(expected);
  });

  it('QA-3 finding №3, literal repro: the owner\'s own browser measurements at 375x812 (container top=133, bottom=812) — the previous fix (two-axis overlap, no sideways dodge) returned top=190, dangling the row in the middle of the empty canvas', () => {
    const ownerRow = rect(335, 145, 28, 28); // right=363, bottom=173
    const ownerToolbar = rect(25, 149, 325, 40); // .App-toolbar-container, right=350, bottom=189
    const ownerStrip = rect(338, 213, 37, 102); // .mobile-misc-tools-container, right=375, bottom=315
    const ownerContainer = rect(0, 133, 375, 812 - 133);
    expect(topOffsetClearing(ownerRow, [ownerToolbar, ownerStrip], ownerContainer)).toEqual({ top: 64, right: 45 });
  });

  it('clears the LOWEST of several overlapping NON-strip islands, not merely the first', () => {
    // Two short top islands, neither flush with the right edge — both stay
    // "step below" obstacles, so the row still cascades straight down past
    // both, same as before finding №3.
    const compactRow = rect(335, 112, 28, 28);
    const firstIsland = rect(25, 116, 325, 40); // bottom 156
    const secondIsland = rect(300, 150, 50, 32); // bottom 182, right=350 (not flush)
    expect(topOffsetClearing(compactRow, [firstIsland, secondIsland], CONTAINER_MOBILE)).toEqual({
      top: 182 - CONTAINER_TOP + CHROME_ISLAND_GAP,
      right: CHROME_EDGE_GAP,
    });
    // order must not matter
    expect(topOffsetClearing(compactRow, [secondIsland, firstIsland], CONTAINER_MOBILE)).toEqual({
      top: 182 - CONTAINER_TOP + CHROME_ISLAND_GAP,
      right: CHROME_EDGE_GAP,
    });
  });

  it('treats edge-to-edge adjacency as "not overlapping" — touching is fine, covering is not', () => {
    const justLeftOfTheRow = rect(1000, 116, CHROME_ROW_1440.left - 1000, 44);
    expect(topOffsetClearing(CHROME_ROW_1440, [justLeftOfTheRow], CONTAINER_1440)).toEqual({
      top: CHROME_EDGE_GAP,
      right: CHROME_EDGE_GAP,
    });
    const oneMorePixel = rect(1000, 116, CHROME_ROW_1440.left - 1000 + 1, 44);
    const pushed = topOffsetClearing(CHROME_ROW_1440, [oneMorePixel], CONTAINER_1440);
    expect(pushed.top).toBeGreaterThan(CHROME_EDGE_GAP);
  });

  it('is idempotent: feeding the pushed-down row back in yields the same offset (no observer feedback loop)', () => {
    const obstacles = [TOOL_ISLAND_1440, LIBRARY_TRIGGER_1440];
    const first = topOffsetClearing(CHROME_ROW_1440, obstacles, CONTAINER_1440);
    const moved = { ...CHROME_ROW_1440, top: CONTAINER_TOP + first.top, bottom: CONTAINER_TOP + first.top + 30 };
    expect(topOffsetClearing(moved, obstacles, CONTAINER_1440)).toEqual(first);
  });

  it('QA-3 finding №2: a tall vertical strip along the right edge that never reaches the row\'s row does NOT push it, on either axis', () => {
    // The real bug: `.mobile-misc-tools-container` measured at 375x812,
    // t=213..315 — far below where the row (t=112..140-ish) actually sits.
    // Shares the row's column horizontally, but not its row vertically.
    const compactRow = rect(335, 112, 28, 28);
    const sideStripBelow = rect(338, 213, 37, 102);
    expect(topOffsetClearing(compactRow, [sideStripBelow], CONTAINER_MOBILE)).toEqual({
      top: CHROME_EDGE_GAP,
      right: CHROME_EDGE_GAP,
    });
  });

  it('QA-3 finding №3: a tall strip that DOES overlap the row at its current position clears it SIDEWAYS, not by chasing it further down', () => {
    const compactRow = rect(335, 112, 28, 28); // spans 112..140
    const stripOverlapping = rect(338, 120, 37, 300); // starts inside the row's own span, flush with the right edge
    const offset = topOffsetClearing(compactRow, [stripOverlapping], CONTAINER_MOBILE);
    // top is untouched (no non-strip obstacle in the way); right steps left
    // past the strip's own left edge, plus the island gap.
    expect(offset).toEqual({ top: CHROME_EDGE_GAP, right: 375 - 338 + CHROME_ISLAND_GAP });
  });

  it('never pushes the row below the container\'s bottom edge — a tall NON-strip obstacle is top-clamped, not followed off-screen', () => {
    const compactRow = rect(335, 112, 28, 28); // 812x-viewport row
    const shortContainer = rect(0, CONTAINER_TOP, 375, 812 - CONTAINER_TOP);
    // Overlaps the row's column (300..350) but stops 25px short of the right
    // edge — well outside the CHROME_ISLAND_GAP tolerance — so it's a plain
    // "step below" obstacle even though it's very tall.
    const tallNonStripObstacle = rect(300, 100, 50, 800); // bottom at 900, right=350
    const rowHeight = 28;
    const unclamped = tallNonStripObstacle.bottom - CONTAINER_TOP + CHROME_ISLAND_GAP;
    expect(unclamped).toBeGreaterThan(812 - CONTAINER_TOP - rowHeight); // sanity: the bug this guards against

    const offset = topOffsetClearing(compactRow, [tallNonStripObstacle], shortContainer);
    expect(offset).toEqual({ top: 812 - CONTAINER_TOP - rowHeight, right: CHROME_EDGE_GAP });
    expect(CONTAINER_TOP + offset.top + rowHeight).toBeLessThanOrEqual(812);
  });

  it('never pushes the row left of the container\'s left edge — an unrealistically wide strip is right-clamped, not followed off-screen', () => {
    const compactRow = rect(335, 112, 28, 28);
    const narrowContainer = rect(0, CONTAINER_TOP, 375, CONTAINER_BOTTOM - CONTAINER_TOP);
    // Spans the full container width and is flush with the right edge —
    // an extreme case (a real strip is much narrower), but the clamp must
    // hold regardless.
    const fullWidthStrip = rect(0, 100, 375, 700);
    const anchorWidth = 28;
    const unclamped = narrowContainer.right - fullWidthStrip.left + CHROME_ISLAND_GAP;
    expect(unclamped).toBeGreaterThan(narrowContainer.right - narrowContainer.left - anchorWidth); // sanity

    const offset = topOffsetClearing(compactRow, [fullWidthStrip], narrowContainer);
    expect(offset).toEqual({ top: CHROME_EDGE_GAP, right: narrowContainer.right - narrowContainer.left - anchorWidth });
    expect(narrowContainer.right - offset.right - anchorWidth).toBeGreaterThanOrEqual(narrowContainer.left);
  });
});

describe('bottomOffsetClearing', () => {
  const saveChip = rect(1283, 830, 145, 26);

  it('leaves the plain corner inset when nothing is under the chip', () => {
    expect(bottomOffsetClearing(saveChip, [], CONTAINER_1440)).toBe(CHROME_EDGE_GAP);
  });

  it('lifts the chip above the desktop help island (bottom-right)', () => {
    const helpIcon = rect(1388, 848, 36, 36);
    expect(bottomOffsetClearing(saveChip, [helpIcon], CONTAINER_1440)).toBe(52 + CHROME_ISLAND_GAP);
  });

  it('ignores the bottom-LEFT zoom cluster, which never shares the chip\'s column', () => {
    const zoomActions = rect(296, 848, 132, 36);
    expect(bottomOffsetClearing(saveChip, [zoomActions], CONTAINER_1440)).toBe(CHROME_EDGE_GAP);
  });

  it('lifts the chip above the full-width mobile tool island (Round 25b-1 §3)', () => {
    // Measured at 375x812: island {x:14,y:750,w:347,h:48} vs a chip that used
    // to sit at a hard-coded bottom-14 and overlapped it by 6px.
    const mobileChip = rect(218, 730, 145, 26);
    const mobileIsland = rect(14, 750, 347, 48);
    const shortContainer = rect(0, CONTAINER_TOP, 375, 812 - CONTAINER_TOP);
    const offset = bottomOffsetClearing(mobileChip, [mobileIsland], shortContainer);
    expect(offset).toBe(62 + CHROME_ISLAND_GAP);
    // and the chip really does end up clear of the island now
    expect(812 - offset - 26).toBeLessThan(750);
  });

  it('mirror of QA-3 finding №2: a tall side strip that never reaches the chip\'s row does NOT lift it (and never will — see boardChromeLayout.ts on why the bottom chip stays single-axis)', () => {
    const mobileChip = rect(218, 730, 145, 26); // spans 730..756
    // Same horizontal column as the chip, but vertically well clear of it —
    // the strip-shaped-obstacle case that used to lift the chip regardless.
    const sideStripAbove = rect(218, 400, 145, 200); // spans 400..600
    const shortContainer = rect(0, CONTAINER_TOP, 375, 812 - CONTAINER_TOP);
    expect(bottomOffsetClearing(mobileChip, [sideStripAbove], shortContainer)).toBe(CHROME_EDGE_GAP);
  });

  it('never lifts the chip past the container\'s top edge — a huge obstacle is clamped, not followed off-screen', () => {
    const mobileChip = rect(218, 730, 145, 26);
    const shortContainer = rect(0, CONTAINER_TOP, 375, 812 - CONTAINER_TOP);
    const hugeObstacle = rect(218, -500, 145, 1300); // spans -500..800, same column, deep under the chip
    const chipHeight = 26;
    const unclamped = shortContainer.bottom - hugeObstacle.top + CHROME_ISLAND_GAP;
    expect(unclamped).toBeGreaterThan(shortContainer.bottom - CONTAINER_TOP - chipHeight); // sanity: the bug this guards against

    const offset = bottomOffsetClearing(mobileChip, [hugeObstacle], shortContainer);
    expect(offset).toBe(shortContainer.bottom - CONTAINER_TOP - chipHeight);
    expect(shortContainer.bottom - offset).toBeGreaterThanOrEqual(CONTAINER_TOP);
  });
});

describe('collectObstacleRects', () => {
  it('reads only what is inside the given container', () => {
    const outside = document.createElement('div');
    outside.className = 'App-toolbar-container';
    document.body.appendChild(outside);

    const container = document.createElement('div');
    const inside = document.createElement('div');
    inside.className = 'App-toolbar-container';
    container.appendChild(inside);
    document.body.appendChild(container);

    expect(collectObstacleRects(container, EXCALIDRAW_TOP_OBSTACLES)).toHaveLength(1);
    expect(collectObstacleRects(container, ['.nothing-here'])).toHaveLength(0);

    outside.remove();
    container.remove();
  });

  it('never lets a missing selector throw — an Excalidraw upgrade that drops one just contributes nothing', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    expect(() => collectObstacleRects(container, EXCALIDRAW_TOP_OBSTACLES)).not.toThrow();
    expect(() => collectObstacleRects(container, EXCALIDRAW_BOTTOM_OBSTACLES)).not.toThrow();
    container.remove();
  });

  it('does not list the full-height .App-bottom-bar wrapper itself, only the island inside it', () => {
    // Excalidraw's mobile .App-bottom-bar spans the whole canvas height;
    // treating it as an obstacle would push the save chip off-screen.
    expect(EXCALIDRAW_BOTTOM_OBSTACLES).toContain('.App-bottom-bar .Island');
    expect(EXCALIDRAW_BOTTOM_OBSTACLES as readonly string[]).not.toContain('.App-bottom-bar');
  });
});
