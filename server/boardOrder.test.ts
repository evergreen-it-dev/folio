/**
 * Z-order of a board's elements (server/boardOrder.ts) and the way the server's
 * SVG picture uses it.
 *
 * The bug these tests pin down: a box's text label was drawn UNDER the box in the
 * picture inside the `.excalidraw.svg` file (document embeds, history previews,
 * the file in Git) when the box's id sorted after its label's id (`t-<id>`) and
 * the elements carried no `index`: the server fell back to id order and ignored
 * the order the scene was written in. The canvas never showed it, because
 * Excalidraw itself draws a bound text right after its container.
 */
import { describe, expect, it } from 'vitest';
import {
  baseEl,
  decodeScenePayload,
  extractScenePayload,
  renderSceneSvg,
  textEl,
  type ExcalidrawElement,
  type ExcalidrawScene,
} from './confluenceWhiteboard.js';
import { orderBoardElements, withBoardIndexes } from './boardOrder.js';

const seed = () => 1;

function box(id: string, index: string | null, extra: Partial<ExcalidrawElement> = {}): ExcalidrawElement {
  return { ...baseEl(seed, id, 'rectangle', 0, 0, 100, 60), index, ...extra };
}

/** A text bound to `containerId` (the way the sketch builder and Excalidraw store it). */
function label(id: string, containerId: string | null, index: string | null, text = id): ExcalidrawElement {
  return {
    ...textEl(seed, id, text, 0, 0, 40, 20, 16, '#1e1e1e', { container: containerId, align: 'center', valign: 'middle' }),
    index,
  };
}

const ids = (els: readonly ExcalidrawElement[]): string[] => els.map((e) => e.id);

describe('orderBoardElements', () => {
  it('puts a container before its bound text when the indexes say so, even though the container id sorts later', () => {
    const out = orderBoardElements([label('t-web', 'web', 'a1'), box('web', 'a0')]);
    expect(ids(out)).toEqual(['web', 't-web']);
  });

  it('puts a bound text right after its container when neither element has an index', () => {
    const out = orderBoardElements([box('api', null), label('t-api', 'api', null), box('web', null), label('t-web', 'web', null)]);
    expect(ids(out)).toEqual(['api', 't-api', 'web', 't-web']);
    // the same, when the input is in id order: the text sits ABOVE its container in that list
    const byId = orderBoardElements([box('api', null), label('t-api', 'api', null), label('t-web', 'web', null), box('web', null)]);
    expect(ids(byId)).toEqual(['api', 't-api', 'web', 't-web']);
  });

  it('puts a bound text right after its container when both indexes are equal', () => {
    const out = orderBoardElements([label('t-web', 'web', 'a0'), box('web', 'a0')]);
    expect(ids(out)).toEqual(['web', 't-web']);
  });

  it('draws a bound text at its container even when the text index is lower (what the canvas does)', () => {
    const out = orderBoardElements([label('t-web', 'web', 'a0'), box('back', 'a1'), box('web', 'a2')]);
    expect(ids(out)).toEqual(['back', 'web', 't-web']);
  });

  it('keeps the order of the scene when indexes differ from id order', () => {
    const out = orderBoardElements([box('c', 'a0'), box('a', 'a1'), box('b', 'a2')]);
    expect(ids(out)).toEqual(['c', 'a', 'b']);
  });

  it('breaks an index tie by input position, not by id', () => {
    const out = orderBoardElements([box('b', 'a1'), box('a', 'a1'), box('c', 'a1')]);
    expect(ids(out)).toEqual(['b', 'a', 'c']);
  });

  it('keeps the array order of the file for elements without an index', () => {
    const out = orderBoardElements([box('z', null), box('a', null), box('m', null)]);
    expect(ids(out)).toEqual(['z', 'a', 'm']);
  });

  it('puts elements without an index below the indexed ones, like the canvas client does', () => {
    const out = orderBoardElements([box('top', 'a5'), box('old-2', null), box('old-1', null)]);
    expect(ids(out)).toEqual(['old-2', 'old-1', 'top']);
  });

  it('does not move what the user ordered: a box sent to the back stays at the back with its label', () => {
    const out = orderBoardElements([
      box('a', 'a2'),
      label('t-a', 'a', 'a3'),
      box('z-sent-to-back', 'a0'),
      label('t-z-sent-to-back', 'z-sent-to-back', 'a1'),
    ]);
    expect(ids(out)).toEqual(['z-sent-to-back', 't-z-sent-to-back', 'a', 't-a']);
  });

  it('puts the label of an arrow right after the arrow', () => {
    const arrow = { ...baseEl(seed, 'zz-arrow', 'arrow', 0, 0, 50, 0), index: 'a1' as string | null };
    const out = orderBoardElements([label('a-label', 'zz-arrow', 'a2'), box('box', 'a0'), arrow]);
    expect(ids(out)).toEqual(['box', 'zz-arrow', 'a-label']);
  });

  it('keeps several texts of one container together, in their own order', () => {
    const out = orderBoardElements([label('t1', 'web', 'a0'), label('t2', 'web', 'a1'), box('web', 'a2'), box('other', 'a3')]);
    expect(ids(out)).toEqual(['web', 't1', 't2', 'other']);
  });

  it('leaves a text whose container is missing where its index puts it', () => {
    const out = orderBoardElements([box('a', 'a0'), label('orphan', 'gone', 'a1'), box('b', 'a2')]);
    expect(ids(out)).toEqual(['a', 'orphan', 'b']);
  });

  it('never loses an element: a text bound to a text is an ordinary element', () => {
    const t1 = label('t1', 't2', 'a0');
    const t2 = label('t2', 't1', 'a1');
    const out = orderBoardElements([t1, t2, box('x', 'a2')]);
    expect(ids(out).sort()).toEqual(['t1', 't2', 'x']);
  });

  it('is stable: ordering an ordered list changes nothing, and the same input gives the same output', () => {
    const input = [box('web', null), label('t-web', 'web', null), box('api', 'a3'), label('t-api', 'api', 'a1'), box('z', 'a3')];
    const once = orderBoardElements(input);
    expect(orderBoardElements(once)).toEqual(once);
    expect(orderBoardElements(input)).toEqual(once);
  });

  it('does not touch its input', () => {
    const input = [label('t-web', 'web', null), box('web', null)];
    const copy = structuredClone(input);
    orderBoardElements(input);
    expect(input).toEqual(copy);
  });
});

