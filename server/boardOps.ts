/**
 * AI assistant (Cursor SDK) — high-level board editing operations for the
 * assistant's `board_ops` MCP tool (see server/mcp.ts). Where boardSketch.ts
 * builds a whole NEW scene from a compact DSL, this module takes an EXISTING
 * scene (read straight off a board page, exactly as `read_page` hands it
 * back) and nudges elements around by id — align, distribute, move, resize,
 * snap-to-grid, or a layered auto-layout — while preserving every element,
 * its id, its bound text, and every arrow binding. This is the "tidy up this
 * board without regenerating it" tool: a `sketch`/`scene` rewrite would blow
 * away the board's exact shapes and connections; this only moves/resizes
 * them and reroutes the arrows that touch what moved.
 *
 * Reuses the SAME element-geometry primitives boardSketch.ts and
 * confluenceWhiteboard.ts's Confluence importer use (placeBoundText,
 * elbowRoute, fixedPointOf, pickSides, boundTextMaxWidth/Height, textMetrics)
 * so a rerouted arrow or a repositioned bound text ends up byte-identical in
 * shape to one boardSketch.ts would have produced from scratch. The result
 * MUST pass confluenceWhiteboard.ts's own selfcheckWhiteboardSvg — same rule
 * as boardSketch.ts, enforced by the caller (server/mcp.ts's board_ops tool)
 * after this module returns, not duplicated here.
 */
import { z } from 'zod';
import {
  boundTextMaxHeight,
  boundTextMaxWidth,
  elbowRoute,
  fixedPointOf,
  placeBoundText,
  textMetrics,
  type ExcalidrawElement,
  type ExcalidrawScene,
} from './confluenceWhiteboard.js';
import { pickSides, SIDE_FRACTION, type Side } from './boardSketch.js';

// ---------------------------------------------------------------------------
// BoardOp schema
// ---------------------------------------------------------------------------

export const boardOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('align'),
    ids: z.array(z.string().min(1)).min(1),
    edge: z.enum(['left', 'centerX', 'right', 'top', 'centerY', 'bottom']),
  }),
  z.object({
    op: z.literal('distribute'),
    ids: z.array(z.string().min(1)).min(2),
    axis: z.enum(['x', 'y']),
    gap: z.number().optional(),
  }),
  z.object({
    op: z.literal('move'),
    ids: z.array(z.string().min(1)).min(1),
    dx: z.number(),
    dy: z.number(),
  }),
  z.object({
    op: z.literal('resize'),
    ids: z.array(z.string().min(1)).min(1),
    w: z.number().positive().optional(),
    h: z.number().positive().optional(),
  }),
  z.object({
    op: z.literal('snap'),
    ids: z.array(z.string().min(1)).optional(),
    grid: z.number().positive().optional(),
  }),
  z.object({
    op: z.literal('auto_layout'),
    direction: z.enum(['LR', 'TB']).optional(),
    colGap: z.number().positive().optional(),
    rowGap: z.number().positive().optional(),
    ids: z.array(z.string().min(1)).optional(),
  }),
]);
export type BoardOp = z.infer<typeof boardOpSchema>;

type ElementMap = Map<string, ExcalidrawElement>;
type AlignEdge = 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom';
type GraphEdge = { from: string; to: string };

/**
 * Small deterministic-enough PRNG for `versionNonce` on edited elements —
 * same rationale as boardSketch.ts's own makeSeeder (not shared: each module
 * that mints/edits elements keeps a tiny private one, plausible-distinct
 * integers are all that's required).
 */
function makeSeeder(): () => number {
  let state = 0x9e3779b9 >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) % 0x7fffffff) + 1;
  };
}

function touch(el: ExcalidrawElement, seed: () => number): void {
  el.version += 1;
  el.versionNonce = seed();
  el.updated = Date.now();
}

