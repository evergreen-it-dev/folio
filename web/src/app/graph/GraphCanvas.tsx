/**
 * Graph view, the drawing half: a <canvas> (2D) driven by d3-force.
 *
 * Why d3-force + our own canvas rather than a graph library: it is the same
 * force model as Obsidian's graph (centre, repel, link force, link distance map
 * one-to-one onto forceX/Y, forceManyBody, forceLink), it is ~15 KB gzipped
 * with no further dependencies (force-graph pulls ~10 packages and its own DOM
 * tooltips; sigma needs WebGL and a separate layout package), and a canvas we
 * draw ourselves takes the page's light/dark colours, culls what is off screen
 * and batches every edge into one path — 5k nodes / 20k edges stay
 * interactive.
 *
 * Interactions: wheel / pinch zoom, drag the background to pan, drag a node to
 * move it (it stays where it is dropped), hover highlights the node and its
 * neighbours and shows its title, a click opens the page. On touch the first
 * tap selects (title + an "Open" button from the host), so a finger can read
 * before it navigates. With prefers-reduced-motion the layout is computed in
 * one go and drawn still — nothing animates.
 */
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';
import { getColorScheme, subscribeColorScheme, type ColorScheme } from '../../diagrams/colorScheme';
import { planLabels, type LabelCandidate } from './graphLabels';
import { neighbourhood, type GraphSettings, type ViewLink, type ViewNode } from './graphModel';

interface SimNode extends SimulationNodeDatum {
  id: string;
  view: ViewNode;
}
type SimLink = SimulationLinkDatum<SimNode> & { count: number; tree: boolean };

export interface GraphCanvasHandle {
  fit: () => void;
  zoomBy: (factor: number) => void;
}

export interface GraphCanvasProps {
  nodes: ViewNode[];
  links: ViewLink[];
  settings: GraphSettings;
  /** A page node was clicked (or a selected node's "Open" pressed). */
  onOpen: (node: ViewNode) => void;
  /** Touch selection / keyboard-free hover, for the host to show a card. */
  onSelect?: (node: ViewNode | null) => void;
  selectedId?: string | null;
  /** Small panel (local graph beside the page): smaller labels, fewer of them. */
  compact?: boolean;
  ariaLabel: string;
  handleRef?: Ref<GraphCanvasHandle>;
}

interface Theme {
  link: string;
  linkFaded: string;
  linkHot: string;
  label: string;
  labelHalo: string;
  ring: string;
}

const THEMES: Record<ColorScheme, Theme> = {
  light: { link: 'rgba(100,116,139,0.35)', linkFaded: 'rgba(100,116,139,0.08)', linkHot: 'rgba(79,70,229,0.85)', label: '#262626', labelHalo: 'rgba(255,255,255,0.85)', ring: '#171717' },
  dark: { link: 'rgba(148,163,184,0.28)', linkFaded: 'rgba(148,163,184,0.06)', linkHot: 'rgba(165,180,252,0.9)', label: '#e5e5e5', labelHalo: 'rgba(10,10,10,0.8)', ring: '#fafafa' },
};

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Above this many nodes, the first layout steps run before the first frame, so the graph does not "explode" on screen. */
const WARM_UP_NODES = 600;

/** Longest label (characters, before the ellipsis) on the small local-graph canvas. */
const COMPACT_LABEL_CHARS = 16;

