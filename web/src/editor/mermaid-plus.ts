/**
 * Growing a diagram on the canvas: the affordances the visual mermaid editor
 * does not ship with.
 *
 * Round 21 added the (+) that hangs off a hovered node. Round 25 is the owner's
 * follow-up, verbatim: "(+) on an edge and the ability to pull an edge from
 * node to node without the Connect button at the top are missing. maybe draw
 * a (link) next to the node's (+)". So the hover affordance is now a small pair —
 *
 *   (+)  add a connected node          (link)  drag from here to another node
 *
 * — and an edge gets a (+) of its own at its midpoint, which drops a node into
 * the middle of the connection (`A --> B` becomes `A --> N --> B`).
 *
 * WHY OUR OWN DRAG rather than visimer's. @visimer/dom already understands a
 * node-to-node drag: `onSvgPointerDown` starts one when `tool === 'connect'` or
 * `event.altKey`. Neither is discoverable, which is the owner's complaint, and
 * neither can be started from a button of ours:
 *
 *  - handing visimer a synthesized PointerEvent runs it straight into
 *    `svg.setPointerCapture(e.pointerId)`, which throws `NotFoundError` for a
 *    pointer id the browser has no record of — the gesture would half-start;
 *  - the SVG those handlers are bound to is replaced wholesale on every render,
 *    so anything holding a reference to it is stale within one edit;
 *  - and jsdom has neither pointer capture nor `elementFromPoint`, so a drag
 *    built on them could not be tested at all.
 *
 * Ours is a plain pointer drag over a ghost line we draw ourselves, ending in
 * `connectEntities` — the same semantic ops visimer's own drag dispatches. The
 * canvas bar's "Connect" toggle (visimer's `tool` prop) stays as the fallback
 * path the owner asked to keep.
 *
 * Everything here is plain DOM appended to visimer's container rather than a
 * React overlay: the container is not ours to re-render, positions come from
 * `getBoundingClientRect`/`getScreenCTM` on SVG elements visimer replaces on
 * every render, and hover has to be answered in the same frame it happens.
 */
import { createIcon } from './icons';
import {
  connectEntities,
  nodeFamily,
  plusIntent,
  runPlus,
  type Canvas,
  type CanvasEditor,
  type GraphFamily,
  type PlusIntent,
} from './mermaid-ops';

export type { Canvas, CanvasEditor } from './mermaid-ops';

/* ------------------------------------------------------------- geometry -- */

/** Container-relative point the affordance is centred on: the node's bottom edge. */
export function plusAnchor(container: HTMLElement, target: Element): { left: number; top: number } {
  const host = container.getBoundingClientRect();
  const rect = target.getBoundingClientRect();
  return {
    left: rect.left + rect.width / 2 - host.left + container.scrollLeft,
    top: rect.bottom - host.top + container.scrollTop,
  };
}

/**
 * The midpoint of an edge, in container coordinates.
 *
 * An edge's hit target is the transparent 14px-wide `<path>` visimer lays over
 * the arrow (`addEdgeHitOverlay` in @visimer/dom), so its bounding box is the
 * whole bend of the curve — its centre can easily sit off the line entirely.
 * `getPointAtLength` walks the path itself, and `getScreenCTM` maps that user
 * -space point through mermaid's viewBox and visimer's pan/zoom transform in
 * one step. Anything that cannot do SVG geometry (jsdom, a non-path target)
 * falls back to the box centre, which is the right answer for a straight edge
 * and an acceptable one for the rest.
 */
export function edgeAnchor(container: HTMLElement, target: Element): { left: number; top: number } {
  const host = container.getBoundingClientRect();
  const path = target as SVGPathElement;
  if (typeof path.getPointAtLength === 'function' && typeof path.getScreenCTM === 'function') {
    try {
      const length = path.getTotalLength();
      const ctm = path.getScreenCTM();
      if (ctm && length > 0) {
        const point = path.getPointAtLength(length / 2);
        return {
          left: ctm.a * point.x + ctm.c * point.y + ctm.e - host.left + container.scrollLeft,
          top: ctm.b * point.x + ctm.d * point.y + ctm.f - host.top + container.scrollTop,
        };
      }
    } catch {
      /* not a laid-out path — fall through to the box */
    }
  }
  const rect = target.getBoundingClientRect();
  return {
    left: rect.left + rect.width / 2 - host.left + container.scrollLeft,
    top: rect.top + rect.height / 2 - host.top + container.scrollTop,
  };
}

