/**
 * Comments on board elements: the rules that need neither React nor the
 * Excalidraw runtime (types only), so they can be tested on their own.
 *
 * A thread hangs on an element by id (`target.elementId`, the same id
 * reactionsModel.ts keys reactions by). The server never knows whether the
 * element still exists in the live scene; the client works that out from the
 * scene it holds and, for a thread whose element is gone, keeps it in the list
 * with a "the element was deleted" note and the label saved at creation.
 */
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { CommentThread } from '@shared/comments';
import { elementSceneBounds, elementVisualOutset, selectionIsIdle, type ReactionSelectionState, type ReactionViewport } from './reactionsModel';

/** The element a board thread is about; undefined for a thread that is not a board-element thread. */
export function threadElementId(thread: Pick<CommentThread, 'target'>): string | undefined {
  return thread.target?.kind === 'board_element' ? thread.target.elementId : undefined;
}

/** Elements that cannot carry a comment: the selection marquee. A bound label counts as its container (see commentableElement). */
export function isCommentable(element: Pick<ExcalidrawElement, 'type' | 'isDeleted'>): boolean {
  return !element.isDeleted && element.type !== 'selection';
}

/** A bound label (a sticky's text) stands for its container, so the thread follows the shape rather than the text inside it. */
export function commentableElement<T extends ExcalidrawElement>(element: T, byId: ReadonlyMap<string, T>): T {
  const containerId = element.type === 'text' ? (element as { containerId?: string | null }).containerId : null;
  const container = containerId ? byId.get(containerId) : undefined;
  return container ?? element;
}

/** Container pixel -> scene point; the inverse of sceneToContainerPoint. */
export function containerToScenePoint(
  point: { x: number; y: number },
  vp: ReactionViewport,
  containerOrigin: { left: number; top: number },
): { x: number; y: number } {
  const zoom = vp.zoom.value || 1;
  return { x: (point.x + containerOrigin.left - vp.offsetLeft) / zoom - vp.scrollX, y: (point.y + containerOrigin.top - vp.offsetTop) / zoom - vp.scrollY };
}

/**
 * The element under a scene point: among the commentable elements whose bounds
 * (grown by the stroke's reach) contain it, the smallest one — a shape sitting
 * on a big frame or a long arrow wins over it; of equal size the one drawn last.
 * A hit on a bound label answers with its container.
 */
export function elementAtPoint<T extends ExcalidrawElement>(elements: readonly T[], point: { x: number; y: number }): T | null {
  const byId = new Map(elements.map((el) => [el.id, el] as const));
  let best: { el: T; area: number } | null = null;
  for (const el of elements) {
    if (!isCommentable(el)) continue;
    const b = elementSceneBounds(el);
    const grow = elementVisualOutset(el);
    if (point.x < b.left - grow || point.x > b.right + grow || point.y < b.top - grow || point.y > b.bottom + grow) continue;
    const area = Math.max(b.right - b.left, 1) * Math.max(b.bottom - b.top, 1);
    if (!best || area <= best.area) best = { el, area };
  }
  return best ? commentableElement(best.el, byId) : null;
}

/** Open (unresolved) threads of each element, in the order given. */
export function threadsByElement(threads: readonly CommentThread[]): Map<string, CommentThread[]> {
  const out = new Map<string, CommentThread[]>();
  for (const thread of threads) {
    const id = threadElementId(thread);
    if (id === undefined) continue;
    const list = out.get(id);
    if (list) list.push(thread);
    else out.set(id, [thread]);
  }
  return out;
}

/** Ids of the threads whose element is no longer in the scene. `liveIds` is the scene's non-deleted element ids. */
export function deletedTargetThreads(threads: readonly CommentThread[], liveIds: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const thread of threads) {
    const id = threadElementId(thread);
    if (id !== undefined && !liveIds.has(id)) out.add(thread.id);
  }
  return out;
}

/** What the draft card quotes before the server has written its own label: the element's text, its bound label's text, else its type. */
export function elementPreview(element: ExcalidrawElement, elements: readonly ExcalidrawElement[]): string {
  const textOf = (el: ExcalidrawElement | undefined): string => (el && el.type === 'text' ? ((el as { originalText?: string; text?: string }).originalText ?? (el as { text?: string }).text ?? '') : '');
  const bound = element.boundElements?.find((b) => b.type === 'text');
  const text = (textOf(element) || textOf(bound ? elements.find((e) => e.id === bound.id) : undefined) || (element.type === 'frame' ? ((element as { name?: string | null }).name ?? '') : '')).trim();
  const label = (text || element.type).replace(/\s+/g, ' ');
  return label.length > 120 ? `${label.slice(0, 119)}…` : label;
}

/**
 * The one element the "comment" button next to the selection belongs to, or null:
 * exactly one element selected (a bound label stands for its container), in the
 * editor with no gesture in progress.
 */
export function commentButtonTarget<T extends ExcalidrawElement>(elements: readonly T[], appState: ReactionSelectionState): T | null {
  if (!selectionIsIdle(appState)) return null;
  const selected = Object.keys(appState.selectedElementIds).filter((id) => appState.selectedElementIds[id]);
  if (selected.length === 0 || selected.length > 2) return null;
  const byId = new Map(elements.map((el) => [el.id, el] as const));
  const targets = new Set<string>();
  for (const id of selected) {
    const el = byId.get(id);
    if (!el || !isCommentable(el)) return null;
    targets.add(commentableElement(el, byId).id);
  }
  return targets.size === 1 ? (byId.get([...targets][0]) ?? null) : null;
}
