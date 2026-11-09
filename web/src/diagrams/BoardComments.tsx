/**
 * Comments on board elements, assembled: the thread list, the panel, the
 * marker layer over the canvas, and the three ways to start a thread (the
 * button next to the selected element, "Comment on an element" in the panel
 * which picks by click — it works in View mode too — and a marker's own
 * click to read one). BoardCanvas calls useBoardComments once and places what
 * comes back; the doc page's counterpart is app/comments/usePageCommentsUi.tsx.
 *
 * The data side is shared with documents (usePageComments.ts): the same REST
 * routes, the same awareness nudge between peers. What differs is the anchor:
 * a thread hangs on an element id (boardCommentsModel.ts), and an element that
 * left the scene does not take its thread with it — the thread stays in the
 * list marked "the commented element was deleted", with the label saved when
 * it began.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageSquare, MessageSquarePlus } from 'lucide-react';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { useAuthOptional } from '../app/auth/AuthProvider';
import { CommentsPanel, DRAFT_ID, type TargetCommentDraft } from '../app/comments/CommentsPanel';
import { ThreadLink } from '../app/comments/ThreadLink';
import { MentionCandidatesContext, useMentionCandidatesValue } from '../app/comments/mentionCandidates';
import { useCommentActions, useCommentsRealtime, usePageCommentsQuery, type AwarenessSession } from '../app/comments/usePageComments';
import type { ResolvedAnchor } from '../editor/comment-anchors';
import { commentButtonTarget, containerToScenePoint, deletedTargetThreads, elementAtPoint, elementPreview, threadElementId, threadsByElement } from './boardCommentsModel';
import { elementSceneBounds, sceneToContainerPoint } from './reactionsModel';
import '../app/i18n/register';

const FLASH_MS = 1600;
/** The comment button sits this far outside the top-right corner of the selected element (clear of the resize handle and of the reaction button at the bottom-right). */
const BUTTON_OFFSET_PX = 26;
const SELECTION_COLOR = '#6965db';
const HIGHLIGHT_COLOR = '#f59e0b';

export interface BoardCommentsOptions {
  api: ExcalidrawImperativeAPI | null;
  containerRef: RefObject<HTMLElement | null>;
  pageId: string;
  /** The board's room; comments need it for the peers' refresh nudge. Null until it opens. */
  session: AwarenessSession | null;
  /** Commenting is on for this surface: a board page of the app, not a share link. */
  enabled: boolean;
  /** The board's space slug, for the @mention suggestions; undefined until it is known. */
  space: string | undefined;
  /** The scene is loaded and synced: only then can "the element is gone" be told from "not drawn yet". */
  ready: boolean;
}

export interface BoardCommentsUi {
  /** The chrome-row button; null when there is nothing to show. */
  button: ReactNode;
  /** The marker layer, to sit over the canvas. */
  layer: ReactNode;
  /** The panel; null when closed. */
  panel: ReactNode;
}

