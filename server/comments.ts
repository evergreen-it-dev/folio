/**
 * Inline comments on doc pages and on board elements (docs/spec.md §4.4, contract: shared/comments.ts):
 * threads anchored to a range of the page's text, kept in Postgres
 * (db/migrations/060_comments.sql) and never in the markdown file. The anchors
 * are Y.RelativePosition bytes the server stores without decoding.
 *
 * This module holds the SQL and the page-level rights; the HTTP wrapper is
 * server/commentsRoutes.ts and the agent tools are in server/mcp.ts, so both
 * ask the same questions the same way.
 */
import type { User } from '../shared/contracts.js';
import { COMMENT_LABEL_MAX, type CommentAuthor, type CommentTarget, type CommentThread, type CommentThreadStatus, type PageComment } from '../shared/comments.js';
import { query, queryOne, withTransaction } from './db/pool.js';
import * as session from './auth/session.js';
import type { PageIndexEntry } from './storage.js';
import * as notificationStore from './notifications/store.js';
import * as notifications from './notifications/dispatch.js';
import * as collab from './collab.js';
import { decodeScenePayload, extractScenePayload, type ExcalidrawElement, type ExcalidrawScene } from './confluenceWhiteboard.js';
import * as storage from './storage.js';
import * as tableService from './tables/service.js';
import { encodeCell } from '../shared/tables/values.js';
import type { TableColumn, TableRow } from '../shared/contracts.js';

/** What a person may do with the comments of one page. */
export interface CommentRights {
  /** May read the page — and so its threads. */
  canView: boolean;
  /** Signed-in reader of a doc page or a board: may start threads and reply. A public-site visitor never may. */
  canComment: boolean;
  /** Editor or above on the page: may resolve/reopen any thread and delete any comment. */
  canModerate: boolean;
}

/** Page kinds that take comments: documents (text anchors), boards (element targets) and tables (cell targets). Every other kind is refused. */
export function isCommentableKind(kind: string): boolean {
  return kind === 'doc' || kind === 'board' || kind === 'table';
}

