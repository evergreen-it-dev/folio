import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import * as storage from './storage.js';
import * as authStore from './auth/store.js';
import * as session from './auth/session.js';
import { clampSubtreeDepth, extractH1, replaceFirstH1, type SubtreeNode } from './storage.js';
import type { FastifyRequest } from 'fastify';
import { parseTableFile, isTableParseError } from '../shared/tables/index.js';
import type { TableColumn, TableDoc } from '../shared/contracts.js';

describe('extractH1', () => {
  it('extracts a simple H1', () => {
    expect(extractH1('# Hello\n\nBody')).toBe('Hello');
  });

  it('returns null when there is no H1', () => {
    expect(extractH1('## Not an H1\n\nBody')).toBeNull();
  });

  it('strips ATX closing hashes', () => {
    expect(extractH1('# Hello #\n')).toBe('Hello');
  });

  it('ignores a "#" line inside a fenced code block', () => {
    const body = '```bash\n# not a heading\n```\n\n# Real Title\n';
    expect(extractH1(body)).toBe('Real Title');
  });

  it('picks the first H1 when there are several', () => {
    expect(extractH1('# First\n\n# Second\n')).toBe('First');
  });
});

describe('copyPage', () => {
  let teardownSchema: () => Promise<void>;
  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });
  afterAll(async () => {
    await teardownSchema();
  });

  it('copies the current document body across spaces under a page and mints a fresh id', async () => {
    const sourceSpace = await storage.createSpace(`Copy Source ${Date.now()}`, null);
    const targetSpace = await storage.createSpace(`Copy Target ${Date.now()}`, null);
    try {
      const source = await storage.createPage({ space: sourceSpace.slug, parentPath: '', title: 'Original', kind: 'doc' });
      const copied = await storage.copyPage(source.id, targetSpace.slug, 'parent', '# Original\n\nLive text\n');

      expect(copied).toMatchObject({ space: targetSpace.slug, path: 'parent/original.md', title: 'Original', kind: 'doc' });
      expect(copied.id).not.toBe(source.id);
      expect(await storage.readFreshDocBody(copied.id)).toContain('Live text');
      expect((await storage.requireEntry(source.id)).space).toBe(sourceSpace.slug);
    } finally {
      await deleteTestSpace(sourceSpace.slug);
      await deleteTestSpace(targetSpace.slug);
    }
  });

  it('copies boards and tables without reusing their embedded ids', async () => {
    const sourceSpace = await storage.createSpace(`Copy Rich Source ${Date.now()}`, null);
    const targetSpace = await storage.createSpace(`Copy Rich Target ${Date.now()}`, null);
    try {
      const board = await storage.createPage({ space: sourceSpace.slug, parentPath: '', title: 'Board', kind: 'board' });
      const boardScene = '<svg xmlns="http://www.w3.org/2000/svg"><text>COPIED-SCENE</text></svg>\n';
      await storage.writeBoardSvg(board.id, boardScene);
      const boardCopy = await storage.copyPage(board.id, targetSpace.slug, '', undefined);
      expect(boardCopy.id).not.toBe(board.id);
      expect(await storage.readBoardSvg(boardCopy.id)).toContain('COPIED-SCENE');

      const table = await storage.createPage({ space: sourceSpace.slug, parentPath: '', title: 'Table', kind: 'table' });
      const tableRaw = await (await import('node:fs/promises')).readFile((await storage.requireEntry(table.id)).absPath, 'utf8');
      const tableCopy = await storage.copyPage(table.id, targetSpace.slug, '', tableRaw);
      expect(tableCopy.id).not.toBe(table.id);
      expect((await storage.readFreshTableDoc(tableCopy.id)).meta.id).toBe(tableCopy.id);
    } finally {
      await deleteTestSpace(sourceSpace.slug);
      await deleteTestSpace(targetSpace.slug);
    }
  });

  it('includeChildren copies a directory-index page\'s whole subtree with fresh ids; includeChildren=false copies only the root', async () => {
    const fsp = await import('node:fs/promises');
    const path = await import('node:path');
    const sourceSpace = await storage.createSpace(`Copy Subtree Source ${Date.now()}`, null);
    const targetSpace = await storage.createSpace(`Copy Subtree Target ${Date.now()}`, null);
    try {
      const guideDir = path.join(storage.REPOS_DIR, sourceSpace.slug, 'guide');
      await fsp.mkdir(guideDir, { recursive: true });
      await fsp.writeFile(path.join(guideDir, 'index.md'), '# Guide\n', 'utf8');
      await fsp.writeFile(path.join(guideDir, 'one.md'), '---\norder: 10\n---\n\n# One\n', 'utf8');
      await fsp.writeFile(path.join(guideDir, 'two.md'), '---\norder: 20\n---\n\n# Two\n', 'utf8');
      await storage.scanSpace(sourceSpace.slug);

      const entries = await storage.listEntries(sourceSpace.slug);
      const guide = entries.find((e) => e.relPath === 'guide/index.md')!;
      const one = entries.find((e) => e.relPath === 'guide/one.md')!;
      const two = entries.find((e) => e.relPath === 'guide/two.md')!;

      const withChildren = await storage.copyPage(guide.id, targetSpace.slug, '', undefined, true);
      expect(withChildren.id).not.toBe(guide.id);
      const copiedChildren = await storage.getSubtree(await storage.requireEntry(withChildren.id), 2);
      expect(copiedChildren.map((c) => c.title)).toEqual(['One', 'Two']);
      const copiedChildIds = copiedChildren.map((c) => c.id);
      expect(copiedChildIds).not.toContain(one.id);
      expect(copiedChildIds).not.toContain(two.id);
      expect(new Set(copiedChildIds).size).toBe(2); // both children got their own fresh id, not each other's

      // A different parent path than the includeChildren copy above — 'guide'
      // now already exists as a directory at the target space root, and this
      // second copy's own stem would collide with it (same title -> same
      // translitSlug), which is not what this assertion means to test.
      const withoutChildren = await storage.copyPage(guide.id, targetSpace.slug, 'solo', undefined, false);
      expect(withoutChildren.id).not.toBe(guide.id);
      expect(withoutChildren.id).not.toBe(withChildren.id);
      expect(await storage.getSubtree(await storage.requireEntry(withoutChildren.id), 2)).toEqual([]);
    } finally {
      await deleteTestSpace(sourceSpace.slug);
      await deleteTestSpace(targetSpace.slug);
    }
  });
});