export function useBoardComments({ api, containerRef, pageId, session, enabled, space, ready }: BoardCommentsOptions): BoardCommentsUi {
  const { t } = useTranslation('app');
  const me = useAuthOptional()?.user;
  const active = enabled && Boolean(me) && Boolean(pageId) && session !== null;

  const query = usePageCommentsQuery(pageId, active);
  const data = query.data;
  useCommentsRealtime(session, pageId, active);
  const actions = useCommentActions(pageId, session);
  const mentionCandidates = useMentionCandidatesValue(space, active);

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<TargetCommentDraft | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ id: string } | null>(null);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    setDraft(null);
    setHoverId(null);
    setFlashId(null);
    setFocus(null);
    setPicking(false);
  }, [pageId]);

  const threads = useMemo(() => (data?.threads ?? []).filter((thread) => thread.target?.kind === 'board_element'), [data]);
  const openThreads = useMemo(() => threads.filter((thread) => thread.status === 'open'), [threads]);
  const resolvedThreads = useMemo(() => threads.filter((thread) => thread.status === 'resolved'), [threads]);
  const byElement = useMemo(() => threadsByElement(openThreads), [openThreads]);

  // Which threads' elements are no longer on the board. Recomputed on every scene change, but the state only moves when the answer does.
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const [missing, setMissing] = useState('');
  useEffect(() => {
    if (!api || typeof api.onChange !== 'function' || !active || !ready) return;
    const compute = () => {
      const live = new Set(api.getSceneElements().map((el) => el.id));
      setMissing([...deletedTargetThreads(threadsRef.current, live)].sort().join(','));
    };
    compute();
    return api.onChange(compute);
  }, [api, active, ready, threads]);
  const missingIds = useMemo(() => new Set(missing ? missing.split(',') : []), [missing]);

  // The panel's "anchors": a board thread is either on its element or detached (its element was deleted).
  const anchors = useMemo(() => {
    const out = new Map<string, ResolvedAnchor>();
    for (const thread of threads)
      out.set(thread.id, {
        id: thread.id,
        state: missingIds.has(thread.id) ? 'detached' : 'anchor',
        from: 0,
        to: 0,
      });
    return out;
  }, [threads, missingIds]);

  const elementOf = useCallback((elementId: string): ExcalidrawElement | undefined => api?.getSceneElements().find((el) => el.id === elementId), [api]);

  /** Brings the element into view when it is off screen (a click in the panel, a notification). */
  const reveal = useCallback(
    (elementId: string) => {
      const el = elementOf(elementId);
      const container = containerRef.current;
      if (!api || !el || !container) return;
      const appState = api.getAppState();
      const b = elementSceneBounds(el);
      const rect = container.getBoundingClientRect();
      const centre = sceneToContainerPoint({ x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 }, appState, rect);
      if (centre.x < 0 || centre.y < 0 || centre.x > appState.width || centre.y > appState.height) api.scrollToContent(el, { animate: true });
    },
    [api, elementOf, containerRef],
  );

  // A notification links here as ?thread=<id> (see ThreadLink): once the list and the scene are in, open the panel on that thread and show its element.
  const showLinkedThread = useCallback(
    (threadId: string) => {
      const found = threadsRef.current.find((thread) => thread.id === threadId);
      if (!found || !api) return;
      setOpen(true);
      setFocus({ id: threadId });
      setFlashId(threadId);
      const id = threadElementId(found);
      const el = id ? elementOf(id) : undefined;
      if (el) api.scrollToContent(el, { animate: true });
    },
    [api, elementOf],
  );

  useEffect(() => {
    if (!flashId) return;
    const timer = setTimeout(() => setFlashId(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flashId]);

  const canComment = data?.canComment === true;

  const startDraft = useCallback(
    (element: ExcalidrawElement) => {
      if (!api) return;
      setDraft({
        target: { kind: 'board_element', elementId: element.id },
        preview: elementPreview(element, api.getSceneElements()),
      });
      setFocus(null);
      setPicking(false);
      setOpen(true);
    },
    [api],
  );
  const openThread = useCallback(
    (id: string) => {
      setOpen(true);
      setFocus({ id });
      setFlashId(id);
      const thread = threadsRef.current.find((th) => th.id === id);
      const elementId = thread && threadElementId(thread);
      if (elementId) reveal(elementId);
    },
    [reveal],
  );

  const activeThreadId = hoverId ?? flashId ?? focus?.id ?? null;
  const activeThread = activeThreadId ? threads.find((thread) => thread.id === activeThreadId) : undefined;
  const highlightId = draft
    ? draft.target.kind === 'board_element' && draft.target.elementId
    : activeThread && !missingIds.has(activeThread.id)
      ? threadElementId(activeThread)
      : undefined;

  const visible = active && data !== undefined && (canComment || threads.length > 0);
  const count = openThreads.length;
  const label = count > 0 ? t('comments.toggleCount', { count }) : t('comments.title');

  const button = visible ? (
    <button
      type="button"
      aria-pressed={open}
      aria-label={label}
      title={label}
      data-board-comments-toggle
      onClick={() => setOpen((v) => !v)}
      className="inline-flex items-center gap-1 rounded-full border border-neutral-300 bg-white/90 p-1.5 text-neutral-600 shadow-sm backdrop-blur transition-colors hover:text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-500 aria-pressed:border-blue-400 aria-pressed:text-blue-700 dark:border-neutral-700 dark:bg-neutral-900/80 dark:text-neutral-300 dark:hover:text-neutral-100 dark:aria-pressed:border-blue-500 dark:aria-pressed:text-blue-300"
    >
      <MessageSquare size={12} aria-hidden="true" />
      {count > 0 && <span className="text-[10px] leading-none tabular-nums">{count > 99 ? '99+' : count}</span>}
    </button>
  ) : null;

  const layer = (
    <>
      {active && <ThreadLink enabled={data !== undefined && ready && api !== null} onThread={showLinkedThread} />}
      {visible && (
        <BoardCommentsLayer
          api={api}
          containerRef={containerRef}
          byElement={byElement}
          missingIds={missingIds}
          highlightId={highlightId || undefined}
          canComment={canComment}
          picking={picking}
          onPicked={(element) => (element ? startDraft(element) : setPicking(false))}
          onStart={startDraft}
          onOpenThread={openThread}
          ready={ready}
        />
      )}
    </>
  );

  const panel =
    visible && open ? (
      <MentionCandidatesContext.Provider value={mentionCandidates}>
        <CommentsPanel
          floating
          openThreads={openThreads}
          resolvedThreads={resolvedThreads}
          anchors={anchors}
          draft={draft}
          meId={me?.id ?? ''}
          canComment={canComment}
          canModerate={data?.canModerate === true}
          activeId={draft ? DRAFT_ID : activeThreadId}
          focus={focus}
          actions={actions}
          emptyHint={t('comments.board.emptyHint')}
          picking={picking}
          onPick={() => setPicking((v) => !v)}
          onHover={setHoverId}
          onSelect={openThread}
          onDraftDone={() => setDraft(null)}
          onClose={() => {
            setOpen(false);
            setPicking(false);
          }}
        />
      </MentionCandidatesContext.Provider>
    ) : null;

  return { button, layer, panel };
}

interface LayerProps {
  api: ExcalidrawImperativeAPI | null;
  containerRef: RefObject<HTMLElement | null>;
  /** Open threads by element id. */
  byElement: ReadonlyMap<string, readonly { id: string }[]>;
  missingIds: ReadonlySet<string>;
  highlightId: string | undefined;
  canComment: boolean;
  picking: boolean;
  /** An element was clicked while picking; null: picking was cancelled (Escape). */
  onPicked(element: ExcalidrawElement | null): void;
  onStart(element: ExcalidrawElement): void;
  onOpenThread(id: string): void;
  ready: boolean;
}

/**
 * The HTML layer over the canvas: a marker (speech bubble with the number of
 * open threads) at the top-right corner of every commented element, the
 * highlight of the element being talked about, the add button next to the
 * selected element, and — while picking — a click catcher. Positions are
 * recomputed from Excalidraw's appState on every change, like BoardReactions.
 */
function BoardCommentsLayer({ api, containerRef, byElement, missingIds, highlightId, canComment, picking, onPicked, onStart, onOpenThread, ready }: LayerProps) {
  const { t } = useTranslation('app');
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (!api || typeof api.onChange !== 'function') return;
    const schedule = () => {
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        rerender();
      });
    };
    const unsubscribe = api.onChange(schedule);
    schedule();
    return () => {
      unsubscribe();
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [api]);

  useEffect(() => {
    if (!picking) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onPicked(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [picking, onPicked]);

  const container = containerRef.current;
  if (!api || typeof api.getAppState !== 'function' || !container || !ready) return null;
  const appState = api.getAppState();
  const origin = container.getBoundingClientRect();
  const zoom = appState.zoom.value || 1;
  const elements = api.getSceneElements();
  const byId = new Map(elements.map((el) => [el.id, el] as const));
  const inView = (x: number, y: number) => x > -100 && y > -60 && x < appState.width + 100 && y < appState.height + 60 && zoom > 0;
  const corner = (el: ExcalidrawElement) => {
    const b = elementSceneBounds(el);
    return {
      topRight: sceneToContainerPoint({ x: b.right, y: b.top }, appState, origin),
      topLeft: sceneToContainerPoint({ x: b.left, y: b.top }, appState, origin),
      bottomRight: sceneToContainerPoint({ x: b.right, y: b.bottom }, appState, origin),
    };
  };

  const markers = [...byElement.entries()].filter(([elementId, list]) => byId.has(elementId) && list.some((th) => !missingIds.has(th.id)));
  const button = canComment ? commentButtonTarget(elements, appState) : null;
  const highlighted = highlightId ? byId.get(highlightId) : undefined;

  return (
    <div className="pointer-events-none absolute inset-0 z-[3] overflow-hidden" data-board-comments-layer>
      {highlighted &&
        (() => {
          const { topLeft, bottomRight } = corner(highlighted);
          return (
            <div
              data-board-comments-highlight
              className="absolute rounded-sm"
              style={{
                left: topLeft.x - 4,
                top: topLeft.y - 4,
                width: bottomRight.x - topLeft.x + 8,
                height: bottomRight.y - topLeft.y + 8,
                border: `2px solid ${HIGHLIGHT_COLOR}`,
                boxShadow: `0 0 0 3px ${HIGHLIGHT_COLOR}33`,
              }}
            />
          );
        })()}

      {markers.map(([elementId, list]) => {
        const el = byId.get(elementId)!;
        const { topRight } = corner(el);
        if (!inView(topRight.x, topRight.y)) return null;
        const live = list.filter((th) => !missingIds.has(th.id));
        const markerLabel = t('comments.board.markerLabel', {
          count: live.length,
        });
        return (
          <button
            key={elementId}
            type="button"
            data-board-comment-marker={elementId}
            aria-label={markerLabel}
            title={markerLabel}
            onClick={() => onOpenThread(live[0].id)}
            className="pointer-events-auto absolute flex h-[22px] min-w-[22px] items-center justify-center gap-0.5 rounded-full rounded-bl-none border border-amber-500 bg-amber-400 px-1 text-[11px] font-medium leading-none text-neutral-900 shadow-sm hover:brightness-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500"
            style={{ left: topRight.x - 2, top: topRight.y - 24 }}
          >
            <MessageSquare size={11} aria-hidden="true" />
            <span className="tabular-nums">{live.length}</span>
          </button>
        );
      })}

      {button &&
        (() => {
          const { topRight } = corner(button);
          if (!inView(topRight.x, topRight.y)) return null;
          return (
            <button
              type="button"
              data-board-comment-add
              aria-label={t('comments.board.commentOn')}
              title={t('comments.board.commentOn')}
              onClick={() => onStart(button)}
              className="pointer-events-auto absolute flex h-[22px] w-[22px] items-center justify-center rounded-full border bg-white text-neutral-600 shadow-sm hover:text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-100"
              style={{
                left: topRight.x + BUTTON_OFFSET_PX - 11,
                top: topRight.y - BUTTON_OFFSET_PX - 11,
                borderColor: SELECTION_COLOR,
              }}
            >
              <MessageSquarePlus size={14} aria-hidden="true" />
            </button>
          );
        })()}

      {picking && (
        <div
          data-board-comments-pick
          role="presentation"
          className="pointer-events-auto absolute inset-0 cursor-crosshair"
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            const rect = container.getBoundingClientRect();
            const point = containerToScenePoint({ x: event.clientX - rect.left, y: event.clientY - rect.top }, appState, rect);
            const hit = elementAtPoint(elements, point);
            if (hit) onPicked(hit);
          }}
        >
          <p className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full border border-amber-400 bg-white/95 px-3 py-1 text-xs text-neutral-700 shadow-sm dark:bg-neutral-900/95 dark:text-neutral-200">
            {t('comments.board.pickHint')}
          </p>
        </div>
      )}
    </div>
  );
}
