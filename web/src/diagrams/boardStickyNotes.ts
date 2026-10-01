import { convertToExcalidrawElements, ROUNDNESS } from '@excalidraw/excalidraw';

/**
 * Miro-style sticky notes (owner request — "a mini plugin for sticky notes,
 * multicolored as in Miro"). This module holds every piece of the feature
 * that is plain data/geometry and therefore unit-testable without mounting
 * Excalidraw: the palette's own colour set, the standard note size,
 * screen<->scene coordinate conversion, and the skeleton a dropped/clicked
 * swatch turns into. BoardCanvas.tsx owns everything that actually touches
 * the DOM or the imperative API (inserting the element, opening it for text
 * entry) — see its own `insertStickyNote` for how these pieces are used.
 */

/**
 * Standard sticky-note side length, in SCENE units. A plain constant (not a
 * "draw your own size" tool) is the whole point of the owner's request: drag
 * from the palette, get a standard-size note, no rectangle-drawing step.
 */
export const STICKY_NOTE_SIZE = 200;

/**
 * Pastel palette, Miro-style. Order here is the order the palette renders
 * in (StickyNotePalette.tsx).
 */
export const STICKY_NOTE_COLORS = [
  { id: 'yellow', value: '#fff3a3' },
  { id: 'pink', value: '#ffb3c9' },
  { id: 'blue', value: '#a9ddff' },
  { id: 'green', value: '#b3f0c0' },
  { id: 'violet', value: '#d9c2ff' },
  { id: 'orange', value: '#ffcda3' },
] as const;

export type StickyNoteColorId = (typeof STICKY_NOTE_COLORS)[number]['id'];

function stickyNoteColorValue(colorId: StickyNoteColorId): string {
  return STICKY_NOTE_COLORS.find((color) => color.id === colorId)?.value ?? STICKY_NOTE_COLORS[0].value;
}

export interface ScenePoint {
  x: number;
  y: number;
}

/** The subset of Excalidraw's AppState screen<->scene conversion actually needs. */
export interface ViewportAppState {
  scrollX: number;
  scrollY: number;
  zoom: { value: number };
  offsetLeft: number;
  offsetTop: number;
}

/**
 * Screen (client) coordinates -> scene coordinates, matching Excalidraw's own
 * viewportCoordsToSceneCoords exactly (confirmed against the installed
 * 0.18.1's own dist source): scene = (client - offset) / zoom - scroll. Kept
 * as our own tiny pure copy rather than importing the package's version — it
 * isn't part of the public API surface, and this is the one fact about it
 * this feature needs.
 */
export function screenToSceneCoords(clientX: number, clientY: number, appState: ViewportAppState): ScenePoint {
  const zoom = appState.zoom.value || 1;
  return {
    x: (clientX - appState.offsetLeft) / zoom - appState.scrollX,
    y: (clientY - appState.offsetTop) / zoom - appState.scrollY,
  };
}

/**
 * The inverse of screenToSceneCoords — used to find where a just-inserted
 * sticky's centre lands on screen, so BoardCanvas can dispatch a synthetic
 * dblclick there (see its own insertStickyNote comment for why that's the
 * only way to open a bound-text container for editing through the public
 * imperative API).
 */
export function sceneToScreenCoords(
  scenePoint: ScenePoint,
  appState: ViewportAppState,
): { clientX: number; clientY: number } {
  const zoom = appState.zoom.value || 1;
  return {
    clientX: (scenePoint.x + appState.scrollX) * zoom + appState.offsetLeft,
    clientY: (scenePoint.y + appState.scrollY) * zoom + appState.offsetTop,
  };
}

/**
 * The raw skeleton for a sticky note centred on `center` — an opaque,
 * standard-size rectangle in the given colour. Deliberately has NO `label`
 * key at all (not even `{ text: '' }`): convertToExcalidrawElements only
 * binds a text element when `element.label?.text` is truthy (confirmed
 * against the installed package's own data/transform.ts source) — an empty
 * label would silently create nothing. The point of this whole feature is
 * that the text is added afterwards, live, by the user typing straight into
 * the note (see BoardCanvas.tsx's insertStickyNote), not baked in here.
 */
export function buildStickyNoteSkeleton(colorId: StickyNoteColorId, center: ScenePoint, size: number = STICKY_NOTE_SIZE) {
  return {
    type: 'rectangle' as const,
    x: center.x - size / 2,
    y: center.y - size / 2,
    width: size,
    height: size,
    backgroundColor: stickyNoteColorValue(colorId),
    // 'solid', not Excalidraw's default hachure fill — a Miro-style sticky
    // reads as a flat colour patch, not a sketchy cross-hatch.
    fillStyle: 'solid' as const,
    strokeColor: 'transparent',
    strokeWidth: 1,
    // Same roundness Excalidraw's own rectangle tool gives a freshly drawn
    // rectangle (see the installed package's App.tsx: `isUsingAdaptiveRadius`
    // is true for "rectangle") — rounded corners, not a hard requirement of
    // handleCanvasDoubleClick's opaque-fill check below, just visual parity
    // with what a hand-drawn Excalidraw rectangle already looks like.
    roundness: { type: ROUNDNESS.ADAPTIVE_RADIUS },
  };
}

/** buildStickyNoteSkeleton, run through the package's own converter — this is the single element BoardCanvas actually inserts into the scene. */
export function createStickyNoteElements(
  colorId: StickyNoteColorId,
  center: ScenePoint,
  size: number = STICKY_NOTE_SIZE,
): ReturnType<typeof convertToExcalidrawElements> {
  return convertToExcalidrawElements([buildStickyNoteSkeleton(colorId, center, size)]);
}
