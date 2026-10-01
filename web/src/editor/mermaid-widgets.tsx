/**
 * Mermaid in live mode: `MermaidWidget` replaces a fence with the diagram it
 * describes, which the reader can zoom and pan in place; a DOUBLE click (or
 * the pencil) opens the visual editor.
 *
 * Round 21 (owner's manual test of round 20) removed the middle step this file
 * used to have. Clicking a diagram used to put the caret inside the fence,
 * which revealed the markdown source with a live preview underneath it
 * (`MermaidPreviewWidget`) — one more thing to read and one more click before
 * the editor the author actually wanted. Live mode now goes straight to the
 * modal; the raw fence stays one keystroke away in source mode, and the pencil
 * on the block is the alternative entry into the same modal.
 *
 * 11.09 (owner): a SINGLE click no longer opens that modal. A diagram is
 * something you read far more often than you edit, and on a big one the first
 * thing you want is to look closer — which a click-to-edit handler made
 * impossible, since every attempt to grab the canvas threw you into the
 * editor. So the plain press now pans, Ctrl/Cmd+wheel zooms, the toolbar
 * carries explicit zoom buttons for anyone without a wheel, and editing moved
 * to the double click (plus the pencil, which was always there).
 *
 * Wheel WITHOUT a modifier is deliberately left alone: the diagram sits in the
 * middle of a document, and a widget that swallows the scroll is a widget you
 * cannot scroll past.
 */
import { useEffect, useMemo, useState } from 'react';
import { syntaxTree } from '@codemirror/language';
import { EditorView, WidgetType } from '@codemirror/view';
import { MermaidBlock } from '../diagrams';
import { debounce } from './debounce';
import { editorServicesFacet, setBlockAnchor } from './editor-services';
import { t } from './i18n';
import { iconButton } from './icons';
import { mermaidFenceAt } from './live-decorations';
import { mountReact, unmountReact } from './react-host';
import { showToast } from './toast';

/** Long enough that mermaid isn't re-parsed per keystroke, short enough to feel live. */
export const PREVIEW_DEBOUNCE_MS = 350;

/** Renders mermaid from a value that keeps changing, without re-parsing per keystroke. */
export function DebouncedMermaid({ code, delay = PREVIEW_DEBOUNCE_MS }: { code: string; delay?: number }) {
  const [shown, setShown] = useState(code);
  const push = useMemo(() => debounce((next: string) => setShown(next), delay), [delay]);

  useEffect(() => {
    push(code);
  }, [code, push]);
  useEffect(() => () => push.cancel(), [push]);

  return <MermaidBlock code={shown} />;
}

/** Resolve the fence around a widget and hand it to the modal editor. */
function openModalFor(view: EditorView, dom: HTMLElement): void {
  const fence = mermaidFenceAt(view.state.doc, syntaxTree(view.state), view.posAtDOM(dom));
  if (!fence) {
    showToast(view, t('mermaid.notFound'));
    return;
  }
  view.dispatch({ effects: setBlockAnchor.of(fence.from) });
  view.state.facet(editorServicesFacet).openMermaidEditor({ view, code: fence.code });
}

/** Zoom/pan state for one rendered diagram, applied as a transform on its stage. */
interface Viewport {
  scale: number;
  x: number;
  y: number;
}

const MIN_SCALE = 0.4;
const MAX_SCALE = 4;
const WHEEL_STEP = 0.0015;
const BUTTON_STEP = 1.25;

