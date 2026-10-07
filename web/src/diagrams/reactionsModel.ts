/**
 * Emoji reactions on board elements ("like the squares").
 *
 * Storage: a dedicated root of the board's Y.Doc, `reactions: Y.Map`, with ONE
 * KEY PER REACTION — `${elementId}|${emoji}|${userId}` -> `{ at }`. Adding is a
 * `set`, removing a `delete`. Because every (element, emoji, user) triple owns
 * its own key, two people reacting to the same shape at the same moment write
 * different keys and both survive the merge (an element-level field such as
 * customData would be last-writer-wins and lose one). The element itself is
 * never touched, so a reaction is neither a scene edit nor an undo step.
 *
 * It travels over the same /collab socket as the scene, is cached offline with
 * the rest of the doc, and is persisted by the server's room snapshot (which
 * encodes every root of the doc, known to the server or not).
 *
 * Kept free of React and of the Excalidraw runtime (types only) so the rules
 * are unit-testable on their own.
 */
import * as Y from 'yjs';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';

/** Reaction palette offered by the picker, in display order. */
export const REACTION_EMOJIS = ['👍', '❤️', '😂', '🎉', '🤔', '👀', '🔥', '👏'] as const;

/** elementId -> emoji -> ids of the users who reacted (oldest reaction first). */
export type ReactionIndex = Map<string, Map<string, string[]>>;

const SEP = '|';

export function reactionKey(elementId: string, emoji: string, userId: string): string {
  return `${elementId}${SEP}${emoji}${SEP}${userId}`;
}

/** Inverse of reactionKey; null for a malformed key. Ids may contain anything but the separator in their first two parts; the user id is the remainder. */
export function parseReactionKey(key: string): { elementId: string; emoji: string; userId: string } | null {
  const first = key.indexOf(SEP);
  if (first <= 0) return null;
  const second = key.indexOf(SEP, first + 1);
  if (second <= first + 1) return null;
  const userId = key.slice(second + 1);
  if (!userId) return null;
  return { elementId: key.slice(0, first), emoji: key.slice(first + 1, second), userId };
}

/** Reads the whole map into an index. Malformed keys (wire data) are skipped; users are ordered by `at`, then id, so every client renders the same order. */
export function indexReactions(map: Y.Map<unknown>): ReactionIndex {
  const rows: { elementId: string; emoji: string; userId: string; at: number }[] = [];
  map.forEach((value, key) => {
    const parsed = parseReactionKey(key);
    if (!parsed) return;
    const at = typeof (value as { at?: unknown } | undefined)?.at === 'number' ? (value as { at: number }).at : 0;
    rows.push({ ...parsed, at });
  });
  rows.sort((a, b) => a.at - b.at || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  const index: ReactionIndex = new Map();
  for (const { elementId, emoji, userId } of rows) {
    let byEmoji = index.get(elementId);
    if (!byEmoji) index.set(elementId, (byEmoji = new Map()));
    const users = byEmoji.get(emoji);
    if (users) users.push(userId);
    else byEmoji.set(emoji, [userId]);
  }
  return index;
}

/**
 * Adds the user's reaction if absent, removes it if present. Returns true when
 * it was added. One transaction, `origin` passed through so a caller can tell
 * its own writes from remote ones.
 */
export function toggleReaction(
  doc: Y.Doc,
  map: Y.Map<unknown>,
  elementId: string,
  emoji: string,
  userId: string,
  origin?: unknown,
  now: () => number = Date.now,
): boolean {
  const key = reactionKey(elementId, emoji, userId);
  let added = false;
  doc.transact(() => {
    if (map.has(key)) {
      map.delete(key);
    } else {
      map.set(key, { at: now() });
      added = true;
    }
  }, origin);
  return added;
}

/** Element types that can carry a reaction: everything but connectors/strokes and the selection marquee. */
const NON_REACTABLE_TYPES = new Set(['arrow', 'line', 'freedraw', 'selection']);

export function isReactable(element: Pick<ExcalidrawElement, 'type' | 'isDeleted'> & { containerId?: string | null }): boolean {
  if (element.isDeleted) return false;
  if (NON_REACTABLE_TYPES.has(element.type)) return false;
  // Text bound to a container (a sticky's label) is part of its container — the container carries the reaction.
  if (element.type === 'text' && element.containerId) return false;
  return true;
}

export interface SceneRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Axis-aligned bounds of an element's (possibly rotated) box in scene coordinates. */
export function elementSceneBounds(el: Pick<ExcalidrawElement, 'x' | 'y' | 'width' | 'height' | 'angle'>): SceneRect {
  const cx = el.x + el.width / 2;
  const cy = el.y + el.height / 2;
  const cos = Math.cos(el.angle || 0);
  const sin = Math.sin(el.angle || 0);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [dx, dy] of [
    [-el.width / 2, -el.height / 2],
    [el.width / 2, -el.height / 2],
    [el.width / 2, el.height / 2],
    [-el.width / 2, el.height / 2],
  ]) {
    xs.push(cx + dx * cos - dy * sin);
    ys.push(cy + dx * sin + dy * cos);
  }
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

/** Topmost reactable element whose bounds (grown by `pad` scene units) contain the point; null if none. Scene arrays are bottom-to-top, so the walk is reversed. */
export function hitTestReactable<T extends ExcalidrawElement>(
  elements: readonly T[],
  point: { x: number; y: number },
  pad = 0,
): T | null {
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if (!isReactable(el)) continue;
    const b = elementSceneBounds(el);
    if (point.x >= b.left - pad && point.x <= b.right + pad && point.y >= b.top - pad && point.y <= b.bottom + pad) return el;
  }
  return null;
}

/** Viewport slice of Excalidraw's appState that scene -> screen mapping needs. */
export interface ReactionViewport {
  scrollX: number;
  scrollY: number;
  zoom: { value: number };
  offsetLeft: number;
  offsetTop: number;
}

/**
 * Scene point -> pixel position inside the board container. Excalidraw maps
 * `(x + scroll) * zoom + offset` to client coordinates; the overlay is
 * positioned relative to the container, whose own client origin
 * (`containerLeft/Top`) is subtracted again.
 */
export function sceneToContainerPoint(
  point: { x: number; y: number },
  vp: ReactionViewport,
  containerOrigin: { left: number; top: number },
): { x: number; y: number } {
  const zoom = vp.zoom.value || 1;
  return {
    x: (point.x + vp.scrollX) * zoom + vp.offsetLeft - containerOrigin.left,
    y: (point.y + vp.scrollY) * zoom + vp.offsetTop - containerOrigin.top,
  };
}

/** Client pixel -> scene point (inverse of the mapping above, without the container step). */
export function clientToScenePoint(clientX: number, clientY: number, vp: ReactionViewport): { x: number; y: number } {
  const zoom = vp.zoom.value || 1;
  return { x: (clientX - vp.offsetLeft) / zoom - vp.scrollX, y: (clientY - vp.offsetTop) / zoom - vp.scrollY };
}
