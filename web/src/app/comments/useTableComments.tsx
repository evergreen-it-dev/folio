/**
 * Comments on table cells, assembled: the thread list, the panel, the toggle
 * and the props the grid needs to draw markers (TableCommentsProps). TablePageView
 * calls useTableComments once and places what comes back; the board's
 * counterpart is diagrams/BoardComments.tsx, the doc page's is usePageCommentsUi.tsx.
 *
 * The data side is shared with documents and boards (usePageComments.ts): the same
 * REST routes, the same awareness nudge between peers. A thread hangs on a row id
 * and a column id (tableCommentsModel.ts) and is visible to everyone who sees the
 * table, whatever filters or hidden columns their view has: the panel lists it
 * regardless, and the grid brings the cell into view when the thread is opened.
 * A row or column that was deleted does not take its thread with it — the thread
 * stays in the list marked "the commented cell was deleted", still open to replies.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageSquare } from 'lucide-react';
import type { TableColumn, TableRow } from '@shared/contracts';
import type { TableCommentsProps } from '../../tables';
import { useAuthOptional } from '../auth/AuthProvider';
import type { ResolvedAnchor } from '../../editor/comment-anchors';
import { CommentsPanel, DRAFT_ID, type TargetCommentDraft } from './CommentsPanel';
import { MentionCandidatesContext, useMentionCandidatesValue } from './mentionCandidates';
import { ThreadLink } from './ThreadLink';
import { cellPreview, deletedCellThreads, threadCell, threadsByCell } from './tableCommentsModel';
import { useCommentActions, useCommentsRealtime, usePageCommentsQuery, type AwarenessSession } from './usePageComments';
import '../i18n/register';

const FLASH_MS = 1600;

export interface TableCommentsOptions {
  pageId: string;
  /** The table's room; comments need it for the peers' refresh nudge. */
  session: AwarenessSession | null;
  /** Commenting is on for this surface: a table page of the app, not a share link. */
  enabled: boolean;
  /** The table's space slug, for the @mention suggestions. */
  space: string | undefined;
  /** The table as it is now (the live mirror): tells a deleted row or column from a live one. Null until it is in. */
  doc: { rows: TableRow[]; columns: TableColumn[] } | null;
}

export interface TableCommentsUi {
  /** Props for the grid; undefined when the table has no comments surface. */
  comments: TableCommentsProps | undefined;
  /** The toggle for the table toolbar; null when there is nothing to show. */
  button: ReactNode;
  /** The panel; null when closed. */
  panel: ReactNode;
  /** The ?thread= handler; render it once. */
  link: ReactNode;
}

export function useTableComments({ pageId, session, enabled, space, doc }: TableCommentsOptions): TableCommentsUi {
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
  const [reveal, setReveal] = useState<{ rowId: string; columnId: string } | null>(null);

  useEffect(() => {
    setDraft(null);
    setHoverId(null);
    setFlashId(null);
    setFocus(null);
    setReveal(null);
  }, [pageId]);

  const threads = useMemo(() => (data?.threads ?? []).filter((thread) => thread.target?.kind === 'table_cell'), [data]);
  const openThreads = useMemo(() => threads.filter((thread) => thread.status === 'open'), [threads]);
  const resolvedThreads = useMemo(() => threads.filter((thread) => thread.status === 'resolved'), [threads]);

  // Which threads' rows or columns are gone. Judged only once the table is in: before that "gone" cannot be told from "not loaded yet".
  const missingIds = useMemo(() => {
    if (!doc) return new Set<string>();
    return deletedCellThreads(threads, new Set(doc.rows.map((r) => r.id)), new Set(doc.columns.map((c) => c.id)));
  }, [threads, doc]);

  // The panel's "anchors": a cell thread is either on its cell or detached (its row or column was deleted).
  const anchors = useMemo(() => {
    const out = new Map<string, ResolvedAnchor>();
    for (const thread of threads) out.set(thread.id, { id: thread.id, state: missingIds.has(thread.id) ? 'detached' : 'anchor', from: 0, to: 0 });
    return out;
  }, [threads, missingIds]);

  const cells = useMemo(() => threadsByCell(openThreads.filter((thread) => !missingIds.has(thread.id))), [openThreads, missingIds]);

  const canComment = data?.canComment === true;

  const openThread = useCallback(
    (id: string) => {
      const thread = threads.find((th) => th.id === id);
      const cell = thread && threadCell(thread);
      setOpen(true);
      setFocus({ id });
      setFlashId(id);
      // A fresh object each time, so asking for the same cell twice scrolls twice. A deleted cell has nowhere to go.
      if (cell && thread && !missingIds.has(thread.id)) setReveal({ ...cell });
    },
    [threads, missingIds],
  );

  // A notification links here as ?thread=<id>: once the list and the table are in, open the panel on that thread and show its cell.
  const showLinkedThread = useCallback((id: string) => openThread(id), [openThread]);

  useEffect(() => {
    if (!flashId) return;
    const timer = setTimeout(() => setFlashId(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flashId]);

  const startDraft = useCallback(
    (rowId: string, columnId: string) => {
      if (!doc) return;
      setDraft({ target: { kind: 'table_cell', rowId, columnId }, preview: cellPreview(doc.rows, doc.columns, { rowId, columnId }) });
      setFocus(null);
      setOpen(true);
    },
    [doc],
  );

  const activeThreadId = hoverId ?? flashId ?? focus?.id ?? null;
  const activeThread = activeThreadId ? threads.find((thread) => thread.id === activeThreadId) : undefined;
  const highlight = useMemo(() => {
    if (draft?.target.kind === 'table_cell') return { rowId: draft.target.rowId, columnId: draft.target.columnId };
    return activeThread && !missingIds.has(activeThread.id) ? (threadCell(activeThread) ?? null) : null;
  }, [draft, activeThread, missingIds]);

  const visible = active && data !== undefined && (canComment || threads.length > 0);
  const count = openThreads.length;
  const label = count > 0 ? t('comments.toggleCount', { count }) : t('comments.title');

  const gridProps = useMemo<TableCommentsProps | undefined>(
    () =>
      visible
        ? {
            canComment,
            cells,
            highlight,
            reveal,
            addLabel: t('comments.table.commentOn'),
            markerLabel: (n: number) => t('comments.table.markerLabel', { count: n }),
            onStart: startDraft,
            onOpenThread: openThread,
          }
        : undefined,
    [visible, canComment, cells, highlight, reveal, t, startDraft, openThread],
  );

  const button = visible ? (
    <button
      type="button"
      aria-pressed={open}
      aria-label={label}
      title={label}
      data-table-comments-toggle
      onClick={() => setOpen((v) => !v)}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-500 aria-pressed:border-blue-400 aria-pressed:text-blue-700 dark:border-neutral-600 dark:text-neutral-300 dark:hover:text-neutral-100 dark:aria-pressed:border-blue-500 dark:aria-pressed:text-blue-300"
    >
      <MessageSquare size={12} aria-hidden="true" />
      {count > 0 && <span className="tabular-nums">{count > 99 ? '99+' : count}</span>}
    </button>
  ) : null;

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
          emptyHint={t('comments.table.emptyHint')}
          onHover={setHoverId}
          onSelect={openThread}
          onDraftDone={() => setDraft(null)}
          onClose={() => setOpen(false)}
        />
      </MentionCandidatesContext.Provider>
    ) : null;

  const link = active ? <ThreadLink enabled={data !== undefined && doc !== null} onThread={showLinkedThread} /> : null;

  return { comments: gridProps, button, panel, link };
}
