/**
 * Trash round — server/trash/service.ts (+ the deletePage hook in
 * server/storage.ts), tested directly against a real PG test schema and the
 * real filesystem, same pattern as server/access/routes.test.ts (no HTTP
 * harness in this codebase — the exported functions carry the authorization
 * themselves).
 *
 * These tests exercise the REAL data/.trash directory (deletePage's own
 * target), so every space they create carries a unique run prefix and the
 * afterAll sweep removes exactly those stamp directories whose contents
 * belong to this run's spaces — pre-existing trash content on the machine
 * is never touched (repo rule: agents must not disturb the owner's data).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setUpTestSchema, deleteTestSpace } from '../db/testSchema.js';
import * as storage from '../storage.js';
import * as authStore from '../auth/store.js';
import * as gitSync from '../gitSync.js';
import { query, queryOne } from '../db/pool.js';
import type { User } from '../../shared/contracts.js';
import { emptyTrash, getTrashSettings, listTrash, purgeTrashItem, restoreTrashItem, setTrashRetention, type TrashRow } from './service.js';
import { getTrashRoot } from './paths.js';

const RUN = `trash-svc-${Date.now().toString(36)}`;
const createdSlugs = new Set<string>();

async function makeSpace(name: string) {
  const info = await storage.createSpace(`${RUN} ${name}`, null);
  createdSlugs.add(info.slug);
  return info;
}

async function rowForPage(pageId: string): Promise<TrashRow | undefined> {
  return queryOne<TrashRow>('SELECT * FROM trash_items WHERE page_id = $1', [pageId]);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Removes ONLY this run's stamp dirs from the real data/.trash: a stamp is swept iff every space-level child belongs to a space this run created. */
async function sweepOwnTrashStamps(): Promise<void> {
  const root = getTrashRoot();
  let stamps: string[] = [];
  try {
    stamps = await fs.readdir(root);
  } catch {
    return;
  }
  for (const stamp of stamps) {
    const stampAbs = path.join(root, stamp);
    let children: string[] = [];
    try {
      children = await fs.readdir(stampAbs);
    } catch {
      continue; // a file, or vanished concurrently — not ours to judge
    }
    if (children.length > 0 && children.every((c) => createdSlugs.has(c))) {
      await fs.rm(stampAbs, { recursive: true, force: true }).catch(() => {});
    }
  }
}

