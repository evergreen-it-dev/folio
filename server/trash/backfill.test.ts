/**
 * Trash round — best-effort backfill of a PRE-EXISTING data/.trash layout
 * (spec item 3). Runs against a SCRATCH trash root (__setTrashRootForTests)
 * rather than the machine's real data/.trash: the real directory holds
 * genuine pre-round deletions that repo rules forbid touching, and a
 * scratch root makes every count assertion deterministic. Kept separate
 * from service.test.ts on purpose: THIS schema never enables retention or
 * calls empty/purge, so a backfilled row here can never trigger a purge of
 * files the test didn't create.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { setUpTestSchema, deleteTestSpace } from '../db/testSchema.js';
import * as storage from '../storage.js';
import * as authStore from '../auth/store.js';
import { query, queryOne } from '../db/pool.js';
import type { User } from '../../shared/contracts.js';
import { backfillTrashFromDisk } from './backfill.js';
import { restoreTrashItem, type TrashRow } from './service.js';
import { __setTrashRootForTests } from './paths.js';

const RUN = `trash-bf-${Date.now().toString(36)}`;
const RESTORE_SLUG = `${RUN}-space`;

async function write(root: string, rel: string, content: string): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
}

async function rowByTrashPath(trashPath: string): Promise<TrashRow | undefined> {
  return queryOne<TrashRow>('SELECT * FROM trash_items WHERE trash_path = $1', [trashPath]);
}

/** Mirrors server/trash/service.ts's own (unexported) humanizeSlug — the name a backfilled space (no snapshot, no <slug>.folio) restores under, since a pre-round deletion never wrote either. */
function humanizeSlugForTest(slug: string): string {
  return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

describe('trash backfill (trash round, scratch trash root + real PG)', () => {
  let teardownSchema: () => Promise<void>;
  let scratch: string;
  let admin: User;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    admin = await authStore.createUser({ email: `${RUN}-admin@t.local`, name: 'BF Admin', passwordHash: 'x', isAdmin: true });
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-trash-backfill-'));
    __setTrashRootForTests(scratch);

    // A pre-round trash layout, exactly the shape deletePage has always produced:
    // 1) a single doc, nested (single-child chain down to one file)
    await write(scratch, `2026-08-01T10-00-00-000Z/bfspace-a/notes/plan.md`, `---\nid: BFDOC1\n---\n\n# Work plan\n\nbody\n`);
    // 2) a board (id rides in the leading svg comment)
    await write(
      scratch,
      `2026-08-02T11-00-00-000Z/bfspace-a/board.excalidraw.svg`,
      `<!-- folio-id: BFBOARD1 -->\n<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>\n`,
    );
    // 3) a deleted directory: index.md + a child + a nested child
    await write(scratch, `2026-08-03T12-00-00-000Z/bfspace-a/docs/index.md`, `---\nid: BFIDX\n---\n\n# Documentation\n`);
    await write(scratch, `2026-08-03T12-00-00-000Z/bfspace-a/docs/child.md`, `# Child\n`);
    await write(scratch, `2026-08-03T12-00-00-000Z/bfspace-a/docs/deep/inner.md`, `# Deeper\n`);
    // 4) a whole deleted space (content directly under the space dir)
    await write(scratch, `2026-08-04T13-00-00-000Z/${RESTORE_SLUG}/index.md`, `---\nid: BFROOT\n---\n\n# Restored space\n`);
    await write(scratch, `2026-08-04T13-00-00-000Z/${RESTORE_SLUG}/guide.md`, `# Guide\n`);
    // 5) a table file
    await write(
      scratch,
      `2026-08-05T14-00-00-000Z/bfspace-a/tracker.table.md`,
      `---\nid: BFTBL1\nfolio:\n  version: 1\n---\n\n# Tracker\n`,
    );
    // garbage that must not crash the scan: broken YAML, a non-page binary, a
    // stamp that isn't a stamp, an empty stamp dir, a stray file at the root
    await write(scratch, `2026-08-06T15-00-00-000Z/bfspace-a/broken.md`, `---\nid: [unclosed\n---\n\n# Broken\n`);
    await write(scratch, `2026-08-07T16-00-00-000Z/bfspace-a/photo.bin`, `not a page`);
    await write(scratch, `not-a-stamp/bfspace-a/x.md`, `# Strange\n`);
    await fs.mkdir(path.join(scratch, `2026-08-08T17-00-00-000Z`), { recursive: true });
    await fs.writeFile(path.join(scratch, 'stray.txt'), 'junk', 'utf8');
  });

  afterAll(async () => {
    __setTrashRootForTests(null);
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
    await deleteTestSpace(RESTORE_SLUG);
    await teardownSchema();
  });

  it('records every recoverable pre-existing deletion best-effort (deleted_by null, stamp -> deleted_at), skipping garbage without crashing', async () => {
    const first = await backfillTrashFromDisk(scratch);
    expect(first.recorded).toBeGreaterThanOrEqual(6);

    const doc = await rowByTrashPath('2026-08-01T10-00-00-000Z/bfspace-a/notes/plan.md');
    expect(doc).toMatchObject({ kind: 'doc', space_slug: 'bfspace-a', page_id: 'BFDOC1', orig_path: 'notes/plan.md', title: 'Work plan', deleted_by: null });
    expect(new Date(doc!.deleted_at).toISOString()).toBe('2026-08-01T10:00:00.000Z');

    const board = await rowByTrashPath('2026-08-02T11-00-00-000Z/bfspace-a/board.excalidraw.svg');
    expect(board).toMatchObject({ kind: 'board', page_id: 'BFBOARD1', title: 'board' });

    const folder = await rowByTrashPath('2026-08-03T12-00-00-000Z/bfspace-a/docs');
    expect(folder).toMatchObject({ kind: 'folder', page_id: 'BFIDX', orig_path: 'docs', title: 'Documentation', children_count: 2 });

    const space = await rowByTrashPath(`2026-08-04T13-00-00-000Z/${RESTORE_SLUG}`);
    expect(space).toMatchObject({ kind: 'space', page_id: RESTORE_SLUG, orig_path: '', title: 'Restored space', children_count: 1 });
    expect(space!.payload).toBeNull();

    const table = await rowByTrashPath('2026-08-05T14-00-00-000Z/bfspace-a/tracker.table.md');
    expect(table).toMatchObject({ kind: 'table', page_id: 'BFTBL1', title: 'Tracker' });

    // broken YAML still yields a row (synthetic id, H1 title); binaries/non-stamps yield nothing
    const broken = await rowByTrashPath('2026-08-06T15-00-00-000Z/bfspace-a/broken.md');
    expect(broken).toMatchObject({ kind: 'doc', title: 'Broken', deleted_by: null });
    expect(await rowByTrashPath('2026-08-07T16-00-00-000Z/bfspace-a/photo.bin')).toBeUndefined();
  });

  it('is idempotent: a second boot records nothing new', async () => {
    const before = await query<{ n: string }>('SELECT count(*) AS n FROM trash_items');
    const second = await backfillTrashFromDisk(scratch);
    expect(second.recorded).toBe(0);
    const after = await query<{ n: string }>('SELECT count(*) AS n FROM trash_items');
    expect(after[0].n).toBe(before[0].n);
  });

  it('a backfilled SPACE (payload null) restores end-to-end: files come home, the space is registered and indexed — memberships alone need re-granting by hand', async () => {
    const row = await rowByTrashPath(`2026-08-04T13-00-00-000Z/${RESTORE_SLUG}`);
    const res = await restoreTrashItem(admin, row!.id);
    expect(res).toEqual({ restoredPath: '', pageId: RESTORE_SLUG, space: RESTORE_SLUG, renamed: false });

    expect(await storage.spaceExists(RESTORE_SLUG)).toBe(true);
    // This pre-round backfill has neither a payload snapshot nor a <slug>.folio
    // (it never wrote either — that's the whole "best-effort" point), so restore
    // falls all the way to humanizing the slug; it does NOT go peeking at the
    // restored index.md's own H1 for a name (see restoreSpaceItem's fallback
    // chain: snapshot -> <slug>.folio -> humanizeSlug — deliberately, since a
    // page body isn't authoritative for the space's own name).
    expect((await storage.getSpaceInfo(RESTORE_SLUG))?.name).toBe(humanizeSlugForTest(RESTORE_SLUG));
    const entries = await storage.listEntries(RESTORE_SLUG);
    expect(entries.some((e) => e.relPath === 'index.md' && e.id === 'BFROOT')).toBe(true);
    expect(entries.some((e) => e.relPath === 'guide.md')).toBe(true);
    expect(await rowByTrashPath(`2026-08-04T13-00-00-000Z/${RESTORE_SLUG}`)).toBeUndefined();
  });
});
