/**
 * The inline comments of a doc page, assembled: data, anchors, the panel, the
 * chrome-row button, and the two ways in (CodeMirror's bridge, Reading mode's
 * selection). editor/index.tsx's PageEditor calls this once and places what
 * comes back — the button in its chrome row, the panel beside the text, and
 * the `editor` props for CodeMirrorHost.
 *
 * Nothing here is shown unless commenting is on for this surface (`enabled`:
 * a doc page of the app, not a share link or a compare column), the user is
 * signed in, the page exists on the server, and the server answered the list
 * (it says who may comment). A page with no threads that its viewer cannot
 * comment on has no button at all.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageSquare } from 'lucide-react';
import { normalizeEol } from '../../editor/collab-sync';
import { createAnchors, quoteOf, type AnchoredThread } from '../../editor/comment-anchors';
import type { EditorComments } from '../../editor/comment-host';
import type { CommentMark, CommentsBridge } from '../../editor/comment-highlights';
import type { CollabSession } from '../../editor/collab';
import { useAuthOptional } from '../auth/AuthProvider';
import { useIsLocalPage } from '../offline';
import { CommentsPanel, DRAFT_ID, type CommentDraft } from './CommentsPanel';
import { ReadingCommentButton, useReadingComments } from './ReadingComments';
import { useCommentActions, useCommentsRealtime, usePageCommentsQuery } from './usePageComments';
import { useResolvedAnchors } from './useResolvedAnchors';
import '../i18n/register';

export interface PageCommentsOptions {
  enabled: boolean;
  pageId: string;
  session: CollabSession | null;
  /** The first sync with the server has completed. */
  synced: boolean;
  /** Reading mode (no CodeMirror view). */
  reading: boolean;
  /** The markdown Reading mode shows ('' in the other modes). */
  markdown: string;
  /** The editor's root element — Reading mode looks for the rendered page inside it. */
  rootRef: RefObject<HTMLElement | null>;
}

export interface PageCommentsUi {
  /** The chrome-row button; null when there is nothing to show. */
  button: ReactNode;
  /** The side panel (and Reading mode's floating button); null when closed. */
  panel: ReactNode;
  /** For CodeMirrorHost; undefined when comments are off. */
  editor: EditorComments | undefined;
}

const FLASH_MS = 1400;
const NOTICE_MS = 5000;

export function usePageComments({ enabled, pageId, session, synced, reading, markdown, rootRef }: PageCommentsOptions): PageCommentsUi {
  const { t } = useTranslation('app');
  const me = useAuthOptional()?.user;
  const isLocal = useIsLocalPage(pageId);
  const active = enabled && Boolean(me) && !isLocal && session !== null;

  const query = usePageCommentsQuery(pageId, active);
  const data = query.data;
  useCommentsRealtime(session, pageId, active);
  const actions = useCommentActions(pageId, session);

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<CommentDraft | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ id: string } | null>(null);
  const [reveal, setReveal] = useState<{ id: string } | null>(null);

  // Another page: nothing of the last one carries over (the panel itself stays as it was).
  useEffect(() => {
    setDraft(null);
    setHoverId(null);
    setFlashId(null);
    setFocus(null);
    setReveal(null);
  }, [pageId]);

  const threads = useMemo(() => data?.threads ?? [], [data]);
  const openThreads = useMemo(() => threads.filter((thread) => thread.status === 'open'), [threads]);
  const resolvedThreads = useMemo(() => threads.filter((thread) => thread.status === 'resolved'), [threads]);

  const toResolve = useMemo<AnchoredThread[]>(() => (draft ? [...openThreads, { id: DRAFT_ID, ...draft }] : openThreads), [openThreads, draft]);
  const anchors = useResolvedAnchors(session, toResolve, active && synced);
  const marks = useMemo<CommentMark[]>(() => {
    const out: CommentMark[] = [];
    for (const anchor of anchors.values()) if (anchor.state !== 'detached') out.push({ id: anchor.id, from: anchor.from, to: anchor.to });
    return out;
  }, [anchors]);

  const activeId = hoverId ?? flashId ?? focus?.id ?? (draft ? DRAFT_ID : null);
  const canComment = data?.canComment === true;

  // Handlers go through refs so the bridge keeps its identity (the view is reconfigured when it changes).
  const startDraft = useCallback(
    ({ from, to }: { from: number; to: number }) => {
      if (!session) return;
      const quotedText = quoteOf(normalizeEol(session.ytext.toString()), from, to);
      if (!quotedText.trim()) return;
      setDraft({ ...createAnchors(session.ytext, from, to), quotedText });
      setFocus(null);
      setOpen(true);
    },
    [session],
  );
  const openThread = useCallback((id: string) => {
    setOpen(true);
    setFocus({ id });
  }, []);
  // Not a toast: the page editor also renders where there is no ToastProvider.
  const [notice, setNotice] = useState(false);
  const unanchorable = useCallback(() => setNotice(true), []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(false), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  const startRef = useRef(startDraft);
  const openRef = useRef(openThread);
  startRef.current = startDraft;
  openRef.current = openThread;
  const bridge = useMemo<CommentsBridge | null>(
    () => (active && data ? { canComment, onStart: (range) => startRef.current(range), onOpenThread: (id) => openRef.current(id) } : null),
    [active, data, canComment],
  );

  const select = useCallback((id: string) => {
    setFocus({ id });
    setReveal({ id });
    setFlashId(id);
  }, []);
  useEffect(() => {
    if (!flashId) return;
    const timer = setTimeout(() => setFlashId(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flashId]);

  useReadingComments({
    enabled: active && reading,
    canComment,
    rootRef,
    markdown,
    marks,
    activeId,
    reveal,
    onOpenThread: openThread,
    onStart: startDraft,
    onUnanchorable: unanchorable,
  });

  const visible = active && data !== undefined && (canComment || threads.length > 0);
  const count = openThreads.length;
  const label = count > 0 ? t('comments.toggleCount', { count }) : t('comments.title');

  const button = visible ? (
    <button
      type="button"
      className="folio-editor__panel-toggle folio-editor__comments"
      aria-pressed={open}
      aria-label={label}
      title={label}
      onClick={() => setOpen((v) => !v)}
    >
      <MessageSquare size={15} aria-hidden="true" />
      {count > 0 && <span className="folio-editor__comments-count">{count > 99 ? '99+' : count}</span>}
    </button>
  ) : null;

  const panel = visible ? (
    <>
      {open && (
        <CommentsPanel
          openThreads={openThreads}
          resolvedThreads={resolvedThreads}
          anchors={anchors}
          draft={draft}
          meId={me?.id ?? ''}
          canComment={canComment}
          canModerate={data?.canModerate === true}
          activeId={activeId}
          focus={focus}
          actions={actions}
          onHover={setHoverId}
          onSelect={select}
          onDraftDone={() => setDraft(null)}
          onClose={() => setOpen(false)}
        />
      )}
      {notice && (
        <p role="status" className="fixed bottom-6 left-1/2 z-50 max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-lg bg-neutral-900 px-4 py-2 text-sm text-white shadow-lg dark:bg-neutral-100 dark:text-neutral-900">
          {t('comments.cannotAnchor')}
        </p>
      )}
      {reading && canComment && <ReadingCommentButton rootRef={rootRef} markdown={markdown} onStart={startDraft} onUnanchorable={unanchorable} />}
    </>
  ) : null;

  const editor = useMemo<EditorComments | undefined>(
    () => (active ? { bridge: visible ? bridge : null, marks, activeId, reveal } : undefined),
    [active, visible, bridge, marks, activeId, reveal],
  );

  return { button, panel, editor };
}