function resolveIds(ids: string[], byId: ElementMap, opName: string): ExcalidrawElement[] {
  const out: ExcalidrawElement[] = [];
  for (const id of ids) {
    const el = byId.get(id);
    if (!el) throw new Error(`${opName}: unknown element id "${id}"`);
    out.push(el);
  }
  return out;
}

function boundTextOf(container: ExcalidrawElement, byId: ElementMap): ExcalidrawElement | undefined {
  const ref = (container.boundElements ?? []).find((b) => b.type === 'text');
  return ref ? byId.get(ref.id) : undefined;
}

function sideAnchor(el: ExcalidrawElement, side: Side): [number, number] {
  const frac = SIDE_FRACTION[side];
  return [el.x + el.width * frac.left, el.y + el.height * frac.top];
}

/**
 * Fully recomputes one arrow's geometry from its (possibly just-moved) bound
 * elements: nearest sides (same heuristic boardSketch.ts's edge-building
 * uses), an elbow route or a straight line between the resulting anchor
 * points, and the binding's fixedPoint. An end with no live binding keeps
 * its CURRENT absolute point (so a half-bound arrow — one end on a shape,
 * one end floating — doesn't snap its free end anywhere).
 */
function rerouteArrow(arrow: ExcalidrawElement, byId: ElementMap, seed: () => number): void {
  const startEl = arrow.startBinding ? byId.get(arrow.startBinding.elementId) : undefined;
  const endEl = arrow.endBinding ? byId.get(arrow.endBinding.elementId) : undefined;
  if (!startEl && !endEl) return;

  const pts0 = arrow.points && arrow.points.length >= 2 ? arrow.points : [[0, 0], [0, 0]] as [number, number][];
  const curStart: [number, number] = [arrow.x + pts0[0][0], arrow.y + pts0[0][1]];
  const lastPt = pts0[pts0.length - 1];
  const curEnd: [number, number] = [arrow.x + lastPt[0], arrow.y + lastPt[1]];

  // pseudo-elements for the unbound end: reuse the arrow's own full element
  // shape (so pickSides, which only reads x/y/width/height, gets a valid
  // ExcalidrawElement) pinned to a zero-size box at the current free point.
  const startRef: ExcalidrawElement = startEl ?? { ...arrow, x: curStart[0], y: curStart[1], width: 0, height: 0 };
  const endRef: ExcalidrawElement = endEl ?? { ...arrow, x: curEnd[0], y: curEnd[1], width: 0, height: 0 };
  const [fromSide, toSide] = pickSides(startRef, endRef);

  const s = startEl ? sideAnchor(startEl, fromSide) : curStart;
  const e = endEl ? sideAnchor(endEl, toSide) : curEnd;

  const elbowed = !!arrow.elbowed;
  const abs: [number, number][] = elbowed ? elbowRoute(s, fromSide, e, toSide) : [s, e];
  const pts: [number, number][] = abs.map(([px, py]) => [px - s[0], py - s[1]]);
  const bw = Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0]));
  const bh = Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1]));

  arrow.x = s[0];
  arrow.y = s[1];
  arrow.width = bw;
  arrow.height = bh;
  arrow.points = pts;
  arrow.lastCommittedPoint = null;
  if (startEl) arrow.startBinding = { elementId: startEl.id, focus: 0, gap: 4, ...fixedPointOf(elbowed, SIDE_FRACTION[fromSide]) };
  if (endEl) arrow.endBinding = { elementId: endEl.id, focus: 0, gap: 4, ...fixedPointOf(elbowed, SIDE_FRACTION[toSide]) };
  touch(arrow, seed);
}

/**
 * Runs after any op that moved/resized elements: repositions the bound text
 * of every affected container (including an affected ARROW's own label —
 * placeBoundText already special-cases arrow containers via arrowMidpoint),
 * then fully reroutes every arrow whose start/endBinding points at one of
 * the affected ids — regardless of whether that arrow itself was named by
 * the op. Returns how many arrows were rerouted, for the op's summary line.
 */