const clampScale = (scale: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

/**
 * Wires zoom (Ctrl/Cmd+wheel and the toolbar buttons) and pan (press and
 * drag) onto one diagram. `stage` is the element the transform lands on;
 * `host` is the fixed-size window it moves inside.
 *
 * Zooming keeps the point under the cursor still — the whole reason to zoom
 * at all is usually "this corner", and a zoom around the centre walks that
 * corner off screen.
 */
function attachZoomPan(host: HTMLElement, stage: HTMLElement): { zoomBy: (factor: number) => void; reset: () => void } {
  const viewport: Viewport = { scale: 1, x: 0, y: 0 };

  const apply = () => {
    stage.style.transform = `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`;
    host.dataset.zoomed = viewport.scale === 1 && viewport.x === 0 && viewport.y === 0 ? 'no' : 'yes';
  };

  const zoomAt = (nextScale: number, originX: number, originY: number) => {
    const scale = clampScale(nextScale);
    if (scale === viewport.scale) return;
    // Keep the document point under (originX, originY) fixed across the change.
    const ratio = scale / viewport.scale;
    viewport.x = originX - (originX - viewport.x) * ratio;
    viewport.y = originY - (originY - viewport.y) * ratio;
    viewport.scale = scale;
    apply();
  };

  host.addEventListener(
    'wheel',
    (event) => {
      // Plain wheel keeps scrolling the document — see this module's docblock.
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = host.getBoundingClientRect();
      zoomAt(viewport.scale * Math.exp(-event.deltaY * WHEEL_STEP), event.clientX - rect.left, event.clientY - rect.top);
    },
    { passive: false },
  );

  let panning: { pointerId: number; startX: number; startY: number; originX: number; originY: number } | null = null;

  host.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    // The widget is contentEditable=false, so nothing here is a text
    // selection; preventing the default only stops CodeMirror from putting a
    // caret into the replaced range (which would drop the block to source).
    event.preventDefault();
    panning = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: viewport.x, originY: viewport.y };
    // jsdom (and a stray old browser) has no pointer capture; panning still
    // works without it, you just lose the drag if the pointer leaves the box.
    if (typeof host.setPointerCapture === 'function') host.setPointerCapture(event.pointerId);
    host.dataset.panning = 'yes';
  });

  const endPan = (event: PointerEvent) => {
    if (!panning || panning.pointerId !== event.pointerId) return;
    panning = null;
    delete host.dataset.panning;
    if (typeof host.hasPointerCapture === 'function' && host.hasPointerCapture(event.pointerId)) {
      host.releasePointerCapture(event.pointerId);
    }
  };

  host.addEventListener('pointermove', (event) => {
    if (!panning || panning.pointerId !== event.pointerId) return;
    viewport.x = panning.originX + (event.clientX - panning.startX);
    viewport.y = panning.originY + (event.clientY - panning.startY);
    apply();
  });
  host.addEventListener('pointerup', endPan);
  host.addEventListener('pointercancel', endPan);

  apply();

  return {
    zoomBy: (factor) => {
      const rect = host.getBoundingClientRect();
      zoomAt(viewport.scale * factor, rect.width / 2, rect.height / 2);
    },
    reset: () => {
      viewport.scale = 1;
      viewport.x = 0;
      viewport.y = 0;
      apply();
    },
  };
}

function toolbar(view: EditorView, dom: HTMLElement, zoom: { zoomBy: (factor: number) => void; reset: () => void }): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'cm-md-blocktools';
  bar.appendChild(iconButton('zoomOut', t('mermaid.zoomOut'), () => zoom.zoomBy(1 / BUTTON_STEP)));
  bar.appendChild(iconButton('zoomIn', t('mermaid.zoomIn'), () => zoom.zoomBy(BUTTON_STEP)));
  bar.appendChild(iconButton('fit', t('mermaid.zoomReset'), () => zoom.reset()));
  bar.appendChild(iconButton('pencil', t('mermaid.edit'), () => openModalFor(view, dom)));
  return bar;
}

export class MermaidWidget extends WidgetType {
  constructor(readonly code: string) {
    super();
  }

  eq(other: MermaidWidget): boolean {
    return other.code === this.code;
  }

  get estimatedHeight(): number {
    return 180;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-md-block cm-md-mermaid';
    wrap.contentEditable = 'false';

    const host = document.createElement('div');
    host.className = 'cm-md-mermaid__host';
    host.title = t('mermaid.doubleClickToEdit');
    wrap.appendChild(host);

    // The transform lives on a stage INSIDE the host: the host stays the
    // fixed window the diagram moves within, so a zoomed-in diagram cannot
    // push the surrounding text around.
    const stage = document.createElement('div');
    stage.className = 'cm-md-mermaid__stage';
    host.appendChild(stage);
    mountReact(stage, <MermaidBlock code={this.code} />);

    wrap.appendChild(toolbar(view, wrap, attachZoomPan(host, stage)));

    host.addEventListener('dblclick', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      openModalFor(view, wrap);
    });

    return wrap;
  }

  destroy(dom: HTMLElement): void {
    const stage = dom.querySelector<HTMLElement>('.cm-md-mermaid__stage');
    if (stage) unmountReact(stage);
  }
}