// The owner, 01.10.2026: "Duplicate" in the page menu — the page copied next
// to itself, with its whole tree if it has one.
describe('duplicatePage', () => {
  let teardownSchema: () => Promise<void>;
  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });
  afterAll(async () => {
    await teardownSchema();
  });

  it('copies a page with a children directory next to itself: fresh ids, the whole tree, the new title on the root only', async () => {
    const space = await storage.createSpace(`Duplicate Leaf ${Date.now()}`, null);
    try {
      const fsp = await import('node:fs/promises');
      const path = await import('node:path');
      const root = (await storage.requireEntry((await storage.createPage({ space: space.slug, parentPath: '', title: 'Seed', kind: 'doc' })).id)).absPath;
      const loops = path.join(path.dirname(root), 'loops');
      await fsp.mkdir(path.join(loops, 'fastline', 'deep'), { recursive: true });
      await fsp.writeFile(path.join(loops, 'fastline.md'), '# Fastline\n\nBody\n', 'utf8');
      await fsp.writeFile(path.join(loops, 'fastline', 'one.md'), '# One\n', 'utf8');
      await fsp.writeFile(path.join(loops, 'fastline', 'deep', 'two.md'), '# Two\n', 'utf8');
      await storage.scanSpace(space.slug);
      const source = (await storage.listEntries(space.slug)).find((e) => e.relPath === 'loops/fastline.md')!;

      const copy = await storage.duplicatePage(source.id, undefined, 'Fastline (copy)');

      expect(copy.id).not.toBe(source.id);
      expect(copy.title).toBe('Fastline (copy)');
      // Same directory as the original, under a name of its own.
      expect(copy.path.startsWith('loops/')).toBe(true);
      expect(copy.path).not.toBe('loops/fastline.md');
      expect(await storage.readFreshDocBody(copy.id)).toContain('# Fastline (copy)');
      expect(await storage.readFreshDocBody(copy.id)).toContain('Body');

      const flatten = (nodes: SubtreeNode[]): SubtreeNode[] => nodes.flatMap((n) => [n, ...flatten(n.children)]);
      const original = flatten(await storage.getSubtree(await storage.requireEntry(source.id), 5));
      const copied = flatten(await storage.getSubtree(await storage.requireEntry(copy.id), 5));
      expect(copied.map((n) => n.title).sort()).toEqual(['One', 'Two']);
      for (const node of copied) expect(original.map((n) => n.id)).not.toContain(node.id);
      // The original is exactly as it was.
      expect(original.map((n) => n.title).sort()).toEqual(['One', 'Two']);
      expect((await storage.requireEntry(source.id)).title).toBe('Fastline');
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it('copies a directory-index page into the directory ABOVE its own, and a board keeps its scene and its child', async () => {
    const space = await storage.createSpace(`Duplicate Index ${Date.now()}`, null);
    try {
      const fsp = await import('node:fs/promises');
      const path = await import('node:path');
      const root = (await storage.requireEntry((await storage.createPage({ space: space.slug, parentPath: '', title: 'Seed', kind: 'doc' })).id)).absPath;
      const guide = path.join(path.dirname(root), 'docs', 'guide');
      await fsp.mkdir(guide, { recursive: true });
      await fsp.writeFile(path.join(guide, 'index.md'), '# Guide\n', 'utf8');
      await fsp.writeFile(path.join(guide, 'one.md'), '# One\n', 'utf8');
      await storage.scanSpace(space.slug);
      const index = (await storage.listEntries(space.slug)).find((e) => e.relPath === 'docs/guide/index.md')!;

      const copy = await storage.duplicatePage(index.id, undefined, 'Guide (copy)');
      expect(copy.title).toBe('Guide (copy)');
      // A sibling of `docs/guide/`, not something nested inside it.
      expect(copy.path.startsWith('docs/')).toBe(true);
      expect(copy.path.startsWith('docs/guide/')).toBe(false);
      expect((await storage.getSubtree(await storage.requireEntry(copy.id), 2)).map((n) => n.title)).toEqual(['One']);

      const board = await storage.createPage({ space: space.slug, parentPath: 'docs', title: 'Board', kind: 'board' });
      await storage.writeBoardSvg(board.id, '<svg xmlns="http://www.w3.org/2000/svg"><text>SCENE</text></svg>\n');
      await storage.createPage({ space: space.slug, parentPath: 'docs/board', title: 'How it works', kind: 'doc' });
      const boardCopy = await storage.duplicatePage(board.id, undefined, 'Board (copy)');
      expect(boardCopy).toMatchObject({ kind: 'board', title: 'Board (copy)' });
      expect(await storage.readBoardSvg(boardCopy.id)).toContain('SCENE');
      expect((await storage.getSubtree(await storage.requireEntry(boardCopy.id), 2)).map((n) => n.title)).toEqual(['How it works']);
      expect((await storage.requireEntry(board.id)).title).toBe('Board');
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it('refuses the space root — there is no "next to it"', async () => {
    const space = await storage.createSpace(`Duplicate Root ${Date.now()}`, null);
    try {
      const fsp = await import('node:fs/promises');
      const path = await import('node:path');
      const seed = await storage.requireEntry((await storage.createPage({ space: space.slug, parentPath: '', title: 'Seed', kind: 'doc' })).id);
      await fsp.writeFile(path.join(path.dirname(seed.absPath), 'index.md'), '# Home\n', 'utf8');
      await storage.scanSpace(space.slug);
      const rootEntry = (await storage.listEntries(space.slug)).find((e) => e.isIndex && e.dirPath === '')!;
      expect(rootEntry).toBeTruthy();
      await expect(storage.duplicatePage(rootEntry.id)).rejects.toThrow(/space root/);
      // An ordinary page at the top level duplicates fine.
      expect((await storage.duplicatePage(seed.id, undefined, 'Seed (copy)')).title).toBe('Seed (copy)');
    } finally {
      await deleteTestSpace(space.slug);
    }
  });
});

describe('replaceFirstH1', () => {
  it('replaces an existing H1 in place', () => {
    expect(replaceFirstH1('# Old\n\nBody text.\n', 'New')).toBe('# New\n\nBody text.\n');
  });

  it('prepends an H1 when none exists', () => {
    expect(replaceFirstH1('Just a paragraph.\n', 'Title')).toBe('# Title\n\nJust a paragraph.\n');
  });
});

describe('clampSubtreeDepth (1..5, default 2 — matches the directive\'s own parsePagetreeDepth on the client)', () => {
  it('defaults to 2 for a missing/blank/garbage value', () => {
    expect(clampSubtreeDepth(undefined)).toBe(2);
    expect(clampSubtreeDepth(null)).toBe(2);
    expect(clampSubtreeDepth('')).toBe(2); // queryString() returns '' for an absent param
    expect(clampSubtreeDepth('deep')).toBe(2);
  });

  it('clamps out-of-range values instead of honouring them', () => {
    expect(clampSubtreeDepth('0')).toBe(1);
    expect(clampSubtreeDepth('-7')).toBe(1);
    expect(clampSubtreeDepth('99')).toBe(5);
    expect(clampSubtreeDepth(1000)).toBe(5);
  });

  it('passes an in-range value through', () => {
    expect(clampSubtreeDepth('1')).toBe(1);
    expect(clampSubtreeDepth('3')).toBe(3);
    expect(clampSubtreeDepth(5)).toBe(5);
  });
});

/**
 * PROD BUG (round 25): `::pagetree` reported "no child pages" everywhere,
 * because GET /api/pages/:id/subtree — which its renderer has fetched since
 * round 13 — was never implemented on the server, and the client degrades any
 * failure (404 included) into the same empty state. These cover the resolver
 * behind the new route, including the page shape getTree does NOT model: a
 * plain `X.md` whose children live in a sibling `X/` directory.
 */
describe('getSubtree (real fs + real PG)', () => {
  let teardownSchema: () => Promise<void>;
  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });
  afterAll(async () => {
    await teardownSchema();
  });

  /** Writes a whole layout of markdown files, then indexes it in one scan. */
  async function makeSpace(name: string, files: Record<string, string>): Promise<string> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const space = await storage.createSpace(`${name} ${Date.now()}`, null);
    for (const [rel, body] of Object.entries(files)) {
      const abs = path.join(storage.REPOS_DIR, space.slug, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      // createSpace already wrote (and indexed) its own placeholder index.md.
      // Overwriting that path without carrying its id forward makes scanSpace
      // mint a fresh one, which then violates pages_index's (space_slug, path)
      // unique constraint — the same trap getEntryIdByExactPath exists for.
      const existingId = await storage.getEntryIdByExactPath(space.slug, rel);
      if (existingId && body.startsWith('---')) throw new Error(`fixture ${rel} would need its frontmatter merged with the existing id`);
      await fs.writeFile(abs, existingId ? `---\nid: ${existingId}\n---\n\n${body}` : body, 'utf8');
    }
    await storage.scanSpace(space.slug);
    return space.slug;
  }

  async function entryAt(space: string, relPath: string) {
    const entry = (await storage.listEntries(space)).find((e) => e.relPath === relPath);
    if (!entry) throw new Error(`no indexed entry at ${relPath}`);
    return entry;
  }

  const titles = (nodes: SubtreeNode[]): string[] => nodes.map((n) => n.title);

  describe('form (a): the page is a directory index (index.md / README.md) — getTree\'s own model, scoped', () => {
    it('lists the directory\'s other entries, recursing into subdirectories', async () => {
      const slug = await makeSpace('Subtree Index Form', {
        'guide/index.md': '# Guide\n',
        'guide/one.md': '---\norder: 10\n---\n\n# One\n',
        'guide/two.md': '---\norder: 20\n---\n\n# Two\n',
        'guide/deep/index.md': '---\norder: 30\n---\n\n# Deep\n',
        'guide/deep/leaf.md': '# Leaf\n',
      });
      try {
        const guide = await entryAt(slug, 'guide/index.md');
        const children = await storage.getSubtree(guide, 2);
        expect(titles(children)).toEqual(['One', 'Two', 'Deep']); // frontmatter order, not alphabetical
        expect(titles(children[2].children)).toEqual(['Leaf']);
        // the index page never lists ITSELF as one of its own children
        expect(children.some((c) => c.id === guide.id)).toBe(false);
        // shape the client depends on
        expect(children[0]).toMatchObject({ space: slug, path: 'guide/one.md', title: 'One', children: [] });
        expect(typeof children[0].id).toBe('string');
      } finally {
        await deleteTestSpace(slug);
      }
    });

    it('README.md acts as the index when there is no index.md', async () => {
      const slug = await makeSpace('Subtree Readme Form', {
        'notes/README.md': '# Notes\n',
        'notes/first.md': '# First\n',
      });
      try {
        const readme = await entryAt(slug, 'notes/README.md');
        expect(titles(await storage.getSubtree(readme, 2))).toEqual(['First']);
      } finally {
        await deleteTestSpace(slug);
      }
    });
  });

  describe('form (b): the page is a plain X.md with a sibling X/ directory (what getTree draws as siblings)', () => {
    it('THE BUG: a leaf page with a same-named directory now reports that directory\'s contents as its children', async () => {
      const slug = await makeSpace('Subtree Sibling Dir', {
        'overview.md': '# Overview\n',
        'overview/alpha.md': '---\norder: 10\n---\n\n# Alpha\n',
        'overview/beta.md': '---\norder: 20\n---\n\n# Beta\n',
        'overview/gamma/index.md': '---\norder: 30\n---\n\n# Gamma\n',
        'overview/gamma/inner.md': '# Inner\n',
      });
      try {
        const overview = await entryAt(slug, 'overview.md');
        const children = await storage.getSubtree(overview, 2);
        expect(titles(children)).toEqual(['Alpha', 'Beta', 'Gamma']);
        expect(titles(children[2].children)).toEqual(['Inner']);
      } finally {
        await deleteTestSpace(slug);
      }
    });

    it('the claimed directory is not ALSO listed as a sibling of the file that owns it', async () => {
      const slug = await makeSpace('Subtree No Dup', {
        'index.md': '# Root\n',
        'overview.md': '# Overview\n',
        'overview/alpha.md': '# Alpha\n',
      });
      try {
        const root = await entryAt(slug, 'index.md');
        const children = await storage.getSubtree(root, 3);
        expect(titles(children)).toEqual(['Overview']); // exactly once, not "Overview" + a folder node
        expect(titles(children[0].children)).toEqual(['Alpha']);
      } finally {
        await deleteTestSpace(slug);
      }
    });

    it('a plain leaf with no same-named directory has no children (not an error, just empty)', async () => {
      const slug = await makeSpace('Subtree Plain Leaf', {
        'index.md': '# Root\n',
        'lonely.md': '# Lonely\n',
      });
      try {
        const lonely = await entryAt(slug, 'lonely.md');
        expect(await storage.getSubtree(lonely, 5)).toEqual([]);
      } finally {
        await deleteTestSpace(slug);
      }
    });

    it('works for a board file too (X.excalidraw.svg next to X/), not just markdown', async () => {
      const slug = await makeSpace('Subtree Board Parent', {
        'index.md': '# Root\n',
        'diagram.excalidraw.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>\n',
        'diagram/note.md': '# Note\n',
      });
      try {
        const board = await entryAt(slug, 'diagram.excalidraw.svg');
        expect(titles(await storage.getSubtree(board, 2))).toEqual(['Note']);
      } finally {
        await deleteTestSpace(slug);
      }
    });
  });

  describe('depth', () => {
    it('depth=1 returns direct children only, with empty children arrays', async () => {
      const slug = await makeSpace('Subtree Depth One', {
        'index.md': '# Root\n',
        'a/index.md': '# A\n',
        'a/b/index.md': '# B\n',
        'a/b/c.md': '# C\n',
      });
      try {
        const root = await entryAt(slug, 'index.md');
        const one = await storage.getSubtree(root, 1);
        expect(titles(one)).toEqual(['A']);
        expect(one[0].children).toEqual([]);

        const two = await storage.getSubtree(root, 2);
        expect(titles(two[0].children)).toEqual(['B']);
        expect(two[0].children[0].children).toEqual([]);

        const three = await storage.getSubtree(root, 3);
        expect(titles(three[0].children[0].children)).toEqual(['C']);
      } finally {
        await deleteTestSpace(slug);
      }
    });

    it('a clamped depth really does stop the walk (?depth=99 -> 5 levels, not the whole space)', async () => {
      const files: Record<string, string> = { 'index.md': '# Root\n' };
      let dir = '';
      for (let level = 1; level <= 8; level++) {
        dir = dir ? `${dir}/l${level}` : `l${level}`;
        files[`${dir}/index.md`] = `# L${level}\n`;
      }
      const slug = await makeSpace('Subtree Deep Chain', files);
      try {
        const root = await entryAt(slug, 'index.md');
        let node = (await storage.getSubtree(root, clampSubtreeDepth('99')))[0];
        let levels = 1;
        while (node.children.length > 0) {
          node = node.children[0];
          levels++;
        }
        expect(levels).toBe(5);
      } finally {
        await deleteTestSpace(slug);
      }
    });
  });

  it('a directory with no page of its own is transparent — its pages are hoisted, never a non-navigable dir: node', async () => {
    const slug = await makeSpace('Subtree Transparent Dir', {
      'index.md': '# Root\n',
      'loose/x.md': '---\norder: 10\n---\n\n# X\n',
      'loose/y.md': '---\norder: 20\n---\n\n# Y\n',
    });
    try {
      const root = await entryAt(slug, 'index.md');
      const children = await storage.getSubtree(root, 2);
      expect(titles(children)).toEqual(['X', 'Y']);
      // every node must be a real page the client can link to at /s/:space/p/:id
      for (const node of children) expect(node.id.startsWith('dir:')).toBe(false);
    } finally {
      await deleteTestSpace(slug);
    }
  });

  it('carries a page icon through, and leaves it off when there is none', async () => {
    const slug = await makeSpace('Subtree Icons', {
      'index.md': '# Root\n',
      'with-icon.md': '---\nicon: "🚀"\n---\n\n# With Icon\n',
      'no-icon.md': '# No Icon\n',
    });
    try {
      const root = await entryAt(slug, 'index.md');
      const byTitle = new Map((await storage.getSubtree(root, 1)).map((n) => [n.title, n]));
      expect(byTitle.get('With Icon')!.icon).toBe('🚀');
      expect('icon' in byTitle.get('No Icon')!).toBe(false);
    } finally {
      await deleteTestSpace(slug);
    }
  });

  it('excludes _templates/ from the subtree, same as getTree does', async () => {
    const slug = await makeSpace('Subtree Templates', {
      'index.md': '# Root\n',
      'real.md': '# Real\n',
      '_templates/meeting.md': '# Meeting Template\n',
    });
    try {
      const root = await entryAt(slug, 'index.md');
      expect(titles(await storage.getSubtree(root, 3))).toEqual(['Real']);
    } finally {
      await deleteTestSpace(slug);
    }
  });

  it('is viewer-gated: a user with no membership in the page\'s space is refused (403), a member is not', async () => {
    const slug = await makeSpace('Subtree Perms', { 'index.md': '# Root\n', 'child.md': '# Child\n' });
    try {
      const stamp = Date.now();
      const member = await authStore.createUser({ email: `subtree-member-${stamp}@test.local`, name: 'Member', passwordHash: 'x', isAdmin: false });
      const outsider = await authStore.createUser({ email: `subtree-outsider-${stamp}@test.local`, name: 'Outsider', passwordHash: 'x', isAdmin: false });
      await authStore.setMembership(slug, member.id, 'viewer');

      const root = await entryAt(slug, 'index.md');
      const asRequest = (user: unknown) => ({ authUser: user }) as unknown as FastifyRequest;

      await expect(session.requirePageRole(asRequest(outsider), root.id, 'viewer')).rejects.toMatchObject({ status: 403 });
      await expect(session.requirePageRole(asRequest(member), root.id, 'viewer')).resolves.toMatchObject({ id: root.id });
    } finally {
      await deleteTestSpace(slug);
    }
  });
});

describe('storage integration (real fs under a throwaway data/spaces/<temp> dir, real PG under an isolated per-run schema)', () => {
  let teardownSchema: () => Promise<void>;
  // Each test below calls deleteTestSpace(spaceSlug) itself at its own end (both the
  // DB row and the directory) — teardownSchema()'s DROP SCHEMA CASCADE is the real
  // backstop regardless, so no additional per-suite fallback cleanup is needed here.
  let spaceSlug = '';

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });

  afterAll(async () => {
    await teardownSchema();
  });

  it('creates a space, creates pages, builds a tree, and resolves relative links', async () => {
    const space = await storage.createSpace(`Vitest Temp ${Date.now()}`, null);
    spaceSlug = space.slug;

    const doc = await storage.createPage({ space: spaceSlug, parentPath: '', title: 'Alpha Page', kind: 'doc' });
    expect(doc.title).toBe('Alpha Page');
    expect(doc.path).toBe('alpha-page.md');

    // Round 2: board FILENAMES go through translitSlug() too, same as docs. The
    // displayed title, though, is the one the caller gave: QA-3 found creation
    // writing only `folio-id`, so the name fell back to the file name and a board
    // called "New board" showed up as "new-board". The header carries the
    // title now, exactly as setBoardTitle has always written it.
    const board = await storage.createPage({ space: spaceSlug, parentPath: '', title: 'New board', kind: 'board' });
    expect(board.kind).toBe('board');
    expect(board.path).toBe('new-board.excalidraw.svg');
    expect(board.title).toBe('New board');

    const tree = await storage.getTree(spaceSlug);
    expect(tree).toHaveLength(1);
    expect(tree[0].path).toBe('index.md');
    expect(tree[0].children.map((c) => c.path).sort()).toEqual(['alpha-page.md', 'new-board.excalidraw.svg']);

    const resolved = await storage.resolve(spaceSlug, './alpha-page.md');
    expect(resolved.id).toBe(doc.id);

    // a link that tries to escape the space root must be rejected, not resolved elsewhere
    await expect(storage.resolve(spaceSlug, '../../etc/passwd')).rejects.toThrow();

    // Deleting just the root page would leave alpha-page.md/the board file/.git behind
    // on the REAL (not schema-isolated) disk — a directory registerReposOnBoot() would
    // then auto-register as a live space on the next server boot. Remove the whole thing.
    const fs = await import('node:fs/promises');
    await deleteTestSpace(spaceSlug);
  });

  it('assigns a missing id and writes it back to disk on rescan', async () => {
    const space = await storage.createSpace(`Vitest Backfill ${Date.now()}`, null);
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const noIdPath = path.join(storage.REPOS_DIR, space.slug, 'no-id.md');
    await fs.writeFile(noIdPath, '# No Id Yet\n\nBody.\n', 'utf8');

    await storage.scanSpace(space.slug);
    const entry = (await storage.listEntries(space.slug)).find((e) => e.relPath === 'no-id.md');
    expect(entry).toBeDefined();
    expect(entry!.id).toMatch(/^[0-9A-Z]{26}$/);

    const raw = await fs.readFile(noIdPath, 'utf8');
    expect(raw).toContain(`id: ${entry!.id}`);

    await deleteTestSpace(space.slug);
  });

  it('a rewrite keeps only Folio\'s own front matter keys (id, order, status, icon, cover) — a documented limitation', async () => {
    const space = await storage.createSpace(`Vitest Extra Keys ${Date.now()}`, null);
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const file = path.join(storage.REPOS_DIR, space.slug, 'hand-written.md');

    // No id yet: the scan that assigns one already rewrites the block.
    await fs.writeFile(file, '---\ntitle: Hand written\ntags:\n  - alpha\nstatus: draft\n---\n# Hand Written\n', 'utf8');
    await storage.scanSpace(space.slug);
    const entry = (await storage.listEntries(space.slug)).find((e) => e.relPath === 'hand-written.md');
    expect(entry).toBeDefined();
    let raw = await fs.readFile(file, 'utf8');
    expect(raw).toContain(`id: ${entry!.id}`);
    expect(raw).toContain('status: draft');
    expect(raw).not.toContain('title: Hand written');
    expect(raw).not.toContain('tags:');

    // With an id: an ordinary body write does the same.
    await fs.writeFile(file, `---\nid: ${entry!.id}\nauthor: Jane\n---\n# Hand Written\n`, 'utf8');
    await storage.scanSpace(space.slug);
    await storage.writeDocBody(entry!.id, '# Hand Written\n\nEdited.\n');
    raw = await fs.readFile(file, 'utf8');
    expect(raw).toContain('Edited.');
    expect(raw).not.toContain('author: Jane');

    await deleteTestSpace(space.slug);
  });

  it('a board with no explicit order serializes order:0 in PageMeta, not the internal MAX_SAFE_INTEGER sentinel', async () => {
    const space = await storage.createSpace(`Vitest Order ${Date.now()}`, null);
    spaceSlug = space.slug;
    const board = await storage.createPage({ space: spaceSlug, parentPath: '', title: 'Ordered Board', kind: 'board' });
    expect(board.order).toBe(0);
    expect(board.order).not.toBe(Number.MAX_SAFE_INTEGER);

    // same fix applies to a doc that never set an explicit order in frontmatter.
    const doc = await storage.createPage({ space: spaceSlug, parentPath: '', title: 'Unordered Doc', kind: 'doc' });
    expect(doc.order).toBe(0);

    const fs = await import('node:fs/promises');
    await deleteTestSpace(spaceSlug);
  });

  describe('board PUT blank-overwrite guard', () => {
    const withPayload = (payload: string) =>
      `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><metadata><!-- payload-type:application/vnd.excalidraw+json --><!-- payload-start -->${payload}<!-- payload-end --></metadata></svg>\n`;
    const blank = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 1 1"></svg>\n';
    const scene = (elements: Array<{ id: string; isDeleted?: boolean }>) =>
      withPayload(Buffer.from(JSON.stringify({ type: 'excalidraw', elements })).toString('base64'));

    it('rejects a blank svg over a non-blank one without force, and accepts it with force=true', async () => {
      const space = await storage.createSpace(`Vitest Blank Guard ${Date.now()}`, null);
      spaceSlug = space.slug;
      const board = await storage.createPage({ space: spaceSlug, parentPath: '', title: 'Guarded Board', kind: 'board' });

      await storage.writeBoardSvg(board.id, withPayload('real-content'));

      await expect(storage.writeBoardSvg(board.id, blank)).rejects.toThrow(/empty scene/);
      // the guard must not have touched the file — the real content is still there.
      const stillReal = await storage.readBoardSvg(board.id);
      expect(stillReal).toContain('real-content');

      await storage.writeBoardSvg(board.id, blank, true); // force=true
      const afterForce = await storage.readBoardSvg(board.id);
      expect(afterForce).not.toContain('real-content');

      const fs = await import('node:fs/promises');
      await deleteTestSpace(spaceSlug);
    });

    it('does not block a blank svg when the current file is ALSO blank (no force needed)', async () => {
      const space = await storage.createSpace(`Vitest Blank Guard Noop ${Date.now()}`, null);
      spaceSlug = space.slug;
      const board = await storage.createPage({ space: spaceSlug, parentPath: '', title: 'Freshly Created Board', kind: 'board' });
      // createPage's own placeholder scene is already blank (no payload) — writing
      // another blank scene over it is not an overwrite of real content.
      await expect(storage.writeBoardSvg(board.id, blank)).resolves.toBeDefined();

      const fs = await import('node:fs/promises');
      await deleteTestSpace(spaceSlug);
    });

    it('never blocks writing non-blank content, regardless of what was there before', async () => {
      const space = await storage.createSpace(`Vitest Blank Guard Nonblank ${Date.now()}`, null);
      spaceSlug = space.slug;
      const board = await storage.createPage({ space: spaceSlug, parentPath: '', title: 'Another Board', kind: 'board' });
      await storage.writeBoardSvg(board.id, withPayload('first'));
      await expect(storage.writeBoardSvg(board.id, withPayload('second'))).resolves.toBeDefined();
      const final = await storage.readBoardSvg(board.id);
      expect(final).toContain('second');

      const fs = await import('node:fs/promises');
      await deleteTestSpace(spaceSlug);
    });

    it('rejects a valid embedded zero-element scene over a populated scene', async () => {
      const space = await storage.createSpace(`Vitest Empty Scene Guard ${Date.now()}`, null);
      spaceSlug = space.slug;
      const board = await storage.createPage({ space: spaceSlug, parentPath: '', title: 'Scene Count Guard', kind: 'board' });
      await storage.writeBoardSvg(board.id, scene([{ id: 'kept' }]));

      await expect(storage.writeBoardSvg(board.id, scene([]))).rejects.toThrow(/empty scene/);
      expect(await storage.readBoardSvg(board.id)).toContain(Buffer.from(JSON.stringify({ type: 'excalidraw', elements: [{ id: 'kept' }] })).toString('base64'));

      await deleteTestSpace(spaceSlug);
    });
  });
});

