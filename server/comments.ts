/**
 * Inline comments on doc pages (docs/spec.md §4.4, contract: shared/comments.ts):
 * threads anchored to a range of the page's text, kept in Postgres
 * (db/migrations/060_comments.sql) and never in the markdown file. The anchors
 * are Y.RelativePosition bytes the server stores without decoding.
 *
 * This module holds the SQL and the page-level rights; the HTTP wrapper is
 * server/commentsRoutes.ts and the agent tools are in server/mcp.ts, so both
 * ask the same questions the same way.
 */
import type { User } from '../shared/contracts.js';
import type { CommentAuthor, CommentThread, CommentThreadStatus, PageComment } from '../shared/comments.js';
import { query, queryOne, withTransaction } from './db/pool.js';
import * as session from './auth/session.js';
import type { PageIndexEntry } from './storage.js';

/** What a person may do with the comments of one page. */
export interface CommentRights {
  /** May read the page — and so its threads. */
  canView: boolean;
  /** Signed-in reader of a doc page: may start threads and reply. A public-site visitor never may. */
  canComment: boolean;
  /** Editor or above on the page: may resolve/reopen any thread and delete any comment. */
  canModerate: boolean;
}

export async function commentRights(user: User, entry: PageIndexEntry): Promise<CommentRights> {
  const role = await session.effectivePageRole(user, entry);
  const canView = session.roleAtLeast(role, 'viewer');
  const canComment = canView && entry.kind === 'doc' && !session.isSystemUser(user);
  return { canView, canComment, canModerate: canComment && session.roleAtLeast(role, 'editor') };
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Anchors arrive as base64 text; false when it is not base64 of at least one byte. */
export function isValidAnchor(value: string): boolean {
  return value.length % 4 === 0 && BASE64_RE.test(value);
}

interface ThreadRow {
  id: string;
  page_id: string;
  anchor_from: Buffer;
  anchor_to: Buffer;
  quoted_text: string;
  status: CommentThreadStatus;
  created_by: string | null;
  created_by_name: string | null;
  created_by_username: string | null;
  created_at: Date;
  resolved_by: string | null;
  resolved_by_name: string | null;
  resolved_by_username: string | null;
  resolved_at: Date | null;
}

interface CommentRow {
  id: string;
  thread_id: string;
  author_id: string | null;
  author_name: string | null;
  author_username: string | null;
  body: string;
  created_at: Date;
  edited_at: Date | null;
}

const THREAD_SELECT = `SELECT t.id, t.page_id, t.anchor_from, t.anchor_to, t.quoted_text, t.status,
         t.created_by, cu.name AS created_by_name, cu.username AS created_by_username, t.created_at,
         t.resolved_by, ru.name AS resolved_by_name, ru.username AS resolved_by_username, t.resolved_at
    FROM comment_threads t
    LEFT JOIN users cu ON cu.id = t.created_by
    LEFT JOIN users ru ON ru.id = t.resolved_by`;

const COMMENT_SELECT = `SELECT c.id, c.thread_id, c.author_id, u.name AS author_name, u.username AS author_username, c.body, c.created_at, c.edited_at
    FROM comments c
    LEFT JOIN users u ON u.id = c.author_id`;

function author(id: string | null, name: string | null, username: string | null): CommentAuthor | null {
  return id === null ? null : { id, name: name ?? '', username };
}

function toComment(row: CommentRow): PageComment {
  return {
    id: row.id,
    threadId: row.thread_id,
    author: author(row.author_id, row.author_name, row.author_username),
    body: row.body,
    createdAt: row.created_at.toISOString(),
    editedAt: row.edited_at?.toISOString() ?? null,
  };
}

function toThread(row: ThreadRow, comments: PageComment[]): CommentThread {
  return {
    id: row.id,
    pageId: row.page_id,
    anchorFrom: row.anchor_from.toString('base64'),
    anchorTo: row.anchor_to.toString('base64'),
    quotedText: row.quoted_text,
    status: row.status,
    createdBy: author(row.created_by, row.created_by_name, row.created_by_username),
    createdAt: row.created_at.toISOString(),
    resolvedBy: author(row.resolved_by, row.resolved_by_name, row.resolved_by_username),
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    comments,
  };
}

/** Oldest first: the opening comment leads. */
const COMMENT_ORDER = 'ORDER BY c.created_at, c.id';

/** Every thread of the page, oldest first, with its comments. */
export async function listThreads(pageId: string): Promise<CommentThread[]> {
  const threads = await query<ThreadRow>(`${THREAD_SELECT} WHERE t.page_id = $1 ORDER BY t.created_at, t.id`, [pageId]);
  if (threads.length === 0) return [];
  const comments = await query<CommentRow>(`${COMMENT_SELECT} WHERE c.thread_id = ANY($1::uuid[]) ${COMMENT_ORDER}`, [threads.map((t) => t.id)]);
  const byThread = new Map<string, PageComment[]>();
  for (const row of comments) {
    const list = byThread.get(row.thread_id) ?? [];
    list.push(toComment(row));
    byThread.set(row.thread_id, list);
  }
  return threads.map((t) => toThread(t, byThread.get(t.id) ?? []));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One thread with its comments; undefined for an unknown id (or one that is not a uuid). */
export async function getThread(threadId: string): Promise<CommentThread | undefined> {
  if (!UUID_RE.test(threadId)) return undefined;
  const row = await queryOne<ThreadRow>(`${THREAD_SELECT} WHERE t.id = $1`, [threadId]);
  if (!row) return undefined;
  const comments = await query<CommentRow>(`${COMMENT_SELECT} WHERE c.thread_id = $1 ${COMMENT_ORDER}`, [threadId]);
  return toThread(row, comments.map(toComment));
}

/** A comment with the page its thread belongs to; undefined for an unknown id. */
export async function getComment(commentId: string): Promise<{ comment: PageComment; pageId: string } | undefined> {
  if (!UUID_RE.test(commentId)) return undefined;
  const row = await queryOne<CommentRow & { page_id: string }>(
    `SELECT c.id, c.thread_id, c.author_id, u.name AS author_name, u.username AS author_username, c.body, c.created_at, c.edited_at, t.page_id
       FROM comments c
       JOIN comment_threads t ON t.id = c.thread_id
       LEFT JOIN users u ON u.id = c.author_id
      WHERE c.id = $1`,
    [commentId],
  );
  return row ? { comment: toComment(row), pageId: row.page_id } : undefined;
}

export interface NewThread {
  anchorFrom: string;
  anchorTo: string;
  quotedText: string;
  body: string;
}

/** Starts a thread with its opening comment. */
export async function createThread(pageId: string, userId: string, input: NewThread): Promise<CommentThread> {
  const threadId = await withTransaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      'INSERT INTO comment_threads (page_id, anchor_from, anchor_to, quoted_text, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [pageId, Buffer.from(input.anchorFrom, 'base64'), Buffer.from(input.anchorTo, 'base64'), input.quotedText, userId],
    );
    await client.query('INSERT INTO comments (thread_id, author_id, body) VALUES ($1, $2, $3)', [inserted.rows[0].id, userId, input.body]);
    return inserted.rows[0].id;
  });
  return (await getThread(threadId))!;
}

