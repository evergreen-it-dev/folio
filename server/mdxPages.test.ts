/**
 * `.mdx` pages (Nimbus / Astro Starlight / Docusaurus docs): an `.mdx` file is a page like `.md` — scanned, titled
 * from its front matter, edited, renamed, moved, copied and linked — and what the editor does not understand in it
 * (ESM `import`/`export`, JSX components, `{expressions}`) comes back from a save byte for byte.
 *
 * The pages are real ones from github.com/cloudflare/nimbus (MIT, Copyright (c) 2025 Cloudflare, Inc.): see
 * shared/fixtures/nimbus. Real PG + real git, the "remote" being a local bare repo (see lightFootprint.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import * as storage from './storage.js';
import * as git from './git.js';
import { query } from './db/pool.js';
import { markdownLinkCandidates, appDirCandidates, tolerantLinkPaths } from './indexV2/resolve.js';
import { targetNameKeys } from './indexV2/store.js';
import { childPrefixOf } from './access/pageTree.js';
import { childPrefixSql } from './access/roleSql.js';

git.__allowLocalRepoPathsForTests();
const execFileAsync = promisify(execFile);
const RUN = `mdx-${Date.now().toString(36)}`;
const createdSlugs = new Set<string>();
const tmpDirs: string[] = [];

const fixture = async (name: string): Promise<string> => fs.readFile(new URL(`../shared/fixtures/nimbus/${name}.mdx`, import.meta.url), 'utf8');

async function seededBareRepo(files: Record<string, string>): Promise<string> {
  const bare = path.join(os.tmpdir(), `folio-${RUN}-${Math.random().toString(36).slice(2, 8)}.git`);
  const seed = `${bare}-seed`;
  tmpDirs.push(bare, seed);
  await execFileAsync('git', ['init', '--bare', '-b', 'main', bare]);
  await fs.mkdir(seed, { recursive: true });
  await git.initWithCommit(seed, 'seed placeholder');
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(seed, rel)), { recursive: true });
    await fs.writeFile(path.join(seed, rel), content, 'utf8');
  }
  await git.commitAll(seed, 'seed', { name: 'Tester', email: 't@example.test' });
  await execFileAsync('git', ['remote', 'add', 'origin', bare], { cwd: seed });
  await git.push(seed, 'main');
  return bare;
}

async function connect(name: string, files: Record<string, string>, rootPath: string) {
  const bare = await seededBareRepo(files);
  const info = await storage.createSpaceFromRepo({ name, repoUrl: bare, branch: 'main', rootPath, createdBy: null });
  createdSlugs.add(info.slug);
  return { slug: info.slug, repo: storage.getRepoDir(info.slug), content: storage.getSpaceDir(info.slug) };
}

async function idsByPath(slug: string): Promise<Map<string, string>> {
  const rows = await query<{ id: string; path: string }>('SELECT id, path FROM pages_index WHERE space_slug = $1', [slug]);
  return new Map(rows.map((r) => [r.path, r.id]));
}

describe('.mdx pages (real PG + git)', () => {
  let teardownSchema: () => Promise<void>;
  let SEED: Record<string, string>;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    SEED = {
      'package.json': '{"name":"site"}\n',
      'src/content/docs/index.mdx': await fixture('index'),
      'src/content/docs/concepts/forecasts.mdx': await fixture('forecasts'),
      'src/content/docs/guides/writing-pages.mdx': await fixture('writing-pages'),
      'src/content/docs/components/code-group.mdx': await fixture('code-group'),
      'src/content/docs/notes/plain.md': '# Plain\n\nA Markdown page next to MDX ones.\n',
      'src/content/docs/notes/other.mdx': '---\ntitle: Other\n---\n\nSecond MDX page in a mixed folder.\n',
    };
  });
  afterAll(async () => {
    for (const slug of createdSlugs) await deleteTestSpace(slug);
    for (const dir of tmpDirs) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await teardownSchema();
  });

  it('opens every .mdx file as a page, titled from its front matter, with index.mdx as the space home; the repo stays untouched', async () => {
    const { slug, repo, content } = await connect(`${RUN} Docs`, SEED, 'src/content/docs');
    const ids = await idsByPath(slug);
    expect([...ids.keys()].sort()).toEqual([
      'components/code-group.mdx',
      'concepts/forecasts.mdx',
      'guides/writing-pages.mdx',
      'index.mdx',
      'notes/other.mdx',
      'notes/plain.md',
    ]);
    const entries = new Map((await storage.listEntries(slug)).map((e) => [e.relPath, e]));
    expect(entries.get('concepts/forecasts.mdx')?.kind).toBe('doc');
    expect(entries.get('concepts/forecasts.mdx')?.title).toBe('How forecasts are made');
    expect(entries.get('guides/writing-pages.mdx')?.title).toBe('Writing pages');
    expect(entries.get('index.mdx')?.isIndex).toBe(true);
    expect(entries.get('notes/other.mdx')?.isIndex).toBe(false);

    // the space home ("index.md" is what the UI asks for) is index.mdx
    expect((await storage.resolve(slug, 'index.md')).path).toBe('index.mdx');
    expect((await storage.resolve(slug, 'concepts/forecasts')).path).toBe('concepts/forecasts.mdx');

    // connecting wrote nothing into the pages
    for (const [rel, text] of Object.entries(SEED)) {
      if (!rel.startsWith('src/content/docs/')) continue;
      expect(await fs.readFile(path.join(repo, rel), 'utf8')).toBe(text);
    }
    const show = (await execFileAsync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: repo })).stdout.trim();
    expect(show).toBe(`src/content/docs/.${slug}.folio`);
    expect((await execFileAsync('git', ['status', '--porcelain'], { cwd: repo })).stdout.trim()).toBe('');
    expect(content.endsWith('src/content/docs')).toBe(true);
  }, 60_000);

  it('a save changes the paragraph and nothing else: import, JSX components, nested Tabs, expressions and front matter come back byte for byte', async () => {
    const { slug, content } = await connect(`${RUN} Edit`, SEED, 'src/content/docs');
    const ids = await idsByPath(slug);

    for (const rel of ['concepts/forecasts.mdx', 'components/code-group.mdx', 'guides/writing-pages.mdx']) {
      const file = path.join(content, rel);
      const before = await fs.readFile(file, 'utf8');
      const body = before.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
      const frontMatter = before.slice(0, before.length - body.length);
      // What the editor sends back is the body it showed; one sentence differs.
      const edited = body.replace(/\.\n/, '. Edited.\n');
      expect(edited).not.toBe(body);
      await storage.writeDocBody(ids.get(rel)!, edited);
      const after = await fs.readFile(file, 'utf8');
      expect(after).toBe(frontMatter + edited);
      expect(after.replace('. Edited.\n', '.\n')).toBe(before);
    }
    // the file is still a `.mdx` one
    expect((await storage.getEntry(ids.get('concepts/forecasts.mdx')!))?.relPath).toBe('concepts/forecasts.mdx');
  }, 60_000);

  it('a new page is .mdx beside .mdx pages, .md in a mixed folder and in a space with no pages; a name taken by the other suffix is taken', async () => {
    const { slug, content } = await connect(`${RUN} New`, SEED, 'src/content/docs');
    // guides/ holds only .mdx
    const inMdx = await storage.createPage({ space: slug, parentPath: 'guides', title: 'Deploy', kind: 'doc' });
    expect(inMdx.path).toBe('guides/deploy.mdx');
    // a new .mdx page carries the `title` a site generator wants, and no `# Title` repeating it in the body
    expect(await fs.readFile(path.join(content, 'guides/deploy.mdx'), 'utf8')).toBe('---\ntitle: "Deploy"\n---\n');
    expect(inMdx.title).toBe('Deploy');
    // notes/ holds a .md and an .mdx
    const inMixed = await storage.createPage({ space: slug, parentPath: 'notes', title: 'Mixed', kind: 'doc' });
    expect(inMixed.path).toBe('notes/mixed.md');
    expect(await fs.readFile(path.join(content, 'notes/mixed.md'), 'utf8')).toBe('# Mixed\n');
    // a folder that does not exist yet takes the nearest folder's habit (the root is all-.mdx except notes/, which is not its own)
    const nested = await storage.createPage({ space: slug, parentPath: 'guides/advanced', title: 'Tuning', kind: 'doc' });
    expect(nested.path).toBe('guides/advanced/tuning.mdx');
    // `deploy.md` is the same name as `deploy.mdx`
    const clash = await storage.createPage({ space: slug, parentPath: 'notes', title: 'Other', kind: 'doc' });
    expect(clash.path).toBe('notes/other-2.md');

    const fresh = await storage.createSpace(`${RUN} Fresh`, null);
    createdSlugs.add(fresh.slug);
    const first = await storage.createPage({ space: fresh.slug, parentPath: '', title: 'Hello', kind: 'doc' });
    expect(first.path.endsWith('.md')).toBe(true);
  }, 60_000);

  it('rename, move and copy keep an .mdx page .mdx; the index page renames its folder', async () => {
    const { slug, content } = await connect(`${RUN} Ops`, SEED, 'src/content/docs');
    const ids = await idsByPath(slug);

    const renamed = await storage.renamePageSlug(ids.get('concepts/forecasts.mdx')!, 'how-forecasts-work');
    expect(renamed.meta.path).toBe('concepts/how-forecasts-work.mdx');
    expect((await fs.readFile(path.join(content, 'concepts/how-forecasts-work.mdx'), 'utf8')).includes('<Tabs syncKey="model">')).toBe(true);

    const moved = await storage.movePage(ids.get('guides/writing-pages.mdx')!, 'concepts');
    expect(moved.path).toBe('concepts/writing-pages.mdx');

    const copy = await storage.copyPage(ids.get('components/code-group.mdx')!, slug, 'concepts', undefined, false);
    expect(copy.path).toMatch(/^concepts\/.*\.mdx$/);
    expect(await fs.readFile(path.join(content, copy.path), 'utf8')).toContain('export const tsLoad');
  }, 60_000);
});

describe('.mdx in the pure path rules', () => {
  it('a link or folder route may name an .mdx page', () => {
    expect(markdownLinkCandidates('guides/deploy.mdx')).toEqual(['guides/deploy.mdx']);
    expect(markdownLinkCandidates('guides/deploy')).toEqual(
      expect.arrayContaining(['guides/deploy', 'guides/deploy/index.md', 'guides/deploy/index.mdx', 'guides/deploy.md', 'guides/deploy.mdx']),
    );
    expect(tolerantLinkPaths('x')).toEqual(['x.md', 'x.mdx']);
    expect(appDirCandidates('')).toEqual(['index.md', 'index.mdx', 'README.md', 'README.mdx']);
    expect(appDirCandidates('guides')).toEqual(expect.arrayContaining(['guides/index.mdx', 'guides.mdx']));
    expect(targetNameKeys('guides/deploy.mdx')).toEqual(expect.arrayContaining(['deploy.mdx', 'deploy']));
    expect(targetNameKeys('guides/index.mdx')).toEqual(expect.arrayContaining(['index.mdx', 'guides']));
  });

  it('the children of an .mdx page live in the same-named folder (page access inheritance, TS and SQL twins)', () => {
    expect(childPrefixOf({ path: 'guides/deploy.mdx', kind: 'doc', isIndex: false })).toBe('guides/deploy/');
    expect(childPrefixOf({ path: 'guides/deploy.md', kind: 'doc', isIndex: false })).toBe('guides/deploy/');
    expect(childPrefixOf({ path: 'guides/index.mdx', kind: 'doc', isIndex: true })).toBe('guides/');
    expect(childPrefixSql('p')).toContain("'.mdx'");
  });
});
