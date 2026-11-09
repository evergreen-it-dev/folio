/**
 * The HTTP wrapper of server/comments.ts: comment threads on doc pages (text anchors) and boards (element targets) and tables (cell targets)
 * (contract: shared/comments.ts). Cookie or PAT — reading needs any token, the
 * writes a write-scope one.
 *
 *   GET    /api/pages/:id/comments               viewer+ on the page -> PageCommentsResponse
 *   POST   /api/pages/:id/comments               signed-in reader, doc pages (text anchor) and boards (target) -> 201 CommentThread
 *   POST   /api/comment-threads/:threadId/comments   same -> 201 PageComment (a reply)
 *   PATCH  /api/comments/:commentId              its author -> PageComment
 *   DELETE /api/comments/:commentId              its author or a moderator -> 204
 *   PATCH  /api/comment-threads/:threadId        the thread's creator or a moderator -> CommentThread
 *
 * A reader of the page may SEE its threads; commenting needs a real account
 * (not a public-site visitor, not a share link — those never reach this scope);
 * a moderator is anyone who can edit the page. A page, thread or comment the
 * caller cannot read is "not found", never a 403.
 */
import type { FastifyInstance } from 'fastify';
import {
  createCommentReplyBodySchema,
  createCommentThreadBodySchema,
  editCommentBodySchema,
  updateCommentThreadBodySchema,
  type CommentThread,
  type PageCommentsResponse,
} from '../shared/comments.js';
import type { User } from '../shared/contracts.js';
import { recordAudit } from './audit.js';
import * as session from './auth/session.js';
import * as comments from './comments.js';
import { badRequest, forbidden, notFound, tooManyRequests } from './errors.js';
import { rateLimited } from './rateLimit.js';
import * as storage from './storage.js';
import type { PageIndexEntry } from './storage.js';
import { parseBody } from './validate.js';

/** A person writes a handful of comments a minute; this stops a script, not a discussion. */
const WRITES_PER_MINUTE = 30;

interface PageAccess {
  entry: PageIndexEntry;
  rights: comments.CommentRights;
}

/** The page behind `pageId` and what `user` may do with its comments; 404 when they cannot read it. */
async function pageAccess(user: User, pageId: string, what: string): Promise<PageAccess> {
  const entry = await storage.getEntry(pageId);
  if (!entry) throw notFound(what);
  const rights = await comments.commentRights(user, entry);
  if (!rights.canView) throw notFound(what);
  return { entry, rights };
}

/** A thread and the access to its page. A thread of a page in the trash is not reachable. */
async function threadAccess(user: User, threadId: string): Promise<PageAccess & { thread: CommentThread }> {
  const thread = await comments.getThread(threadId);
  if (!thread) throw notFound('comment thread');
  return { thread, ...(await pageAccess(user, thread.pageId, 'comment thread')) };
}

function requireCanComment(rights: comments.CommentRights, entry: PageIndexEntry): void {
  if (!comments.isCommentableKind(entry.kind)) throw badRequest('comments are only available on documents, boards and tables');
  if (!rights.canComment) throw forbidden('commenting requires a signed-in account');
}

function limitWrites(user: User): void {
  if (rateLimited('comments', user.id, WRITES_PER_MINUTE, 60_000)) throw tooManyRequests('too many comments, wait a moment');
}