/**
 * Round 26 (DATA TABLES) — server/storage.ts point-edits: titleFallback,
 * the scanSpace `.table.md`-before-`.md` dispatch, indexTableFile,
 * createPage's table branch, renamePageSlug/renameTableFile, and the FTS
 * plain_text builder (tableDocToPlainText). See docs/spec-tables.md §2/§12b.
 */
describe('data tables (round 26)', () => {
  let teardownSchema: () => Promise<void>;
  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });
  afterAll(async () => {
    await teardownSchema();
  });

  const STATUS_COLUMN: TableColumn = { id: 'status', name: 'Status', type: 'status', options: [{ value: 'DONE', color: 'green' }, { value: 'IN PROG', color: 'blue' }] };
  const OWNER_COLUMN: TableColumn = { id: 'owner', name: 'Owner', type: 'text' };

  it('createPage(kind: "table") writes a valid starter .table.md with an empty-but-valid schema', async () => {
    const space = await storage.createSpace(`Vitest Table Create ${Date.now()}`, null);
    try {
      const meta = await storage.createPage({ space: space.slug, parentPath: '', title: 'Weekly Plan', kind: 'table', columns: [OWNER_COLUMN] });
      expect(meta.kind).toBe('table');
      expect(meta.path).toBe('weekly-plan.table.md');
      // titleFallback correctness: the fallback path (title derived from filename) must
      // strip the WHOLE ".table.md" suffix, not just ".md" (which would leave ".table").
      expect(meta.title).toBe('Weekly Plan'); // real title: extracted from the H1 in `head`

      const raw = await (await import('node:fs/promises')).readFile(
        (await import('node:path')).join(storage.REPOS_DIR, space.slug, 'weekly-plan.table.md'),
        'utf8',
      );
      const parsed = parseTableFile(raw);
      expect(isTableParseError(parsed)).toBe(false);
      const doc = parsed as TableDoc;
      expect(doc.columns.map((c) => c.id)).toEqual(['owner']);
      expect(doc.rows).toEqual([]);
      expect(doc.views).toHaveLength(1); // spec §5: first view created automatically
      expect(doc.meta.id).toBe(meta.id);

      // GitHub-renderability guardrail (spec §2.1): the written file must contain a
      // plain GFM pipe table, not a bespoke format.
      expect(raw).toContain('| Owner | id |');
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it('MANDATORY: scanSpace never indexes a .table.md file as a plain doc (no 23505 UNIQUE(space_slug, path) collision)', async () => {
    const space = await storage.createSpace(`Vitest Table Collision ${Date.now()}`, null);
    try {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const doc: TableDoc = {
        meta: { id: 'TABLECOLLISIONTEST01', version: 1, rowIds: 'column' },
        head: '# Collision Table\n\n',
        tail: '',
        columns: [STATUS_COLUMN],
        views: [{ id: 'all', name: 'All', columns: { hidden: [], order: [], width: {} }, sort: [], filter: { op: 'and', rules: [] }, frozen: 0, rowHeight: 'short' }],
        rows: [{ id: 'r0000001', values: { status: 'DONE' } }],
      };
      const { serializeTableFile } = await import('../shared/tables/index.js');
      await fs.writeFile(path.join(storage.REPOS_DIR, space.slug, 'collision.table.md'), serializeTableFile(doc), 'utf8');

      // Two scans (not one): confirms the file's classification is STABLE across a
      // rescan too (the unchanged-file skip path), not just correct on first index.
      await storage.scanSpace(space.slug);
      await expect(storage.scanSpace(space.slug)).resolves.toBeDefined();

      const entries = await storage.listEntries(space.slug);
      const matches = entries.filter((e) => e.relPath === 'collision.table.md');
      expect(matches).toHaveLength(1); // exactly one row for this path — not indexed twice under two kinds
      expect(matches[0].kind).toBe('table');
      expect(matches[0].isIndex).toBe(false); // spec §1: a table file never becomes a directory index

      // And the denormalized FTS text (spec §11) made it into pages_index.plain_text —
      // exposed here via listEntries' `body` field (see PageIndexEntry.body's doc comment).
      expect(matches[0].body).toContain('Status: DONE');
      expect(matches[0].body).toContain('Collision Table'); // head prose (the H1) is included too
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it('renamePageSlug preserves the .table.md extension (not .md)', async () => {
    const space = await storage.createSpace(`Vitest Table Slug ${Date.now()}`, null);
    try {
      const meta = await storage.createPage({ space: space.slug, parentPath: '', title: 'Renamable', kind: 'table' });
      const result = await storage.renamePageSlug(meta.id, 'renamed-slug');
      expect(result.meta.path).toBe('renamed-slug.table.md');
      expect(result.meta.kind).toBe('table');
      // the file really is there under the new name, and still a valid table file
      const raw = await (await import('node:fs/promises')).readFile(
        (await import('node:path')).join(storage.REPOS_DIR, space.slug, 'renamed-slug.table.md'),
        'utf8',
      );
      expect(isTableParseError(parseTableFile(raw))).toBe(false);
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it('renameTableFile rewrites the H1 in `head`, preserving columns/views/rows (spec §12b.6: table rename is H1-shaped, not filename-shaped)', async () => {
    const space = await storage.createSpace(`Vitest Table Rename ${Date.now()}`, null);
    try {
      const meta = await storage.createPage({ space: space.slug, parentPath: '', title: 'Old Title', kind: 'table', columns: [OWNER_COLUMN] });
      await storage.writeTableDoc(meta.id, {
        ...(await storage.readFreshTableDoc(meta.id)),
        rows: [{ id: 'abc12345', values: { owner: 'sk' } }],
      });

      const renamed = await storage.renameTableFile(meta.id, 'New Title');
      expect(renamed.title).toBe('New Title');
      expect(renamed.path).toBe('old-title.table.md'); // filename is untouched by this function

      const doc = await storage.readFreshTableDoc(meta.id);
      expect(doc.head).toContain('# New Title');
      expect(doc.columns.map((c) => c.id)).toEqual(['owner']); // schema survived
      expect(doc.rows).toEqual([{ id: 'abc12345', values: { owner: 'sk' } }]); // rows survived
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it('writeTableDoc keeps pages_index in sync: title, updatedAt, and denormalized plain_text', async () => {
    const space = await storage.createSpace(`Vitest Table Write ${Date.now()}`, null);
    try {
      const meta = await storage.createPage({ space: space.slug, parentPath: '', title: 'Sync Check', kind: 'table', columns: [OWNER_COLUMN, STATUS_COLUMN] });
      const before = await storage.requireEntry(meta.id);

      const doc = await storage.readFreshTableDoc(meta.id);
      await storage.writeTableDoc(meta.id, { ...doc, rows: [{ id: 'r1', values: { owner: 'alice', status: 'IN PROG' } }] });

      const after = await storage.requireEntry(meta.id);
      expect(after.body).toContain('Owner: alice');
      expect(after.body).toContain('Status: IN PROG');
      expect(new Date(after.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(before.updatedAt).getTime());
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it('a structurally invalid .table.md is indexed as a best-effort stub, never dropped or aborting the scan (spec §1: "does not lose data silently")', async () => {
    const space = await storage.createSpace(`Vitest Table Broken ${Date.now()}`, null);
    try {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      // Valid frontmatter (real id), but the GFM table block itself is broken (row cell
      // count doesn't match the schema) — parseTableFile fails structurally.
      const broken = [
        '---',
        'folio: table',
        'version: 1',
        'id: BROKENTABLEFILE0001',
        'columns:',
        '  - { id: owner, name: Owner, type: text }',
        'views: []',
        'options: { rowIds: column }',
        '---',
        '',
        '# Broken Table',
        '',
        '<!-- folio:table:begin -->',
        '',
        '| Owner | id |',
        '| --- | --- |',
        '| only-one-cell |', // wrong cell count -> structural parse error
        '',
        '<!-- folio:table:end -->',
        '',
      ].join('\n');
      await fs.writeFile(path.join(storage.REPOS_DIR, space.slug, 'broken.table.md'), broken, 'utf8');

      await expect(storage.scanSpace(space.slug)).resolves.toBeDefined(); // must not throw / abort the scan

      const entries = await storage.listEntries(space.slug);
      const entry = entries.find((e) => e.relPath === 'broken.table.md');
      expect(entry).toBeDefined();
      expect(entry!.kind).toBe('table');
      expect(entry!.id).toBe('BROKENTABLEFILE0001'); // recovered from the (valid) frontmatter, not re-minted
      expect(entry!.title).toBe('Broken Table'); // recovered from the H1 in the (valid) prose
    } finally {
      await deleteTestSpace(space.slug);
    }
  });
});

/**
 * Explicit sibling `order` for the two page kinds that had nowhere to keep
 * one, which is what made the sidebar tree's reorder (the "…" menu's
 * Up/Down, and now drag-and-drop) 400 on them:
 *
 *   board — `<!-- folio-order: N -->`, a second bookkeeping comment beside
 *           the `<!-- folio-id: … -->` one a `.excalidraw.svg` has always
 *           carried (server/storage.ts's splitBoardHeader);
 *   table — a top-level `order` key in the file's own frontmatter, set
 *           WITHOUT round-tripping the table schema that shares that block.
 *
 * Both live in the FILE, never only in pages_index: PostgreSQL is a derived
 * index here (db/migrations/001_init.sql — "safe to drop and rebuild from a
 * scan"), so the load-bearing assertion in each case is the one that wipes
 * every indexed row for the space and rescans from disk alone.
 */
describe('explicit page order for boards and tables (files are the only truth)', () => {
  let teardownSchema: () => Promise<void>;
  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });
  afterAll(async () => {
    await teardownSchema();
  });

  /** A structurally real excalidraw export: the base64-ish scene blob between the payload markers IS the drawing. */
  const boardSvgWithScene = (payload: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><metadata><!-- payload-type:application/vnd.excalidraw+json --><!-- payload-start -->${payload}<!-- payload-end --></metadata></svg>\n`;

  /** Everything after the leading run of `<!-- folio-*: … -->` lines — i.e. the drawing itself, byte for byte. */
  const sceneOf = (svg: string) => svg.replace(/^(?:<!--\s*folio-[a-z-]+:[^>]*-->\n)+/, '');

  const readFile = async (slug: string, rel: string) => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    return fs.readFile(path.join(storage.REPOS_DIR, slug, rel), 'utf8');
  };

  /** Throws away every indexed row for the space and rebuilds it from the files alone. */
  const rebuildIndexFromDisk = async (slug: string) => {
    const { query } = await import('./db/pool.js');
    await query('DELETE FROM pages_index WHERE space_slug = $1', [slug]);
    await storage.scanSpace(slug);
  };

  it("persists a board's order in the svg, and it survives a full index rebuild from disk", async () => {
    const space = await storage.createSpace(`Vitest Board Order ${Date.now()}`, null);
    try {
      const board = await storage.createPage({ space: space.slug, parentPath: '', title: 'Ordered Board', kind: 'board' });
      await storage.writeBoardSvg(board.id, boardSvgWithScene('SCENE-PAYLOAD-v1'));

      await storage.setBoardOrder(await storage.requireEntry(board.id), 20);

      const raw = await readFile(space.slug, board.path);
      expect(raw).toContain(`<!-- folio-id: ${board.id} -->`);
      expect(raw).toContain('<!-- folio-order: 20 -->');

      await rebuildIndexFromDisk(space.slug);

      const reindexed = await storage.requireEntry(board.id);
      expect(reindexed.kind).toBe('board');
      expect(reindexed.explicitOrder).toBe(20);
      expect(reindexed.order).toBe(20);
      expect(storage.toPageMeta(reindexed).order).toBe(20);
      // and the id was NOT re-minted by the rescan — the extra comment line
      // must not have pushed the id comment out of recognition.
      expect(reindexed.id).toBe(board.id);
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it('an order-only write leaves the excalidraw scene byte-identical (the payload IS the drawing)', async () => {
    const space = await storage.createSpace(`Vitest Board Scene ${Date.now()}`, null);
    try {
      const board = await storage.createPage({ space: space.slug, parentPath: '', title: 'Scene Board', kind: 'board' });
      const scene = boardSvgWithScene('eyJ0eXBlIjoiZXhjYWxpZHJhdyIsImVsZW1lbnRzIjpbeyJpZCI6ImEifV19');
      await storage.writeBoardSvg(board.id, scene);
      const before = sceneOf(await readFile(space.slug, board.path));

      await storage.setBoardOrder(await storage.requireEntry(board.id), 30);
      const after = sceneOf(await readFile(space.slug, board.path));

      expect(after).toBe(before);
      expect(after).toBe(scene); // and it is still exactly what was PUT, not a re-serialization
      expect(after).toContain('<!-- payload-start -->eyJ0eXBlIjoiZXhjYWxpZHJhdyI');

      // Changing it again (and back to none) still never touches the scene.
      await storage.setBoardOrder(await storage.requireEntry(board.id), 40);
      expect(sceneOf(await readFile(space.slug, board.path))).toBe(scene);
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it('a normal board save (excalidraw export, which carries no order comment) keeps the order', async () => {
    const space = await storage.createSpace(`Vitest Board Resave ${Date.now()}`, null);
    try {
      const board = await storage.createPage({ space: space.slug, parentPath: '', title: 'Resaved Board', kind: 'board' });
      await storage.setBoardOrder(await storage.requireEntry(board.id), 50);

      await storage.writeBoardSvg(board.id, boardSvgWithScene('SCENE-AFTER-EDIT'));

      const raw = await readFile(space.slug, board.path);
      expect(raw).toContain('<!-- folio-order: 50 -->');
      expect(raw).toContain('SCENE-AFTER-EDIT');
      await rebuildIndexFromDisk(space.slug);
      expect((await storage.requireEntry(board.id)).explicitOrder).toBe(50);
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it('a board with NO order comment falls back to name ordering (sorts after ordered siblings), not to a random slot', async () => {
    const space = await storage.createSpace(`Vitest Board Fallback ${Date.now()}`, null);
    try {
      // Deliberately alphabetically LAST so "sorted by title" is distinguishable from "kept insertion order".
      const zulu = await storage.createPage({ space: space.slug, parentPath: '', title: 'Zulu Board', kind: 'board' });
      const alpha = await storage.createPage({ space: space.slug, parentPath: '', title: 'Alpha Board', kind: 'board' });

      const unordered = await storage.requireEntry(zulu.id);
      expect(unordered.explicitOrder).toBeUndefined();
      expect(unordered.order).toBe(Number.MAX_SAFE_INTEGER); // the "sorts last, then by title" sentinel

      const childrenOf = async () => (await storage.getTree(space.slug))[0].children.map((c) => c.title);
      expect(await childrenOf()).toEqual(['Alpha Board', 'Zulu Board']); // both unordered -> title order

      // One explicit order is enough to lift that board above the still-unordered one.
      await storage.setBoardOrder(await storage.requireEntry(zulu.id), 10);
      expect(await childrenOf()).toEqual(['Zulu Board', 'Alpha Board']);
      expect((await storage.requireEntry(alpha.id)).explicitOrder).toBeUndefined(); // untouched
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it("persists a table's order in its frontmatter without disturbing the table schema, and it survives a rebuild", async () => {
    const space = await storage.createSpace(`Vitest Table Order ${Date.now()}`, null);
    try {
      const column: TableColumn = { id: 'owner', name: 'Owner', type: 'text' };
      const table = await storage.createPage({ space: space.slug, parentPath: '', title: 'Ordered Table', kind: 'table', columns: [column] });
      const beforeDoc = await storage.readFreshTableDoc(table.id);

      await storage.setTableOrder(await storage.requireEntry(table.id), 60);

      // The schema half of the frontmatter is intact and the file still parses.
      const afterDoc = await storage.readFreshTableDoc(table.id);
      expect(afterDoc.columns).toEqual(beforeDoc.columns);
      expect(afterDoc.views).toEqual(beforeDoc.views);
      expect(afterDoc.rows).toEqual(beforeDoc.rows);
      expect(afterDoc.meta).toEqual(beforeDoc.meta);
      expect(afterDoc.head).toEqual(beforeDoc.head);
      expect(await readFile(space.slug, table.path)).toContain('order: 60');

      await rebuildIndexFromDisk(space.slug);
      expect((await storage.requireEntry(table.id)).explicitOrder).toBe(60);
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it('an ordinary table edit (writeTableDoc, which serializes through the codec) keeps the order', async () => {
    const space = await storage.createSpace(`Vitest Table Resave ${Date.now()}`, null);
    try {
      const table = await storage.createPage({ space: space.slug, parentPath: '', title: 'Edited Table', kind: 'table', columns: [{ id: 'owner', name: 'Owner', type: 'text' }] });
      await storage.setTableOrder(await storage.requireEntry(table.id), 70);

      const doc = await storage.readFreshTableDoc(table.id);
      await storage.writeTableDoc(table.id, { ...doc, rows: [{ id: 'r1', values: { owner: 'Sam' } }] });

      await rebuildIndexFromDisk(space.slug);
      expect((await storage.requireEntry(table.id)).explicitOrder).toBe(70);
      expect((await storage.readFreshTableDoc(table.id)).rows).toHaveLength(1);
    } finally {
      await deleteTestSpace(space.slug);
    }
  });
});

/**
 * A board's title/icon are the doc-shaped fix for the product owner's report
 * (spec-implementation-light.md-adjacent round): today a board's title WAS
 * its filename, and renaming it (`renameBoardFile`, now `setBoardTitle`)
 * `fs.rename`d the file — changing a board's title silently changed its URL
 * and broke every existing link to it. Both now live in the leading
 * `folio-*` header comment (splitBoardHeader/renderBoardHeader), exactly
 * like `folio-order` already does — the file itself, and therefore its
 * slug/URL, is never touched by a title or icon change.
 */
describe('board title/icon (doc-shaped metadata in the header, filename left alone)', () => {
  let teardownSchema: () => Promise<void>;
  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });
  afterAll(async () => {
    await teardownSchema();
  });

  /** A structurally real excalidraw export: the base64-ish scene blob between the payload markers IS the drawing. */
  const boardSvgWithScene = (payload: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><metadata><!-- payload-type:application/vnd.excalidraw+json --><!-- payload-start -->${payload}<!-- payload-end --></metadata></svg>\n`;

  /** Everything after the leading run of `<!-- folio-*: … -->` lines — i.e. the drawing itself, byte for byte. */
  const sceneOf = (svg: string) => svg.replace(/^(?:<!--\s*folio-[a-z-]+:[^>]*-->\n)+/, '');

  const readFile = async (slug: string, rel: string) => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    return fs.readFile(path.join(storage.REPOS_DIR, slug, rel), 'utf8');
  };

  /** Throws away every indexed row for the space and rebuilds it from the files alone. */
  const rebuildIndexFromDisk = async (slug: string) => {
    const { query } = await import('./db/pool.js');
    await query('DELETE FROM pages_index WHERE space_slug = $1', [slug]);
    await storage.scanSpace(slug);
  };

  it('resolves a space whose root is README.md, including the explicit "index.md" ask', async () => {
    // QA-3: a space created from an ordinary git repo has README.md and no index.md.
    // SpaceHome asks resolve(space, 'index.md') by name, and the old fallback only
    // ever tried `index.md/README.md`, so the space's own home answered 404 and the
    // UI concluded the SPACE did not exist.
    const space = await storage.createSpace(`Vitest Readme Root ${Date.now()}`, null);
    try {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const dir = path.join(storage.REPOS_DIR, space.slug);
      await fs.writeFile(path.join(dir, 'README.md'), '# Readme Root\n\nbody\n', 'utf8');
      await fs.rm(path.join(dir, 'index.md'), { force: true });
      await storage.scanSpace(space.slug);

      const byEmpty = await storage.resolve(space.slug, '');
      expect(byEmpty.path).toBe('README.md');
      const byIndexName = await storage.resolve(space.slug, 'index.md');
      expect(byIndexName.path).toBe('README.md');
      expect(byIndexName.id).toBe(byEmpty.id);
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it('keeps a board title that translit would mangle, straight from creation', async () => {
    // QA-3: creation wrote only `folio-id`, so scanSpace fell back to the file name
    // and "My release plan" appeared in the tree as "my-release-plan". Renaming to
    // the SAME title used to be the only way to get the real name stored.
    const space = await storage.createSpace(`Vitest Board Create Title ${Date.now()}`, null);
    try {
      const title = 'My release plan';
      const board = await storage.createPage({ space: space.slug, parentPath: '', title, kind: 'board' });
      expect(board.title).toBe(title);

      const raw = await readFile(space.slug, board.path);
      expect(raw).toContain(`<!-- folio-id: ${board.id} -->`);
      expect(raw).toMatch(/<!-- folio-title: [A-Za-z0-9+/=]+ -->/);

      // The name has to survive a full rebuild from disk, not just the live index.
      await rebuildIndexFromDisk(space.slug);
      const reindexed = await storage.requireEntry(board.id);
      expect(reindexed.title).toBe(title);
      expect(reindexed.id).toBe(board.id);
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it("setBoardTitle writes the title into the header comment, and it survives a full index rebuild from disk", async () => {
    const space = await storage.createSpace(`Vitest Board Title ${Date.now()}`, null);
    try {
      const board = await storage.createPage({ space: space.slug, parentPath: '', title: 'Original Slug Title', kind: 'board' });
      const meta = await storage.setBoardTitle(board.id, 'Renamed Board Title');
      expect(meta.title).toBe('Renamed Board Title');

      const raw = await readFile(space.slug, board.path);
      expect(raw).toContain(`<!-- folio-id: ${board.id} -->`);
      expect(raw).toMatch(/<!-- folio-title: [A-Za-z0-9+/=]+ -->/);

      await rebuildIndexFromDisk(space.slug);
      const reindexed = await storage.requireEntry(board.id);
      expect(reindexed.title).toBe('Renamed Board Title');
      expect(reindexed.id).toBe(board.id); // the id comment must not have been pushed out of recognition
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it("renaming a board's title does NOT move the file — the path is unchanged (the regression this round must never bring back)", async () => {
    const space = await storage.createSpace(`Vitest Board No Move ${Date.now()}`, null);
    try {
      const board = await storage.createPage({ space: space.slug, parentPath: '', title: 'Stable Slug', kind: 'board' });
      const originalPath = board.path;

      const meta = await storage.setBoardTitle(board.id, 'A Completely Different Title, With Spaces');
      expect(meta.path).toBe(originalPath);

      const entry = await storage.requireEntry(board.id);
      expect(entry.relPath).toBe(originalPath);

      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      // the file still exists at its ORIGINAL path — nothing new was created elsewhere.
      await expect(fs.stat(path.join(storage.REPOS_DIR, space.slug, originalPath))).resolves.toBeDefined();
      const siblingFiles = await fs.readdir(path.join(storage.REPOS_DIR, space.slug));
      expect(siblingFiles.filter((f) => f.endsWith('.excalidraw.svg'))).toEqual([originalPath]);
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it('a header-less board (every pre-existing board, before this round) still indexes correctly, showing its filename-derived title until someone renames it', async () => {
    const space = await storage.createSpace(`Vitest Board Legacy ${Date.now()}`, null);
    try {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const id = 'LEGACYBOARD00000000000001';
      // A board file written the OLD way — id comment only, no title/icon (exactly
      // what every board in a real, pre-existing wiki looks like on disk today).
      const abs = path.join(storage.REPOS_DIR, space.slug, 'legacy-board-name.excalidraw.svg');
      await fs.writeFile(abs, `<!-- folio-id: ${id} -->\n<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 1 1"></svg>\n`, 'utf8');

      await storage.scanSpace(space.slug);
      const entry = await storage.requireEntry(id);
      expect(entry.kind).toBe('board');
      expect(entry.title).toBe('legacy-board-name'); // titleFallback — unchanged, non-destructive migration
      expect(entry.icon).toBeUndefined();
      expect(entry.relPath).toBe('legacy-board-name.excalidraw.svg'); // untouched
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it('a hostile title (quotes, -->, angle brackets, embedded newlines, emoji, Cyrillic) round-trips exactly, without corrupting the file', async () => {
    const space = await storage.createSpace(`Vitest Board Hostile ${Date.now()}`, null);
    try {
      const board = await storage.createPage({ space: space.slug, parentPath: '', title: 'Board', kind: 'board' });
      const before = await readFile(space.slug, board.path);
      // Everything after the leading folio-* comment run. (Creation writes id AND
      // title since QA-3, so "skip one line" would silently include the title line.)
      const scenePart = before
        .split('\n')
        .filter((line, i, all) => i >= all.findIndex((l) => !l.startsWith('<!-- folio-')))
        .join('\n');

      const hostile = 'Evil "quoted" <tag> --> breakout\nsecond line 😀 Ünïcödé text';
      const meta = await storage.setBoardTitle(board.id, hostile);
      expect(meta.title).toBe(hostile);

      const raw = await readFile(space.slug, board.path);
      const lines = raw.split('\n');
      // exactly two header lines (id, title) — the base64-encoded value can never
      // introduce a stray newline, so the hostile title cannot smuggle a THIRD line
      // or corrupt/shorten the header run.
      expect(lines[0]).toBe(`<!-- folio-id: ${board.id} -->`);
      expect(lines[1]).toMatch(/^<!-- folio-title: [A-Za-z0-9+/=]+ -->$/);
      expect(lines.slice(2).join('\n')).toBe(scenePart); // the scene/svg itself is untouched, byte for byte

      // A full reindex from disk must parse the file without throwing and recover
      // the title exactly — this is the real "never silently mangled" guarantee.
      await storage.scanSpace(space.slug);
      expect((await storage.requireEntry(board.id)).title).toBe(hostile);
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it('a title-only write (setBoardTitle) leaves the excalidraw scene byte-identical', async () => {
    const space = await storage.createSpace(`Vitest Board Title Scene ${Date.now()}`, null);
    try {
      const board = await storage.createPage({ space: space.slug, parentPath: '', title: 'Scene Board', kind: 'board' });
      const scene = boardSvgWithScene('eyJ0eXBlIjoiZXhjYWxpZHJhdyIsImVsZW1lbnRzIjpbeyJpZCI6ImEifV19');
      await storage.writeBoardSvg(board.id, scene);

      await storage.setBoardTitle(board.id, 'New Title');
      const after = sceneOf(await readFile(space.slug, board.path));

      expect(after).toBe(scene);
      expect(after).toContain('<!-- payload-start -->eyJ0eXBlIjoiZXhjYWxpZHJhdyI');
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it('an ordinary board save (writeBoardSvg, an excalidraw export with no folio-* header at all) preserves title, icon, AND order together', async () => {
    const space = await storage.createSpace(`Vitest Board Save Preserves ${Date.now()}`, null);
    try {
      const board = await storage.createPage({ space: space.slug, parentPath: '', title: 'Preserved Board', kind: 'board' });
      await storage.setBoardTitle(board.id, 'Kept Title');
      await storage.setBoardIcon(await storage.requireEntry(board.id), '🎯');
      await storage.setBoardOrder(await storage.requireEntry(board.id), 15);

      // excalidraw's own SVG export never includes ANY folio-* comment.
      await storage.writeBoardSvg(board.id, boardSvgWithScene('SCENE-AFTER-EDIT'));

      const raw = await readFile(space.slug, board.path);
      expect(raw).toContain('SCENE-AFTER-EDIT');
      expect(raw).toContain('<!-- folio-order: 15 -->');
      expect(raw).toMatch(/<!-- folio-title: [A-Za-z0-9+/=]+ -->/);
      expect(raw).toMatch(/<!-- folio-icon: [A-Za-z0-9+/=]+ -->/);

      await rebuildIndexFromDisk(space.slug);
      const reindexed = await storage.requireEntry(board.id);
      expect(reindexed.title).toBe('Kept Title');
      expect(reindexed.icon).toBe('🎯');
      expect(reindexed.explicitOrder).toBe(15);
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it("a board's icon set/clear/absent behaves like a doc's PUT { icon } (resolveIconCoverOverride semantics)", async () => {
    const space = await storage.createSpace(`Vitest Board Icon ${Date.now()}`, null);
    try {
      const board = await storage.createPage({ space: space.slug, parentPath: '', title: 'Iconic Board', kind: 'board' });
      expect((await storage.requireEntry(board.id)).icon).toBeUndefined();

      // string -> set
      await storage.setBoardIcon(await storage.requireEntry(board.id), storage.resolveIconCoverOverride('🚀', undefined));
      expect((await storage.requireEntry(board.id)).icon).toBe('🚀');

      // absent (undefined override) -> preserve
      const entryAfterSet = await storage.requireEntry(board.id);
      await storage.setBoardIcon(entryAfterSet, storage.resolveIconCoverOverride(undefined, entryAfterSet.icon));
      expect((await storage.requireEntry(board.id)).icon).toBe('🚀');

      // null -> clear
      const entryBeforeClear = await storage.requireEntry(board.id);
      await storage.setBoardIcon(entryBeforeClear, storage.resolveIconCoverOverride(null, entryBeforeClear.icon));
      expect((await storage.requireEntry(board.id)).icon).toBeUndefined();

      const raw = await readFile(space.slug, board.path);
      expect(raw).not.toContain('folio-icon');
    } finally {
      await deleteTestSpace(space.slug);
    }
  });
});

/**
 * Production, 15.09: connecting a repository with `_tasks` folders failed
 * with a 500 and left invisible "orphans" (client-offers, -2, -3).
 * gray-matter throws on handwritten YAML such as `title: Fix: login`, and
 * indexDocFile did not catch it — one such file cut scanSpace short for the
 * whole space.
 */
describe('scanSpace: a file with unreadable frontmatter', () => {
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    teardown = await setUpTestSchema();
  });

  afterAll(async () => {
    await teardown();
  });

  it('does not cut the scan short, indexes the file as text and does NOT rewrite it', async () => {
    const fsp = await import('node:fs/promises');
    const nodePath = await import('node:path');
    const space = await storage.createSpace(`Vitest Broken YAML ${Date.now()}`, null);
    const dir = nodePath.join(storage.REPOS_DIR, space.slug);

    const brokenPath = nodePath.join(dir, 'broken.md');
    const brokenRaw = '---\ntitle: Fix: login breaks\n---\n# A task with crooked YAML\n\nbody\n';
    await fsp.writeFile(brokenPath, brokenRaw, 'utf8');
    await fsp.writeFile(nodePath.join(dir, 'fine.md'), '# A normal page\n\ntext\n', 'utf8');

    await expect(storage.scanSpace(space.slug)).resolves.toBeDefined();

    const entries = await storage.listEntries(space.slug);
    const broken = entries.find((e) => e.relPath === 'broken.md');
    const fine = entries.find((e) => e.relPath === 'fine.md');
    expect(broken).toBeDefined();
    expect(fine).toBeDefined();
    expect(broken!.title).toBe('A task with crooked YAML');

    // Not rewritten — no id injected into a file we could not read.
    expect(await fsp.readFile(brokenPath, 'utf8')).toBe(brokenRaw);

    // And the id is stable between rescans. We change the broken file ITSELF
    // so that the scan re-reads it instead of skipping it as unchanged; fine.md
    // is left alone — rewriting it without an id would give quite a different,
    // known collision (space, path).
    await fsp.appendFile(brokenPath, '\none more line\n', 'utf8');
    await storage.scanSpace(space.slug);
    const again = (await storage.listEntries(space.slug)).find((e) => e.relPath === 'broken.md');
    expect(again!.id).toBe(broken!.id);

    await deleteTestSpace(space.slug);
  });
});

/**
 * The same incident from the other side: any error of ONE file used to cut
 * scanSpace short entirely. The documented trap is reproduced here — a file
 * is replaced without its id, and the insert hits UNIQUE (space_slug, path).
 */
describe('scanSpace: one problem file does not bring the whole space down', () => {
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    teardown = await setUpTestSchema();
  });

  afterAll(async () => {
    await teardown();
  });

  it('skips a file that cannot be indexed and takes the scan to the end', async () => {
    const fsp = await import('node:fs/promises');
    const nodePath = await import('node:path');
    const space = await storage.createSpace(`Vitest Isolation ${Date.now()}`, null);
    const dir = nodePath.join(storage.REPOS_DIR, space.slug);

    // index.md is already indexed by createSpace under its id — overwrite it without an id.
    await fsp.writeFile(nodePath.join(dir, 'index.md'), '# Replaced without an id\n', 'utf8');
    await fsp.writeFile(nodePath.join(dir, 'ok.md'), '# Perfectly normal\n', 'utf8');

    await expect(storage.scanSpace(space.slug)).resolves.toBeDefined();

    const paths = (await storage.listEntries(space.slug)).map((e) => e.relPath).sort();
    expect(paths).toContain('ok.md');
    // The row of the problem file did not disappear — it was in stillPresent.
    expect(paths).toContain('index.md');

    await deleteTestSpace(space.slug);
  });
});

/**
 * The real cause of the 15.09 incident, which /api/admin/boot-scan showed:
 * "string is too long for tsvector (1815088 bytes, max 1048575 bytes)" in
 * three spaces of those left after failed attempts to connect a repository.
 */
describe('scanSpace: the aftermath of the 15.09 incident', () => {
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    teardown = await setUpTestSchema();
  });

  afterAll(async () => {
    await teardown();
  });

  it('a page with more than 1 MB of text is indexed; plain_text is stored in full', async () => {
    const fsp = await import('node:fs/promises');
    const nodePath = await import('node:path');
    const space = await storage.createSpace(`Vitest Huge Page ${Date.now()}`, null);
    const dir = nodePath.join(storage.REPOS_DIR, space.slug);

    // Different words, so that the vector is not compressed by repeats — as in a real big document.
    const words: string[] = [];
    let size = 0;
    for (let i = 0; size < 1_900_000; i++) {
      const w = `word${i.toString(36)}`;
      words.push(w);
      size += Buffer.byteLength(w, 'utf8') + 1;
    }
    await fsp.writeFile(nodePath.join(dir, 'huge.md'), `# A big page\n\n${words.join(' ')}\n`, 'utf8');

    await expect(storage.scanSpace(space.slug)).resolves.toBeDefined();
    const entry = (await storage.listEntries(space.slug)).find((e) => e.relPath === 'huge.md');
    expect(entry).toBeDefined();

    await deleteTestSpace(space.slug);
  });

  it('a rescan where the ONLY changed file fails no longer throws — this is what brought production down', async () => {
    const fsp = await import('node:fs/promises');
    const nodePath = await import('node:path');
    const space = await storage.createSpace(`Vitest One Of One ${Date.now()}`, null);
    const dir = nodePath.join(storage.REPOS_DIR, space.slug);

    // The only changed file falls into the documented trap (space_slug, path).
    await fsp.writeFile(nodePath.join(dir, 'index.md'), '# Replaced without an id\n', 'utf8');

    await expect(storage.scanSpace(space.slug)).resolves.toBeDefined();

    await deleteTestSpace(space.slug);
  });

  it('isConnectionFailure: only a real loss of the connection, not the data of one file', () => {
    expect(storage.isConnectionFailure({ code: '08006' })).toBe(true);
    expect(storage.isConnectionFailure({ code: '57P01' })).toBe(true);
    expect(storage.isConnectionFailure({ code: 'ECONNREFUSED' })).toBe(true);
    expect(storage.isConnectionFailure({ code: '54000' })).toBe(false); // program_limit_exceeded (tsvector)
    expect(storage.isConnectionFailure({ code: '23505' })).toBe(false); // unique_violation
    expect(storage.isConnectionFailure(new Error('boom'))).toBe(false);
  });

  it('capForTsvector does not cut a multi-byte letter and fits the budget', () => {
    const text = 'é'.repeat(400_000); // 800 000 bytes
    const capped = storage.capForTsvector(text);
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(600_000);
    expect(capped).toBe('é'.repeat(capped.length));
    expect(storage.capForTsvector('short')).toBe('short');
  });
});