/** Centre of an element, in container coordinates — where a ghost edge starts. */
function centreOf(container: HTMLElement, target: Element): { left: number; top: number } {
  const host = container.getBoundingClientRect();
  const rect = target.getBoundingClientRect();
  return {
    left: rect.left + rect.width / 2 - host.left + container.scrollLeft,
    top: rect.top + rect.height / 2 - host.top + container.scrollTop,
  };
}

/* ---------------------------------------------------------------- setup -- */

export interface CanvasAffordanceOptions {
  view: Canvas;
  editor: CanvasEditor;
  /** Tooltip for the (+), given the intent it currently carries. */
  plusTitle(intent: PlusIntent): string;
  /** Tooltip for the link handle. */
  linkTitle: string;
  /** Default text the created entity carries, given the intent. */
  newText(intent: PlusIntent): string;
  /**
   * Element under a viewport point. Injectable because `elementFromPoint`
   * needs a layout engine, which the tests do not have.
   */
  elementAt?: (x: number, y: number) => Element | null;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** `CSS.escape` where it exists; a quoted-attribute escape everywhere else. */
function escapeValue(value: string): string {
  const css = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS;
  return typeof css?.escape === 'function' ? css.escape(value) : value.replace(/["\\]/g, '\\$&');
}

/**
 * Hang the affordances off whatever the pointer is over. Returns the teardown.
 *
 * Hover is tracked with mouse events, not pointer events: these are mouse
 * affordances (a touch device has no hover at all, and the canvas's own touch
 * gestures — pan, zoom, tap-to-select — must not have floating buttons
 * appearing under the finger mid-gesture). The link DRAG is a pointer gesture,
 * because that is the one that has to survive leaving the button.
 */
export function attachCanvasAffordances({
  view,
  editor,
  plusTitle,
  linkTitle,
  newText,
  elementAt,
}: CanvasAffordanceOptions): () => void {
  const container = view.container;
  const hitTest = elementAt ?? ((x: number, y: number) => document.elementFromPoint(x, y));

  const group = document.createElement('div');
  group.className = 'folio-mermaid-affordance';
  group.hidden = true;

  const button = (className: string, icon: 'plus' | 'link', title: string): HTMLButtonElement => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = className;
    el.title = title;
    el.setAttribute('aria-label', title);
    // The editor's own icon set: a "+" typed as text would inherit whatever
    // font the canvas draws labels in and sit off-centre in the circle.
    el.appendChild(createIcon(icon));
    group.appendChild(el);
    return el;
  };

  const plus = button('folio-mermaid-plus', 'plus', '');
  const link = button('folio-mermaid-link', 'link', linkTitle);
  container.appendChild(group);

  /** The ghost edge drawn while a link is being dragged. */
  const ghost = document.createElementNS(SVG_NS, 'svg');
  ghost.setAttribute('class', 'folio-mermaid-ghost');
  ghost.setAttribute('aria-hidden', 'true');
  const ghostLine = document.createElementNS(SVG_NS, 'line');
  ghost.appendChild(ghostLine);
  ghost.style.display = 'none';
  container.appendChild(ghost);

  /** The intent the visible affordance carries. */
  let anchored: PlusIntent | null = null;
  /** The node a link is being dragged from, while dragging. */
  let dragging: { sourceId: string; family: GraphFamily; from: { left: number; top: number } } | null = null;
  let marked: Element | null = null;

  const hide = (): void => {
    if (dragging) return;
    anchored = null;
    group.hidden = true;
  };

  const show = (target: Element, intent: PlusIntent): void => {
    const { left, top } = intent.kind === 'split' ? edgeAnchor(container, target) : plusAnchor(container, target);
    group.style.left = `${left}px`;
    group.style.top = `${top}px`;
    // Only a node of a connectable family can start an edge; an edge's (+) or a
    // timeline item's has nothing to drag to.
    link.hidden = intent.kind !== 'grow';
    plus.title = plusTitle(intent);
    plus.setAttribute('aria-label', plus.title);
    group.hidden = false;
    anchored = intent;
  };

  const onOver = (event: MouseEvent): void => {
    if (dragging) return;
    const target = event.target as Element | null;
    if (!target || typeof target.closest !== 'function') return;
    // Travelling from the node onto the buttons themselves must not dismiss them.
    if (group.contains(target)) return;
    const hit = target.closest('[data-mw-entity]');
    const entityId = hit?.getAttribute('data-mw-entity');
    const intent = hit && entityId ? plusIntent(editor, entityId) : null;
    if (!hit || !intent) {
      hide();
      return;
    }
    show(hit, intent);
  };

  const onPlusClick = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    const intent = anchored;
    if (!intent) return;
    // The canvas re-renders from scratch, so the coordinates written on the
    // group are stale the moment the op lands.
    hide();
    runPlus(editor, view, intent, newText(intent));
  };

  /* --------------------------------------------------------- link drag -- */

  const markTarget = (element: Element | null): void => {
    if (marked === element) return;
    marked?.removeAttribute('data-folio-link-target');
    marked = element;
    marked?.setAttribute('data-folio-link-target', 'true');
  };

  /** The connectable node under a viewport point, or null. */
  const candidateAt = (x: number, y: number): { id: string; el: Element } | null => {
    if (!dragging) return null;
    const hit = hitTest(x, y);
    const el = hit && typeof hit.closest === 'function' ? hit.closest('[data-mw-entity]') : null;
    const id = el?.getAttribute('data-mw-entity');
    if (!el || !id || id === dragging.sourceId || nodeFamily(id) !== dragging.family) return null;
    return { id, el };
  };

  const drawGhost = (x: number, y: number): void => {
    if (!dragging) return;
    const host = container.getBoundingClientRect();
    ghostLine.setAttribute('x1', String(dragging.from.left));
    ghostLine.setAttribute('y1', String(dragging.from.top));
    ghostLine.setAttribute('x2', String(x - host.left + container.scrollLeft));
    ghostLine.setAttribute('y2', String(y - host.top + container.scrollTop));
  };

  const endDrag = (): void => {
    dragging = null;
    markTarget(null);
    ghost.style.display = 'none';
    container.classList.remove('folio-mermaid--linking');
    group.classList.remove('folio-mermaid-affordance--dragging');
    document.removeEventListener('pointermove', onPointerMove, true);
    document.removeEventListener('pointerup', onPointerUp, true);
    document.removeEventListener('keydown', onKeyDown, true);
  };

  function onPointerMove(event: PointerEvent): void {
    drawGhost(event.clientX, event.clientY);
    markTarget(candidateAt(event.clientX, event.clientY)?.el ?? null);
  }

  function onPointerUp(event: PointerEvent): void {
    const source = dragging?.sourceId;
    const target = candidateAt(event.clientX, event.clientY)?.id;
    endDrag();
    hide();
    if (source && target) connectEntities(editor, source, target);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    endDrag();
    hide();
  }

  const onLinkDown = (event: PointerEvent): void => {
    const intent = anchored;
    if (!intent || intent.kind !== 'grow') return;
    const family = nodeFamily(intent.entityId);
    if (!family) return;
    event.preventDefault();
    event.stopPropagation();

    const source = container.querySelector(`[data-mw-entity="${escapeValue(intent.entityId)}"]`);
    dragging = {
      sourceId: intent.entityId,
      family,
      from: source ? centreOf(container, source) : { left: 0, top: 0 },
    };
    container.classList.add('folio-mermaid--linking');
    // The group must stop hit-testing so `elementFromPoint` sees the canvas
    // under it; pointer capture keeps delivering the move/up events regardless.
    group.classList.add('folio-mermaid-affordance--dragging');
    ghost.style.display = '';
    drawGhost(event.clientX, event.clientY);

    if (typeof event.pointerId === 'number') {
      try {
        link.setPointerCapture(event.pointerId);
      } catch {
        /* synthetic pointer (tests) — document listeners carry the drag */
      }
    }
    document.addEventListener('pointermove', onPointerMove, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('keydown', onKeyDown, true);
  };

  container.addEventListener('mouseover', onOver);
  container.addEventListener('mouseleave', hide);
  plus.addEventListener('click', onPlusClick);
  link.addEventListener('pointerdown', onLinkDown);
  // A button that starts a drag must not also start a text selection or steal
  // the canvas's focus on the way down.
  link.addEventListener('mousedown', (event) => event.preventDefault());
  // Any re-render replaces the SVG the group was measured against.
  const offRender = view.on('render', hide);

  return () => {
    endDrag();
    offRender();
    container.removeEventListener('mouseover', onOver);
    container.removeEventListener('mouseleave', hide);
    plus.removeEventListener('click', onPlusClick);
    link.removeEventListener('pointerdown', onLinkDown);
    group.remove();
    ghost.remove();
  };
}
