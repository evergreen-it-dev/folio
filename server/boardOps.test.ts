/**
 * server/boardOps.ts — one focused smoke test per the round's instructions:
 * build a scene from a ragged sketch (6 nodes, 5 edges), run auto_layout +
 * align + distribute over it, and verify the result still passes
 * confluenceWhiteboard.ts's own selfcheckWhiteboardSvg (the SAME guard
 * boardSketch.test.ts checks against), keeps every element, and that every
 * arrow's points still start/end at the (gap-adjusted) edge of its bound
 * shape.
 */
import { describe, expect, it } from 'vitest';
import { renderSceneSvg, selfcheckWhiteboardSvg, type ExcalidrawElement } from './confluenceWhiteboard.js';
import { buildSceneFromSketch, type BoardSketch } from './boardSketch.js';
import { applyBoardOps } from './boardOps.js';

describe('boardOps.ts: applyBoardOps', () => {
  it('auto_layout + align + distribute keep the scene intact and passing selfcheck', () => {
    // A deliberately ragged layout: 6 nodes, 5 edges (a small DAG with one
    // branch), scattered x/y so auto_layout has real work to do.
    const sketch: BoardSketch = {
      nodes: [
        { id: 'a', type: 'rectangle', label: 'Start', x: 900, y: 500 },
        { id: 'b', type: 'ellipse', label: 'Step B', x: 40, y: 10 },
        { id: 'c', type: 'diamond', label: 'Decide', x: 400, y: 900 },
        { id: 'd', type: 'rectangle', label: 'Step D', x: 700, y: 20 },
        { id: 'e', type: 'rectangle', label: 'End', x: 10, y: 700 },
        { id: 'f', type: 'rectangle', label: 'Unlinked note box', x: 1200, y: 1200 },
        { id: 'note', type: 'text', label: 'nearby free note', x: 895, y: 420, w: 160 },
      ],
      edges: [
        { from: 'a', to: 'c', label: 'go' },
        { from: 'c', to: 'd', elbowed: false },
        { from: 'c', to: 'e' },
        { from: 'b', to: 'a' },
        { from: 'd', to: 'e', start: 'arrow', end: 'arrow' },
      ],
    };

    const scene = buildSceneFromSketch(sketch);
    const originalCount = scene.elements.length;

    const { scene: laidOut, summary } = applyBoardOps(scene, [
      { op: 'auto_layout', direction: 'LR', colGap: 260, rowGap: 140 },
      { op: 'align', ids: ['b', 'd'], edge: 'top' },
      { op: 'distribute', ids: ['a', 'c', 'e'], axis: 'y' },
    ]);

    expect(summary).toContain('auto_layout LR');
    expect(summary).toContain('align top');
    expect(summary).toContain('distribute y');

    const svg = renderSceneSvg(laidOut);
    const count = selfcheckWhiteboardSvg(svg);
    expect(count).toBe(originalCount);
    expect(laidOut.elements.length).toBe(originalCount);

    // ids are stable — the same set of ids survives the ops untouched.
    const beforeIds = new Set(scene.elements.map((e) => e.id));
    const afterIds = new Set(laidOut.elements.map((e) => e.id));
    expect(afterIds).toEqual(beforeIds);

    const byId = new Map(laidOut.elements.map((e) => [e.id, e]));

    // Every arrow that has both bindings must still have its first/last
    // point sitting exactly on the (gap-independent) edge of its bound
    // shape — rerouteArrow always places the raw anchor ON the box edge.
    for (const el of laidOut.elements) {
      if (el.type !== 'arrow') continue;
      expect(el.startBinding).toBeTruthy();
      expect(el.endBinding).toBeTruthy();
      const startShape = byId.get(el.startBinding!.elementId)!;
      const endShape = byId.get(el.endBinding!.elementId)!;
      const pts = el.points!;
      const firstAbs: [number, number] = [el.x + pts[0][0], el.y + pts[0][1]];
      const lastAbs: [number, number] = [el.x + pts[pts.length - 1][0], el.y + pts[pts.length - 1][1]];
      expect(onBoxEdge(firstAbs, startShape)).toBe(true);
      expect(onBoxEdge(lastAbs, endShape)).toBe(true);
    }

    // Bound text of every shape container stays fully inside it — the same
    // containment selfcheckWhiteboardSvg enforces, restated directly here.
    for (const el of laidOut.elements) {
      if (!el.containerId) continue;
      const container = byId.get(el.containerId)!;
      if (container.type === 'arrow') continue;
      expect(el.x).toBeGreaterThanOrEqual(container.x - 0.5);
      expect(el.y).toBeGreaterThanOrEqual(container.y - 0.5);
      expect(el.x + el.width).toBeLessThanOrEqual(container.x + container.width + 0.5);
      expect(el.y + el.height).toBeLessThanOrEqual(container.y + container.height + 0.5);
    }
  });
});

/** True if `pt` lies on the boundary rectangle of `box` (within a small epsilon — anchor points are placed exactly on an edge fraction). */
function onBoxEdge(pt: [number, number], box: ExcalidrawElement): boolean {
  const eps = 0.5;
  const onLeft = Math.abs(pt[0] - box.x) < eps;
  const onRight = Math.abs(pt[0] - (box.x + box.width)) < eps;
  const onTop = Math.abs(pt[1] - box.y) < eps;
  const onBottom = Math.abs(pt[1] - (box.y + box.height)) < eps;
  const withinX = pt[0] >= box.x - eps && pt[0] <= box.x + box.width + eps;
  const withinY = pt[1] >= box.y - eps && pt[1] <= box.y + box.height + eps;
  return ((onLeft || onRight) && withinY) || ((onTop || onBottom) && withinX);
}