function propagateGeometryChanges(affectedIds: Set<string>, byId: ElementMap, seed: () => number): number {
  for (const id of affectedIds) {
    const el = byId.get(id);
    if (!el) continue;
    const label = boundTextOf(el, byId);
    if (label) {
      placeBoundText(el, label);
      touch(label, seed);
    }
  }
  const arrowIds = new Set<string>();
  for (const el of byId.values()) {
    if (el.type !== 'arrow') continue;
    const s = el.startBinding?.elementId;
    const e = el.endBinding?.elementId;
    if ((s && affectedIds.has(s)) || (e && affectedIds.has(e))) arrowIds.add(el.id);
  }
  for (const id of arrowIds) rerouteArrow(byId.get(id)!, byId, seed);
  return arrowIds.size;
}

/**
 * Resizes `el` to (newW, newH), but never below what its bound label needs:
 * re-wraps the label at the new width and, if the re-wrapped text is taller
 * than the new height allows, grows the height just enough to fit it (same
 * "grow for text" rule boardSketch.ts's growForText applies when building a
 * container from scratch).
 */
function applySafeResize(el: ExcalidrawElement, newW: number, newH: number, byId: ElementMap, seed: () => number): void {
  const label = boundTextOf(el, byId);
  let w = newW;
  let h = newH;
  if (label) {
    const fontSize = label.fontSize ?? 16;
    const maxW = boundTextMaxWidth({ ...el, width: w }, fontSize);
    const m = textMetrics(label.originalText ?? label.text ?? '', fontSize, maxW);
    const maxH = boundTextMaxHeight({ ...el, height: h });
    if (m.height > maxH) h += m.height - maxH;
    label.text = m.text;
    label.width = Math.min(m.width, maxW);
    label.height = m.height;
    touch(label, seed);
  }
  el.width = w;
  el.height = h;
  touch(el, seed);
}

// ---------------------------------------------------------------------------
// align / distribute / move / resize / snap
// ---------------------------------------------------------------------------

function edgeValue(el: ExcalidrawElement, edge: AlignEdge): number {
  switch (edge) {
    case 'left': return el.x;
    case 'right': return el.x + el.width;
    case 'centerX': return el.x + el.width / 2;
    case 'top': return el.y;
    case 'bottom': return el.y + el.height;
    case 'centerY': return el.y + el.height / 2;
  }
}

function applyEdge(el: ExcalidrawElement, edge: AlignEdge, target: number): void {
  switch (edge) {
    case 'left': el.x = target; break;
    case 'right': el.x = target - el.width; break;
    case 'centerX': el.x = target - el.width / 2; break;
    case 'top': el.y = target; break;
    case 'bottom': el.y = target - el.height; break;
    case 'centerY': el.y = target - el.height / 2; break;
  }
}

function opAlign(ids: string[], edge: AlignEdge, byId: ElementMap, seed: () => number): string {
  const els = resolveIds(ids, byId, 'align');
  if (els.length === 0) return `align ${edge}: 0 elements`;
  const target = edge === 'centerX' || edge === 'centerY'
    ? els.reduce((sum, el) => sum + edgeValue(el, edge), 0) / els.length
    : edgeValue(els[0], edge);
  const affected = new Set<string>();
  for (const el of els) {
    if (Math.abs(edgeValue(el, edge) - target) < 1e-6) continue;
    applyEdge(el, edge, target);
    touch(el, seed);
    affected.add(el.id);
  }
  propagateGeometryChanges(affected, byId, seed);
  return `align ${edge}: ${els.length} elements`;
}

