/**
 * Files of a space (Obsidian brief, wave 3), real PG + real files: the scan
 * indexes every non-page file (assets/ included) incrementally, link and embed
 * targets resolve against that index (asset when the file exists, unresolved
 * when it does not), a repo-mode upload is indexed at once, and
 * GET /api/spaces/:space/files lists files with an ACL-aware `referencedBy`.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SpaceFilesResponse, User } from '../shared/contracts.js';
import { userViewer } from './accessSql.js';
import * as authStore from './auth/store.js';
import * as session from './auth/session.js';
import { query } from './db/pool.js';
import { deleteTestSpace, setUpTestSchema } from './db/testSchema.js';
import { HttpError } from './errors.js';
import { listUnresolvedLinks } from './indexV2/read.js';
import * as pageAccess from './pageAccess.js';
import { clampFilesLimit, normalizeFilesPrefix } from './spaceFiles.js';
import { registerSpaceFilesRoutes } from './spaceFilesRoutes.js';
import * as storage from './storage.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('authUser', null);
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
  });
  await app.register(fastifyCookieModule.default);
  await app.register(async (scope) => {
    scope.addHook('onRequest', session.requireSession);
    registerSpaceFilesRoutes(scope);
  });
  await app.ready();
  return app;
}

interface LinkRow {
  syntax: string;
  kind: string;
  target_path: string;
}

async function linksOf(sourceId: string): Promise<LinkRow[]> {
  return query<LinkRow>('SELECT syntax, kind, target_path FROM page_links WHERE source_page_id = $1 ORDER BY line, id', [sourceId]);
}

async function filesOf(space: string): Promise<string[]> {
  return (await query<{ path: string }>('SELECT path FROM space_files WHERE space_slug = $1 ORDER BY path COLLATE "C"', [space])).map((r) => r.path);
}

describe('files of a space: index, resolution, route (real PG)', () => {
  let teardownSchema: () => Promise<void>;
  let owner: User;
  let member: User;
  const spaces: string[] = [];

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const stamp = Date.now();
    owner = await authStore.createUser({ email: `files-owner-${stamp}@example.com`, name: 'Owner', passwordHash: 'x', isAdmin: false });
    member = await authStore.createUser({ email: `files-member-${stamp}@example.com`, name: 'Member', passwordHash: 'x', isAdmin: false });
  });
  afterAll(async () => {
    for (const slug of spaces) await deleteTestSpace(slug);
    await teardownSchema();
  });

  async function newSpace(name: string) {
    const slug = (await storage.createSpace(`${name} ${Date.now()}`, owner.id)).slug;
    spaces.push(slug);
    await authStore.setMembership(slug, owner.id, 'admin');
    await authStore.setMembership(slug, member.id, 'editor');
    const dir = storage.getSpaceDir(slug);
    return {
      slug,
      dir,
      put: async (rel: string, text: string) => {
        await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
        await fs.writeFile(path.join(dir, rel), text, 'utf8');
      },
      id: async (rel: string) => {
        const found = await storage.getEntryIdByExactPath(slug, rel);
        if (!found) throw new Error(`no page ${rel}`);
        return found;
      },
    };
  }

  it('the scan indexes every non-page file — assets/ included — and nothing hidden, Folio-owned, ignored or a page', async () => {
    const s = await newSpace('Files Scan');
    await s.put('assets/diagram.png', 'png');
    await s.put('assets/nested/notes.md', '# not a page inside assets\n');
    await s.put('assets/report.pdf', '%PDF-1.4 not a page inside assets');
    await s.put('notes/attachment.csv', 'a,b\n');
    await s.put('notes/page.md', '# A page\n');
    await s.put('notes/spec.pdf', '%PDF-1.4 a pdf page');
    await s.put('notes/.cache/thumb.png', 'hidden');
    await s.put('.hidden.png', 'hidden');
    await s.put('.obsidian/app.json', '{}');
    await s.put('.folio/site.json', '{}');
    await s.put('_templates/logo.svg', '<svg/>');
    await s.put('build/out.js', 'ignored');
    await s.put('readme.markdown', 'an unsupported dialect is still a file');
    await storage.setSpaceScanSettings(s.slug, { scanIgnore: ['build/'] });
    const stats = await storage.scanSpace(s.slug);

    expect(await filesOf(s.slug)).toEqual([
      '_templates/logo.svg',
      'assets/diagram.png',
      'assets/nested/notes.md',
      'assets/report.pdf',
      'notes/attachment.csv',
      'readme.markdown',
    ]);
    expect(stats.indexedFiles).toBe(6);
    // pages stay pages; nothing under assets/ became one
    expect(await storage.getEntryIdByExactPath(s.slug, 'notes/spec.pdf')).toBeTruthy();
    expect(await storage.getEntryIdByExactPath(s.slug, 'assets/nested/notes.md')).toBeUndefined();
    expect(await storage.getEntryIdByExactPath(s.slug, 'assets/report.pdf')).toBeUndefined();
    // the space's own `<slug>.folio` metadata file lives at this content root and is never listed
    expect((await fs.readdir(s.dir)).some((n) => n.endsWith('.folio'))).toBe(true);
  });

  it('is incremental: unchanged rows are not rewritten, a changed file is, a deleted one goes, a new one comes', async () => {
    const s = await newSpace('Files Incremental');
    await s.put('assets/a.png', 'a');
    await s.put('assets/b.png', 'b');
    await storage.scanSpace(s.slug);
    // A marker the scan would clear (an upsert resets sha256): rows the scan does not touch keep it.
    await query(`UPDATE space_files SET sha256 = 'marker' WHERE space_slug = $1`, [s.slug]);
    await storage.scanSpace(s.slug);
    expect((await query<{ sha256: string | null }>('SELECT sha256 FROM space_files WHERE space_slug = $1', [s.slug])).every((r) => r.sha256 === 'marker')).toBe(true);

    await s.put('assets/a.png', 'a, but longer now');
    await fs.rm(path.join(s.dir, 'assets/b.png'));
    await s.put('assets/c.png', 'c');
    await storage.scanSpace(s.slug);
    const rows = await query<{ path: string; size: string; sha256: string | null }>('SELECT path, size, sha256 FROM space_files WHERE space_slug = $1 ORDER BY path', [s.slug]);
    expect(rows.map((r) => [r.path, Number(r.size), r.sha256])).toEqual([
      ['assets/a.png', 'a, but longer now'.length, null],
      ['assets/c.png', 1, null],
    ]);
  });

  it('links and embeds resolve against the files: asset when the file exists (path normalized), unresolved when it does not; a file that appears or goes re-resolves them', async () => {
    const s = await newSpace('Files Resolve');
    await s.put('assets/img.png', 'png');
    await s.put('assets/x.png', 'png');
    await s.put('docs/guide/local.png', 'png');
    await s.put('Attachments/by-name.png', 'png');
    await s.put(
      'docs/guide/page.md',
      [
        '# Page',
        '',
        '![[img.png]] and ![[local.png|200]] and ![[missing.png]]',
        '![x](../../assets/x.png) ![y](local.png) ![z](../../assets/gone.png) ![n](by-name.png)',
        `![app](/files/${s.slug}/assets/img.png) [folder](../) [nowhere](nowhere/)`,
        '![[Later.pdf]]',
      ].join('\n') + '\n',
    );
    await s.put('root.md', '# Root\n\n![r](assets/x.png) ![[assets/img.png]]\n');
    await storage.scanSpace(s.slug);
    const pageId = await s.id('docs/guide/page.md');

    expect((await linksOf(pageId)).map((l) => `${l.syntax}:${l.kind}:${l.target_path}`)).toEqual([
      'embed:asset:assets/img.png', // the attachment basename rule
      'embed:asset:docs/guide/local.png', // nearest first: the file next to the note
      'embed:unresolved:missing.png', // an attachment kept as written, never `missing.png.md`
      'image:asset:assets/x.png',
      'image:asset:docs/guide/local.png',
      'image:unresolved:assets/gone.png',
      'image:asset:Attachments/by-name.png', // a markdown embed finds an attachment by its name too, as Obsidian does
      'image:asset:assets/img.png', // an app-absolute /files/<this space>/ URL is a path of the space
      'md:asset:docs', // a folder that holds pages or files
      'md:unresolved:docs/guide/nowhere',
      'embed:unresolved:Later.pdf',
    ]);
    expect((await linksOf(await s.id('root.md'))).map((l) => `${l.kind}:${l.target_path}`)).toEqual(['asset:assets/x.png', 'asset:assets/img.png']);

    // missing attachments are listed with the other unresolved links
    const unresolved = await listUnresolvedLinks(s.slug, userViewer(owner), { limit: 100, offset: 0 });
    expect(unresolved.links.map((l) => l.targetPath).sort()).toEqual(['Later.pdf', 'assets/gone.png', 'docs/guide/nowhere', 'missing.png'].sort());

    // a file that appears resolves the links waiting for it; one that goes turns them unresolved
    await s.put('later/missing.png', 'now here');
    await s.put('assets/gone.png', 'back');
    await fs.rm(path.join(s.dir, 'assets/x.png'));
    await storage.scanSpace(s.slug);
    const after = (await linksOf(pageId)).map((l) => `${l.kind}:${l.target_path}`);
    expect(after).toContain('asset:later/missing.png');
    expect(after).toContain('asset:assets/gone.png');
    expect(after).toContain('unresolved:assets/x.png');
    expect((await linksOf(await s.id('root.md'))).map((l) => `${l.kind}:${l.target_path}`)).toEqual(['unresolved:assets/x.png', 'asset:assets/img.png']);
  });

  it('a repo-mode upload is indexed at once: the embed saved right after resolves without a rescan', async () => {
    const s = await newSpace('Files Upload');
    const page = await storage.createPage({ space: s.slug, parentPath: '', title: 'Upload', kind: 'doc' });
    const saved = await storage.saveAssetIntoRepo(s.slug, 'Shot 1.png', Buffer.from('png'));
    expect(await filesOf(s.slug)).toContain(saved.path);
    await storage.writeDocBody(page.id, `# Upload\n\n![shot](${saved.path.replace(/ /g, '%20')}) ![app](${saved.url})\n`);
    expect((await linksOf(page.id)).map((l) => `${l.kind}:${l.target_path}`)).toEqual([`asset:${saved.path}`, `asset:${saved.path}`]);
  });

  describe('GET /api/spaces/:space/files', () => {
    let app: FastifyInstance;
    let s: Awaited<ReturnType<typeof newSpace>>;
    let ownerAuth: Record<string, string>;
    let memberAuth: Record<string, string>;
    const cookie = async (user: User) => ({ cookie: `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(user.id)).token}` });

    beforeAll(async () => {
      app = await buildApp();
      s = await newSpace('Files Route');
      await s.put('assets/shared.png', 'shared');
      await s.put('assets/secret.png', 'secret');
      await s.put('assets/unused.png', 'unused');
      await s.put('assets/Deep/Photo.JPG', 'deep');
      await s.put('docs/data.csv', 'a,b');
      await s.put('open.md', '# Open\n\n![s](assets/shared.png) ![s again](assets/shared.png) ![[data.csv]]\n');
      await s.put('restricted.md', '# Restricted\n\n![s](assets/shared.png) ![x](assets/secret.png)\n');
      await s.put('_templates/tpl.md', '# Template\n\n![s](../assets/shared.png)\n');
      await storage.scanSpace(s.slug);
      await pageAccess.setAccess(owner, (await storage.getEntry(await s.id('restricted.md')))!, 'restricted', []);
      ownerAuth = await cookie(owner);
      memberAuth = await cookie(member);
    });
    afterAll(async () => {
      await app.close();
    });

    const get = async (url: string, headers: Record<string, string>) => {
      const res = await app.inject({ method: 'GET', url, headers });
      return { status: res.statusCode, body: res.json() as SpaceFilesResponse & { error?: string } };
    };

    it('lists files with size, date and the number of readable pages referencing them; a file only hidden pages reference is hidden', async () => {
      const ownerList = await get(`/api/spaces/${s.slug}/files`, ownerAuth);
      expect(ownerList.status).toBe(200);
      expect(ownerList.body.total).toBe(5);
      expect(ownerList.body.files.map((f) => [f.path, f.referencedBy])).toEqual([
        ['assets/Deep/Photo.JPG', 0],
        ['assets/secret.png', 1],
        ['assets/shared.png', 2], // open + restricted; the template is not counted, the double embed is one page
        ['assets/unused.png', 0],
        ['docs/data.csv', 1],
      ]);
      const shared = ownerList.body.files.find((f) => f.path === 'assets/shared.png')!;
      expect(shared.size).toBe('shared'.length);
      expect(new Date(shared.updatedAt).toString()).not.toBe('Invalid Date');

      const memberList = await get(`/api/spaces/${s.slug}/files`, memberAuth);
      expect(memberList.body.total).toBe(4);
      expect(memberList.body.files.map((f) => [f.path, f.referencedBy])).toEqual([
        ['assets/Deep/Photo.JPG', 0],
        ['assets/shared.png', 1],
        ['assets/unused.png', 0],
        ['docs/data.csv', 1],
      ]);
    });

    it('filters by folder prefix and a case-insensitive substring, pages with limit/offset, and answers 403 outside the space', async () => {
      expect((await get(`/api/spaces/${s.slug}/files?prefix=assets`, ownerAuth)).body.files.map((f) => f.path)).toEqual([
        'assets/Deep/Photo.JPG',
        'assets/secret.png',
        'assets/shared.png',
        'assets/unused.png',
      ]);
      expect((await get(`/api/spaces/${s.slug}/files?prefix=/assets/Deep/`, ownerAuth)).body.files.map((f) => f.path)).toEqual(['assets/Deep/Photo.JPG']);
      expect((await get(`/api/spaces/${s.slug}/files?q=PHOTO`, ownerAuth)).body.files.map((f) => f.path)).toEqual(['assets/Deep/Photo.JPG']);
      const page2 = await get(`/api/spaces/${s.slug}/files?limit=2&offset=2`, ownerAuth);
      expect(page2.body.total).toBe(5);
      expect(page2.body.files.map((f) => f.path)).toEqual(['assets/shared.png', 'assets/unused.png']);

      const outsider = await authStore.createUser({ email: `files-out-${Date.now()}@example.com`, name: 'Out', passwordHash: 'x', isAdmin: false });
      expect((await get(`/api/spaces/${s.slug}/files`, await cookie(outsider))).status).toBe(403);
      expect((await get(`/api/spaces/no-such-space-${Date.now()}/files`, ownerAuth)).status).toBe(404);
    });

    it('clamps limit and normalizes the prefix', () => {
      expect(clampFilesLimit(undefined)).toBe(100);
      expect(clampFilesLimit('0')).toBe(1);
      expect(clampFilesLimit('9999')).toBe(500);
      expect(normalizeFilesPrefix('')).toBe('');
      expect(normalizeFilesPrefix('/assets')).toBe('assets/');
      expect(normalizeFilesPrefix('assets//img/')).toBe('assets/img/');
    });
  });
});