export function registerCommentRoutes(app: FastifyInstance): void {
  app.get('/api/pages/:id/comments', async (request): Promise<PageCommentsResponse> => {
    const { id } = request.params as { id: string };
    const { rights } = await pageAccess(request.authUser!, id, 'page');
    return { threads: await comments.listThreads(id), canModerate: rights.canModerate, canComment: rights.canComment };
  });

  app.post('/api/pages/:id/comments', async (request, reply): Promise<CommentThread> => {
    const { id } = request.params as { id: string };
    const user = request.authUser!;
    const { entry, rights } = await pageAccess(user, id, 'page');
    session.requireWriteScope(request);
    requireCanComment(rights, entry);
    const body = parseBody(createCommentThreadBodySchema, request.body);
    let input: comments.NewThread;
    if (entry.kind === 'board') {
      // A board thread hangs on an element, never on text; the label is the server's own reading of the element.
      if (!body.target) throw badRequest('a comment on a board needs a target');
      if (body.target.kind !== 'board_element') throw badRequest('a board takes comments on its elements only');
      const target = await comments.boardElementTarget(id, body.target.elementId);
      if (!target) throw badRequest('the board has no such element');
      input = { target, body: body.body };
    } else if (entry.kind === 'table') {
      // A table thread hangs on a cell (row + column ids); the label is the server's reading of the cell.
      if (!body.target) throw badRequest('a comment on a table needs a target');
      if (body.target.kind !== 'table_cell') throw badRequest('a table takes comments on its cells only');
      const target = await comments.tableCellTarget(id, body.target.rowId, body.target.columnId);
      if (!target) throw badRequest('the table has no such row or column');
      input = { target, body: body.body };
    } else {
      // A doc thread keeps requiring its anchor in the text.
      if (body.target || !body.anchorFrom || !body.anchorTo || !body.quotedText) throw badRequest('a comment on a document needs anchorFrom, anchorTo and quotedText');
      if (!comments.isValidAnchor(body.anchorFrom) || !comments.isValidAnchor(body.anchorTo)) throw badRequest('anchorFrom and anchorTo must be base64');
      input = { anchorFrom: body.anchorFrom, anchorTo: body.anchorTo, quotedText: body.quotedText, body: body.body };
    }
    limitWrites(user);
    const thread = await comments.createThread(id, user.id, input);
    recordAudit(user.id, 'comment.created', id, { threadId: thread.id });
    reply.status(201);
    return thread;
  });

  app.post('/api/comment-threads/:threadId/comments', async (request, reply) => {
    const { threadId } = request.params as { threadId: string };
    const user = request.authUser!;
    const { entry, rights } = await threadAccess(user, threadId);
    session.requireWriteScope(request);
    requireCanComment(rights, entry);
    const body = parseBody(createCommentReplyBodySchema, request.body);
    limitWrites(user);
    const created = await comments.addReply(threadId, user.id, body.body);
    if (!created) throw notFound('comment thread');
    recordAudit(user.id, 'comment.created', entry.id, { threadId, commentId: created.id });
    reply.status(201);
    return created;
  });

  app.patch('/api/comments/:commentId', async (request) => {
    const { commentId } = request.params as { commentId: string };
    const user = request.authUser!;
    const found = await comments.getComment(commentId);
    if (!found) throw notFound('comment');
    const { entry, rights } = await pageAccess(user, found.pageId, 'comment');
    session.requireWriteScope(request);
    if (found.comment.author?.id !== user.id) throw forbidden('only the author can edit a comment');
    requireCanComment(rights, entry);
    const body = parseBody(editCommentBodySchema, request.body);
    const edited = await comments.editComment(commentId, body.body);
    if (!edited) throw notFound('comment');
    return edited;
  });

  app.delete('/api/comments/:commentId', async (request, reply) => {
    const { commentId } = request.params as { commentId: string };
    const user = request.authUser!;
    const found = await comments.getComment(commentId);
    if (!found) throw notFound('comment');
    const { rights } = await pageAccess(user, found.pageId, 'comment');
    session.requireWriteScope(request);
    if (found.comment.author?.id !== user.id && !rights.canModerate) throw forbidden('only the author or an editor of the page can delete a comment');
    const { threadDeleted } = await comments.deleteComment(commentId);
    recordAudit(user.id, 'comment.deleted', found.pageId, { threadId: found.comment.threadId, commentId, threadDeleted });
    reply.status(204).send();
  });

  app.patch('/api/comment-threads/:threadId', async (request): Promise<CommentThread> => {
    const { threadId } = request.params as { threadId: string };
    const user = request.authUser!;
    const { thread, entry, rights } = await threadAccess(user, threadId);
    session.requireWriteScope(request);
    requireCanComment(rights, entry);
    if (thread.createdBy?.id !== user.id && !rights.canModerate) throw forbidden('only the thread starter or an editor of the page can resolve or reopen it');
    const body = parseBody(updateCommentThreadBodySchema, request.body);
    const updated = await comments.setThreadStatus(threadId, body.status, user.id);
    if (!updated) throw notFound('comment thread');
    return updated;
  });
}