function opDistribute(ids: string[], axis: 'x' | 'y', gap: number | undefined, byId: ElementMap, seed: () => number): string {
  const els = resolveIds(ids, byId, 'distribute');
  if (els.length < 2) return `distribute ${axis}: skipped (need at least 2 ids)`;
  const sorted = [...els].sort((a, b) => (axis === 'x' ? a.x - b.x : a.y - b.y));
  const size = (e: ExcalidrawElement) => (axis === 'x' ? e.width : e.height);
  const pos = (e: ExcalidrawElement) => (axis === 'x' ? e.x : e.y);
  const setPos = (e: ExcalidrawElement, v: number) => { if (axis === 'x') e.x = v; else e.y = v; };
  const affected = new Set<string>();

  if (gap !== undefined) {
    let cursor = pos(sorted[0]);
    for (const el of sorted) {
      if (Math.abs(pos(el) - cursor) > 1e-6) {
        setPos(el, cursor);
        touch(el, seed);
        affected.add(el.id);
      }
      cursor += size(el) + gap;
    }
  } else {
    if (sorted.length < 3) return `distribute ${axis}: skipped (need at least 3 ids without an explicit gap)`;
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const span = pos(last) + size(last) - pos(first);
    const sumSizes = sorted.reduce((sum, e) => sum + size(e), 0);
    const freeGap = (span - sumSizes) / (sorted.length - 1);
    let cursor = pos(first) + size(first) + freeGap;
    for (let i = 1; i < sorted.length - 1; i++) {
      const el = sorted[i];
      if (Math.abs(pos(el) - cursor) > 1e-6) {
        setPos(el, cursor);
        touch(el, seed);
        affected.add(el.id);
      }
      cursor += size(el) + freeGap;
    }
  }
  propagateGeometryChanges(affected, byId, seed);
  return `distribute ${axis}: ${sorted.length} elements${gap !== undefined ? ` (gap ${gap})` : ''}`;
}

function opMove(ids: string[], dx: number, dy: number, byId: ElementMap, seed: () => number): string {
  const els = resolveIds(ids, byId, 'move');
  const affected = new Set<string>();
  for (const el of els) {
    el.x += dx;
    el.y += dy;
    touch(el, seed);
    affected.add(el.id);
  }
  propagateGeometryChanges(affected, byId, seed);
  return `move: ${els.length} elements (dx=${dx}, dy=${dy})`;
}

function opResize(ids: string[], w: number | undefined, h: number | undefined, byId: ElementMap, seed: () => number): string {
  if (w === undefined && h === undefined) return 'resize: skipped (no w or h given)';
  const requested = resolveIds(ids, byId, 'resize');
  const els = requested.filter((e) => e.type !== 'text' && e.type !== 'arrow' && e.type !== 'frame');
  const skipped = requested.length - els.length;
  const affected = new Set<string>();
  for (const el of els) {
    applySafeResize(el, w ?? el.width, h ?? el.height, byId, seed);
    affected.add(el.id);
  }
  propagateGeometryChanges(affected, byId, seed);
  const dims = [w !== undefined ? `w=${w}` : null, h !== undefined ? `h=${h}` : null].filter(Boolean).join(' ');
  return `resize: ${els.length} elements ${dims}${skipped ? ` (skipped ${skipped} non-resizable element(s))` : ''}`;
}

function opSnap(idsArg: string[] | undefined, grid: number | undefined, byId: ElementMap, seed: () => number): string {
  const g = grid && grid > 0 ? grid : 20;
  const candidates = idsArg ? resolveIds(idsArg, byId, 'snap') : [...byId.values()];
  const els = candidates.filter((e) => e.type !== 'arrow' && !e.containerId);
  const roundTo = (v: number) => Math.round(v / g) * g;
  const affected = new Set<string>();
  for (const el of els) {
    const nx = roundTo(el.x);
    const ny = roundTo(el.y);
    const nw = Math.max(g, roundTo(el.width));
    const nh = Math.max(g, roundTo(el.height));
    if (nx === el.x && ny === el.y && nw === el.width && nh === el.height) continue;
    el.x = nx;
    el.y = ny;
    if (el.type === 'frame') {
      el.width = nw;
      el.height = nh;
      touch(el, seed);
    } else {
      applySafeResize(el, nw, nh, byId, seed);
    }
    affected.add(el.id);
  }
  propagateGeometryChanges(affected, byId, seed);
  return `snap: ${affected.size} of ${els.length} elements to grid ${g}`;
}

