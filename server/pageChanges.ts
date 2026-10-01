/**
 * A personal history of structural changes to pages, and undoing them safely.
 *
 * audit_log stays an immutable journal of events. This, instead, stores only
 * the actions for which the server has an explicit reverse operation. Before
 * a rollback the current state is compared with the "after" state, so an old
 * undo cannot silently overwrite a newer change by another user or by a sync.
 */
import path from 'node:path';
import type { PageChangeAction, PageChangeInfo, PageChangeState, PageMeta, User } from '../shared/contracts.js';
import { officeFormat } from '../shared/contracts.js';
import * as storage from './storage.js';
import type { PageIndexEntry } from './storage.js';
import * as collab from './collab.js';
import * as forms from './forms/service.js';
import * as gitSync from './gitSync.js';
import * as session from './auth/session.js';
import * as trash from './trash/service.js';
import { query, queryOne } from './db/pool.js';
import { HttpError, conflict, forbidden, notFound } from './errors.js';

interface PageChangeRow {
  id: string;
  actor_id: string;
  space_slug: string;
  page_id: string;
  action: PageChangeAction;
  before_state: PageChangeState | null;
  after_state: PageChangeState;
  created_at: Date | string;
}

function cleanDir(value: string): string {
  return value === '.' ? '' : value;
}

function slugOf(entry: PageIndexEntry): string {
  if (entry.isIndex) return path.posix.basename(entry.dirPath);
  const basename = path.posix.basename(entry.relPath);
  const extension =
    entry.kind === 'board'
      ? '.excalidraw.svg'
      : entry.kind === 'table'
        ? '.table.md'
        : entry.kind === 'form'
          ? '.form.md'
          : entry.kind === 'pdf'
            ? '.pdf'
            : entry.kind === 'office'
              ? `.${officeFormat(entry.relPath)}`
              : '.md';
  return basename.endsWith(extension) ? basename.slice(0, -extension.length) : basename;
}

/** The state of one page, enough to describe and to verify the reverse action. */
export function snapshotPageChange(entry: PageIndexEntry): PageChangeState {
  return {
    title: entry.title,
    path: entry.relPath,
    parentPath: entry.isIndex ? cleanDir(path.posix.dirname(entry.dirPath)) : entry.dirPath,
    slug: slugOf(entry),
    updatedAt: entry.updatedAt,
  };
}

function toInfo(row: PageChangeRow): PageChangeInfo {
  const info: PageChangeInfo = {
    id: String(row.id),
    action: row.action,
    pageId: row.page_id,
    space: row.space_slug,
    after: row.after_state,
    at: new Date(row.created_at).toISOString(),
  };
  if (row.before_state) info.before = row.before_state;
  return info;
}

/**
 * Recording must not turn a file operation that already succeeded into an
 * HTTP 500: the database and the file cannot be committed atomically in one
 * transaction. So a history error is logged, and the change itself stays successful.
 */
