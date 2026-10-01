/**
 * Round 26 follow-up — the three `kind === 'table'` dispatch gaps in
 * server/routes.ts that SHELL-TABLES hit while wiring the page view, and the
 * two service.ts functions added to close them.
 *
 * Why these existed: the orchestrator told SERVER-TABLES not to touch
 * server/routes.ts at all (it is the shared conflict hotspot between the three
 * rounds running that night), but spec §8 also calls for edits to the kind
 * forks that live IN that file. The route modules got written, the forks did
 * not — so a table page 400'd on read, a shared table link was dead, and
 * restore-to-sha wrote a table's markdown into the prose Y.Text room.
 *
 * The restore case is the one that mattered: it is a silent data-corruption
 * path, not a 4xx, so it gets the most coverage here. Real fs + real PG, same
 * conventions as service.test.ts. No WS connections are opened, so these
 * exercise the DIRECT (non-collab) branch of applyPatch.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import matter from 'gray-matter';
import { setUpTestSchema, deleteTestSpace } from '../db/testSchema.js';
import * as storage from '../storage.js';
import * as git from '../git.js';
import * as gitSync from '../gitSync.js';
import * as service from './service.js';
import { isTableParseError, parseTableFile } from '../../shared/tables/index.js';
import type { TableColumn } from '../../shared/contracts.js';

describe('table arms of the generic page routes (real fs + real PG)', () => {
  let teardownSchema: () => Promise<void>;
  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });
  afterAll(async () => {
    await teardownSchema();
  });

  const OWNER: TableColumn = { id: 'owner', name: 'Owner', type: 'text' };

  async function makeTable(title: string, columns: TableColumn[] = [OWNER]) {
    const space = await storage.createSpace(`${title} ${Date.now()}`, null);
    const meta = await storage.createPage({ space: space.slug, parentPath: '', title, kind: 'table', columns });
    return { space, meta, dir: storage.getRepoDir(space.slug) };
  }

  /**
   * GET /api/pages/:id and GET /api/share/:token both hand a table back as
   * PageDoc.markdown (PageDoc is deliberately not extended for tables — see
   * DEV-PLAN R26's contract note). Both routes call this one function, so
   * testing it covers both arms; what it must NOT be is frontmatter-stripped,
   * because the frontmatter is the schema.
   */
  it('readTableMarkdown returns the whole file, schema included, and round-trips through the codec', async () => {
    const { space, meta } = await makeTable('Read Arm');
    const seeded = await storage.readFreshTableDoc(meta.id);
    await storage.writeTableDoc(meta.id, {
      ...seeded,
      head: '# Read Arm\n\nProse above the table.\n',
      tail: '\nProse below the table.\n',
      rows: [{ id: 'r0000001', values: { owner: 'alice' } }],
    });

    const markdown = await service.readTableMarkdown(meta.id);

    expect(markdown).toMatch(/^---/); // frontmatter (= the column schema) present
    expect(markdown).toContain('folio: table');

    const parsed = parseTableFile(markdown);
    expect(isTableParseError(parsed)).toBe(false);
    if (!isTableParseError(parsed)) {
      expect(parsed.columns.map((c) => c.id)).toEqual(['owner']);
      expect(parsed.rows).toEqual([{ id: 'r0000001', values: { owner: 'alice' } }]);
      expect(parsed.head).toContain('Prose above the table.');
      expect(parsed.tail).toContain('Prose below the table.');
    }

    await deleteTestSpace(space.slug);
  });

  it('persists a table icon through ordinary writes and a full rescan', async () => {
    const { space, meta } = await makeTable('Icon Arm');
    let entry = await storage.requireEntry(meta.id);

    await storage.setTableIcon(entry, '😀');
    expect((await storage.requireEntry(meta.id)).icon).toBe('😀');
    expect(matter(await service.readTableMarkdown(meta.id)).data.icon).toBe('😀');

    const doc = await storage.readFreshTableDoc(meta.id);
    await storage.writeTableDoc(meta.id, {
      ...doc,
      rows: [{ id: 'r0000001', values: { owner: 'alice' } }],
    });
    expect(matter(await service.readTableMarkdown(meta.id)).data.icon).toBe('😀');

    await storage.scanSpace(space.slug);
    entry = await storage.requireEntry(meta.id);
    expect(entry.icon).toBe('😀');

    await storage.setTableIcon(entry, undefined);
    expect(matter(await service.readTableMarkdown(meta.id)).data.icon).toBeUndefined();

    await deleteTestSpace(space.slug);
  });

  /**
   * The corruption fix. Before it, this path ran the table's raw markdown
   * through collab.editDocBody — the PROSE Y.Text room, not the table's
   * structured Y.Doc. Restoring an old revision has to bring back the schema,
   * the rows AND the prose, or the page comes back as some hybrid of two
   * revisions.
   */
  it('restoreTableFromMarkdown brings back the old schema, rows and prose together', async () => {
    const { space, meta, dir } = await makeTable('Restore Arm');

    // v1: one column, one row, its own prose.
    const v1 = await storage.readFreshTableDoc(meta.id);
    await storage.writeTableDoc(meta.id, {
      ...v1,
      head: '# Restore Arm\n\nVersion one.\n',
      rows: [{ id: 'r0000001', values: { owner: 'alice' } }],
    });
    await git.commitAll(dir, 'docs: table v1', { name: 'Tester', email: 't@example.test' });

    // v2: schema grows a column, rows change, prose changes.
    const v2 = await storage.readFreshTableDoc(meta.id);
    await storage.writeTableDoc(meta.id, {
      ...v2,
      columns: [...v2.columns, { id: 'status', name: 'Status', type: 'status', options: [{ value: 'DONE', color: 'green' }] }],
      head: '# Restore Arm\n\nVersion two.\n',
      rows: [
        { id: 'r0000001', values: { owner: 'alice', status: 'DONE' } },
        { id: 'r0000002', values: { owner: 'bob', status: null } },
      ],
    });
    await git.commitAll(dir, 'docs: table v2', { name: 'Tester', email: 't@example.test' });

    const history = await gitSync.getPageHistory(meta.id);
    const olderSha = history[history.length - 1].sha;
    const atOldSha = await gitSync.getPageAtSha(meta.id, olderSha);

    await service.restoreTableFromMarkdown(meta.id, atOldSha.markdown!);

    // What actually landed on disk is v1 in full — this is the assertion that
    // fails outright if the restore goes through the prose room instead.
    const restored = await storage.readFreshTableDoc(meta.id);
    expect(restored.columns.map((c) => c.id)).toEqual(['owner']); // NOT v2's ['owner','status']
    expect(restored.rows).toEqual([{ id: 'r0000001', values: { owner: 'alice' } }]);
    expect(restored.head).toContain('Version one.');
    expect(restored.head).not.toContain('Version two.');

    // And it is still a well-formed table file, not a doc-shaped body that
    // merely happens to contain the old text.
    const reparsed = parseTableFile(await service.readTableMarkdown(meta.id));
    expect(isTableParseError(reparsed)).toBe(false);

    await deleteTestSpace(space.slug);
  });

  /**
   * A revision that isn't a valid table file (e.g. the page was a doc at that
   * sha, or the file was hand-edited into nonsense) must be REFUSED, not
   * half-applied. Silently restoring an empty table over a populated one is
   * exactly the failure mode the spec's "never a silent loss of rows"
   * rule exists to prevent.
   */
  it('restoreTableFromMarkdown refuses a revision that is not a valid table file, leaving the page untouched', async () => {
    const { space, meta } = await makeTable('Restore Guard');
    const before = await storage.readFreshTableDoc(meta.id);
    await storage.writeTableDoc(meta.id, { ...before, rows: [{ id: 'r0000001', values: { owner: 'alice' } }] });

    await expect(service.restoreTableFromMarkdown(meta.id, '# Just a plain doc\n\nno table here\n')).rejects.toThrow(/not a valid data table/i);

    const after = await storage.readFreshTableDoc(meta.id);
    expect(after.rows).toEqual([{ id: 'r0000001', values: { owner: 'alice' } }]); // untouched
    expect(after.columns.map((c) => c.id)).toEqual(['owner']);

    await deleteTestSpace(space.slug);
  });
});
