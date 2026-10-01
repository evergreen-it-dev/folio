/**
 * Pure-function coverage for boardStickyNotes.ts (Miro-style sticky notes,
 * owner request — see BoardCanvas.tsx's own insertStickyNote for how these
 * are actually wired to a drag/click on StickyNotePalette). Mocks
 * '@excalidraw/excalidraw' the same minimal way BoardCanvas.test.tsx does —
 * this file only needs `convertToExcalidrawElements` to exist and behave
 * like a converter, not the real (heavy) package.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@excalidraw/excalidraw', () => ({
  // Passthrough: enough to prove createStickyNoteElements hands the built
  // skeleton to the real converter — the converter's OWN behaviour (binding
  // text, generating ids, etc.) is the installed package's responsibility,
  // not this module's.
  convertToExcalidrawElements: vi.fn((skeletons: unknown[]) => skeletons),
  ROUNDNESS: { LEGACY: 1, PROPORTIONAL_RADIUS: 2, ADAPTIVE_RADIUS: 3 },
}));

import {
  STICKY_NOTE_COLORS,
  STICKY_NOTE_SIZE,
  buildStickyNoteSkeleton,
  createStickyNoteElements,
  sceneToScreenCoords,
  screenToSceneCoords,
  type StickyNoteColorId,
} from './boardStickyNotes';

describe('screenToSceneCoords', () => {
  it('applies scroll, zoom and container offset the same way Excalidraw\'s own viewportCoordsToSceneCoords does', () => {
    const appState = { scrollX: 10, scrollY: -5, zoom: { value: 2 }, offsetLeft: 100, offsetTop: 50 };
    expect(screenToSceneCoords(300, 150, appState)).toEqual({
      x: (300 - 100) / 2 - 10,
      y: (150 - 50) / 2 - -5,
    });
  });

  it('treats a zero zoom as 1 rather than dividing by zero', () => {
    const appState = { scrollX: 0, scrollY: 0, zoom: { value: 0 }, offsetLeft: 0, offsetTop: 0 };
    expect(screenToSceneCoords(42, 7, appState)).toEqual({ x: 42, y: 7 });
  });

  it('is the exact inverse of sceneToScreenCoords (round trip)', () => {
    const appState = { scrollX: 20, scrollY: 30, zoom: { value: 1.5 }, offsetLeft: 12, offsetTop: 8 };
    const scene = screenToSceneCoords(400, 300, appState);
    expect(sceneToScreenCoords(scene, appState)).toEqual({ clientX: 400, clientY: 300 });
  });
});

describe('buildStickyNoteSkeleton', () => {
  it('builds a standard-size, opaque, correctly-coloured rectangle centred on the given point', () => {
    const skeleton = buildStickyNoteSkeleton('pink', { x: 500, y: 500 });
    expect(skeleton.type).toBe('rectangle');
    expect(skeleton.width).toBe(STICKY_NOTE_SIZE);
    expect(skeleton.height).toBe(STICKY_NOTE_SIZE);
    expect(skeleton.x).toBe(500 - STICKY_NOTE_SIZE / 2);
    expect(skeleton.y).toBe(500 - STICKY_NOTE_SIZE / 2);
    expect(skeleton.backgroundColor).toBe(STICKY_NOTE_COLORS.find((c) => c.id === 'pink')?.value);
    expect(skeleton.fillStyle).toBe('solid');
    // Opaque, not Excalidraw's default 'transparent' background — see
    // handleCanvasDoubleClick's own !isTransparent(...) check, the whole
    // reason the synthetic-dblclick path in BoardCanvas.tsx works at all.
    expect(skeleton.backgroundColor).not.toBe('transparent');
  });

  it('centres a custom size on the same point', () => {
    const skeleton = buildStickyNoteSkeleton('blue', { x: 0, y: 0 }, 80);
    expect(skeleton.width).toBe(80);
    expect(skeleton.height).toBe(80);
    expect(skeleton.x).toBe(-40);
    expect(skeleton.y).toBe(-40);
  });

  it('every configured colour id builds a differently-coloured skeleton', () => {
    const values = STICKY_NOTE_COLORS.map((c) => buildStickyNoteSkeleton(c.id, { x: 0, y: 0 }).backgroundColor);
    expect(new Set(values).size).toBe(STICKY_NOTE_COLORS.length);
  });

  it('never sets a `label` key at all — an empty one would silently bind no text (convertToExcalidrawElements only checks element.label?.text)', () => {
    const skeleton = buildStickyNoteSkeleton('yellow', { x: 0, y: 0 });
    expect('label' in skeleton).toBe(false);
  });

  it('falls back to the first configured colour for an unrecognized id, instead of an undefined backgroundColor', () => {
    const skeleton = buildStickyNoteSkeleton('not-a-real-color' as StickyNoteColorId, { x: 0, y: 0 });
    expect(skeleton.backgroundColor).toBe(STICKY_NOTE_COLORS[0].value);
  });
});

describe('createStickyNoteElements', () => {
  it('runs buildStickyNoteSkeleton\'s output through convertToExcalidrawElements', () => {
    const [element] = createStickyNoteElements('green', { x: 10, y: 10 });
    expect(element).toBeTruthy();
    expect((element as { type: string }).type).toBe('rectangle');
    expect((element as { backgroundColor: string }).backgroundColor).toBe(
      STICKY_NOTE_COLORS.find((c) => c.id === 'green')?.value,
    );
  });
});
