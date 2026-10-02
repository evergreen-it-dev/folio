/**
 * Z-order of a board's elements — ONE definition shared by every server path
 * that turns a scene into an ordered element list or into a picture
 * (server/collab.ts: seeding a room, persisting it, the agent's full-scene
 * write, "take the version from Git"; server/confluenceWhiteboard.ts:
 * renderSceneSvg, the SVG inside every `.excalidraw.svg` file).
 *
 * Why it exists. The board's live room is a Y.Map keyed by element id, so it has
 * no order of its own: the z-order is carried by each element's fractional
 * `index` (Excalidraw's own scheme). Scenes that come from the server side —
 * create_board / update_board / board_ops, the Confluence importer — carry NO
 * `index`; their z-order is the array order. The server used to sort the room by
 * `index` and then by `id`, which for index-less elements meant "by id": the
 * order the scene was written in was lost, and a box whose id sorted after its
 * label's id (`t-<id>`) was drawn OVER its label in the SVG ("Web shop" box with
 * no text in the document, the history preview and the file in Git). The canvas
 * never showed it: Excalidraw draws a bound text right after its container
 * whatever the indexes say, and so does this module.
 *
 * Three rules:
 *  1. Elements are ordered by `index`; an element without one sorts before the
 *     ones that have one (the web client reads the room the same way); equal or
 *     missing indexes keep the order they were given in (the sort is stable).
 *  2. A text bound to a container (`containerId`) is placed right after that
 *     container — above it, and above nothing else.
 *  3. A scene in which some element has no `index` is given keys from its array
 *     order (withBoardIndexes), so the order survives being put into the room.
 *
 * Everything here is a pure function of its input: the same scene gives the same
 * output, so a board is never rewritten in Git only because it was ordered again.
 */
import type { ExcalidrawElement } from './confluenceWhiteboard.js';

const hasIndex = (el: ExcalidrawElement): boolean => typeof el.index === 'string' && el.index.length > 0;

/**
 * `elements` in z-order: bottom first. Does not modify its input.
 *
 * Callers that read elements out of an unordered container (the room's Y.Map)
 * must hand them over in a deterministic order (by id) first — ties are broken
 * by position in `elements`.
 */
export function orderBoardElements(elements: readonly ExcalidrawElement[]): ExcalidrawElement[] {
  const sorted = [...elements].sort((a, b) => {
    const ai = a.index ?? '';
    const bi = b.index ?? '';
    return ai === bi ? 0 : ai < bi ? -1 : 1;
  });
  return placeBoundTexts(sorted);
}

/**
 * Rule 2 on its own, for a list that is already in the order it should be in:
 * every bound text moves to the slot right after its container, nothing else
 * moves. Does not modify its input.
 */
export function placeBoundTexts(sorted: readonly ExcalidrawElement[]): ExcalidrawElement[] {
  const byId = new Map(sorted.map((el) => [el.id, el]));
  const bound = new Set<ExcalidrawElement>();
  const boundTo = new Map<string, ExcalidrawElement[]>();
  for (const el of sorted) {
    if (el.type !== 'text' || !el.containerId) continue;
    const container = byId.get(el.containerId);
    // A text is never a container (nothing is bound to a text), which also keeps a broken cycle of texts from vanishing.
    if (!container || container === el || container.type === 'text') continue;
    bound.add(el);
    const list = boundTo.get(container.id);
    if (list) list.push(el);
    else boundTo.set(container.id, [el]);
  }
  if (bound.size === 0) return [...sorted];

  const out: ExcalidrawElement[] = [];
  const placed = new Set<ExcalidrawElement>();
  for (const el of sorted) {
    if (bound.has(el)) continue;
    out.push(el);
    for (const text of boundTo.get(el.id) ?? []) {
      if (placed.has(text)) continue;
      placed.add(text);
      out.push(text);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fractional keys. The same alphabet and integer-part scheme as the
// `fractional-indexing` package Excalidraw uses to make `index` (base 62, the
// first character says how long the integer part is), so a key made here is
// one Excalidraw accepts and extends. Only "the next key after this one" is
// needed — scenes are always given keys from the bottom up — so the rest of the
// package (keys BETWEEN two others) is not carried over.
// ---------------------------------------------------------------------------

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const FIRST_KEY = 'a0';

/** Length of the integer part of a key, from its first character; null for a character that does not start a key. */
function integerLength(head: string): number | null {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 'a'.charCodeAt(0) + 2;
  if (head >= 'A' && head <= 'Z') return 'Z'.charCodeAt(0) - head.charCodeAt(0) + 2;
  return null;
}

/** The integer part one above `x`, or null when `x` is the largest there is. */
function incrementInteger(x: string): string | null {
  const head = x[0];
  const digits = x.slice(1).split('');
  let carry = true;
  for (let i = digits.length - 1; carry && i >= 0; i--) {
    const d = DIGITS.indexOf(digits[i]) + 1;
    if (d === DIGITS.length) {
      digits[i] = DIGITS[0];
    } else {
      digits[i] = DIGITS[d];
      carry = false;
    }
  }
  if (!carry) return head + digits.join('');
  if (head === 'Z') return `a${DIGITS[0]}`;
  if (head === 'z') return null;
  const nextHead = String.fromCharCode(head.charCodeAt(0) + 1);
  if (nextHead > 'a') digits.push(DIGITS[0]);
  else digits.pop();
  return nextHead + digits.join('');
}

/** A key that sorts after `key`. */
function nextKey(key: string): string {
  const length = integerLength(key[0] ?? '');
  const integer = length !== null && length <= key.length ? key.slice(0, length) : null;
  const wellFormed = integer !== null && [...integer.slice(1)].every((c) => DIGITS.includes(c));
  const next = wellFormed ? incrementInteger(integer) : null;
  // Past the largest integer part, or a key this module did not make: extend the key itself.
  return next ?? `${key}V`;
}

/**
 * The scene's elements with an `index` on each, so that the z-order the scene
 * was written in survives being stored in the room's Y.Map.
 *
 * A scene where every element already has an `index` is returned untouched (the
 * same element objects): its order is the indexes, even when the array says
 * otherwise. Otherwise the array order is the z-order: the elements are walked
 * bottom to top, an element keeps its key while the keys keep rising, and from
 * the first one that has none (or breaks the sequence) on, each gets the next
 * key. So elements an agent adds without an index land on top, and a scene with
 * no indexes at all gets `a0`, `a1`, … in the order it was written in.
 *
 * Returns copies only for the elements it changes; never modifies its input.
 */
export function withBoardIndexes(elements: readonly ExcalidrawElement[]): ExcalidrawElement[] {
  if (elements.every(hasIndex)) return [...elements];
  const out: ExcalidrawElement[] = [];
  let last: string | null = null;
  let rekeying = false;
  for (const el of elements) {
    if (!rekeying && hasIndex(el) && (last === null || (el.index as string) > last)) {
      out.push(el);
      last = el.index as string;
      continue;
    }
    rekeying = true;
    last = last === null ? FIRST_KEY : nextKey(last);
    out.push({ ...el, index: last });
  }
  return out;
}

/**
 * The elements as they are DRAWN: keys given to a scene that lacks them, then
 * ordered. What renderSceneSvg puts in the picture, so that a scene handed to it
 * in any order (the array of a file, the room's id order) is drawn the way the
 * room would order it.
 */
export function boardDrawOrder(elements: readonly ExcalidrawElement[]): ExcalidrawElement[] {
  return orderBoardElements(withBoardIndexes(elements));
}
