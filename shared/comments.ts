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
export const COMMENT_LABEL_MAX = 200;

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

/**
 * What a thread hangs on when it is not a span of text. `kind` picks the shape;
 * `label` is the server's snapshot of the target at the time the thread began
 * (a board element's text or type), so a thread whose element is gone still
 * says what it was about. Stored as comment_threads.target (jsonb).
 *
 *   board_element  an Excalidraw element of a board, by its id (as in reactionsModel.ts)
 *   table_cell     a row and a column of a table, by their ids (the `label` is the
 *                  cell's text, else the column's name)
 */
export const commentTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('board_element'), elementId: z.string().min(1).max(200), label: z.string().max(COMMENT_LABEL_MAX).optional() }),
  z.object({ kind: z.literal('table_cell'), rowId: z.string().min(1).max(200), columnId: z.string().min(1).max(200), label: z.string().max(COMMENT_LABEL_MAX).optional() }),
]);
export type CommentTarget = z.infer<typeof commentTargetSchema>;

export const commentThreadSchema = z.object({
  id: z.string(),
  pageId: z.string(),
  /** base64 of Y.encodeRelativePosition(start), into the 'content' Y.Text. Null for a thread on a board element (see `target`). */
  anchorFrom: z.string().nullable(),
  /** base64 of Y.encodeRelativePosition(end). Null for a thread with a `target`. */
  anchorTo: z.string().nullable(),
  /** The selected text when the thread was created. Null for a thread with a `target`. */
  quotedText: z.string().nullable(),
  /** What a non-text thread is attached to; null for the text threads of doc pages. */
  target: commentTargetSchema.nullable(),
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

/**
 * POST /api/pages/:id/comments -> CommentThread (201).
 * A doc page takes the three text-anchor fields, a board takes `target`
 * (its `label` is ignored: the server writes its own); the route refuses the
 * wrong one for the page's kind. Exactly one of the two forms per request.
 */
export const createCommentThreadBodySchema = z
  .object({
    anchorFrom: z.string().min(1).max(512).optional(),
    anchorTo: z.string().min(1).max(512).optional(),
    quotedText: z.string().min(1).max(COMMENT_QUOTE_MAX).optional(),
    target: commentTargetSchema.optional(),
    body: bodySchema,
  })
  .refine(
    (v) => {
      const text = [v.anchorFrom, v.anchorTo, v.quotedText];
      const anyText = text.some((x) => x !== undefined);
      if (v.target) return !anyText;
      return text.every((x) => x !== undefined);
    },
    { message: 'give either anchorFrom, anchorTo and quotedText, or a target' },
  );
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