// ---------------------------------------------------------------------------
// auto_layout
// ---------------------------------------------------------------------------

/** Longest-path layering (Kahn's algorithm, propagating `layer(u)+1` to every successor) — a node's layer is the longest path from any source that reaches it. Nodes stuck in a cycle never reach in-degree 0 and fall back to layer 0 so they still get placed somewhere. */
function computeLayers(nodeIds: string[], edges: GraphEdge[]): Map<string, number> {
  const adj = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const id of nodeIds) {
    adj.set(id, []);
    indeg.set(id, 0);
  }
  for (const e of edges) {
    if (!adj.has(e.from) || !indeg.has(e.to)) continue;
    adj.get(e.from)!.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const layer = new Map<string, number>();
  const remaining = new Map(indeg);
  const queue: string[] = nodeIds.filter((id) => (indeg.get(id) ?? 0) === 0);
  for (const id of queue) layer.set(id, 0);
  const seen = new Set(queue);
  let i = 0;
  while (i < queue.length) {
    const u = queue[i++];
    for (const v of adj.get(u) ?? []) {
      const candidate = (layer.get(u) ?? 0) + 1;
      if ((layer.get(v) ?? -1) < candidate) layer.set(v, candidate);
      const left = (remaining.get(v) ?? 0) - 1;
      remaining.set(v, left);
      if (left === 0 && !seen.has(v)) {
        seen.add(v);
        queue.push(v);
      }
    }
  }
  for (const id of nodeIds) if (!layer.has(id)) layer.set(id, 0);
  return layer;
}

/** Orders each layer by the barycenter of its nodes' predecessors' positions in the previous (already-ordered) layer — the standard Sugiyama-style layer-ordering heuristic. Layer 0 (no predecessors) keeps its current top-to-bottom (y) order for a stable, non-shuffled start. */
function orderLayers(nodeIds: string[], layer: Map<string, number>, edges: GraphEdge[], byId: ElementMap): Map<number, string[]> {
  const maxLayer = nodeIds.length ? Math.max(...nodeIds.map((id) => layer.get(id) ?? 0)) : -1;
  const byLayer = new Map<number, string[]>();
  for (let l = 0; l <= maxLayer; l++) byLayer.set(l, []);
  for (const id of nodeIds) byLayer.get(layer.get(id) ?? 0)!.push(id);

  const preds = new Map<string, string[]>();
  for (const id of nodeIds) preds.set(id, []);
  for (const e of edges) if (preds.has(e.to) && layer.has(e.from)) preds.get(e.to)!.push(e.from);

  const posInLayer = new Map<string, number>();
  const yOf = (id: string) => byId.get(id)?.y ?? 0;
  for (let l = 0; l <= maxLayer; l++) {
    const nodes = byLayer.get(l)!;
    if (l === 0) {
      nodes.sort((a, b) => yOf(a) - yOf(b));
    } else {
      const barycenter = (id: string): number => {
        const known = (preds.get(id) ?? []).map((p) => posInLayer.get(p)).filter((v): v is number => v !== undefined);
        return known.length ? known.reduce((a, b) => a + b, 0) / known.length : Number.POSITIVE_INFINITY;
      };
      nodes.sort((a, b) => {
        const ba = barycenter(a);
        const bb = barycenter(b);
        return ba !== bb ? ba - bb : yOf(a) - yOf(b);
      });
    }
    nodes.forEach((id, idx) => posInLayer.set(id, idx));
  }
  return byLayer;
}

function rectDistance(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): number {
  const dx = Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width), 0);
  const dy = Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height), 0);
  return Math.hypot(dx, dy);
}