export async function commentRights(user: User, entry: PageIndexEntry): Promise<CommentRights> {
  const role = await session.effectivePageRole(user, entry);
  const canView = session.roleAtLeast(role, 'viewer');
  const canComment = canView && isCommentableKind(entry.kind) && !session.isSystemUser(user);
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
  anchor_from: Buffer | null;
  anchor_to: Buffer | null;
  quoted_text: string | null;
  target: CommentTarget | null;
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

const THREAD_SELECT = `SELECT t.id, t.page_id, t.anchor_from, t.anchor_to, t.quoted_text, t.target, t.status,
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
    anchorFrom: row.anchor_from?.toString('base64') ?? null,
    anchorTo: row.anchor_to?.toString('base64') ?? null,
    quotedText: row.quoted_text,
    target: row.target,
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

// ---------------------------------------------------------------------------
// Notifications: the one hook for REST and MCP. It lives inside createThread /
// addReply, the only two functions that write a comment, so a route or a tool
// cannot forget it — and cannot call it twice.
// ---------------------------------------------------------------------------

/** `@username` the way the composer and ThreadCard write it; a dot/dash at the end is punctuation. */
const MENTION_RE = /(?<![A-Za-z0-9._@-])@([A-Za-z0-9][A-Za-z0-9._-]*)/g;

/** The distinct, lower-cased usernames mentioned in a comment body. */
export function parseMentions(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(MENTION_RE)) found.add(match[1].replace(/[._-]+$/, '').toLowerCase());
  found.delete('');
  return [...found];
}

const EXCERPT_MAX = 160;

/**
 * Tells the mentioned people (comment_mention) and, for a reply, the other
 * participants of the thread (comment_reply) — never the author, and a person
 * who is both mentioned and a participant gets only the mention. Page access
 * is checked inside notifications.deliverToPage. A failure here never fails
 * the comment that was already saved.
 */
async function notifyAboutComment(pageId: string, thread: CommentThread, comment: PageComment, isReply: boolean): Promise<void> {
  try {
    const authorId = comment.author?.id;
    const payload = {
      threadId: thread.id,
      commentId: comment.id,
      authorId,
      authorName: comment.author?.name,
      excerpt: comment.body.length > EXCERPT_MAX ? `${comment.body.slice(0, EXCERPT_MAX)}…` : comment.body,
    };
    const mentioned = (await notificationStore.findUserIdsByUsernames(parseMentions(comment.body))).filter((id) => id !== authorId);
    await notifications.deliverToPage(mentioned, 'comment_mention', pageId, payload);
    if (!isReply) return;
    const skip = new Set([authorId, ...mentioned]);
    const participants = new Set<string>();
    if (thread.createdBy) participants.add(thread.createdBy.id);
    for (const c of thread.comments) if (c.author) participants.add(c.author.id);
    await notifications.deliverToPage([...participants].filter((id) => !skip.has(id)), 'comment_reply', pageId, payload);
  } catch (err) {
    console.error('comment notification failed', err);
  }
}

/** A thread on a span of text of a doc page. */
export interface NewTextThread {
  anchorFrom: string;
  anchorTo: string;
  quotedText: string;
  body: string;
}

/** A thread on a board element or a table cell; the target already carries the server's label. */
export interface NewTargetThread {
  target: CommentTarget;
  body: string;
}

export type NewThread = NewTextThread | NewTargetThread;

/** Starts a thread with its opening comment. The one write path for REST and MCP, doc or board. */
export async function createThread(pageId: string, userId: string, input: NewThread): Promise<CommentThread> {
  const threadId = await withTransaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      'INSERT INTO comment_threads (page_id, anchor_from, anchor_to, quoted_text, target, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      'target' in input
        ? [pageId, null, null, null, JSON.stringify(input.target), userId]
        : [pageId, Buffer.from(input.anchorFrom, 'base64'), Buffer.from(input.anchorTo, 'base64'), input.quotedText, null, userId],
    );
    await client.query('INSERT INTO comments (thread_id, author_id, body) VALUES ($1, $2, $3)', [inserted.rows[0].id, userId, input.body]);
    return inserted.rows[0].id;
  });
  const thread = (await getThread(threadId))!;
  await notifyAboutComment(pageId, thread, thread.comments[0], false);
  return thread;
}

/** Adds a reply; undefined when the thread is gone. One statement, so a thread deleted in the meantime cannot be answered. */
export async function addReply(threadId: string, userId: string, body: string): Promise<PageComment | undefined> {
  const row = await queryOne<{ id: string }>('INSERT INTO comments (thread_id, author_id, body) SELECT id, $2, $3 FROM comment_threads WHERE id = $1 RETURNING id', [threadId, userId, body]);
  const comment = row ? (await getComment(row.id))?.comment : undefined;
  if (comment) {
    const found = await getThread(threadId);
    if (found) await notifyAboutComment(found.pageId, found, comment, true);
  }
  return comment;
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

// ---------------------------------------------------------------------------
// Board elements: finding the element a thread is about, and what to call it.
// ---------------------------------------------------------------------------

/** The board's scene as it is now: the live room if one is open, else the file. Undefined when it cannot be read. */
export async function readBoardScene(pageId: string): Promise<ExcalidrawScene | undefined> {
  const live = collab.getLiveBoardScene(pageId);
  if (live) return live;
  try {
    const payload = extractScenePayload(await storage.readBoardSvg(pageId));
    return payload ? decodeScenePayload(payload) : undefined;
  } catch {
    return undefined;
  }
}

/** What an element is called in a thread: its own text, the text bound to it (a labelled shape), a frame's name, else its type. */
export function elementLabel(scene: ExcalidrawScene, element: ExcalidrawElement): string {
  const own = element.type === 'text' ? (element.originalText ?? element.text ?? '') : '';
  const bound = element.boundElements?.find((b) => b.type === 'text');
  const boundEl = bound ? scene.elements.find((e) => e.id === bound.id && !e.isDeleted) : undefined;
  const text = own || (boundEl ? (boundEl.originalText ?? boundEl.text ?? '') : '') || (element.type === 'frame' ? (element.name ?? '') : '');
  const label = (text.trim() || element.type).replace(/\s+/g, ' ');
  return label.length > COMMENT_LABEL_MAX ? `${label.slice(0, COMMENT_LABEL_MAX - 1)}…` : label;
}

/** The target for an element of the board, with the label the server reads from the scene; undefined when the board has no such (live) element. */
export async function boardElementTarget(pageId: string, elementId: string): Promise<CommentTarget | undefined> {
  const scene = await readBoardScene(pageId);
  const element = scene?.elements.find((e) => e.id === elementId && !e.isDeleted);
  return scene && element ? { kind: 'board_element', elementId, label: elementLabel(scene, element) } : undefined;
}

/** The ids of the board's live elements (for marking threads whose element is gone); undefined when the scene cannot be read. */
export async function liveElementIds(pageId: string): Promise<Set<string> | undefined> {
  const scene = await readBoardScene(pageId);
  return scene ? new Set(scene.elements.filter((e) => !e.isDeleted).map((e) => e.id)) : undefined;
}

// ---------------------------------------------------------------------------
// Table cells: finding the cell a thread is about, and what to call it.
// ---------------------------------------------------------------------------

/** What a cell is called in a thread: its text as a reader sees it, else the column's name. */
function cellLabel(rows: TableRow[], columns: TableColumn[], rowId: string, columnId: string): string | undefined {
  const row = rows.find((r) => r.id === rowId);
  const column = columns.find((c) => c.id === columnId);
  if (!row || !column) return undefined;
  const text = encodeCell(column, row.values[columnId] ?? null).replace(/\s+/g, ' ').trim();
  const label = text || column.name;
  return label.length > COMMENT_LABEL_MAX ? `${label.slice(0, COMMENT_LABEL_MAX - 1)}…` : label;
}

/** The target for a cell of the table, with the label the server reads from the table now; undefined when the table has no such live row or column. */
export async function tableCellTarget(pageId: string, rowId: string, columnId: string): Promise<CommentTarget | undefined> {
  try {
    const { rows, columns } = await tableService.getTableSnapshot(pageId);
    const label = cellLabel(rows, columns, rowId, columnId);
    return label === undefined ? undefined : { kind: 'table_cell', rowId, columnId, label };
  } catch {
    return undefined;
  }
}

/** The ids of the table's live rows and columns (for marking threads whose row or column is gone); undefined when the table cannot be read. */
export async function liveTableIds(pageId: string): Promise<{ rows: Set<string>; columns: Set<string> } | undefined> {
  try {
    const { rows, columns } = await tableService.getTableSnapshot(pageId);
    return { rows: new Set(rows.map((r) => r.id)), columns: new Set(columns.map((c) => c.id)) };
  } catch {
    return undefined;
  }
}
