import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setUpTestSchema } from './db/testSchema.js';
import * as storage from './storage.js';
import * as links from './links.js';
import { query } from './db/pool.js';

describe('links / backlinks (real PG)', () => {
  let teardownSchema: () => Promise<void>;
  let spaceSlug: string;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const space = await storage.createSpace(`Links Test ${Date.now()}`, null);
    spaceSlug = space.slug;
  });

  afterAll(async () => {
    const root = (await storage.listEntries(spaceSlug)).find((e) => e.dirPath === '' && e.isIndex);
    if (root) await storage.deletePage(root.id).catch(() => {});
    await teardownSchema();
  });

  it('a relative markdown link is picked up as a backlink on the target page', async () => {
    const target = await storage.createPage({ space: spaceSlug, parentPath: '', title: 'Target Page', kind: 'doc' });
    const source = await storage.createPage({ space: spaceSlug, parentPath: '', title: 'Source Page', kind: 'doc' });

    await storage.writeDocBody(source.id, `# Source Page\n\nSee [target](./${target.path}) for details.\n`);

    const backlinks = await links.getBacklinks(target.id);
    expect(backlinks.map((b) => b.id)).toContain(source.id);
  });

  it('external and broken links are classified but never appear as page backlinks', async () => {
    const target = await storage.createPage({ space: spaceSlug, parentPath: '', title: 'Another Target', kind: 'doc' });
    const source = await storage.createPage({ space: spaceSlug, parentPath: '', title: 'Mixed Links', kind: 'doc' });

    await storage.writeDocBody(
      source.id,
      `# Mixed Links\n\n` + `[external](https://example.com/x) ` + `[broken](./does-not-exist.md) ` + `[good](./${target.path})\n`,
    );

    const backlinks = await links.getBacklinks(target.id);
    expect(backlinks.map((b) => b.id)).toContain(source.id);

    const rows = await query<{ kind: string; target_page_id: string | null }>('SELECT kind, target_page_id FROM links WHERE source_page_id = $1', [
      source.id,
    ]);
    expect(rows.some((r) => r.kind === 'external')).toBe(true);
    expect(rows.some((r) => r.kind === 'broken')).toBe(true);
    expect(rows.some((r) => r.kind === 'page' && r.target_page_id === target.id)).toBe(true);
  });

  it('delete+reinsert: removing the link from the source body removes the backlink', async () => {
    const target = await storage.createPage({ space: spaceSlug, parentPath: '', title: 'Volatile Target', kind: 'doc' });
    const source = await storage.createPage({ space: spaceSlug, parentPath: '', title: 'Volatile Source', kind: 'doc' });
    await storage.writeDocBody(source.id, `# Volatile Source\n\n[link](./${target.path})\n`);
    expect((await links.getBacklinks(target.id)).map((b) => b.id)).toContain(source.id);

    await storage.writeDocBody(source.id, `# Volatile Source\n\nNo links here anymore.\n`);
    expect((await links.getBacklinks(target.id)).map((b) => b.id)).not.toContain(source.id);
  });

  it('a fresh boot-style scanSpace also (re)indexes links from scratch', async () => {
    const target = await storage.createPage({ space: spaceSlug, parentPath: '', title: 'Scan Target', kind: 'doc' });
    const source = await storage.createPage({ space: spaceSlug, parentPath: '', title: 'Scan Source', kind: 'doc' });
    await storage.writeDocBody(source.id, `# Scan Source\n\n[link](./${target.path})\n`);

    // Simulate a boot rescan wiping and rebuilding the derived index from disk alone.
    await query('DELETE FROM links WHERE source_page_id = $1', [source.id]);
    expect((await links.getBacklinks(target.id)).map((b) => b.id)).not.toContain(source.id);

    await storage.scanSpace(spaceSlug);
    expect((await links.getBacklinks(target.id)).map((b) => b.id)).toContain(source.id);
  });
});

describe('rewriteRelativeLinks (round 22 slug-rename link rewriter, pure — no DB)', () => {
  it('rewrites a same-directory link to a renamed leaf page', () => {
    const body = 'See [target](old-name.md) for details.\n';
    const out = links.rewriteRelativeLinks(body, 'docs', 'docs/old-name.md', 'docs/new-slug.md');
    expect(out).toBe('See [target](new-slug.md) for details.\n');
  });

  it('rewrites a cross-directory link (adds/removes the right number of "..")', () => {
    const body = '[target](../../docs/old-name.md)\n'; // from "guides/deep": up twice to root, then down into docs/
    const out = links.rewriteRelativeLinks(body, 'guides/deep', 'docs/old-name.md', 'docs/new-slug.md');
    expect(out).toBe('[target](../../docs/new-slug.md)\n');
  });

  it('leaves external, root-relative, and non-matching links untouched, and returns the SAME string reference when nothing changed', () => {
    const body = '[ext](https://example.com/old-name.md) [root](/old-name.md) [other](sibling.md)\n';
    const out = links.rewriteRelativeLinks(body, 'docs', 'docs/old-name.md', 'docs/new-slug.md');
    expect(out).toBe(body);
    expect(out).toBe(body); // same content
    expect(Object.is(out, body)).toBe(true); // AND the same reference — a cheap no-op-write guard for callers
  });

  it('preserves an optional "title" suffix and any #fragment/?query', () => {
    const body = '[t](old-name.md "A Title") [f](old-name.md#section) [q](old-name.md?x=1)\n';
    const out = links.rewriteRelativeLinks(body, 'docs', 'docs/old-name.md', 'docs/new-slug.md');
    expect(out).toBe('[t](new-slug.md "A Title") [f](new-slug.md#section) [q](new-slug.md?x=1)\n');
  });

  it('rewrites BOTH an explicit "dir/index.md" link and an implicit bare-directory link to a renamed directory-index, preserving each one\'s own style', () => {
    const body = '[explicit](old-name/index.md) [implicit](old-name) [implicit-slash](old-name/)\n';
    const out = links.rewriteRelativeLinks(body, '', 'old-name/index.md', 'new-slug/index.md');
    expect(out).toBe('[explicit](new-slug/index.md) [implicit](new-slug) [implicit-slash](new-slug/)\n');
  });

  it('an implicit bare-directory link is NOT rewritten when the target\'s index is README.md, not index.md (matches classify()\'s own asymmetric resolution — such a link was never indexed as a backlink in the first place)', () => {
    const body = '[implicit](old-name)\n';
    const out = links.rewriteRelativeLinks(body, '', 'old-name/README.md', 'new-slug/README.md');
    expect(out).toBe(body); // untouched: classify() never resolves a bare "old-name" to a README.md-indexed page either
  });
});
