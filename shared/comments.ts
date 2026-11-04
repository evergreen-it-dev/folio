import { z } from 'zod';

/**
 * Inline comments on a doc page (docs/spec.md §4.4): a thread is anchored to a
 * range of the page's Y.Text ('content') by a pair of Y.RelativePosition,
 * encoded with Y.encodeRelativePosition and sent as base64. Comments never go
 * into the markdown file, so they stay out of git.
 *
 * The client resolves the anchors against its live Y.Doc. When the range is
 * gone (deleted text, or the doc was reseeded from the file), it falls back to
 * finding `quotedText` and, failing that, shows the thread as detached with
 * the quote — "orphaned" is never stored.
 */

export const COMMENT_BODY_MAX = 10_000;
export const COMMENT_QUOTE_MAX = 2_000;

export const commentThreadStatusSchema = z.enum(['open', 'resolved']);
export type CommentThreadStatus = z.infer<typeof commentThreadStatusSchema>;

export const commentAuthorSchema = z.object({
  id: z.string(),
  name: z.string(),
  username: z.string().nullable(),
});
export type CommentAuthor = z.infer<typeof commentAuthorSchema>;

export const pageCommentSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  /** null when the author's account was deleted. */
  author: commentAuthorSchema.nullable(),
  body: z.string(),
  createdAt: z.string(),
  editedAt: z.string().nullable(),
});
export type PageComment = z.infer<typeof pageCommentSchema>;

export const commentThreadSchema = z.object({
  id: z.string(),
  pageId: z.string(),
  /** base64 of Y.encodeRelativePosition(start), into the 'content' Y.Text. */
  anchorFrom: z.string(),
  /** base64 of Y.encodeRelativePosition(end). */
  anchorTo: z.string(),
  /** The selected text when the thread was created. */
  quotedText: z.string(),
  status: commentThreadStatusSchema,
  createdBy: commentAuthorSchema.nullable(),
  createdAt: z.string(),
  resolvedBy: commentAuthorSchema.nullable(),
  resolvedAt: z.string().nullable(),
  /** Oldest first; comments[0] is the thread's opening comment. */
  comments: z.array(pageCommentSchema),
});
export type CommentThread = z.infer<typeof commentThreadSchema>;

/** GET /api/pages/:id/comments */
export const pageCommentsResponseSchema = z.object({
  threads: z.array(commentThreadSchema),
  /** May the current user resolve/reopen any thread and delete any comment (page editor or above). */
  canModerate: z.boolean(),
  /** May the current user add comments and replies. */
  canComment: z.boolean(),
});
export type PageCommentsResponse = z.infer<typeof pageCommentsResponseSchema>;

const bodySchema = z.string().trim().min(1).max(COMMENT_BODY_MAX);

/** POST /api/pages/:id/comments -> CommentThread (201) */
export const createCommentThreadBodySchema = z.object({
  anchorFrom: z.string().min(1).max(512),
  anchorTo: z.string().min(1).max(512),
  quotedText: z.string().min(1).max(COMMENT_QUOTE_MAX),
  body: bodySchema,
});
export type CreateCommentThreadBody = z.infer<typeof createCommentThreadBodySchema>;

/** POST /api/comment-threads/:threadId/comments -> PageComment (201) */
export const createCommentReplyBodySchema = z.object({ body: bodySchema });
export type CreateCommentReplyBody = z.infer<typeof createCommentReplyBodySchema>;

/** PATCH /api/comments/:commentId -> PageComment. Author only. */
export const editCommentBodySchema = z.object({ body: bodySchema });
export type EditCommentBody = z.infer<typeof editCommentBodySchema>;

/**
 * PATCH /api/comment-threads/:threadId -> CommentThread.
 * Thread creator or a moderator (canModerate).
 */
export const updateCommentThreadBodySchema = z.object({ status: commentThreadStatusSchema });
export type UpdateCommentThreadBody = z.infer<typeof updateCommentThreadBodySchema>;

/*
 * DELETE /api/comments/:commentId -> 204. Author or moderator. Deleting a
 * thread's opening comment deletes the whole thread.
 *
 * Realtime: after a change the client bumps `commentsRev` in its own Yjs
 * awareness state; peers on the page see it change and refetch
 * GET /api/pages/:id/comments. No server push is involved.
 */