describe('withBoardIndexes', () => {
  it('leaves a scene where every element has an index exactly as it is', () => {
    const input = [box('b', 'a2'), box('a', 'a0'), box('c', 'a1')];
    const out = withBoardIndexes(input);
    expect(out).toHaveLength(3);
    out.forEach((el, i) => expect(el).toBe(input[i]));
  });

  it('gives a scene without any index keys in the array order of the scene', () => {
    const input = [box('zone', null), box('web', null), label('t-web', 'web', null)];
    const out = withBoardIndexes(input);
    expect(out.map((e) => e.index)).toEqual(['a0', 'a1', 'a2']);
    expect(ids(orderBoardElements(out))).toEqual(['zone', 'web', 't-web']);
  });

  it('puts elements added without an index above the ones that have one, and leaves those untouched', () => {
    const a = box('a', 'a0');
    const b = box('b', 'a1');
    const out = withBoardIndexes([a, b, box('added-1', null), box('added-2', null)]);
    expect(out[0]).toBe(a);
    expect(out[1]).toBe(b);
    expect(out[2].index! > 'a1').toBe(true);
    expect(out[3].index! > out[2].index!).toBe(true);
  });

  it('follows the array order when an index breaks the sequence, from that element on', () => {
    const out = withBoardIndexes([box('first', 'a3'), box('second', 'a1'), box('third', null)]);
    expect(out[0].index).toBe('a3');
    const keys = out.map((e) => e.index!);
    expect([...keys].sort()).toEqual(keys); // strictly rising along the array
    expect(new Set(keys).size).toBe(3);
  });

  it('keeps counting past a single digit: more than 62 elements still get distinct rising keys', () => {
    const input = Array.from({ length: 150 }, (_, i) => box(`e${i}`, null));
    const keys = withBoardIndexes(input).map((e) => e.index!);
    expect(keys.slice(0, 3)).toEqual(['a0', 'a1', 'a2']);
    expect(keys[61]).toBe('az');
    expect(keys[62]).toBe('b00');
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(150);
  });

  it('gives the same keys for the same scene every time (no churn in Git)', () => {
    const input = [box('web', null), label('t-web', 'web', null), box('api', null)];
    expect(withBoardIndexes(input)).toEqual(withBoardIndexes(input));
  });

  it('does not touch its input', () => {
    const input = [box('web', null), box('api', 'a0')];
    const copy = structuredClone(input);
    withBoardIndexes(input);
    expect(input).toEqual(copy);
  });
});

describe('renderSceneSvg: the picture follows the z-order of the scene', () => {
  function scene(elements: ExcalidrawElement[]): ExcalidrawScene {
    return { type: 'excalidraw', version: 2, source: 'test', elements, appState: { viewBackgroundColor: '#ffffff' }, files: {} };
  }

  /** Position of the box's <rect> (marked by its fill) and of its label's text in the markup. */
  function positions(svg: string, fill: string, text: string): { rect: number; text: number } {
    return { rect: svg.indexOf(`fill="${fill}"`), text: svg.indexOf(`>${text}</tspan>`) };
  }

  it('draws a label above its box when the box id sorts after the label id and nothing has an index', () => {
    const web = box('web', null, { backgroundColor: '#a5d8ff', width: 180, height: 70 });
    const t = label('t-web', 'web', null, 'Web shop');
    // the order the buggy server produced: label first, because 't-web' < 'web'
    const { rect, text } = positions(renderSceneSvg(scene([t, web])), '#a5d8ff', 'Web shop');
    expect(rect).toBeGreaterThan(-1);
    expect(text).toBeGreaterThan(rect);
  });

  it('keeps the box before its label when the scene is already in order', () => {
    const web = box('web', 'a0', { backgroundColor: '#a5d8ff' });
    const t = label('t-web', 'web', 'a1', 'Web shop');
    const { rect, text } = positions(renderSceneSvg(scene([web, t])), '#a5d8ff', 'Web shop');
    expect(text).toBeGreaterThan(rect);
  });

  it('draws by index when the array order disagrees with it', () => {
    const under = box('under', 'a0', { backgroundColor: '#111111' });
    const over = box('over', 'a1', { backgroundColor: '#222222' });
    const svg = renderSceneSvg(scene([over, under]));
    expect(svg.indexOf('fill="#111111"')).toBeLessThan(svg.indexOf('fill="#222222"'));
  });

  it('does not reorder the elements stored in the file: only the picture is drawn in z-order', () => {
    const web = box('web', null);
    const t = label('t-web', 'web', null, 'Web shop');
    const svg = renderSceneSvg(scene([t, web]));
    const stored = decodeScenePayload(extractScenePayload(svg)!);
    expect(ids(stored.elements)).toEqual(['t-web', 'web']);
    expect(stored.elements.map((e) => e.index)).toEqual([null, null]);
  });
});
