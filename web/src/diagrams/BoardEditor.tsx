import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { ShareLinkMode } from '@shared/contracts';
import { useConnectivity } from '../app/offline/connectivity';
import { isStaleChunkError } from '../app/stale-chunk';
import { ErrorBoundary } from '../app/ui/ErrorBoundary';
import { isKeyboardOpen, keyboardSafeHeight, useVisualViewport } from '../app/visualViewport';
import './i18n/register';

const loadBoardCanvas = () => import('./BoardCanvas');
const LazyBoardCanvas = lazy(loadBoardCanvas);

export interface BoardEditorProps {
  pageId: string;
  /**
   * Present for a guest viewing/editing via a share link (round 8) instead
   * of an authenticated session — see BoardCanvasProps for the full
   * contract. `pageId` may be `''` in this case; the share token is what
   * actually resolves the page server-side, and it's what this component
   * keys the remount on when present.
   */
  shareToken?: string;
  /** Ignored when shareToken is absent. Omitting it (or 'view') is the safe default — see BoardCanvasProps. */
  shareMode?: ShareLinkMode;
}

/**
 * Public entry point for the excalidraw board editor. The actual
 * implementation — and the @excalidraw/excalidraw dependency, which is
 * large — lives in ./BoardCanvas and is loaded lazily via React.lazy, so
 * pages that never open a board never download it.
 *
 * Keyed by shareToken || pageId so switching boards (or switching which
 * share link is open) gets a clean remount (fresh load, fresh autosave
 * baseline) instead of trying to reconcile Excalidraw's internal state
 * across two different documents.
 */
export function BoardEditor({ pageId, shareToken, shareMode }: BoardEditorProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const height = useKeyboardSafeHeight(wrapRef);
  // `lazy()` remembers a failed import forever, so trying again means a new
  // lazy component. Attempt 0 is the module-level one every board shares.
  const [attempt, setAttempt] = useState(0);
  const Canvas = useMemo(() => (attempt === 0 ? LazyBoardCanvas : lazy(loadBoardCanvas)), [attempt]);
  return (
    <div ref={wrapRef} className="h-full w-full" style={height === null ? undefined : { height }}>
      <ErrorBoundary
        resetKey={`${shareToken || pageId}:${attempt}`}
        fallback={(error) => <BoardEditorUnavailable error={error} onRetry={() => setAttempt((n) => n + 1)} />}
      >
        <Suspense fallback={<BoardEditorFallback />}>
          <Canvas key={shareToken || pageId} pageId={pageId} shareToken={shareToken} shareMode={shareMode} />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

/**
 * The board editor's code could not be loaded. Offline that is expected the
 * first time a board is opened on a device (the chunk is warmed up ahead of
 * need while there is a network — offline/OfflineRuntime.tsx — but a tab that
 * went offline seconds after opening never got to it). Nothing is lost: a
 * board created offline is in the registry and on disk, and opens the
 * moment the editor can be fetched — which this retries by itself when the
 * connection returns.
 */
function BoardEditorUnavailable({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useTranslation('diagrams');
  const connectivity = useConnectivity();
  const chunk = isStaleChunkError(error);
  /**
   * A module that failed to load stays failed for the life of the document:
   * the browser remembers the failed fetch and answers every later
   * `import()` of the same URL with the same error, network or no network
   * (seen on the stand: the retry after reconnecting failed instantly). So
   * for a chunk the only retry that can work is a reload — safe here,
   * because everything made offline is on disk (the registry and the
   * Y.Docs) and nothing else is mounted on a board's page. Offline a
   * reload would only trade this message for the browser's error page, so
   * it waits for the connection.
   */
  const retry = (): void => {
    if (!chunk) return onRetry();
    if (connectivity !== 'offline') window.location.reload();
  };
  const was = useRef(connectivity);
  useEffect(() => {
    const before = was.current;
    was.current = connectivity;
    if (before === 'offline' && connectivity !== 'offline') retry();
    // `retry` closes over this render's values, which are the ones wanted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectivity]);
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-neutral-600 dark:text-neutral-300">
      <p className="max-w-md">{t(chunk && connectivity === 'offline' ? 'board.editorUnavailableOffline' : 'board.editorFailed')}</p>
      <button
        type="button"
        disabled={chunk && connectivity === 'offline'}
        onClick={retry}
        className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-600 dark:hover:bg-neutral-800"
      >
        {t('board.retry')}
      </button>
    </div>
  );
}

/**
 * The owner, 24.09.2026, from a phone: "the bottom panel got cut off in the board".
 * Excalidraw pins its mobile tool bar to the bottom of its container, and
 * the container fills the layout viewport — which the on-screen keyboard
 * does not shrink. So while a board text is being typed the bar sits under
 * the keyboard, and after iOS has scrolled the visual viewport to show the
 * field, the bottom of the board is cut off. This measures the visible
 * area instead (DEV-PLAN Round 25b, item B) and, only while the keyboard
 * is open, gives the wrapper an explicit height that ends on the visible
 * bottom edge; Excalidraw's own ResizeObserver does the rest. On the
 * keyboard's way out the window is scrolled back to the top, so the
 * reveal-scroll never lingers.
 */
function useKeyboardSafeHeight(wrap: RefObject<HTMLDivElement | null>): number | null {
  const box = useVisualViewport();
  const [top, setTop] = useState(0);
  const open = isKeyboardOpen(box);
  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    if (!open) return;
    // The wrapper's top edge is set by the flow above it, so the height this
    // hook assigns never moves it — safe to read here without a loop.
    setTop(wrap.current ? wrap.current.getBoundingClientRect().top : 0);
  }, [open, box?.height, box?.offsetTop, wrap]);
  useEffect(() => {
    if (wasOpen.current && !open && typeof window !== 'undefined') window.scrollTo(0, 0);
    wasOpen.current = open;
  }, [open]);
  return keyboardSafeHeight(box, top);
}

function BoardEditorFallback() {
  const { t } = useTranslation('diagrams');
  return (
    <div className="flex h-full w-full items-center justify-center text-sm opacity-60">{t('board.loadingEditor')}</div>
  );
}
