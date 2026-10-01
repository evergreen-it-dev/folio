/**
 * Round 22: POST /api/pages/:id/slug. storage.renamePageSlug does the
 * mechanical fs-rename + reindex (unit-tested implicitly here through the
 * full flow); collab.renamePageSlug is the orchestration entry point routes.ts
 * actually calls — live-doc-aware backlink rewriting, FTS reindex, one
 * dedicated commit. Exercised directly (no HTTP layer — see routes.test.ts's
 * own doc comment for why this codebase's tests never spin up Fastify).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as Y from 'yjs';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import * as storage from './storage.js';
import * as collab from './collab.js';
import * as links from './links.js';
import * as git from './git.js';

const AUTHOR = { name: 'Tester', email: 't@example.test' };

describe('slug rename (round 22, real git + real PG)', () => {
  let teardownSchema: () => Promise<void>;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });
  afterAll(async () => {
    await teardownSchema();
  });

  it('renames a leaf doc page: file relocates, id is unchanged, and lands as one dedicated commit', async () => {
    const space = await storage.createSpace(`Slug Rename Leaf ${Date.now()}`, null);
    const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'Old Name', kind: 'doc' });
    expect(page.path).toBe('old-name.md');
    const dir = storage.getRepoDir(space.slug);
    const beforeHistory = await git.fileHistory(dir, 'old-name.md');

    const result = await collab.renamePageSlug(page.id, 'new-slug', AUTHOR);
    expect(result.id).toBe(page.id);
    expect(result.path).toBe('new-slug.md');

    expect(await fs.readFile(path.join(dir, 'new-slug.md'), 'utf8')).toContain('# Old Name');
    await expect(fs.access(path.join(dir, 'old-name.md'))).rejects.toThrow();

    const history = await git.fileHistory(dir, 'new-slug.md');
    expect(history.length).toBe(beforeHistory.length + 1);
    expect(history[0].message).toBe('docs: rename old-name.md -> new-slug.md');

    await deleteTestSpace(space.slug);
  });

  it('renames a board (.excalidraw.svg) leaf the same way', async () => {
    const space = await storage.createSpace(`Slug Rename Board ${Date.now()}`, null);
    const board = await storage.createPage({ space: space.slug, parentPath: '', title: 'Old Board', kind: 'board' });
    expect(board.path).toBe('old-board.excalidraw.svg');

    const result = await collab.renamePageSlug(board.id, 'new-board', AUTHOR);
    expect(result.id).toBe(board.id);
    expect(result.path).toBe('new-board.excalidraw.svg');

    await deleteTestSpace(space.slug);
  });

  it('renames a directory-index page: the whole subtree relocates together, every nested page keeps its own id, and the commit message names the primary (index) rename', async () => {
    const space = await storage.createSpace(`Slug Rename Dir ${Date.now()}`, null);
    const dir = storage.getSpaceDir(space.slug);

    await fs.mkdir(path.join(dir, 'old-name', 'sub'), { recursive: true });
    await fs.writeFile(path.join(dir, 'old-name', 'index.md'), '# Old Name Index\n\nBody.\n', 'utf8');
    await fs.writeFile(path.join(dir, 'old-name', 'sibling.md'), '# Sibling\n', 'utf8');
    await fs.writeFile(path.join(dir, 'old-name', 'sub', 'nested.md'), '# Nested\n', 'utf8');
    await storage.scanSpace(space.slug);

    const entries = await storage.listEntries(space.slug);
    const indexEntry = entries.find((e) => e.relPath === 'old-name/index.md')!;
    const siblingEntry = entries.find((e) => e.relPath === 'old-name/sibling.md')!;
    const nestedEntry = entries.find((e) => e.relPath === 'old-name/sub/nested.md')!;
    expect(indexEntry).toBeDefined();
    expect(siblingEntry).toBeDefined();
    expect(nestedEntry).toBeDefined();

    const result = await collab.renamePageSlug(indexEntry.id, 'new-slug', AUTHOR);
    expect(result.id).toBe(indexEntry.id);
    expect(result.path).toBe('new-slug/index.md');

    const afterEntries = await storage.listEntries(space.slug);
    expect(afterEntries.find((e) => e.id === siblingEntry.id)?.relPath).toBe('new-slug/sibling.md');
    expect(afterEntries.find((e) => e.id === nestedEntry.id)?.relPath).toBe('new-slug/sub/nested.md');

    await expect(fs.access(path.join(dir, 'old-name'))).rejects.toThrow();
    const history = await git.fileHistory(storage.getRepoDir(space.slug), 'new-slug/index.md');
    expect(history[0].message).toBe('docs: rename old-name/index.md -> new-slug/index.md');

    await deleteTestSpace(space.slug);
  });

  it('rewrites an incoming RELATIVE link after a leaf rename, reindexes FTS/links for the source page, and preserves the backlink relationship by id', async () => {
    const space = await storage.createSpace(`Slug Rename Relink ${Date.now()}`, null);
    const target = await storage.createPage({ space: space.slug, parentPath: 'docs', title: 'Old Name', kind: 'doc' });
    expect(target.path).toBe('docs/old-name.md');
    const source = await storage.createPage({ space: space.slug, parentPath: '', title: 'Source Page', kind: 'doc' });
    await storage.writeDocBody(source.id, `# Source Page\n\nSee [target](./${target.path}) for details.\n`);

    const result = await collab.renamePageSlug(target.id, 'new-slug', AUTHOR);
    expect(result.path).toBe('docs/new-slug.md');

    const updatedSourceBody = await storage.readFreshDocBody(source.id);
    expect(updatedSourceBody).toContain('(docs/new-slug.md)');
    expect(updatedSourceBody).not.toContain('old-name.md');

    // Same id, so the backlink relationship (keyed by id, not path) survives untouched.
    const backlinks = await links.getBacklinks(target.id);
    expect(backlinks.map((b) => b.id)).toContain(source.id);

    await deleteTestSpace(space.slug);
  });

  it('rewrites an incoming link written via the implicit bare-directory style ("[[..]]"-picked links are the same relative markdown link on disk — see links.rewriteRelativeLinks)', async () => {
    const space = await storage.createSpace(`Slug Rename Implicit ${Date.now()}`, null);
    const dir = storage.getSpaceDir(space.slug);
    await fs.mkdir(path.join(dir, 'old-name'), { recursive: true });
    await fs.writeFile(path.join(dir, 'old-name', 'index.md'), '# Old Name Index\n\nBody.\n', 'utf8');
    await storage.scanSpace(space.slug);
    const target = (await storage.listEntries(space.slug)).find((e) => e.relPath === 'old-name/index.md')!;

    const source = await storage.createPage({ space: space.slug, parentPath: '', title: 'Implicit Source', kind: 'doc' });
    await storage.writeDocBody(source.id, `# Implicit Source\n\n[pick](old-name)\n`);

    await collab.renamePageSlug(target.id, 'new-slug', AUTHOR);

    const updatedSourceBody = await storage.readFreshDocBody(source.id);
    expect(updatedSourceBody).toContain('[pick](new-slug)');

    await deleteTestSpace(space.slug);
  });

  it('rewrites an incoming link on a LIVE source page without breaking its session, flushing the fix to disk immediately (not waiting on the debounce)', async () => {
    const space = await storage.createSpace(`Slug Rename Live ${Date.now()}`, null);
    // Title translit-slugs to a single-char filename ("x.md") on purpose: the rewritten
    // href (to the much longer new slug below) is then strictly LONGER than the original,
    // so persistDoc's round-8 "SEATBELT" (refuses to shrink an unconfirmed-seeded doc's
    // on-disk content — see its own doc comment) can't trip here on account of THIS
    // test's simplified live-doc setup (bindState directly, not through the real
    // ensureDocSeeded lifecycle a genuine WS connection always completes before any other
    // code could observe isDocLive()===true — this test isn't replicating that timing, so
    // isDocSeeded() is (harmlessly, for a body that only ever GROWS) false throughout).
    const target = await storage.createPage({ space: space.slug, parentPath: '', title: 'X', kind: 'doc' });
    expect(target.path).toBe('x.md');
    const source = await storage.createPage({ space: space.slug, parentPath: '', title: 'Live Source', kind: 'doc' });
    const bodyText = `# Live Source\n\n[target](./${target.path})\n`;
    await storage.writeDocBody(source.id, bodyText);

    const { createRequire } = await import('node:module');
    const nodeRequire = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ywsUtils = nodeRequire('y-websocket/bin/utils') as { docs: Map<string, import('yjs').Doc> };
    const ydoc = new Y.Doc();
    ydoc.getText('content').insert(0, bodyText);
    ywsUtils.docs.set(source.id, ydoc);
    // bindState (not just stuffing the doc into `docs`) is what actually registers the
    // debounced writer + 'update' listener a real live session would have — needed here
    // so flushDoc has a real writer to flush; content is already seeded (ytext.length > 0)
    // so bindState's own seed-from-file/snapshot branches are both no-ops, same as the
    // "THE DOUBLING fix" tests in gitNative.test.ts rely on elsewhere.
    await collab.bindState(source.id, ydoc);

    try {
      expect(collab.isDocLive(source.id)).toBe(true);
      await collab.renamePageSlug(target.id, 'renamed-target', AUTHOR);

      // The live Y.Doc's own text was fixed up (never bypassed/desynced from the file).
      expect(ydoc.getText('content').toString()).toContain('renamed-target.md');
      expect(collab.getLiveText(source.id)).toContain('renamed-target.md');

      // AND the file on disk already reflects it — flushed immediately by renamePageSlug,
      // not left to race the normal ~800ms debounce, so the dedicated commit captures it.
      const onDisk = await storage.readFreshDocBody(source.id);
      expect(onDisk).toContain('renamed-target.md');
    } finally {
      ywsUtils.docs.delete(source.id);
    }

    await deleteTestSpace(space.slug);
  });

  it('409s when a page already exists with the requested slug at that location', async () => {
    const space = await storage.createSpace(`Slug Rename Conflict ${Date.now()}`, null);
    const a = await storage.createPage({ space: space.slug, parentPath: '', title: 'Page A', kind: 'doc' });
    await storage.createPage({ space: space.slug, parentPath: '', title: 'Page B', kind: 'doc' }); // -> page-b.md

    await expect(collab.renamePageSlug(a.id, 'page-b', AUTHOR)).rejects.toMatchObject({ status: 409 });

    await deleteTestSpace(space.slug);
  });

  it('400s on an invalid slug (uppercase, symbols, leading dash, too long) — nothing on disk moves', async () => {
    const space = await storage.createSpace(`Slug Rename Invalid ${Date.now()}`, null);
    const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'Valid Page', kind: 'doc' });

    for (const bad of ['Invalid-Slug', 'has spaces', '-leading-dash', 'trailing_underscore!', 'a'.repeat(65), '']) {
      await expect(collab.renamePageSlug(page.id, bad, AUTHOR)).rejects.toMatchObject({ status: 400 });
    }
    // untouched: still at its original path.
    expect((await storage.requireEntry(page.id)).relPath).toBe('valid-page.md');

    await deleteTestSpace(space.slug);
  });

  it('400s when trying to change the slug of the space root', async () => {
    const space = await storage.createSpace(`Slug Rename Root Guard ${Date.now()}`, null);
    const root = (await storage.listEntries(space.slug)).find((e) => e.dirPath === '' && e.isIndex)!;

    await expect(collab.renamePageSlug(root.id, 'new-root-slug', AUTHOR)).rejects.toMatchObject({ status: 400 });

    await deleteTestSpace(space.slug);
  });

  it('renaming to the CURRENT slug is a no-op success (no error, no new commit)', async () => {
    const space = await storage.createSpace(`Slug Rename Noop ${Date.now()}`, null);
    const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'Same Slug', kind: 'doc' });
    expect(page.path).toBe('same-slug.md');
    const dir = storage.getRepoDir(space.slug);
    const before = await git.fileHistory(dir, 'same-slug.md');

    const result = await collab.renamePageSlug(page.id, 'same-slug', AUTHOR);
    expect(result.path).toBe('same-slug.md');

    const after = await git.fileHistory(dir, 'same-slug.md');
    expect(after.length).toBe(before.length); // no new commit was made

    await deleteTestSpace(space.slug);
  });

  it('never changes the page id in frontmatter', async () => {
    const space = await storage.createSpace(`Slug Rename Keep Id ${Date.now()}`, null);
    const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'Keep Id', kind: 'doc' });

    const result = await collab.renamePageSlug(page.id, 'renamed-keep-id', AUTHOR);
    expect(result.id).toBe(page.id);

    const raw = await fs.readFile(path.join(storage.getSpaceDir(space.slug), 'renamed-keep-id.md'), 'utf8');
    expect(raw).toContain(`id: ${page.id}`);

    await deleteTestSpace(space.slug);
  });
});
