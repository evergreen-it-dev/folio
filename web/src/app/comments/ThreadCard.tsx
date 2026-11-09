import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, MoreHorizontal, RotateCcw } from 'lucide-react';
import type { CommentThread, PageComment } from '@shared/comments';
import type { ResolvedAnchor } from '../../editor/comment-anchors';
import { formatDateTime } from '../formatDate';
import { formatRelativeDate } from '../history';
import { Menu } from '../ui/Menu';
import { CommentComposer } from './CommentComposer';
import type { CommentActions } from './usePageComments';
import '../i18n/register';

const MENTION = /(@[A-Za-z0-9][A-Za-z0-9._-]*)/g;

/** Plain text with line breaks kept; `@username` is only styled, never resolved. */
function CommentBody({ text }: { text: string }) {
  return (
    <p className="whitespace-pre-wrap break-words text-sm text-neutral-800 dark:text-neutral-200">
      {text.split(MENTION).map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className="font-medium text-blue-600 dark:text-blue-400">
            {part}
          </span>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </p>
  );
}

export interface ThreadCardProps {
  thread: CommentThread;
  /** Absent for a resolved thread (resolved threads are not placed in the text). */
  anchor?: ResolvedAnchor;
  meId: string;
  canComment: boolean;
  canModerate: boolean;
  active: boolean;
  actions: CommentActions;
  onHover(id: string | null): void;
  /** The card was clicked: show its range in the text. */
  onSelect(id: string): void;
  /** Ask to delete a comment; the panel confirms when that would take the thread with it. */
  onDelete(comment: PageComment, isThread: boolean): void;
}

export function ThreadCard({ thread, anchor, meId, canComment, canModerate, active, actions, onHover, onSelect, onDelete }: ThreadCardProps) {
  const { t, i18n } = useTranslation('app');
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const resolved = thread.status === 'resolved';
  const detached = !resolved && anchor?.state === 'detached';
  // A board thread has no quoted text: it names its element (the label saved when it began).
  const quote = thread.quotedText ?? thread.target?.label ?? t(thread.target?.kind === 'table_cell' ? 'comments.table.element' : 'comments.board.element');
  const canResolve = canModerate || thread.createdBy?.id === meId;
  const [first] = thread.comments;

  return (
    <article
      data-thread-id={thread.id}
      aria-current={active ? 'true' : undefined}
      onMouseEnter={() => onHover(thread.id)}
      onMouseLeave={() => onHover(null)}
      onClick={(event) => {
        // Controls inside the card do their own thing; the card itself shows the text.
        if (!(event.target as HTMLElement).closest('button,textarea,a,[role="menu"]') && !resolved && !detached) onSelect(thread.id);
      }}
      className={`rounded-lg border bg-white p-3 text-left shadow-sm dark:bg-neutral-900 ${
        active ? 'border-amber-400 ring-1 ring-amber-300 dark:border-amber-500 dark:ring-amber-600' : 'border-neutral-200 dark:border-neutral-800'
      } ${resolved ? 'opacity-80' : ''} ${!resolved && !detached ? 'cursor-pointer' : ''}`}
    >
      <div className="mb-2 flex items-start gap-2">
        <blockquote className="line-clamp-2 min-w-0 flex-1 break-words border-l-2 border-amber-400 pl-2 text-xs text-neutral-500 dark:border-amber-500 dark:text-neutral-400" title={quote}>
          {quote}
        </blockquote>
        {canResolve && (
          <button
            type="button"
            onClick={() => void actions.setStatus(thread.id, resolved ? 'open' : 'resolved')}
            aria-label={resolved ? t('comments.reopen') : t('comments.resolve')}
            title={resolved ? t('comments.reopen') : t('comments.resolve')}
            className="shrink-0 rounded-md p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          >
            {resolved ? <RotateCcw size={14} /> : <Check size={14} />}
          </button>
        )}
      </div>
      {detached && <p className="mb-2 text-xs italic text-amber-700 dark:text-amber-400">{thread.target?.kind === 'table_cell' ? t('comments.table.cellDeleted') : thread.target ? t('comments.board.elementDeleted') : t('comments.detached')}</p>}
      {resolved && thread.resolvedBy && <p className="mb-2 text-xs text-neutral-400 dark:text-neutral-500">{t('comments.resolvedBy', { name: thread.resolvedBy.name })}</p>}

      <ul className="flex flex-col gap-3">
        {thread.comments.map((comment) => {
          const mine = comment.author?.id === meId;
          const isThread = comment.id === first?.id;
          const canEdit = mine && canComment;
          const canDelete = mine || canModerate;
          return (
            <li key={comment.id} data-comment-id={comment.id}>
              <div className="mb-0.5 flex items-center gap-1.5 text-xs">
                <span className="truncate font-medium text-neutral-800 dark:text-neutral-200">{comment.author?.name ?? t('comments.deletedUser')}</span>
                <time dateTime={comment.createdAt} title={formatDateTime(comment.createdAt, i18n.language)} className="shrink-0 text-neutral-400 dark:text-neutral-500">
                  {formatRelativeDate(comment.createdAt)}
                </time>
                {comment.editedAt && <span className="shrink-0 text-neutral-400 dark:text-neutral-500">· {t('comments.edited')}</span>}
                {(canEdit || canDelete) && (
                  <Menu className="ml-auto shrink-0" align="right" triggerLabel={t('comments.actions')} trigger={<MoreHorizontal size={14} aria-hidden="true" />}>
                    {(close) => (
                      <div className="flex min-w-32 flex-col p-1 text-sm">
                        {canEdit && (
                          <button
                            type="button"
                            className="rounded px-2 py-1 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800"
                            onClick={() => {
                              setEditing(comment.id);
                              close();
                            }}
                          >
                            {t('comments.edit')}
                          </button>
                        )}
                        {canDelete && (
                          <button
                            type="button"
                            className="rounded px-2 py-1 text-left text-red-600 hover:bg-neutral-100 dark:text-red-400 dark:hover:bg-neutral-800"
                            onClick={() => {
                              onDelete(comment, isThread);
                              close();
                            }}
                          >
                            {t('comments.delete')}
                          </button>
                        )}
                      </div>
                    )}
                  </Menu>
                )}
              </div>
              {editing === comment.id ? (
                <CommentComposer
                  autoFocus
                  initial={comment.body}
                  placeholder={t('comments.editPlaceholder')}
                  submitLabel={t('comments.save')}
                  onSubmit={async (body) => {
                    await actions.edit(comment.id, body);
                    setEditing(null);
                  }}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <CommentBody text={comment.body} />
              )}
            </li>
          );
        })}
      </ul>

      {canComment && !resolved && (
        <div className="mt-3">
          {replying ? (
            <CommentComposer
              autoFocus
              placeholder={t('comments.replyPlaceholder')}
              submitLabel={t('comments.reply')}
              onSubmit={async (body) => {
                await actions.reply(thread.id, body);
                setReplying(false);
              }}
              onCancel={() => setReplying(false)}
            />
          ) : (
            <button
              type="button"
              onClick={() => setReplying(true)}
              className="w-full rounded-md border border-neutral-200 px-2 py-1.5 text-left text-sm text-neutral-400 hover:border-neutral-300 dark:border-neutral-700 dark:text-neutral-500 dark:hover:border-neutral-600"
            >
              {t('comments.replyPlaceholder')}
            </button>
          )}
        </div>
      )}
    </article>
  );
}