export function GraphCanvas({ nodes, links, settings, onOpen, onSelect, selectedId, compact = false, ariaLabel, handleRef }: GraphCanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const simNodesRef = useRef<Map<string, SimNode>>(new Map());
  const simLinksRef = useRef<SimLink[]>([]);
  const transformRef = useRef({ k: 1, x: 0, y: 0 });
  const sizeRef = useRef({ w: 300, h: 200, dpr: 1 });
  const hoverRef = useRef<string | null>(null);
  const hotRef = useRef<Set<string> | null>(null);
  const fitKRef = useRef(0);
  const widthCacheRef = useRef<{ font: number; map: Map<string, number> }>({ font: 0, map: new Map() });
  const frameRef = useRef(0);
  // Keep the whole graph in view while the layout spreads out — until the viewer zooms or pans themselves.
  const autoFitRef = useRef(true);
  const userMovedRef = useRef(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const selectedRef = useRef<string | null>(selectedId ?? null);
  selectedRef.current = selectedId ?? null;
  const linksRef = useRef(links);
  linksRef.current = links;
  const [scheme, setScheme] = useState<ColorScheme>(() => getColorScheme());
  const schemeRef = useRef(scheme);
  schemeRef.current = scheme;
  const [hoverTitle, setHoverTitle] = useState<{ title: string; x: number; y: number } | null>(null);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => subscribeColorScheme(setScheme), []);

  // ---------- drawing ----------
  const draw = useCallback(() => {
    frameRef.current = 0;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { w, h, dpr } = sizeRef.current;
    const { k, x, y } = transformRef.current;
    const s = settingsRef.current;
    const theme = THEMES[schemeRef.current];
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * x, dpr * y);

    const focus = hoverRef.current ?? selectedRef.current;
    const hot = focus ? (hotRef.current ??= neighbourhood(focus, linksRef.current)) : null;
    // Visible world rectangle, with a margin, for culling.
    const pad = 40 / k;
    const x0 = -x / k - pad;
    const y0 = -y / k - pad;
    const x1 = (w - x) / k + pad;
    const y1 = (h - y) / k + pad;
    const inView = (n: SimNode) => n.x! >= x0 && n.x! <= x1 && n.y! >= y0 && n.y! <= y1;

    // Edges: one path per style.
    const lw = (0.8 * s.linkThickness) / Math.max(0.35, Math.sqrt(k));
    const simLinks = simLinksRef.current;
    const strokeLinks = (filter: (l: SimLink) => boolean, color: string, width: number, dash?: number[]) => {
      ctx.beginPath();
      for (const l of simLinks) {
        if (!filter(l)) continue;
        const a = l.source as SimNode;
        const b = l.target as SimNode;
        if ((a.x! < x0 && b.x! < x0) || (a.x! > x1 && b.x! > x1) || (a.y! < y0 && b.y! < y0) || (a.y! > y1 && b.y! > y1)) continue;
        ctx.moveTo(a.x!, a.y!);
        ctx.lineTo(b.x!, b.y!);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      if (dash) ctx.setLineDash(dash);
      ctx.stroke();
      if (dash) ctx.setLineDash([]);
    };
    const isHot = (l: SimLink) => !!hot && !!focus && ((l.source as SimNode).id === focus || (l.target as SimNode).id === focus);
    // Tree edges (parent → child, not links): dashed and thinner, under the links.
    const treeDash = [4 / k, 3 / k];
    strokeLinks((l) => l.tree && !isHot(l), hot ? theme.linkFaded : theme.link, lw * 0.7, treeDash);
    strokeLinks((l) => !l.tree && !isHot(l), hot ? theme.linkFaded : theme.link, lw);
    if (hot) {
      strokeLinks((l) => l.tree && isHot(l), theme.linkHot, lw * 1.1, treeDash);
      strokeLinks((l) => !l.tree && isHot(l), theme.linkHot, lw * 1.6);
    }

    if (s.arrows && (simLinks.length < 4000 || k > 1)) {
      ctx.beginPath();
      for (const l of simLinks) {
        if (l.tree) continue; // a tree edge is no link: no arrow
        const a = l.source as SimNode;
        const b = l.target as SimNode;
        if (!inView(b)) continue;
        if (hot && !isHot(l) && hot.size > 0 && focus) continue;
        const dx = b.x! - a.x!;
        const dy = b.y! - a.y!;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        const tipX = b.x! - ux * (b.view.radius + 1);
        const tipY = b.y! - uy * (b.view.radius + 1);
        const size = Math.max(3, 4 * s.linkThickness) / Math.max(0.6, Math.sqrt(k));
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(tipX - ux * size - uy * size * 0.5, tipY - uy * size + ux * size * 0.5);
        ctx.lineTo(tipX - ux * size + uy * size * 0.5, tipY - uy * size - ux * size * 0.5);
        ctx.closePath();
      }
      ctx.fillStyle = hot ? theme.linkHot : theme.link.replace(/0\.\d+\)$/, '0.6)');
      ctx.fill();
    }

    // Nodes, batched by colour and shape; faded ones first.
    const all = [...simNodesRef.current.values()];
    const batches = new Map<string, SimNode[]>();
    for (const n of all) {
      if (!inView(n)) continue;
      const faded = hot ? !hot.has(n.id) : false;
      const key = `${faded ? 0 : 1}|${n.view.kind === 'file' ? 's' : n.view.kind === 'unresolved' ? 'r' : n.view.space ? 'o' : 'c'}|${n.view.color}`;
      let list = batches.get(key);
      if (!list) batches.set(key, (list = []));
      list.push(n);
    }
    for (const [key, list] of [...batches.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const [faded, shape, color] = key.split('|');
      ctx.globalAlpha = faded === '0' ? 0.18 : 1;
      ctx.beginPath();
      for (const n of list) {
        const r = n.view.radius;
        if (shape === 's') {
          ctx.rect(n.x! - r, n.y! - r, r * 2, r * 2);
        } else {
          ctx.moveTo(n.x! + r, n.y!);
          ctx.arc(n.x!, n.y!, r, 0, Math.PI * 2);
        }
      }
      if (shape === 'r') {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5 / Math.sqrt(k);
        ctx.setLineDash([2 / k, 2 / k]);
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (shape === 'o') {
        // A page of another space: a pale disc with a solid ring in its colour.
        const alpha = ctx.globalAlpha;
        ctx.globalAlpha = alpha * 0.3;
        ctx.fillStyle = color;
        ctx.fill();
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2 / Math.sqrt(k);
        ctx.stroke();
      } else {
        ctx.fillStyle = color;
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // Rings: the centre of a local graph, the selected node.
    for (const id of [selectedRef.current, ...all.filter((n) => n.view.isCenter).map((n) => n.id)]) {
      const n = id ? simNodesRef.current.get(id) : undefined;
      if (!n) continue;
      ctx.beginPath();
      if (compact && n.view.isCenter) {
        // The local graph's current page: a soft halo in the node's own colour instead of a hard outline.
        ctx.arc(n.x!, n.y!, n.view.radius + 3.5 / k, 0, Math.PI * 2);
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = n.view.color;
        ctx.lineWidth = 2.5 / k;
        ctx.stroke();
        ctx.globalAlpha = 1;
        continue;
      }
      ctx.arc(n.x!, n.y!, n.view.radius + 2.5 / k, 0, Math.PI * 2);
      ctx.strokeStyle = theme.ring;
      ctx.lineWidth = 1.5 / k;
      ctx.stroke();
    }

    // Labels: screen-size text, chosen by graphLabels.ts — the focus, its neighbours and the centre always; the
    // rest by degree, fading in with the zoom (top hubs first at a low zoom) and never over one another.
    const fontPx = compact ? 10 : 12;
    ctx.font = `${fontPx / k}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    const widths = widthCacheRef.current;
    if (widths.font !== fontPx) {
      widths.font = fontPx;
      widths.map.clear();
    }
    const measure = (text: string) => {
      let w = widths.map.get(text);
      if (w === undefined) {
        w = ctx.measureText(text).width * k; // the font is `fontPx` on screen at any zoom, so this width is stable
        widths.map.set(text, w);
      }
      return w;
    };
    const candidates: LabelCandidate[] = [];
    for (const n of all) {
      if (!inView(n)) continue;
      candidates.push({
        id: n.id,
        sx: n.x! * k + x,
        sy: n.y! * k + y,
        radiusPx: n.view.radius * k,
        degree: n.view.degree,
        text: n.view.title.length > (compact ? COMPACT_LABEL_CHARS + 1 : 40) ? `${n.view.title.slice(0, compact ? COMPACT_LABEL_CHARS : 39).trimEnd()}…` : n.view.title,
        isCenter: n.view.isCenter,
      });
    }
    const planned = planLabels({ candidates, total: all.length, k, labelZoom: s.labelZoom, fitK: fitKRef.current, area: w * h, focusId: focus, hot, measure, fontPx, maxLabels: compact ? 8 : 600 });
    for (const label of planned) {
      ctx.globalAlpha = label.alpha;
      const lx = (label.sx - x) / k;
      const ty = (label.top - y) / k;
      ctx.strokeStyle = theme.labelHalo;
      ctx.lineWidth = 3 / k;
      ctx.strokeText(label.text, lx, ty);
      ctx.fillStyle = theme.label;
      ctx.fillText(label.text, lx, ty);
    }
    ctx.globalAlpha = 1;
  }, [compact]);

  const requestDraw = useCallback(() => {
    if (!frameRef.current) frameRef.current = requestAnimationFrame(draw);
  }, [draw]);

  useEffect(() => {
    hotRef.current = null; // the highlighted neighbourhood follows the selection
    requestDraw();
  }, [scheme, selectedId, settings.arrows, settings.labelZoom, settings.linkThickness, requestDraw]);

  // ---------- fit / zoom ----------
  const fit = useCallback(() => {
    const list = [...simNodesRef.current.values()];
    if (!list.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of list) {
      minX = Math.min(minX, n.x! - n.view.radius);
      minY = Math.min(minY, n.y! - n.view.radius);
      maxX = Math.max(maxX, n.x! + n.view.radius);
      maxY = Math.max(maxY, n.y! + n.view.radius + 14);
    }
    const { w, h } = sizeRef.current;
    let k: number;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    if (compact) {
      // Padding all round, and every node's (truncated, centred) label counted by its own width, so nothing is clipped.
      const pad = 12;
      let kx = 1.6;
      for (const n of list) {
        const text = n.view.title.length > COMPACT_LABEL_CHARS + 1 ? COMPACT_LABEL_CHARS + 1 : n.view.title.length;
        const half = Math.max(n.view.radius + 4, (text * 5.3) / 2);
        const dx = Math.abs(n.x! - cx);
        if (dx > 0) kx = Math.min(kx, (w / 2 - pad - half) / dx);
      }
      let top = Infinity, bottom = -Infinity, rMax = 0;
      for (const n of list) {
        top = Math.min(top, n.y!);
        bottom = Math.max(bottom, n.y!);
        rMax = Math.max(rMax, n.view.radius);
      }
      const LABEL_PX = 16; // the label under the lowest node, screen size
      const ky = (h - pad * 2 - LABEL_PX) / Math.max(1, bottom - top + 2 * rMax);
      k = Math.max(0.05, Math.min(1.6, kx, ky));
      const contentH = (bottom - top + 2 * rMax) * k + LABEL_PX;
      const ty = (h - contentH) / 2 + rMax * k - top * k;
      transformRef.current = { k, x: w / 2 - cx * k, y: ty };
      fitKRef.current = k;
      requestDraw();
      return;
    } else {
      const margin = 40;
      k = Math.min(2, Math.max(0.05, Math.min((w - margin * 2) / Math.max(1, maxX - minX), (h - margin * 2) / Math.max(1, maxY - minY))));
    }
    transformRef.current = { k, x: w / 2 - cx * k, y: h / 2 - cy * k };
    fitKRef.current = k;
    requestDraw();
  }, [compact, requestDraw]);

  const zoomAt = useCallback(
    (factor: number, sx: number, sy: number) => {
      autoFitRef.current = false;
      userMovedRef.current = true;
      const t = transformRef.current;
      const k = Math.min(8, Math.max(0.03, t.k * factor));
      const wx = (sx - t.x) / t.k;
      const wy = (sy - t.y) / t.k;
      transformRef.current = { k, x: sx - wx * k, y: sy - wy * k };
      requestDraw();
    },
    [requestDraw],
  );

  useImperativeHandle(handleRef, () => ({ fit, zoomBy: (f) => zoomAt(f, sizeRef.current.w / 2, sizeRef.current.h / 2) }), [fit, zoomAt]);

  // ---------- size ----------
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const apply = () => {
      const rect = wrap.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      sizeRef.current = { w: Math.max(1, rect.width), h: Math.max(1, rect.height), dpr };
      canvas.width = Math.round(sizeRef.current.w * dpr);
      canvas.height = Math.round(sizeRef.current.h * dpr);
      canvas.style.width = `${sizeRef.current.w}px`;
      canvas.style.height = `${sizeRef.current.h}px`;
      requestDraw();
    };
    apply();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(apply);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [requestDraw]);

  // ---------- simulation: rebuilt on new data, positions kept by id ----------
  useEffect(() => {
    const prev = simNodesRef.current;
    const next = new Map<string, SimNode>();
    const isNew = prev.size === 0;
    nodes.forEach((view, i) => {
      const old = prev.get(view.id);
      if (old) {
        old.view = view;
        next.set(view.id, old);
      } else {
        // Spiral seed: deterministic, compact, no overlap at the start.
        const a = i * 2.399963;
        const r = 10 * Math.sqrt(i + 1);
        next.set(view.id, { id: view.id, view, x: Math.cos(a) * r, y: Math.sin(a) * r });
      }
    });
    simNodesRef.current = next;
    simLinksRef.current = links
      .filter((l) => next.has(l.source) && next.has(l.target))
      .map((l) => ({ source: next.get(l.source)!, target: next.get(l.target)!, count: l.count, tree: l.tree === true }));
    hotRef.current = null;

    const sim = simRef.current ?? forceSimulation<SimNode, SimLink>();
    simRef.current = sim;
    sim.nodes([...next.values()]);
    sim.force('link', forceLink<SimNode, SimLink>(simLinksRef.current).id((n) => n.id));
    applyForces(sim, settingsRef.current, next.size);
    autoFitRef.current = !userMovedRef.current;
    sim.on('tick', () => (autoFitRef.current ? fit() : requestDraw()));
    sim.on('end', () => {
      autoFitRef.current = false;
    });

    if (prefersReducedMotion()) {
      sim.stop();
      sim.alpha(1);
      const steps = Math.min(300, Math.max(60, Math.round(120000 / Math.max(1, next.size))));
      for (let i = 0; i < steps; i++) sim.tick();
      if (!userMovedRef.current) fit();
      autoFitRef.current = false;
    } else {
      sim.alpha(isNew ? 1 : 0.5).restart();
      if (isNew && next.size > WARM_UP_NODES) {
        sim.stop();
        for (let i = 0; i < 40; i++) sim.tick();
        sim.restart();
      }
      if (autoFitRef.current) fit();
    }
    requestDraw();
  }, [nodes, links, fit, requestDraw]);

  // Forces follow the sliders without rebuilding (not on mount: the simulation effect above has just applied them).
  const forcesMountedRef = useRef(false);
  useEffect(() => {
    const sim = simRef.current;
    if (!forcesMountedRef.current) {
      forcesMountedRef.current = true;
      return;
    }
    if (!sim) return;
    applyForces(sim, settingsRef.current, simNodesRef.current.size);
    if (prefersReducedMotion()) {
      for (let i = 0; i < 120; i++) sim.tick();
      requestDraw();
    } else {
      sim.alpha(0.4).restart();
    }
  }, [settings.centerForce, settings.repelForce, settings.linkForce, settings.linkDistance, requestDraw]);

  useEffect(
    () => () => {
      simRef.current?.stop();
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  // ---------- pointer input ----------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const pointers = new Map<number, { x: number; y: number }>();
    let drag: { kind: 'pan' | 'node'; node?: SimNode; startX: number; startY: number; moved: boolean; pointerType: string } | null = null;
    let pinch: { dist: number } | null = null;

    const local = (e: PointerEvent | WheelEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const nodeAt = (sx: number, sy: number): SimNode | undefined => {
      const t = transformRef.current;
      const wx = (sx - t.x) / t.k;
      const wy = (sy - t.y) / t.k;
      let best: SimNode | undefined;
      let bestD = Infinity;
      for (const n of simNodesRef.current.values()) {
        const d = Math.hypot(n.x! - wx, n.y! - wy);
        const hit = n.view.radius + 4 / t.k;
        if (d <= hit && d < bestD) {
          best = n;
          bestD = d;
        }
      }
      return best;
    };
    const setHover = (n: SimNode | undefined, sx = 0, sy = 0) => {
      const id = n?.id ?? null;
      if (hoverRef.current !== id) {
        hoverRef.current = id;
        hotRef.current = null;
        requestDraw();
      }
      setHoverTitle(n ? { title: n.view.title, x: sx, y: sy } : null);
      canvas.style.cursor = n ? 'pointer' : drag?.kind === 'pan' ? 'grabbing' : 'grab';
    };

    const onDown = (e: PointerEvent) => {
      const p = local(e);
      pointers.set(e.pointerId, p);
      canvas.setPointerCapture(e.pointerId);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) };
        if (drag?.node) {
          drag.node.fx = null;
          drag.node.fy = null;
        }
        drag = null;
        return;
      }
      const n = nodeAt(p.x, p.y);
      drag = { kind: n ? 'node' : 'pan', node: n, startX: p.x, startY: p.y, moved: false, pointerType: e.pointerType };
    };
    const onMove = (e: PointerEvent) => {
      const p = local(e);
      const prev = pointers.get(e.pointerId);
      if (prev) pointers.set(e.pointerId, p);
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch.dist > 0) zoomAt(dist / pinch.dist, (a.x + b.x) / 2, (a.y + b.y) / 2);
        pinch.dist = dist;
        return;
      }
      if (!drag) {
        if (e.pointerType === 'mouse') setHover(nodeAt(p.x, p.y), p.x, p.y);
        return;
      }
      if (!drag.moved && Math.hypot(p.x - drag.startX, p.y - drag.startY) < 4) return;
      drag.moved = true;
      if (drag.kind === 'pan' && prev) {
        autoFitRef.current = false;
        userMovedRef.current = true;
        const t = transformRef.current;
        transformRef.current = { k: t.k, x: t.x + (p.x - prev.x), y: t.y + (p.y - prev.y) };
        canvas.style.cursor = 'grabbing';
        requestDraw();
      } else if (drag.node) {
        const t = transformRef.current;
        drag.node.fx = (p.x - t.x) / t.k;
        drag.node.fy = (p.y - t.y) / t.k;
        const sim = simRef.current;
        if (sim) {
          if (prefersReducedMotion()) {
            drag.node.x = drag.node.fx;
            drag.node.y = drag.node.fy;
            requestDraw();
          } else sim.alphaTarget(0.25).restart();
        }
        if (e.pointerType === 'mouse') setHover(drag.node, p.x, p.y);
      }
    };
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pinch) {
        if (pointers.size < 2) pinch = null;
        return;
      }
      const d = drag;
      drag = null;
      simRef.current?.alphaTarget(0);
      canvas.style.cursor = 'grab';
      if (!d || d.moved) return;
      if (d.node) {
        if (d.pointerType === 'mouse') onOpenRef.current(d.node.view);
        else onSelectRef.current?.(d.node.view);
      } else {
        onSelectRef.current?.(null);
      }
    };
    const onLeave = () => {
      if (!drag) setHover(undefined);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = local(e);
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      zoomAt(factor, p.x, p.y);
    };
    const onKey = (e: KeyboardEvent) => {
      const { w, h } = sizeRef.current;
      if (e.key === '+' || e.key === '=') zoomAt(1.25, w / 2, h / 2);
      else if (e.key === '-') zoomAt(0.8, w / 2, h / 2);
      else if (e.key === '0') fit();
      else if (e.key.startsWith('Arrow')) {
        autoFitRef.current = false;
        userMovedRef.current = true;
        const t = transformRef.current;
        const step = e.shiftKey ? 120 : 40;
        const dx = e.key === 'ArrowLeft' ? step : e.key === 'ArrowRight' ? -step : 0;
        const dy = e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0;
        transformRef.current = { ...t, x: t.x + dx, y: t.y + dy };
        requestDraw();
      } else return;
      e.preventDefault();
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('keydown', onKey);
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('keydown', onKey);
    };
  }, [fit, requestDraw, zoomAt]);

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden">
      <canvas ref={canvasRef} role="img" aria-label={ariaLabel} tabIndex={0} className="block touch-none outline-none focus-visible:ring-2 focus-visible:ring-indigo-400" style={{ cursor: 'grab' }} />
      {hoverTitle && (
        <div
          className="pointer-events-none absolute z-10 max-w-64 truncate rounded bg-neutral-900/90 px-2 py-1 text-xs text-white shadow dark:bg-neutral-100/90 dark:text-neutral-900"
          style={{ left: Math.min(hoverTitle.x + 12, sizeRef.current.w - 120), top: hoverTitle.y + 12 }}
        >
          {hoverTitle.title}
        </div>
      )}
    </div>
  );
}

/** Settings → forces (Obsidian's four sliders). */
function applyForces(sim: Simulation<SimNode, SimLink>, s: GraphSettings, count: number): void {
  const link = sim.force('link') as ReturnType<typeof forceLink<SimNode, SimLink>> | undefined;
  if (link) {
    link.distance(s.linkDistance);
    // d3's default strength, scaled: 1 / min(degree of the two ends).
    const deg = new Map<string, number>();
    for (const l of link.links()) {
      const a = typeof l.source === 'object' ? (l.source as SimNode).id : String(l.source);
      const b = typeof l.target === 'object' ? (l.target as SimNode).id : String(l.target);
      deg.set(a, (deg.get(a) ?? 0) + 1);
      deg.set(b, (deg.get(b) ?? 0) + 1);
    }
    link.strength((l) => {
      const a = (l.source as SimNode).id;
      const b = (l.target as SimNode).id;
      return (s.linkForce * 1.6) / Math.min(deg.get(a) ?? 1, deg.get(b) ?? 1);
    });
  }
  sim.force('charge', forceManyBody<SimNode>().strength(-s.repelForce * 20).theta(count > 2000 ? 1.2 : 0.9).distanceMax(count > 2000 ? 600 : 1200));
  sim.force('x', forceX<SimNode>(0).strength(s.centerForce * 0.15));
  sim.force('y', forceY<SimNode>(0).strength(s.centerForce * 0.15));
  sim.alphaDecay(count > 2000 ? 0.04 : 0.0228);
}
