/**
 * Round 23 (EXPORT), Stage 1 — markdown export and subtree collation,
 * against a real PostgreSQL test schema and real files on disk (same
 * convention as server/storage.test.ts / server/shares.test.ts).
 *
 * Covers the tests DEV-PLAN names explicitly for this stage: absolute links,
 * subtree strictness (`foo-bar` is NOT a child of `foo`), collation order,
 * heading demotion, anchor dedup, the limits + truncation marker, boards
 * (image AND extracted scene text, empty scene doesn't crash) and data
 * tables (several column types, empty table doesn't crash).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TableDoc } from '../../shared/contracts.js';
import { encodeScenePayload } from '../confluenceWhiteboard.js';
import { setUpTestSchema, deleteTestSpace } from '../db/testSchema.js';
import * as authStore from '../auth/store.js';
import * as storage from '../storage.js';
import { collectForExport, collectSubtree, singlePage } from './collect.js';
import { MAX_EXPORT_BYTES, MAX_EXPORT_PAGES } from './limits.js';
import { assembleMarkdown, headingPlainText, slugifyHeading } from './markdown.js';

const BASE = 'https://folio.example.com';

async function entryFor(id: string) {
  return storage.requireEntry(id);
}

/** A page whose body is exactly `markdown` (createPage seeds an `# H1`, so this overwrites). */
async function makeDoc(space: string, parentPath: string, title: string, markdown: string) {
  const meta = await storage.createPage({ space, parentPath, title, kind: 'doc' });
  await storage.writeDocBody(meta.id, markdown);
  return entryFor(meta.id);
}

function sceneSvg(elements: unknown[]): string {
  const scene = { type: 'excalidraw', version: 2, source: 'test', elements, appState: {}, files: {} };
  const payload = encodeScenePayload(scene as never);
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">' +
    '<metadata><!-- payload-type:application/vnd.excalidraw+json -->' +
    `<!-- payload-start -->${payload}<!-- payload-end --></metadata></svg>\n`
  );
}

function textElement(id: string, x: number, y: number, text: string, frameId: string | null = null) {
  return { id, type: 'text', x, y, width: 100, height: 20, text, originalText: text, frameId, isDeleted: false };
}