describe('trash service (trash round, real fs + real PG)', () => {
  let teardownSchema: () => Promise<void>;
  let admin: User;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    admin = await authStore.createUser({ email: `${RUN}-admin@t.local`, name: 'Instance Admin', passwordHash: 'x', isAdmin: true });
  });

  afterAll(async () => {
    for (const slug of createdSlugs) await deleteTestSpace(slug);
    await sweepOwnTrashStamps();
    await teardownSchema();
  });

  // -----------------------------------------------------------------------
  // deletePage hook + doc restore
  // -----------------------------------------------------------------------

  it('deleting a doc records a trash row (kind/path/title/deleted_by) and moves the file into data/.trash', async () => {
    const sp = await makeSpace('doc-basic');
    const page = await storage.createPage({ space: sp.slug, parentPath: '', title: 'Alpha', kind: 'doc' });
    await storage.deletePage(page.id, admin.id);

    const row = await rowForPage(page.id);
    expect(row).toBeDefined();
    expect(row!.kind).toBe('doc');
    expect(row!.space_slug).toBe(sp.slug);
    expect(row!.orig_path).toBe(page.path);
    expect(row!.title).toBe('Alpha');
    expect(row!.deleted_by).toBe(admin.id);
    expect(row!.children_count).toBe(0);
    expect(row!.payload).toBeNull();

    // the file left the space and landed at the recorded trash path
    expect(await pathExists(path.join(storage.getSpaceDir(sp.slug), page.path))).toBe(false);
    expect(await pathExists(path.join(getTrashRoot(), row!.trash_path))).toBe(true);
    expect(await storage.getEntry(page.id)).toBeUndefined();

    // and the list surfaces it with the resolved deleter name
    const list = await listTrash(admin, { space: sp.slug });
    const item = list.items.find((i) => i.pageId === page.id);
    expect(item).toBeDefined();
    expect(item!.deletedBy).toEqual({ id: admin.id, name: admin.name });
  });

  it('restores a doc to its original path with the same page id, removes the row, and lands a dedicated "docs: restore" commit', async () => {
    const sp = await makeSpace('doc-restore');
    const page = await storage.createPage({ space: sp.slug, parentPath: '', title: 'Beta', kind: 'doc' });
    await storage.deletePage(page.id, admin.id);
    // commit the deletion like prod's quiet-period auto-commit would, so the
    // restore commit below has an actual diff to record
    await gitSync.commitNow(sp.slug, 'docs: update', { name: admin.name, email: admin.email });

    const row = await rowForPage(page.id);
    const res = await restoreTrashItem(admin, row!.id);
    expect(res).toEqual({ restoredPath: page.path, pageId: page.id, space: sp.slug, renamed: false });

    const entry = await storage.getEntry(page.id);
    expect(entry?.relPath).toBe(page.path);
    expect(entry?.title).toBe('Beta');
    expect(await rowForPage(page.id)).toBeUndefined();
    expect(await pathExists(path.join(getTrashRoot(), row!.trash_path))).toBe(false);

    const history = await gitSync.getPageHistory(page.id);
    expect(history.some((h) => h.message.includes(`docs: restore ${page.path}`))).toBe(true);
  });

  // -----------------------------------------------------------------------
  // board + table
  // -----------------------------------------------------------------------

  it('board: delete records kind board; restore keeps the folio-id and the svg file', async () => {
    const sp = await makeSpace('board');
    const board = await storage.createPage({ space: sp.slug, parentPath: '', title: 'Whiteboard', kind: 'board' });
    await storage.deletePage(board.id, admin.id);

    const row = await rowForPage(board.id);
    expect(row!.kind).toBe('board');

    const res = await restoreTrashItem(admin, row!.id);
    expect(res.renamed).toBe(false);
    const entry = await storage.getEntry(board.id);
    expect(entry?.kind).toBe('board');
    expect(entry?.relPath).toBe(board.path);
    const svg = await storage.readBoardSvg(board.id);
    expect(svg).toContain(`folio-id: ${board.id}`);
  });

  it('table: a .table.md restores with its schema intact (id in frontmatter, default view preserved)', async () => {
    const sp = await makeSpace('table');
    const table = await storage.createPage({
      space: sp.slug,
      parentPath: '',
      title: 'Tracker',
      kind: 'table',
      columns: [{ id: 'name', name: 'Name', type: 'text' }],
    });
    await storage.deletePage(table.id, admin.id);

    const row = await rowForPage(table.id);
    expect(row!.kind).toBe('table');

    const res = await restoreTrashItem(admin, row!.id);
    expect(res.restoredPath).toBe(table.path);

    const entry = await storage.getEntry(table.id);
    expect(entry?.kind).toBe('table');
    const doc = await storage.readFreshTableDoc(table.id);
    expect(doc.meta.id).toBe(table.id);
    expect(doc.columns.map((c) => c.id)).toEqual(['name']);
    expect(doc.views[0]?.name).toBe('All records');
  });

  // -----------------------------------------------------------------------
  // directory with children
  // -----------------------------------------------------------------------

  it('folder: deleting an index page trashes the whole directory (children_count) and restore brings the subtree back with the same ids', async () => {
    const sp = await makeSpace('folder');
    const spaceRoot = storage.getSpaceDir(sp.slug);
    await fs.mkdir(path.join(spaceRoot, 'notes'), { recursive: true });
    await fs.writeFile(path.join(spaceRoot, 'notes', 'index.md'), '# Notes\n', 'utf8');
    await storage.scanSpace(sp.slug);
    const child1 = await storage.createPage({ space: sp.slug, parentPath: 'notes', title: 'Child One', kind: 'doc' });
    const child2 = await storage.createPage({ space: sp.slug, parentPath: 'notes', title: 'Child Two', kind: 'doc' });
    const indexEntry = (await storage.listEntries(sp.slug)).find((e) => e.relPath === 'notes/index.md')!;

    await storage.deletePage(indexEntry.id, admin.id);
    const row = await rowForPage(indexEntry.id);
    expect(row!.kind).toBe('folder');
    expect(row!.orig_path).toBe('notes');
    expect(row!.title).toBe('Notes');
    expect(row!.children_count).toBe(2);
    expect(await storage.getEntry(child1.id)).toBeUndefined();

    const res = await restoreTrashItem(admin, row!.id);
    expect(res).toMatchObject({ restoredPath: 'notes', renamed: false, pageId: indexEntry.id });

    const after = await storage.listEntries(sp.slug);
    expect(after.find((e) => e.relPath === 'notes/index.md')?.id).toBe(indexEntry.id);
    expect(after.find((e) => e.relPath === child1.path)?.id).toBe(child1.id);
    expect(after.find((e) => e.relPath === child2.path)?.id).toBe(child2.id);
  });

  // -----------------------------------------------------------------------
  // whole space (snapshot -> memberships return)
  // -----------------------------------------------------------------------

  it('space: deletion snapshots members into payload; restore recreates the spaces row, memberships with roles, and the pages', async () => {
    const spaceAdmin = await authStore.createUser({ email: `${RUN}-sadm@t.local`, name: 'Space Admin', passwordHash: 'x', isAdmin: false });
    const editor = await authStore.createUser({ email: `${RUN}-sedit@t.local`, name: 'Space Editor', passwordHash: 'x', isAdmin: false });
    const sp = await makeSpace('gamma');
    await authStore.setMembership(sp.slug, spaceAdmin.id, 'admin');
    await authStore.setMembership(sp.slug, editor.id, 'editor');
    await storage.createPage({ space: sp.slug, parentPath: '', title: 'Deep Page', kind: 'doc' });
    const root = (await storage.listEntries(sp.slug)).find((e) => e.relPath === 'index.md')!;
    const originalName = (await storage.getSpaceInfo(sp.slug))!.name;

    await storage.deletePage(root.id, admin.id);
    expect(await storage.spaceExists(sp.slug)).toBe(false);

    const row = await queryOne<TrashRow>('SELECT * FROM trash_items WHERE kind = $1 AND space_slug = $2', ['space', sp.slug]);
    expect(row).toBeDefined();
    expect(row!.page_id).toBe(sp.slug);
    expect(row!.orig_path).toBe('');
    expect(row!.children_count).toBe(1);
    expect(row!.payload?.members).toEqual(
      expect.arrayContaining([
        { userId: spaceAdmin.id, role: 'admin' },
        { userId: editor.id, role: 'editor' },
      ]),
    );

    // the deleted space stays visible to its (snapshot) admin, who can restore it themselves
    const visible = await listTrash(spaceAdmin);
    expect(visible.items.some((i) => i.id === row!.id)).toBe(true);

    const res = await restoreTrashItem(spaceAdmin, row!.id);
    expect(res).toEqual({ restoredPath: '', pageId: sp.slug, space: sp.slug, renamed: false });

    expect(await storage.spaceExists(sp.slug)).toBe(true);
    expect((await storage.getSpaceInfo(sp.slug))?.name).toBe(originalName);
    expect(await authStore.getMembershipRole(sp.slug, spaceAdmin.id)).toBe('admin');
    expect(await authStore.getMembershipRole(sp.slug, editor.id)).toBe('editor');
    const entries = await storage.listEntries(sp.slug);
    expect(entries.some((e) => e.relPath === 'index.md')).toBe(true);
    expect(entries.some((e) => e.title === 'Deep Page')).toBe(true);
    expect(await queryOne('SELECT id FROM trash_items WHERE id = $1', [row!.id])).toBeUndefined();
  });

  it('admin space deletion moves and restores a complete imported repo even without a root index page', async () => {
    const sp = await makeSpace('full-repo');
    await authStore.setMembership(sp.slug, admin.id, 'admin');
    const page = await storage.createPage({ space: sp.slug, parentPath: '', title: 'Only Page', kind: 'doc' });
    await fs.rm(path.join(storage.getSpaceDir(sp.slug), 'index.md'), { force: true });
    await storage.scanSpace(sp.slug);

    await storage.deleteSpace(sp.slug, admin.id);
    expect(await storage.spaceExists(sp.slug)).toBe(false);
    expect(await pathExists(storage.getRepoDir(sp.slug))).toBe(false);
    const row = await queryOne<TrashRow>('SELECT * FROM trash_items WHERE kind = $1 AND space_slug = $2', ['space', sp.slug]);
    expect(row?.payload?.fullRepo).toBe(true);

    await restoreTrashItem(admin, row!.id);
    expect(await storage.spaceExists(sp.slug)).toBe(true);
    expect((await storage.getEntry(page.id))?.title).toBe('Only Page');
    expect(await pathExists(path.join(storage.getRepoDir(sp.slug), '.git'))).toBe(true);
  });

  it('restoring a page whose space is still deleted is refused with a truthful conflict; after the space returns, the page restores too', async () => {
    const sp = await makeSpace('delta');
    const page = await storage.createPage({ space: sp.slug, parentPath: '', title: 'Orphan', kind: 'doc' });
    await storage.deletePage(page.id, admin.id);
    const root = (await storage.listEntries(sp.slug)).find((e) => e.relPath === 'index.md')!;
    await storage.deletePage(root.id, admin.id);

    const pageRow = await rowForPage(page.id);
    await expect(restoreTrashItem(admin, pageRow!.id)).rejects.toThrow(/no longer exists/);

    const spaceRow = await queryOne<TrashRow>('SELECT * FROM trash_items WHERE kind = $1 AND space_slug = $2', ['space', sp.slug]);
    await restoreTrashItem(admin, spaceRow!.id);
    const res = await restoreTrashItem(admin, pageRow!.id);
    expect(res.restoredPath).toBe(page.path);
    expect((await storage.getEntry(page.id))?.relPath).toBe(page.path);
  });

  // -----------------------------------------------------------------------
  // path conflict -> -restored suffix, truthful response
  // -----------------------------------------------------------------------

  it('path conflict: never overwrites — restores alongside as -restored / -restored-2 and reports the ACTUAL path', async () => {
    const sp = await makeSpace('conflict');
    const original = await storage.createPage({ space: sp.slug, parentPath: '', title: 'Alpha', kind: 'doc' });
    await storage.deletePage(original.id, admin.id);

    // a NEW page now occupies the original path, and another one squats on '-restored'
    const usurper = await storage.createPage({ space: sp.slug, parentPath: '', title: 'Alpha', kind: 'doc' });
    expect(usurper.path).toBe(original.path);
    const squatter = await storage.createPage({ space: sp.slug, parentPath: '', title: 'Alpha restored', kind: 'doc' });
    expect(squatter.path).toBe('alpha-restored.md');

    const row = await rowForPage(original.id);
    const res = await restoreTrashItem(admin, row!.id);
    expect(res.renamed).toBe(true);
    expect(res.restoredPath).toBe('alpha-restored-2.md');

    // all three coexist; nobody was overwritten
    const entries = await storage.listEntries(sp.slug);
    expect(entries.find((e) => e.id === original.id)?.relPath).toBe('alpha-restored-2.md');
    expect(entries.find((e) => e.id === usurper.id)?.relPath).toBe(original.path);
    expect(entries.find((e) => e.id === squatter.id)?.relPath).toBe('alpha-restored.md');
  });

  // -----------------------------------------------------------------------
  // permissions
  // -----------------------------------------------------------------------

  it('permissions: a space admin sees only their space; a foreign item is invisible and cannot be restored/purged; a plain user sees nothing', async () => {
    const spaceAdminA = await authStore.createUser({ email: `${RUN}-adm-a@t.local`, name: 'Admin A', passwordHash: 'x', isAdmin: false });
    const outsider = await authStore.createUser({ email: `${RUN}-outsider@t.local`, name: 'Outsider', passwordHash: 'x', isAdmin: false });
    const spA = await makeSpace('perm-a');
    const spB = await makeSpace('perm-b');
    await authStore.setMembership(spA.slug, spaceAdminA.id, 'admin');

    const pageA = await storage.createPage({ space: spA.slug, parentPath: '', title: 'Mine', kind: 'doc' });
    const pageB = await storage.createPage({ space: spB.slug, parentPath: '', title: 'Foreign', kind: 'doc' });
    await storage.deletePage(pageA.id, spaceAdminA.id);
    await storage.deletePage(pageB.id, admin.id);

    const forA = await listTrash(spaceAdminA);
    expect(forA.items.some((i) => i.pageId === pageA.id)).toBe(true);
    expect(forA.items.some((i) => i.pageId === pageB.id)).toBe(false);

    const rowB = await rowForPage(pageB.id);
    await expect(restoreTrashItem(spaceAdminA, rowB!.id)).rejects.toThrow(/admin/);
    await expect(purgeTrashItem(spaceAdminA, rowB!.id)).rejects.toThrow(/admin/);
    await expect(purgeTrashItem(outsider, rowB!.id)).rejects.toThrow(/admin/);
    expect((await listTrash(outsider)).items).toEqual([]);

    // the instance admin sees both — the deliberate administration-not-content exception
    const forInstance = await listTrash(admin);
    expect(forInstance.items.some((i) => i.pageId === pageA.id)).toBe(true);
    expect(forInstance.items.some((i) => i.pageId === pageB.id)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // filters
  // -----------------------------------------------------------------------

  it('filters: space, kind and date range narrow the list', async () => {
    const sp = await makeSpace('filters');
    const doc = await storage.createPage({ space: sp.slug, parentPath: '', title: 'Doc F', kind: 'doc' });
    const board = await storage.createPage({ space: sp.slug, parentPath: '', title: 'Board F', kind: 'board' });
    await storage.deletePage(doc.id, admin.id);
    await storage.deletePage(board.id, admin.id);

    const onlyBoards = await listTrash(admin, { space: sp.slug, kind: 'board' });
    expect(onlyBoards.items.map((i) => i.pageId)).toEqual([board.id]);

    const today = new Date().toISOString().slice(0, 10);
    const todays = await listTrash(admin, { space: sp.slug, from: today, to: today });
    expect(todays.items).toHaveLength(2);
    const none = await listTrash(admin, { space: sp.slug, to: '2000-01-01' });
    expect(none.items).toEqual([]);
  });

  it('pagination: limit/offset slice the filtered set and total/spaces cover the whole (unpaged) result', async () => {
    const sp = await makeSpace('paging');
    const pages = [];
    for (let i = 0; i < 5; i++) pages.push(await storage.createPage({ space: sp.slug, parentPath: '', title: `P${i}`, kind: 'doc' }));
    for (const p of pages) await storage.deletePage(p.id, admin.id);

    const page1 = await listTrash(admin, { space: sp.slug, limit: 2, offset: 0 });
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBe(5);
    expect(page1.spaces).toContain(sp.slug);

    const page2 = await listTrash(admin, { space: sp.slug, limit: 2, offset: 2 });
    expect(page2.items).toHaveLength(2);
    expect(page2.total).toBe(5);
    expect(page1.items.map((i) => i.id)).not.toEqual(page2.items.map((i) => i.id));

    // invalid/out-of-range values fall back to the defaults (limit 100, offset 0)
    const defaulted = await listTrash(admin, { space: sp.slug, limit: -1, offset: -5 });
    expect(defaulted.items).toHaveLength(5);
    expect(defaulted.total).toBe(5);
  });

  // -----------------------------------------------------------------------
  // permanent delete + empty the trash
  // -----------------------------------------------------------------------

  it('permanent delete removes the files and the row for good', async () => {
    const sp = await makeSpace('purge');
    const page = await storage.createPage({ space: sp.slug, parentPath: '', title: 'Doomed', kind: 'doc' });
    await storage.deletePage(page.id, admin.id);
    const row = await rowForPage(page.id);
    const abs = path.join(getTrashRoot(), row!.trash_path);
    expect(await pathExists(abs)).toBe(true);

    await purgeTrashItem(admin, row!.id);
    expect(await pathExists(abs)).toBe(false);
    expect(await rowForPage(page.id)).toBeUndefined();
  });

  it('empty the trash: empties everything visible in the given space', async () => {
    const sp = await makeSpace('empty');
    const p1 = await storage.createPage({ space: sp.slug, parentPath: '', title: 'One', kind: 'doc' });
    const p2 = await storage.createPage({ space: sp.slug, parentPath: '', title: 'Two', kind: 'doc' });
    await storage.deletePage(p1.id, admin.id);
    await storage.deletePage(p2.id, admin.id);

    const res = await emptyTrash(admin, sp.slug);
    expect(res.removed).toBe(2);
    expect((await listTrash(admin, { space: sp.slug })).items).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // retention (kept last: it flips the schema-wide setting)
  // -----------------------------------------------------------------------

  it('retention: null by default (no auto-purge); instance-admin only; once set, opening the list lazily purges expired items', async () => {
    const nonAdmin = await authStore.createUser({ email: `${RUN}-ret-na@t.local`, name: 'NA', passwordHash: 'x', isAdmin: false });
    await expect(setTrashRetention(nonAdmin, 7)).rejects.toThrow(/instance admin/);
    expect(await getTrashSettings()).toEqual({ retentionDays: null });

    const sp = await makeSpace('retention');
    const fresh = await storage.createPage({ space: sp.slug, parentPath: '', title: 'Fresh', kind: 'doc' });
    const old = await storage.createPage({ space: sp.slug, parentPath: '', title: 'Old', kind: 'doc' });
    await storage.deletePage(fresh.id, admin.id);
    await storage.deletePage(old.id, admin.id);
    const oldRow = await rowForPage(old.id);
    await query(`UPDATE trash_items SET deleted_at = now() - interval '30 days' WHERE id = $1`, [oldRow!.id]);

    // no retention set -> nothing purged
    expect((await listTrash(admin, { space: sp.slug })).items).toHaveLength(2);

    expect(await setTrashRetention(admin, 7)).toEqual({ retentionDays: 7 });
    const after = await listTrash(admin, { space: sp.slug });
    expect(after.items.map((i) => i.pageId)).toEqual([fresh.id]);
    expect(await rowForPage(old.id)).toBeUndefined();
    expect(await pathExists(path.join(getTrashRoot(), oldRow!.trash_path))).toBe(false);

    await setTrashRetention(admin, null);
  });
});