/** Adds a reply; undefined when the thread is gone. One statement, so a thread deleted in the meantime cannot be answered. */
export async function addReply(threadId: string, userId: string, body: string): Promise<PageComment | undefined> {
  const row = await queryOne<{ id: string }>('INSERT INTO comments (thread_id, author_id, body) SELECT id, $2, $3 FROM comment_threads WHERE id = $1 RETURNING id', [threadId, userId, body]);
  return row ? (await getComment(row.id))?.comment : undefined;
}

/** Edits the text of a comment. */
export async function editComment(commentId: string, body: string): Promise<PageComment | undefined> {
  const row = await queryOne<{ id: string }>('UPDATE comments SET body = $2, edited_at = now() WHERE id = $1 RETURNING id', [commentId, body]);
  return row ? (await getComment(row.id))?.comment : undefined;
}

/**
 * Deletes a comment; the thread's opening comment takes the whole thread with
 * it. Returns whether the thread went too (false: only the reply).
 */
export async function deleteComment(commentId: string): Promise<{ threadDeleted: boolean }> {
  return withTransaction(async (client) => {
    const found = await client.query<{ thread_id: string; first_id: string }>(
      `SELECT c.thread_id,
              (SELECT f.id FROM comments f WHERE f.thread_id = c.thread_id ORDER BY f.created_at, f.id LIMIT 1) AS first_id
         FROM comments c WHERE c.id = $1`,
      [commentId],
    );
    const row = found.rows[0];
    if (!row) return { threadDeleted: false };
    if (row.first_id === commentId) {
      await client.query('DELETE FROM comment_threads WHERE id = $1', [row.thread_id]);
      return { threadDeleted: true };
    }
    await client.query('DELETE FROM comments WHERE id = $1', [commentId]);
    return { threadDeleted: false };
  });
}

/** Resolves or reopens a thread (who resolved it is kept while it is resolved). */
export async function setThreadStatus(threadId: string, status: CommentThreadStatus, userId: string): Promise<CommentThread | undefined> {
  const row = await queryOne<{ id: string }>(
    `UPDATE comment_threads
        SET status = $2,
            resolved_by = CASE WHEN $2 = 'resolved' THEN $3::uuid END,
            resolved_at = CASE WHEN $2 = 'resolved' THEN now() END
      WHERE id = $1 RETURNING id`,
    [threadId, status, userId],
  );
  return row ? getThread(row.id) : undefined;
}