describe('R23 export — markdown assembly (real PG + real files)', () => {
  let teardownSchema: () => Promise<void>;
  let space: string;
  let userId: string;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const user = await authStore.createUser({ email: `export-md-${Date.now()}@test.local`, name: 'Exporter', passwordHash: 'x', isAdmin: false });
    userId = user.id;
    const created = await storage.createSpace(`Export MD ${Date.now()}`, userId);
    space = created.slug;
  });

  afterAll(async () => {
    await deleteTestSpace(space);
    await teardownSchema();
  });

  // -------------------------------------------------------------------------

  it('single page: no frontmatter, and every relative link/image becomes an absolute prod URL', async () => {
    const foo = await makeDoc(
      space,
      '',
      `Links ${Date.now()}`,
      [
        '# Links',
        '',
        '![shot](assets/shot.png)',
        '',
        '[external](https://example.org/x)',
        '',
        '[root relative](/files/other/thing.png)',
        '',
        '[mail](mailto:a@b.c)',
      ].join('\n'),
    );

    const out = await assembleMarkdown(singlePage(foo), { baseUrl: BASE });

    expect(out.markdown.startsWith('---')).toBe(false); // frontmatter never travels
    expect(out.markdown).toContain(`![shot](${BASE}/files/${space}/assets/shot.png)`);
    expect(out.markdown).toContain('[external](https://example.org/x)'); // untouched
    expect(out.markdown).toContain(`[root relative](${BASE}/files/other/thing.png)`);
    expect(out.markdown).toContain('[mail](mailto:a@b.c)'); // untouched
    // Nothing relative is left anywhere.
    expect(/\]\((?!https?:|mailto:|#)/.test(out.markdown)).toBe(false);
  });

  it('links inside a fenced code block are left exactly as written', async () => {
    const page = await makeDoc(
      space,
      '',
      `Fenced ${Date.now()}`,
      ['# Fenced', '', '```md', '[keep me](notes/raw.md)', '```', '', '[rewrite me](notes/raw.md)'].join('\n'),
    );
    const out = await assembleMarkdown(singlePage(page), { baseUrl: BASE });
    expect(out.markdown).toContain('[keep me](notes/raw.md)');
    expect(out.markdown).toContain(`[rewrite me](${BASE}/files/${space}/notes/raw.md)`);
  });

  // -------------------------------------------------------------------------

  describe('includeChildren collation', () => {
    let root: Awaited<ReturnType<typeof entryFor>>;
    let childA: Awaited<ReturnType<typeof entryFor>>;
    let childB: Awaited<ReturnType<typeof entryFor>>;
    let grandchild: Awaited<ReturnType<typeof entryFor>>;
    let sibling: Awaited<ReturnType<typeof entryFor>>;
    let rootSlug: string;

    beforeAll(async () => {
      // `foo.md` + a `foo/` directory next to it: the shape whose children the
      // sidebar shows and which a naive path-prefix check gets wrong.
      root = await makeDoc(space, '', 'Foo', '# Foo\n\nRoot body.\n');
      rootSlug = root.relPath.replace(/\.md$/, '');
      childA = await makeDoc(space, rootSlug, 'Alpha', '# Alpha\n\nAlpha body.\n');
      childB = await makeDoc(space, rootSlug, 'Beta', '# Beta\n\nBeta body.\n');
      grandchild = await makeDoc(space, `${rootSlug}/${childA.relPath.split('/').pop()!.replace(/\.md$/, '')}`, 'Deep', '# Deep\n\nDeep body.\n');
      // THE strictness fixture: a sibling whose PATH starts with the root's path.
      sibling = await makeDoc(space, '', 'Foo Bar', '# Foo Bar\n\nNot a child.\n');
    });

    it('membership is index-based: `foo-bar.md` is NOT a descendant of `foo`', async () => {
      const collected = await collectSubtree(root);
      expect(collected.ids.has(sibling.id)).toBe(false);
      expect(sibling.relPath.startsWith(rootSlug)).toBe(true); // the prefix trap is real...
      expect(collected.ids.has(childA.id)).toBe(true); // ...and the real children are still found
      expect(collected.ids.has(grandchild.id)).toBe(true);
    });

    it('collation order is tree order, depth-first, parent before children', async () => {
      const collected = await collectSubtree(root);
      expect(collected.pages.map((p) => p.entry.title)).toEqual(['Foo', 'Alpha', 'Deep', 'Beta']);
      expect(collected.pages.map((p) => p.depth)).toEqual([0, 1, 2, 1]);
    });

    it('child headings are demoted by depth, and `flatten=0` leaves them alone', async () => {
      const collected = await collectSubtree(root);

      const demoted = await assembleMarkdown(collected, { baseUrl: BASE });
      expect(demoted.markdown).toContain('# Foo');
      expect(demoted.markdown).toContain('## Alpha');
      expect(demoted.markdown).toContain('### Deep');
      expect(demoted.markdown).toContain('## Beta');

      const flat = await assembleMarkdown(collected, { baseUrl: BASE, flatten: false });
      expect(flat.markdown).toContain('# Alpha');
      expect(flat.markdown).not.toContain('## Alpha');
    });

    it('pages are separated by `---`', async () => {
      const out = await assembleMarkdown(await collectSubtree(root), { baseUrl: BASE });
      expect(out.markdown.split('\n---\n').length).toBe(4); // 4 pages -> 3 separators
    });

    it('a link between two included pages becomes an in-document anchor; a link out stays an absolute URL', async () => {
      const linker = await makeDoc(
        space,
        rootSlug,
        'Linker',
        ['# Linker', '', `[to alpha](${childA.relPath.split('/').pop()})`, '', `[to sibling](../${sibling.relPath})`].join('\n'),
      );
      const collected = await collectSubtree(root);
      expect(collected.ids.has(linker.id)).toBe(true);

      const out = await assembleMarkdown(collected, { baseUrl: BASE });
      expect(out.markdown).toContain('[to alpha](#alpha)');
      expect(out.markdown).toContain(`[to sibling](${BASE}/s/${space}/p/${sibling.id})`);

      await storage.deletePage(linker.id);
    });

    it('descends PAST storage.getSubtree\'s own depth cap by re-rooting the same function', async () => {
      // getSubtree stops at SUBTREE_MAX_DEPTH (5) because that is all the
      // ::pagetree directive ever needs. An export needs the whole subtree, and
      // the spec forbids a second traversal algorithm — so collect.ts re-roots
      // getSubtree at the cap. This fixture is one level deeper than the cap.
      const deepRoot = await makeDoc(space, '', `Deep Root ${Date.now()}`, '# L0\n\nlevel 0\n');
      let parentPath = deepRoot.relPath.replace(/\.md$/, '');
      const levels = storage.SUBTREE_MAX_DEPTH + 1;
      for (let i = 1; i <= levels; i++) {
        const page = await makeDoc(space, parentPath, `L${i}`, `# L${i}\n\nlevel ${i}\n`);
        parentPath = `${parentPath}/${page.relPath.split('/').pop()!.replace(/\.md$/, '')}`;
      }

      const collected = await collectSubtree(deepRoot);
      expect(collected.pages.map((p) => p.depth)).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(collected.pages.at(-1)!.entry.title).toBe(`L${levels}`);

      const out = await assembleMarkdown(collected, { baseUrl: BASE });
      expect(out.markdown).toContain(`level ${levels}`);
      expect(out.markdown).toContain(`###### L${levels}`); // demotion clamps at H6

      await deletePageTree(deepRoot);
    });

    it('heading anchors are deduplicated across the WHOLE assembled document', async () => {
      const dupRoot = await makeDoc(space, '', `Dup ${Date.now()}`, '# Overview\n\nroot\n');
      const dupSlug = dupRoot.relPath.replace(/\.md$/, '');
      await makeDoc(space, dupSlug, 'One', '# Overview\n\none\n');
      await makeDoc(space, dupSlug, 'Two', '# Overview\n\ntwo\n');

      const out = await assembleMarkdown(await collectSubtree(dupRoot), { baseUrl: BASE, flatten: false });
      // First keeps its natural anchor; the other two get explicit, unique ones.
      expect(out.markdown).toContain('<a id="overview-1"></a>');
      expect(out.markdown).toContain('<a id="overview-2"></a>');
      expect(out.markdown).not.toContain('<a id="overview"></a>');
      expect((out.markdown.match(/<a id="overview-\d"><\/a>/g) ?? []).length).toBe(2);

      await deletePageTree(dupRoot);
    });
  });

  // -------------------------------------------------------------------------

  describe('limits', () => {
    it('the shipped defaults are the ones the spec names', () => {
      expect(MAX_EXPORT_PAGES).toBe(200);
      expect(MAX_EXPORT_BYTES).toBe(5 * 1024 * 1024);
    });

    it('the page cap truncates with an EXPLICIT marker and an accurate omitted count', async () => {
      const capRoot = await makeDoc(space, '', `Cap ${Date.now()}`, '# Cap\n\nroot\n');
      const capSlug = capRoot.relPath.replace(/\.md$/, '');
      for (const name of ['C1', 'C2', 'C3', 'C4']) await makeDoc(space, capSlug, name, `# ${name}\n\nbody\n`);

      const full = await collectSubtree(capRoot);
      expect(full.pages.length).toBe(5);
      expect(full.truncation).toBeNull();

      const capped = await collectSubtree(capRoot, 3);
      expect(capped.pages.length).toBe(3);
      expect(capped.truncation).toMatchObject({ reason: 'pages', omittedPages: 2 });

      const out = await assembleMarkdown(capped, { baseUrl: BASE });
      expect(out.markdown).toContain('<!-- folio-export: TRUNCATED (pages)');
      expect(out.markdown).toContain('2 page(s) omitted');
      expect(out.pageCount).toBe(3);
      expect(out.truncation?.reason).toBe('pages');

      await deletePageTree(capRoot);
    });

    it('the byte cap stops the collation and says so, instead of silently returning half', async () => {
      const bigRoot = await makeDoc(space, '', `Big ${Date.now()}`, `# Big\n\n${'x'.repeat(4000)}\n`);
      const bigSlug = bigRoot.relPath.replace(/\.md$/, '');
      await makeDoc(space, bigSlug, 'Big One', `# Big One\n\n${'y'.repeat(4000)}\n`);
      await makeDoc(space, bigSlug, 'Big Two', `# Big Two\n\n${'z'.repeat(4000)}\n`);

      const out = await assembleMarkdown(await collectSubtree(bigRoot), { baseUrl: BASE, maxBytes: 6000 });
      expect(out.pageCount).toBe(1); // root always goes in whole; the rest didn't fit
      expect(out.truncation).toMatchObject({ reason: 'bytes', omittedPages: 2 });
      expect(out.markdown).toContain('<!-- folio-export: TRUNCATED (bytes)');

      await deletePageTree(bigRoot);
    });
  });

  // -------------------------------------------------------------------------

  describe('boards (R23 addendum 3)', () => {
    it('a board child contributes BOTH the image and the extracted scene text, in reading order', async () => {
      const boardRoot = await makeDoc(space, '', `Board Root ${Date.now()}`, '# Board Root\n\nroot\n');
      const rootSlug = boardRoot.relPath.replace(/\.md$/, '');
      const board = await storage.createPage({ space, parentPath: rootSlug, title: 'Architecture', kind: 'board' });
      await storage.writeBoardSvg(
        board.id,
        sceneSvg([
          { id: 'f1', type: 'frame', x: 0, y: 0, width: 400, height: 200, name: 'Backend', isDeleted: false },
          textElement('t3', 10, 300, 'standalone note'),
          textElement('t2', 200, 40, 'queue', 'f1'),
          textElement('t1', 10, 40, 'api gateway', 'f1'),
        ]),
        true,
      );

      const out = await assembleMarkdown(await collectSubtree(boardRoot), { baseUrl: BASE });
      const boardEntry = await entryFor(board.id);

      // A board carries its title in the `folio-title` header comment (it has no
      // frontmatter and no H1) — before QA-3 creation never wrote one, so the title
      // fell back to the filename stem and this expected the slug. The section
      // heading and the image alt are both exactly that title.
      expect(boardEntry.title).toBe('Architecture');
      expect(out.markdown).toContain(`![${boardEntry.title}](${BASE}/files/${space}/${boardEntry.relPath})`);
      expect(out.markdown).toContain(`## ${boardEntry.title}`); // section heading is the board page's title, demoted by depth
      expect(out.markdown).toContain('**Board structure:**');
      expect(out.markdown).toContain('```yaml');
      expect(out.markdown).toContain('name: Backend');
      // same y -> left-to-right
      expect(out.markdown.indexOf('api gateway')).toBeLessThan(out.markdown.indexOf('queue'));
      // framed content first, unframed after
      expect(out.markdown.indexOf('queue')).toBeLessThan(out.markdown.indexOf('standalone note'));

      await deletePageTree(boardRoot);
    });

    /**
     * The owner saw the "Board text (reading order)" list under a board in a
     * PDF and asked to remove it. This dump of captions exists for the MACHINE
     * reader — the MD export and the md link for an agent, where a picture is
     * useless. In PDF and DOCX the board is drawn, and a duplicate of the
     * captions under it is just noise.
     */
    it('omits the extracted board text when the caller asks for it (PDF/DOCX), keeping the picture', async () => {
      const board = await storage.createPage({ space, parentPath: '', title: `Quiet Board ${Date.now()}`, kind: 'board' });
      await storage.writeBoardSvg(board.id, sceneSvg([{ type: 'text', x: 0, y: 0, text: 'standalone note' }]), true);
      const entry = await entryFor(board.id);

      const forAgent = await assembleMarkdown(singlePage(entry), { baseUrl: BASE });
      expect(forAgent.markdown).toContain('**Board structure:**');
      expect(forAgent.markdown).toContain('standalone note');

      const forPrint = await assembleMarkdown(singlePage(entry), { baseUrl: BASE, boardText: false });
      expect(forPrint.markdown).not.toContain('**Board structure:**');
      expect(forPrint.markdown).not.toContain('standalone note');
      // ...but the board itself has to stay — we cut out the captions, not the picture.
      expect(forPrint.markdown).toContain(`![${entry.title}](${BASE}/files/${space}/${entry.relPath})`);

      await storage.deletePage(board.id);
    });

    it('a board with an EMPTY scene exports its picture and does not crash', async () => {
      const board = await storage.createPage({ space, parentPath: '', title: `Empty Board ${Date.now()}`, kind: 'board' });
      await storage.writeBoardSvg(board.id, sceneSvg([]), true);
      const entry = await entryFor(board.id);

      const out = await assembleMarkdown(singlePage(entry), { baseUrl: BASE });
      expect(out.markdown).toContain(`![${entry.title}](${BASE}/files/${space}/${entry.relPath})`);
      expect(out.markdown).not.toContain('**Board structure:**');

      await storage.deletePage(board.id);
    });

    it('a board whose SVG carries no payload at all still exports', async () => {
      const board = await storage.createPage({ space, parentPath: '', title: `No Payload ${Date.now()}`, kind: 'board' });
      await storage.writeBoardSvg(board.id, '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>\n', true);
      const entry = await entryFor(board.id);

      const out = await assembleMarkdown(singlePage(entry), { baseUrl: BASE });
      expect(out.markdown).toContain('![');
      await storage.deletePage(board.id);
    });
  });

  // -------------------------------------------------------------------------

  describe('data tables (R23 addendum 4)', () => {
    it('serializes to a GFM pipe table, expanding every column type to text', async () => {
      const page = await storage.createPage({ space, parentPath: '', title: `Roadmap ${Date.now()}`, kind: 'table' });
      const doc: TableDoc = {
        meta: { id: page.id, version: 1, rowIds: 'column' },
        head: '# Roadmap\n\nIntro prose.\n\n',
        tail: '\nTrailing prose.\n',
        columns: [
          { id: 'name', name: 'Name', type: 'text' },
          { id: 'due', name: 'Due', type: 'date' },
          { id: 'done', name: 'Done', type: 'checkbox' },
          { id: 'tags', name: 'Tags', type: 'select', multiple: true, options: [{ value: 'api', color: 'blue' }, { value: 'ui', color: 'green' }] },
          { id: 'ref', name: 'Ref', type: 'link' },
          { id: 'hidden', name: 'Hidden', type: 'text' },
        ],
        views: [
          {
            id: 'v1',
            name: 'All',
            columns: { hidden: ['hidden'], order: ['name', 'due', 'done', 'tags', 'ref'], width: {} },
            sort: [{ column: 'name', dir: 'asc' }],
            filter: { op: 'and', rules: [] },
            frozen: 0,
            rowHeight: 'short',
          },
        ],
        rows: [
          { id: 'r2', values: { name: 'Beta', due: '2026-02-01', done: false, tags: ['ui'], ref: 'https://plain.example', hidden: 'nope' } },
          { id: 'r1', values: { name: 'Alpha', due: '2026-01-15', done: true, tags: ['api', 'ui'], ref: '[docs](https://d.example)', hidden: 'nope' } },
        ],
      };
      await storage.writeTableDoc(page.id, doc);

      const out = await assembleMarkdown(singlePage(await entryFor(page.id)), { baseUrl: BASE });

      expect(out.markdown).toContain('| Name | Due | Done | Tags | Ref |');
      expect(out.markdown).not.toContain('Hidden'); // the view hides it
      expect(out.markdown).toContain('Intro prose.');
      expect(out.markdown).toContain('Trailing prose.');
      // sorted by name asc — Alpha before Beta, despite the file order
      expect(out.markdown.indexOf('| Alpha ')).toBeLessThan(out.markdown.indexOf('| Beta '));
      expect(out.markdown).toContain('| Alpha | 2026-01-15 | [x] | api, ui | [docs](https://d.example) |');
      // a bare URL still comes out as a real markdown link
      expect(out.markdown).toContain('| Beta | 2026-02-01 | [ ] | ui | [https://plain.example](https://plain.example) |');

      await storage.deletePage(page.id);
    });

    // QA-3 P2: three rows in a table with no user columns exported as a
    // 21-byte "# Title\n" — the rows were dropped with no marker at all,
    // while the YAML exporter honestly reported them. Rows are data; the
    // export now falls back to the one column such a table still has.
    it('a table with rows but NO user columns exports the rows under a synthetic id column, never silently', async () => {
      const page = await storage.createPage({ space, parentPath: '', title: `Columnless ${Date.now()}`, kind: 'table' });
      const doc: TableDoc = {
        meta: { id: page.id, version: 1, rowIds: 'column' },
        head: '# Columnless\n\n',
        tail: '',
        columns: [],
        views: [],
        rows: [{ id: 'row-aaa', values: {} }, { id: 'row-bbb', values: {} }, { id: 'row-ccc', values: {} }],
      };
      await storage.writeTableDoc(page.id, doc);

      const { tableDocToMarkdown, ROW_ID_COLUMN } = await import('./tableMarkdown.js');
      const result = tableDocToMarkdown(await storage.readFreshTableDoc(page.id), {});
      expect(result.markdown).toContain(`| ${ROW_ID_COLUMN} |`);
      for (const id of ['row-aaa', 'row-bbb', 'row-ccc']) expect(result.markdown).toContain(`| ${id} |`);

      // and through the real export route's assembly, not just the helper
      const out = await assembleMarkdown(singlePage(await entryFor(page.id)), { baseUrl: BASE });
      expect(out.markdown).toContain('row-ccc');

      await storage.deletePage(page.id);
    });

    it('a view that hides EVERY column still exports its rows rather than an empty document', async () => {
      const page = await storage.createPage({ space, parentPath: '', title: `All Hidden ${Date.now()}`, kind: 'table' });
      const doc: TableDoc = {
        meta: { id: page.id, version: 1, rowIds: 'column' },
        head: '# All Hidden\n\n',
        tail: '',
        columns: [{ id: 'n', name: 'N', type: 'text' }],
        views: [
          { id: 'v1', name: 'Nothing', columns: { hidden: ['n'], order: ['n'], width: {} }, sort: [], filter: { op: 'and', rules: [] }, frozen: 0, rowHeight: 'short' },
        ],
        rows: [{ id: 'hid-1', values: { n: 'one' } }],
      };
      await storage.writeTableDoc(page.id, doc);

      const { tableDocToMarkdown } = await import('./tableMarkdown.js');
      const result = tableDocToMarkdown(await storage.readFreshTableDoc(page.id), {});
      expect(result.markdown).toContain('| hid-1 |');
      expect(result.markdown).not.toContain('| N |'); // the hidden column stays hidden
      expect(result.markdown).not.toContain('one');

      await storage.deletePage(page.id);
    });

    it('a columnless table with NO rows still exports prose only — nothing invented', async () => {
      const page = await storage.createPage({ space, parentPath: '', title: `Columnless Empty ${Date.now()}`, kind: 'table' });
      const { tableDocToMarkdown, ROW_ID_COLUMN } = await import('./tableMarkdown.js');
      const doc = await storage.readFreshTableDoc(page.id);
      const result = tableDocToMarkdown({ ...doc, columns: [], views: [], rows: [] }, {});
      expect(result.markdown).not.toContain(`| ${ROW_ID_COLUMN} |`);
      await storage.deletePage(page.id);
    });

    it('an empty table does not crash the export', async () => {
      const page = await storage.createPage({ space, parentPath: '', title: `Empty Table ${Date.now()}`, kind: 'table' });
      const entry = await entryFor(page.id);
      const out = await assembleMarkdown(singlePage(entry), { baseUrl: BASE });
      expect(out.markdown).toContain(entry.title);
      expect(out.truncation).toBeNull();
      await storage.deletePage(page.id);
    });

    it('a table with more rows than the cap truncates with an explicit marker', async () => {
      const page = await storage.createPage({ space, parentPath: '', title: `Big Table ${Date.now()}`, kind: 'table' });
      const doc: TableDoc = {
        meta: { id: page.id, version: 1, rowIds: 'column' },
        head: '# Big Table\n\n',
        tail: '',
        columns: [{ id: 'n', name: 'N', type: 'text' }],
        views: [
          { id: 'v1', name: 'All', columns: { hidden: [], order: [], width: {} }, sort: [], filter: { op: 'and', rules: [] }, frozen: 0, rowHeight: 'short' },
        ],
        rows: Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, values: { n: `row-${i}` } })),
      };
      await storage.writeTableDoc(page.id, doc);

      const { tableDocToMarkdown } = await import('./tableMarkdown.js');
      const result = tableDocToMarkdown(await storage.readFreshTableDoc(page.id), { rowCap: 5 });
      expect(result.truncation).toMatchObject({ reason: 'rows', omittedRows: 7 });
      expect(result.markdown).toContain('row-4');
      expect(result.markdown).not.toContain('row-5');

      await storage.deletePage(page.id);
    });
  });

  // -------------------------------------------------------------------------

  describe('pure helpers', () => {
    it('slugifyHeading keeps unicode letters (uk/ru headings must anchor)', () => {
      expect(slugifyHeading('Hello, World!')).toBe('hello-world');
      expect(slugifyHeading('Übersicht des Systems')).toBe('übersicht-des-systems');
      expect(slugifyHeading('!!!')).toBe('section');
    });

    it('headingPlainText strips inline markdown before slugging', () => {
      expect(headingPlainText('**Bold** and `code` and [link](x)')).toBe('Bold and code and link');
      expect(headingPlainText('Closing hashes ###')).toBe('Closing hashes');
    });
  });
});

/** Removes a page and everything under it (the test spaces are shared across cases). */
async function deletePageTree(root: { id: string; space: string; relPath: string }): Promise<void> {
  const collected = await collectForExport(await storage.requireEntry(root.id), true);
  for (const page of [...collected.pages].reverse()) {
    await storage.deletePage(page.entry.id).catch(() => {});
  }
}