function opAutoLayout(
  direction: 'LR' | 'TB',
  colGap: number,
  rowGap: number,
  idsArg: string[] | undefined,
  byId: ElementMap,
  allElements: ExcalidrawElement[],
  seed: () => number,
): string {
  const shapeTypes = new Set(['rectangle', 'ellipse', 'diamond']);
  if (idsArg) for (const id of idsArg) if (!byId.has(id)) throw new Error(`auto_layout: unknown element id "${id}"`);
  const candidateIds = idsArg ?? [...byId.values()].filter((e) => shapeTypes.has(e.type)).map((e) => e.id);

  let skippedFrames = 0;
  const nodeIds: string[] = [];
  for (const id of candidateIds) {
    const el = byId.get(id);
    if (!el || !shapeTypes.has(el.type)) continue;
    if (el.frameId) {
      skippedFrames++;
      continue;
    }
    nodeIds.push(id);
  }
  if (nodeIds.length === 0) {
    return `auto_layout ${direction}: no eligible nodes${skippedFrames ? ` (skipped ${skippedFrames} inside frames)` : ''}`;
  }
  const nodeSet = new Set(nodeIds);

  const edges: GraphEdge[] = [];
  for (const el of allElements) {
    if (el.type !== 'arrow' || el.isDeleted) continue;
    const s = el.startBinding?.elementId;
    const e = el.endBinding?.elementId;
    if (s && e && nodeSet.has(s) && nodeSet.has(e)) edges.push({ from: s, to: e });
  }

  const degree = new Map<string, number>();
  for (const id of nodeIds) degree.set(id, 0);
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const connectedIds = nodeIds.filter((id) => (degree.get(id) ?? 0) > 0);
  const isolatedIds = nodeIds.filter((id) => (degree.get(id) ?? 0) === 0);

  const layer = computeLayers(connectedIds, edges);
  const byLayer = orderLayers(connectedIds, layer, edges, byId);

  const primaryGap = direction === 'LR' ? colGap : rowGap;
  const secondaryGap = direction === 'LR' ? rowGap : colGap;
  let maxCount = 0;
  for (const arr of byLayer.values()) maxCount = Math.max(maxCount, arr.length);
  const maxExtent = Math.max(0, maxCount - 1) * secondaryGap;

  const originalBoxes = new Map<string, { x: number; y: number; width: number; height: number }>();
  for (const id of nodeIds) {
    const el = byId.get(id)!;
    originalBoxes.set(id, { x: el.x, y: el.y, width: el.width, height: el.height });
  }
  const nodeEls = nodeIds.map((id) => byId.get(id)!);
  const originX = Math.min(...nodeEls.map((e) => e.x));
  const originY = Math.min(...nodeEls.map((e) => e.y));

  const affected = new Set<string>();
  const deltas = new Map<string, { dx: number; dy: number }>();

  for (const [layerIdx, arr] of byLayer.entries()) {
    const extent = Math.max(0, arr.length - 1) * secondaryGap;
    const centerOffset = (maxExtent - extent) / 2;
    arr.forEach((id, idx) => {
      const el = byId.get(id)!;
      const primaryCenter = layerIdx * primaryGap;
      const secondaryCenter = centerOffset + idx * secondaryGap;
      const cx = direction === 'LR' ? primaryCenter : secondaryCenter;
      const cy = direction === 'LR' ? secondaryCenter : primaryCenter;
      const newX = originX + cx - el.width / 2;
      const newY = originY + cy - el.height / 2;
      const dx = newX - el.x;
      const dy = newY - el.y;
      if (Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6) {
        deltas.set(id, { dx, dy });
        el.x = newX;
        el.y = newY;
        touch(el, seed);
        affected.add(id);
      }
    });
  }

  if (isolatedIds.length) {
    const bottom = connectedIds.length
      ? Math.max(...connectedIds.map((id) => { const e = byId.get(id)!; return e.y + e.height; }))
      : originY;
    const rowY = bottom + rowGap;
    isolatedIds.forEach((id, idx) => {
      const el = byId.get(id)!;
      const newX = originX + idx * colGap - el.width / 2;
      const newY = rowY;
      const dx = newX - el.x;
      const dy = newY - el.y;
      if (Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6) {
        deltas.set(id, { dx, dy });
        el.x = newX;
        el.y = newY;
        touch(el, seed);
        affected.add(id);
      }
    });
  }

  // Free-standing text (no containerId, not itself a node): rides along with
  // the nearest node it was within 40px of BEFORE the layout ran, if that
  // node actually moved. Anything farther away is left alone.
  let movedTexts = 0;
  for (const el of allElements) {
    if (el.type !== 'text' || el.containerId || nodeSet.has(el.id)) continue;
    let best: { id: string; dist: number } | null = null;
    for (const id of nodeIds) {
      const box = originalBoxes.get(id)!;
      const dist = rectDistance(el, box);
      if (dist <= 40 && (!best || dist < best.dist)) best = { id, dist };
    }
    const delta = best ? deltas.get(best.id) : undefined;
    if (delta) {
      el.x += delta.dx;
      el.y += delta.dy;
      touch(el, seed);
      movedTexts++;
    }
  }

  const reroutedArrows = propagateGeometryChanges(affected, byId, seed);

  const parts = [
    `auto_layout ${direction}: ${byLayer.size} layer${byLayer.size === 1 ? '' : 's'}, ${nodeIds.length} node${nodeIds.length === 1 ? '' : 's'}, ${reroutedArrows} arrow${reroutedArrows === 1 ? '' : 's'} rerouted`,
  ];
  if (isolatedIds.length) parts.push(`${isolatedIds.length} unconnected node(s) placed in a row below`);
  if (skippedFrames) parts.push(`skipped ${skippedFrames} element(s) inside frames`);
  if (movedTexts) parts.push(`moved ${movedTexts} nearby label(s)`);
  return parts.join('; ');
}