export async function recordPageChange(
  actorId: string,
  action: PageChangeAction,
  pageId: string,
  space: string,
  before: PageChangeState | undefined,
  after: PageChangeState,
): Promise<void> {
  await query(
    `INSERT INTO page_change_history (actor_id, space_slug, page_id, action, before_state, after_state)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [actorId, space, pageId, action, before ? JSON.stringify(before) : null, JSON.stringify(after)],
  ).catch((error) => {
    // eslint-disable-next-line no-console
    console.error(`[changes] could not record ${action} for ${pageId}:`, error);
  });
}

/**
 * The newest `trash_items` record for a page that has just been deleted —
 * DELETE /api/pages/:id calls this right after `storage.deletePage` to attach
 * the id of the trash record to `after_state` (`trashItemId`) and then have
 * something to restore the page with through `trash.restoreTrashItem` on undo.
 */
export async function findTrashItemId(pageId: string): Promise<string | undefined> {
  const row = await queryOne<{ id: string }>(
    `SELECT id::text FROM trash_items WHERE page_id = $1 ORDER BY deleted_at DESC LIMIT 1`,
    [pageId],
  );
  return row?.id;
}

/** The latest actions of the current user in the current space that have not been undone yet. */
export async function listPageChanges(actorId: string, space: string, limit = 10): Promise<PageChangeInfo[]> {
  const safeLimit = Math.max(1, Math.min(20, Math.trunc(limit)));
  const rows = await query<PageChangeRow>(
    `SELECT id::text, actor_id, space_slug, page_id, action, before_state, after_state, created_at
       FROM page_change_history
      WHERE actor_id = $1 AND space_slug = $2 AND undone_at IS NULL
      ORDER BY id DESC
      LIMIT $3`,
    [actorId, space, safeLimit],
  );
  return rows.map(toInfo);
}

async function renamePage(entry: PageIndexEntry, title: string): Promise<PageMeta> {
  if (entry.kind === 'doc') {
    return (await collab.applyH1Rename(entry.id, title))
      ? storage.toPageMeta(await storage.requireEntry(entry.id))
      : storage.renameDocDirect(entry.id, title);
  }
  if (entry.kind === 'table') {
    return (await collab.applyH1Rename(entry.id, title))
      ? storage.toPageMeta(await storage.requireEntry(entry.id))
      : storage.renameTableFile(entry.id, title);
  }
  if (entry.kind === 'form') {
    const result = await storage.renameFormDirect(entry.id, title);
    // Undo must behave like the forward rename: the paired table's title
    // follows too — best-effort, see forms.renamePairedTableBestEffort's
    // doc comment.
    const formDoc = await storage.readFreshFormDoc(entry.id);
    await forms.renamePairedTableBestEffort(entry, formDoc.table, title.trim());
    return result;
  }
  return storage.setBoardTitle(entry.id, title);
}

function requireSame(actual: string, expected: string): void {
  if (actual !== expected) throw conflict('page changed after this action; undo is no longer safe');
}

/**
 * `page.delete` is a separate branch of undo: there is no point looking for a
 * deleted page through `storage.requireEntry` (it is gone from the index for
 * the very reason we are undoing), so rights are checked on the SPACE, and
 * the restore goes through the trash (`trash.restoreTrashItem`), which keeps
 * the files and the frontmatter itself. `restoreTrashItem` performs its own
 * (stricter, admin+) rights check — the editor+ check here only cuts off the
 * most frequent case quickly and gives a clearer refusal to a user who has
 * no right to edit at all.
 */
async function undoPageDelete(actor: User, space: string, row: PageChangeRow): Promise<{ undone: PageChangeInfo; page?: PageMeta }> {
  const role = await session.effectiveRole(actor, space);
  if (!session.roleAtLeast(role, 'editor')) throw forbidden('requires editor+ role on this space');

  const trashItemId = row.after_state.trashItemId;
  if (!trashItemId) throw conflict('this change cannot be undone');

  const author = { name: actor.name, email: actor.email };
  gitSync.recordEditor(space, author);

  let restored;
  try {
    restored = await trash.restoreTrashItem(actor, trashItemId);
  } catch (error) {
    // The trash record no longer exists (purged, or restored earlier) — the
    // same "changed after this action" state as requireSame below.
    if (error instanceof HttpError && error.status === 404) throw conflict('this change cannot be undone');
    throw error;
  }

  const restoredEntry = await storage.requireEntry(restored.pageId);
  const page = storage.toPageMeta(restoredEntry);

  await query('UPDATE page_change_history SET undone_at = now() WHERE id = $1 AND actor_id = $2 AND undone_at IS NULL', [row.id, actor.id]);
  gitSync.noteActivity(space);
  return { undone: toInfo(row), page };
}

/**
 * Undoes the chosen action of one's own. Formal LIFO is not required: an
 * independent change to another page can be undone at once, and a dependent
 * or stale one is stopped anyway by the check of the relevant field of the
 * current state.
 */
export async function undoPageChange(actor: User, space: string, id: string): Promise<{ undone: PageChangeInfo; page?: PageMeta }> {
  const row = await queryOne<PageChangeRow>(
    `SELECT id::text, actor_id, space_slug, page_id, action, before_state, after_state, created_at
       FROM page_change_history
      WHERE id = $1 AND actor_id = $2 AND space_slug = $3 AND undone_at IS NULL`,
    [id, actor.id, space],
  );
  if (!row) throw notFound('page change');

  if (row.action === 'page.delete') return undoPageDelete(actor, space, row);

  const entry = await storage.requireEntry(row.page_id);
  const role = await session.effectivePageRole(actor, entry);
  if (!session.roleAtLeast(role, 'editor')) throw forbidden('requires editor+ role on this page');

  const current = snapshotPageChange(entry);
  const author = { name: actor.name, email: actor.email };
  gitSync.recordEditor(space, author);
  let page: PageMeta | undefined;

  switch (row.action) {
    case 'page.rename':
      if (!row.before_state) throw conflict('this change cannot be undone');
      requireSame(current.title, row.after_state.title);
      page = await renamePage(entry, row.before_state.title);
      break;
    case 'page.move':
      if (!row.before_state) throw conflict('this change cannot be undone');
      requireSame(current.path, row.after_state.path);
      page = await storage.movePage(entry.id, row.before_state.parentPath);
      break;
    case 'page.slug':
      if (!row.before_state) throw conflict('this change cannot be undone');
      requireSame(current.path, row.after_state.path);
      page = await collab.renamePageSlug(entry.id, row.before_state.slug, author);
      break;
    case 'page.create':
    case 'page.copy':
      requireSame(current.path, row.after_state.path);
      requireSame(current.title, row.after_state.title);
      requireSame(current.updatedAt, row.after_state.updatedAt);
      await storage.deletePage(entry.id, actor.id);
      break;
  }

  await query('UPDATE page_change_history SET undone_at = now() WHERE id = $1 AND actor_id = $2 AND undone_at IS NULL', [row.id, actor.id]);
  gitSync.noteActivity(space);
  const undone = toInfo(row);
  return page ? { undone, page } : { undone };
}
