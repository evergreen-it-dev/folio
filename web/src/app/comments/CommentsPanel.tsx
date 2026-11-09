import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type { CommentTarget, CommentThread, CreateCommentThreadBody, PageComment } from '@shared/comments';
import { sortByPosition, type ResolvedAnchor } from '../../editor/comment-anchors';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { CommentComposer } from './CommentComposer';
import { ThreadCard } from './ThreadCard';
import type { CommentActions } from './usePageComments';
import '../i18n/register';

/** A thread on a span of text being written: anchored, not yet sent. */
export interface TextCommentDraft {
  anchorFrom: string;
  anchorTo: string;
  quotedText: string;
}

/** A thread on a board element being written; `preview` is what the draft card quotes (the element's label). */
export interface TargetCommentDraft {
  target: CommentTarget;
  preview: string;
}

export type CommentDraft = TextCommentDraft | TargetCommentDraft;

/** The body of POST /api/pages/:id/comments for a draft. */
export function draftToThread(draft: CommentDraft, body: string): CreateCommentThreadBody {
  return 'target' in draft ? { target: draft.target, body } : { ...draft, body };
}

export const DRAFT_ID = '__draft__';

export interface CommentsPanelProps {
  openThreads: readonly CommentThread[];
  resolvedThreads: readonly CommentThread[];
  anchors: ReadonlyMap<string, ResolvedAnchor>;
  draft: CommentDraft | null;
  meId: string;
  canComment: boolean;
  canModerate: boolean;
  /** The thread whose range is emphasised in the text (hovered, or the one just revealed). */
  activeId: string | null;
  /** A thread to bring into view in the list; a new object per request. */
  focus: { id: string } | null;
  actions: CommentActions;
  onHover(id: string | null): void;
  onSelect(id: string): void;
  onDraftDone(): void;
  onClose(): void;
  /** Board: lays the panel over the page at every width instead of docking it beside the text on a wide screen. */
  floating?: boolean;
  /** Board: the hint shown when there is nothing to list (the default talks about selecting text). */
  emptyHint?: string;
  /** Board: starts picking an element to comment on; absent for a document. */
  onPick?: () => void;
  picking?: boolean;
}

/**
 * The comments column: docked beside the text on a wide screen, a floating card
 * on a tablet, a bottom sheet on a phone — one element, three skins (classes).
 */
export function CommentsPanel(props: CommentsPanelProps) {
  const { openThreads, resolvedThreads, anchors, draft, meId, canComment, canModerate, activeId, focus, actions, onHover, onSelect, onDraftDone, onClose, floating, emptyHint, onPick, picking } = props;
  const { t } = useTranslation('app');
  const [showResolved, setShowResolved] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ comment: PageComment; isThread: boolean } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // Document order; the draft takes its place among the threads it sits between.
  const ordered = useMemo(() => {
    const items: { id: string; thread?: CommentThread }[] = openThreads.map((thread) => ({ id: thread.id, thread }));
    if (draft) items.push({ id: DRAFT_ID });
    return sortByPosition(items, anchors);
  }, [openThreads, draft, anchors]);

  useEffect(() => {
    if (!focus) return;
    listRef.current?.querySelector(`[data-thread-id="${CSS.escape(focus.id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focus]);

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await actions.remove(pendingDelete.comment.id);
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
  };

  const card = (thread: CommentThread) => (
    <ThreadCard
      key={thread.id}
      thread={thread}
      anchor={anchors.get(thread.id)}
      meId={meId}
      canComment={canComment}
      canModerate={canModerate}
      active={activeId === thread.id}
      actions={actions}
      onHover={onHover}
      onSelect={onSelect}
      onDelete={(comment, isThread) => (isThread ? setPendingDelete({ comment, isThread }) : void actions.remove(comment.id))}
    />
  );

  return (
    <aside
      aria-label={t('comments.title')}
      data-comments-panel=""
      className={`ph-mask fixed inset-x-0 bottom-0 z-40 flex max-h-[65vh] flex-col rounded-t-xl border-t border-neutral-200 bg-neutral-50 shadow-2xl dark:border-neutral-800 dark:bg-neutral-950 md:inset-x-auto md:bottom-4 md:right-4 md:top-20 md:max-h-none md:w-80 md:rounded-xl md:border ${floating ? '' : 'min-[1280px]:static min-[1280px]:z-auto min-[1280px]:w-80 min-[1280px]:shrink-0 min-[1280px]:rounded-none min-[1280px]:border-0 min-[1280px]:border-l min-[1280px]:shadow-none'}`}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
        <h2 className="flex-1 text-sm font-medium text-neutral-700 dark:text-neutral-300">{t('comments.title')}</h2>
        {resolvedThreads.length > 0 && (
          <button
            type="button"
            aria-pressed={showResolved}
            onClick={() => setShowResolved((v) => !v)}
            className="rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 aria-pressed:bg-neutral-100 aria-pressed:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:aria-pressed:bg-neutral-800 dark:aria-pressed:text-neutral-200"
          >
            {showResolved ? t('comments.hideResolved') : t('comments.showResolved', { count: resolvedThreads.length })}
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label={t('ui.close')}
          title={t('ui.close')}
          className="rounded-md p-1 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          <X size={16} />
        </button>
      </div>

      {onPick && canComment && (
        <div className="shrink-0 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
          <button
            type="button"
            aria-pressed={picking}
            onClick={onPick}
            className="w-full rounded-md border border-neutral-300 px-2 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100 aria-pressed:border-amber-400 aria-pressed:bg-amber-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800 dark:aria-pressed:border-amber-500 dark:aria-pressed:bg-amber-950"
          >
            {picking ? t('comments.board.pickingCancel') : t('comments.board.pick')}
          </button>
        </div>
      )}

      <div ref={listRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {ordered.length === 0 && !showResolved && (
          <p className="px-1 py-4 text-center text-sm text-neutral-400 dark:text-neutral-500">{canComment ? (emptyHint ?? t('comments.emptyHint')) : t('comments.empty')}</p>
        )}
        {ordered.map((item) =>
          item.thread ? (
            card(item.thread)
          ) : draft ? (
            <article key={DRAFT_ID} data-thread-id={DRAFT_ID} className="rounded-lg border border-amber-400 bg-white p-3 shadow-sm ring-1 ring-amber-300 dark:border-amber-500 dark:bg-neutral-900 dark:ring-amber-600">
              <blockquote className="mb-2 line-clamp-2 break-words border-l-2 border-amber-400 pl-2 text-xs text-neutral-500 dark:border-amber-500 dark:text-neutral-400">{'target' in draft ? draft.preview : draft.quotedText}</blockquote>
              <CommentComposer
                autoFocus
                placeholder={t('comments.newPlaceholder')}
                submitLabel={t('comments.post')}
                onSubmit={async (body) => {
                  await actions.createThread(draftToThread(draft, body));
                  onDraftDone();
                }}
                onCancel={onDraftDone}
              />
            </article>
          ) : null,
        )}
        {showResolved && resolvedThreads.map(card)}
      </div>

      {pendingDelete && (
        <ConfirmDialog
          title={t('comments.deleteThreadTitle')}
          confirmLabel={t('comments.delete')}
          destructive
          busy={deleting}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setPendingDelete(null)}
        >
          <p className="text-sm text-neutral-600 dark:text-neutral-300">{t('comments.deleteThreadBody')}</p>
        </ConfirmDialog>
      )}
    </aside>
  );
}
