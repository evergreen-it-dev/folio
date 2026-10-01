/**
 * The WYSIWYG surface of the mermaid dialog (round 20): visimer's canvas, where
 * nodes and edges are edited by clicking and typing on the diagram itself and
 * the mermaid source is kept in sync as minimal text edits.
 *
 * Two things matter here beyond drawing the canvas:
 *
 *  - `@visimer/react` is reached through `lazy(() => import(...))` only, so the
 *    engine (core + dom + the React binding) stays out of the main bundle and
 *    is fetched the first time somebody actually opens a diagram.
 *  - visimer understands a large but finite part of mermaid. A diagram type it
 *    cannot model — or source it cannot parse — must not take the dialog down
 *    with it, so the canvas is wrapped in an error boundary that falls back to
 *    the read-only preview. The source pane is untouched by that, which is what
 *    keeps the author's edits when the visual side gives up.
 */
import { Component, Suspense, lazy, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import mermaid from 'mermaid';
import { tryReloadForStaleChunk } from '../app/stale-chunk';
import { NS } from './i18n';
import { attachCanvasAffordances } from './mermaid-plus';
import {
  addEntity,
  describeDiagram,
  type Canvas,
  type CanvasEditor,
  type CanvasHint,
  type DiagramSupport,
  type PlusIntent,
} from './mermaid-ops';
import { DebouncedMermaid } from './mermaid-widgets';

/** Kept in step with the app's own mermaid config (diagrams/mermaidSetup.ts):
 *  visimer calls `mermaid.initialize()` on the shared singleton, so anything
 *  different here would leak out into the page's other diagrams. */
function mermaidConfigFor(dark: boolean): Record<string, unknown> {
  return { startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'neutral' };
}

const VisimerCanvas = lazy(async () => {
  const mod = await import('@visimer/react');
  return { default: mod.MermaidWysiwyg };
});

/**
 * Same rule the stylesheet uses: an explicit `data-theme` on <html> wins, the
 * OS preference decides when the user has not chosen.
 */
export function isDarkTheme(): boolean {
  if (typeof document === 'undefined') return false;
  const chosen = document.documentElement.getAttribute('data-theme');
  if (chosen === 'dark') return true;
  if (chosen === 'light') return false;
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
}

function useDarkTheme(): boolean {
  const [dark, setDark] = useState(isDarkTheme);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => setDark(isDarkTheme());
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  return dark;
}

/* ------------------------------------------------------------- boundary -- */

interface BoundaryProps {
  children: ReactNode;
  /** Rendered instead of `children` once anything below has thrown. */
  fallback: ReactNode;
  onFail?: () => void;
}

/**
 * Deliberately one-way: once the canvas has thrown on this document, it stays
 * down for the life of the dialog. Re-mounting it per keystroke would just
 * re-throw, and the fallback pair (source + preview) is a complete editor on
 * its own.
 */
export class MermaidVisualBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  // `@visimer/react` itself is loaded via lazy(() => import(...)) — a stale
  // tab asking for that chunk after a deploy throws right here. Try the
  // shared one-shot reload (app/stale-chunk.ts) before falling back to the
  // read-only preview; if the reload already happened this session (real
  // failure, not a stale bundle), the fallback below is still a reasonable
  // landing spot, same as any other canvas failure.
  componentDidCatch(error: unknown): void {
    if (tryReloadForStaleChunk(error)) return;
    this.props.onFail?.();
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/* ----------------------------------------------------------------- pane -- */

export interface MermaidVisualPaneProps {
  code: string;
  onCodeChange: (code: string) => void;
}

const NO_SUPPORT: DiagramSupport = { type: null, add: null, connect: false, hint: 'flat' };

/**
 * One sentence per kind of hover affordance. Chosen by the diagram type rather
 * than by `connect`, which is what QA-3 caught: a sequence diagram is not
 * connectable but has no flat (+) either, and used to be promised one.
 */
const HINT_KEY: Record<CanvasHint, string> = {
  connected: 'mermaid.addHint',
  flat: 'mermaid.addHintFlat',
  lifeline: 'mermaid.addHintSequence',
};

/** The canvas, its loading state and its fallback, as one pane. */
export function MermaidVisualPane({ code, onCodeChange }: MermaidVisualPaneProps) {
  const { t } = useTranslation(NS);
  const dark = useDarkTheme();
  const canvas = useRef<{ editor: CanvasEditor; view: Canvas } | null>(null);
  const teardown = useRef<Array<() => void>>([]);
  // Round 25: every diagram type visimer can edit gets an add button — what it
  // creates and what it is called come from the type itself (mermaid-ops.ts),
  // so a timeline offers a period and a gantt a task. Only a document visimer
  // cannot model at all keeps the bare canvas.
  const [support, setSupport] = useState<DiagramSupport>(NO_SUPPORT);
  /** visimer's 'connect' tool: a drag from node to node draws the edge. */
  const [connecting, setConnecting] = useState(false);

  useEffect(
    () => () => {
      for (const off of teardown.current) off();
      teardown.current = [];
      canvas.current = null;
    },
    [],
  );

  // Read through refs inside the overlay's callbacks: the overlay is attached
  // once per canvas and must not be torn down and rebuilt on every language or
  // document change (it would drop a link drag in progress).
  const strings = useRef<{ title(intent: PlusIntent): string; text(intent: PlusIntent): string }>({
    title: () => '',
    text: () => '',
  });
  strings.current = {
    // `mermaid.thing.*` is the accusative name of the kind, so every language
    // gets a grammatical sentence without adjective agreement games.
    title: (intent) => t(`mermaid.plus.${intent.kind}`, { thing: t(`mermaid.thing.${intent.add}`) }),
    text: (intent) => t(`mermaid.new.${intent.add}`),
  };

  const onReady = useCallback(
    (editor: CanvasEditor, view: Canvas) => {
      // A remount (React's strict double-effect, a `mermaid` identity change)
      // hands us a second canvas; the first one's listeners go with it.
      for (const off of teardown.current) off();
      teardown.current = [];
      canvas.current = { editor, view };
      const sync = () => setSupport(describeDiagram(editor));
      sync();
      teardown.current.push(
        editor.on('change', sync),
        attachCanvasAffordances({
          view,
          editor,
          plusTitle: (intent) => strings.current.title(intent),
          linkTitle: t('mermaid.linkTitle'),
          newText: (intent) => strings.current.text(intent),
        }),
      );
    },
    [t],
  );

  const onAdd = () => {
    const current = canvas.current;
    if (current && support.add) addEntity(current.editor, current.view, t(`mermaid.new.${support.add}`));
  };

  return (
    <MermaidVisualBoundary fallback={<MermaidVisualFallback code={code} notice={t('mermaid.visualFailed')} />}>
      {support.add && (
        <div className="folio-modal__canvasbar">
          <button
            type="button"
            className="folio-modal__chip"
            onClick={onAdd}
            title={t('mermaid.addTitle', { thing: t(`mermaid.thing.${support.add}`) })}
          >
            {`+ ${t(`mermaid.label.${support.add}`)}`}
          </button>
          {/* The link handle on a hovered node is the primary way to draw an
              edge now; visimer's own `tool` prop stays as the fallback the
              owner asked to keep — it turns a plain drag into a connect drag
              anywhere on the canvas. */}
          {support.connect && (
            <button
              type="button"
              className="folio-modal__chip"
              aria-pressed={connecting}
              onClick={() => setConnecting((on) => !on)}
              title={t('mermaid.connectTitle')}
            >
              {t('mermaid.connect')}
            </button>
          )}
          <span className="folio-modal__canvashint">{t(HINT_KEY[support.hint])}</span>
        </div>
      )}
      <Suspense fallback={<p className="folio-modal__notice">{t('mermaid.visualLoading')}</p>}>
        <VisimerCanvas
          code={code}
          onCodeChange={onCodeChange}
          mermaid={mermaid}
          mermaidConfig={mermaidConfigFor(dark)}
          panZoom
          tool={connecting ? 'connect' : 'select'}
          onReady={onReady}
          className="folio-modal__canvas"
        />
      </Suspense>
    </MermaidVisualBoundary>
  );
}

/** The pre-round-20 right-hand pane: a plain, read-only rendering of the code. */
export function MermaidVisualFallback({ code, notice }: { code: string; notice: string }) {
  return (
    <div className="folio-modal__fallback">
      <p className="folio-modal__notice" role="status">
        {notice}
      </p>
      <div className="folio-modal__fallback-preview">
        <DebouncedMermaid code={code} delay={300} />
      </div>
    </div>
  );
}
