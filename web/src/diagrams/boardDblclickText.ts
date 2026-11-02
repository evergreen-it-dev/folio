/**
 * Double-click inside a shape edits THAT shape's text.
 *
 * Excalidraw 0.18.1 (handleCanvasDoubleClick -> startTextEditing) binds new
 * text to a container only when the point is within ~30px of its centre; it
 * moves the point to the centre itself only when the container already has
 * text, has a fill, or the click hits its outline. So a double-click on the
 * transparent interior of an empty rectangle/ellipse/diamond, away from both
 * the outline and the centre, creates a free text element on top of the shape
 * (users then group the two by hand). `containerForDblclickText` finds those
 * clicks; BoardCanvas.tsx redirects them to the shape's own text editor and
 * lets Excalidraw handle every other double-click natively.
 */

/** The slice of an Excalidraw element this module reads. */
export interface DblclickElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isDeleted?: boolean;
  locked?: boolean;
  groupIds?: readonly string[];
  boundElements?: readonly { id: string; type: string }[] | null;
}

/** Shapes Excalidraw lets text be bound to (isTextBindableContainer minus arrows). */
const TEXT_CONTAINER_TYPES = new Set(['rectangle', 'ellipse', 'diamond']);

/** Arrows and lines are skipped when finding what is under the point, see below. */
const LINEAR_TYPES = new Set(['arrow', 'line']);

/** Frames sit after their children in the element order, so a shape inside one would never be reached. */
const FRAME_TYPES = new Set(['frame', 'magicframe']);

/**
 * Returns the id of the shape whose own text a double-click at the scene point
 * should open, or null to leave the double-click to Excalidraw.
 *
 * The target is the topmost element whose bounding box contains the point
 * (Excalidraw's own loop in getTextBindableContainerAtPosition). Arrows and
 * lines are skipped rather than hit-tested: if one really is under the point,
 * Excalidraw's path is still the right one for it to take.
 * Frames are skipped too: a click in a frame's interior is about what is drawn
 * inside it.
 *
 * It must be an empty rect/ellipse/diamond: one that already has bound text,
 * and anything else (free text, image, frame, ...) on top, is handled natively.
 * A shape whose group is currently selected is also left alone: the first
 * double-click there enters the group. So is any double-click while an arrow
 * or line is selected: the first click of the pair selects a linear element
 * it hits, and a double-click on an arrow is its label, not the shape behind.
 */
export function containerForDblclickText(
  elements: readonly DblclickElement[],
  selection: { selectedElementIds: Readonly<Record<string, boolean>>; selectedGroupIds: Readonly<Record<string, boolean>> },
  point: { x: number; y: number },
): string | null {
  const { selectedElementIds, selectedGroupIds } = selection;
  if (elements.some((el) => !el.isDeleted && LINEAR_TYPES.has(el.type) && selectedElementIds[el.id])) return null;
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i]!;
    if (el.isDeleted || LINEAR_TYPES.has(el.type) || FRAME_TYPES.has(el.type)) continue;
    if (!(el.x < point.x && point.x < el.x + el.width && el.y < point.y && point.y < el.y + el.height)) continue;
    if (!TEXT_CONTAINER_TYPES.has(el.type) || el.locked) return null;
    if (el.boundElements?.some((b) => b.type === 'text')) return null;
    if (el.groupIds?.some((g) => selectedGroupIds[g])) return null;
    return el.id;
  }
  return null;
}