// ---------------------------------------------------------------------------
// applyBoardOps
// ---------------------------------------------------------------------------

/**
 * Applies `ops` in order to a COPY of `scene` (the input is never mutated)
 * and returns the edited scene plus a human-readable summary line per op.
 * Element ids never change; only geometry (x/y/width/height/points) and the
 * version/versionNonce/updated bookkeeping on TOUCHED elements. Throws a
 * plain Error (never a partial result) on an unknown element id, exactly
 * like boardSketch.ts's buildSceneFromSketch does for a bad reference — the
 * MCP tool turns that into one errorResult.
 */
export function applyBoardOps(scene: ExcalidrawScene, ops: BoardOp[]): { scene: ExcalidrawScene; summary: string } {
  const elements: ExcalidrawElement[] = scene.elements.map((e) => ({ ...e }));
  const byId: ElementMap = new Map(elements.map((e) => [e.id, e]));
  const seed = makeSeeder();
  const summaries: string[] = [];

  for (const op of ops) {
    switch (op.op) {
      case 'align':
        summaries.push(opAlign(op.ids, op.edge, byId, seed));
        break;
      case 'distribute':
        summaries.push(opDistribute(op.ids, op.axis, op.gap, byId, seed));
        break;
      case 'move':
        summaries.push(opMove(op.ids, op.dx, op.dy, byId, seed));
        break;
      case 'resize':
        summaries.push(opResize(op.ids, op.w, op.h, byId, seed));
        break;
      case 'snap':
        summaries.push(opSnap(op.ids, op.grid, byId, seed));
        break;
      case 'auto_layout':
        summaries.push(opAutoLayout(op.direction ?? 'LR', op.colGap ?? 260, op.rowGap ?? 140, op.ids, byId, elements, seed));
        break;
    }
  }

  return { scene: { ...scene, elements }, summary: summaries.join('\n') };
}
