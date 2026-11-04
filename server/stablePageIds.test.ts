/**
 * Stable page ids (the public demo, 03.11.2026): a link to a page must survive a rebuilt index, a re-seeded demo and
 * a page that had no id in its file. Real PG, real files; the public side through fastify inject.
 *
 *  1. a page without an `id` in its file gets the id of its path (never a random one), and keeps it
 *  2. an index rebuilt from the repository hands every page the same id back
 *  3. FOLIO_STABLE_IDS: a space re-created by the same script gets the same ids (home, doc, table, board, form + its table)
 *  4. an old, derived id resolves to the page it meant (storage.findMovedPage), the app route and the public site
 *     (JSON payload, 301 for the HTML and the Markdown copy)
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PublicPagePayload, User } from '../shared/contracts.js';
import * as authStore from './auth/store.js';
import * as session from './auth/session.js';
import { query } from './db/pool.js';
import { deleteTestSpace, setUpTestSchema } from './db/testSchema.js';
import { HttpError } from './errors.js';
import { registerPublicLlmsRoutes } from './publicLlms.js';
import { resolvePublicSiteHead } from './publicSiteMeta.js';
import { registerPublicSiteRoutes } from './publicSiteRoutes.js';
import { registerRoutes } from './routes.js';
import { invalidatePublicSiteCache } from './publicSites.js';
import * as storage from './storage.js';

const RUN = `sid-${Date.now().toString(36)}`;
const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const ORIGIN = 'https://folio.example.com';

async function idsByPath(space: string): Promise<Map<string, string>> {
  const rows = await query<{ id: string; path: string }>('SELECT id, path FROM pages_index WHERE space_slug = $1', [space]);
  return new Map(rows.map((r) => [r.path, r.id]));
}
async function rebuildIndex(space: string): Promise<void> {
  await query('DELETE FROM pages_index WHERE space_slug = $1', [space]);
  await storage.scanSpace(space);
}

describe('stable page ids (real PG)', () => {
  const savedUrl = process.env.PUBLIC_URL;
  const savedStable = process.env.FOLIO_STABLE_IDS;
  let teardownSchema: () => Promise<void>;
  let admin: User;
  const spaces: string[] = [];

  beforeAll(async () => {
    process.env.PUBLIC_URL = ORIGIN;
    delete process.env.FOLIO_STABLE_IDS;
    teardownSchema = await setUpTestSchema();
    admin = await authStore.createUser({ email: `${RUN}@example.com`, name: 'Stable Ids', passwordHash: 'x', isAdmin: true });
  });
  afterAll(async () => {
    for (const space of spaces) await deleteTestSpace(space).catch(() => {});
    await teardownSchema();
    if (savedUrl === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = savedUrl;
    if (savedStable === undefined) delete process.env.FOLIO_STABLE_IDS;
    else process.env.FOLIO_STABLE_IDS = savedStable;
  });

  async function newSpace(name: string): Promise<string> {
    const slug = (await storage.createSpace(`${RUN} ${name}`, admin.id)).slug;
    spaces.push(slug);
    await authStore.setMembership(slug, admin.id, 'admin');
    return slug;
  }

  it('stableUlid is a pure, ULID-shaped function of space + path', () => {
    const a = storage.stableUlid('s', 'a/b.md');
    expect(a).toMatch(ULID_RE);
    expect(storage.stableUlid('s', 'a/b.md')).toBe(a);
    expect(storage.stableUlid('s', 'a/c.md')).not.toBe(a);
    expect(storage.stableUlid('t', 'a/b.md')).not.toBe(a);
    expect(storage.stableUlid('s', 'a/b.md', 1)).not.toBe(a);
  });

  it('a doc and a board found on disk without an id get the id of their path, written into the file, and keep it after an index rebuild', async () => {
    const space = await newSpace('Found files');
    const dir = storage.getSpaceDir(space);
    await fs.mkdir(path.join(dir, 'notes'), { recursive: true });
    await fs.writeFile(path.join(dir, 'notes', 'plain.md'), '# Plain\n\nNo front matter at all.\n');
    await fs.writeFile(path.join(dir, 'sketch.excalidraw.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>\n');
    await storage.scanSpace(space);

    const first = await idsByPath(space);
    expect(first.get('notes/plain.md')).toBe(storage.stableUlid(space, 'notes/plain.md'));
    expect(first.get('sketch.excalidraw.svg')).toBe(storage.stableUlid(space, 'sketch.excalidraw.svg'));
    expect(await fs.readFile(path.join(dir, 'notes', 'plain.md'), 'utf8')).toContain(`id: ${first.get('notes/plain.md')}`);

    // The index is rebuilt (a fresh database on the same files) - the same ids come back.
    await rebuildIndex(space);
    expect(await idsByPath(space)).toEqual(first);

    // ...and even if the id is wiped from the file first: the file at that path is the same page.
    const raw = await fs.readFile(path.join(dir, 'notes', 'plain.md'), 'utf8');
    await fs.writeFile(path.join(dir, 'notes', 'plain.md'), raw.replace(/^---\n[\s\S]*?\n---\n/, ''));
    await storage.scanSpace(space);
    expect((await idsByPath(space)).get('notes/plain.md')).toBe(first.get('notes/plain.md'));
  });

  it('a page created in the app keeps its (random) id through an index rebuild: the id lives in the file', async () => {
    const space = await newSpace('Created pages');
    const page = await storage.createPage({ space, parentPath: '', title: 'Roadmap', kind: 'doc' });
    const board = await storage.createPage({ space, parentPath: '', title: 'Plan', kind: 'board' });
    const table = await storage.createPage({ space, parentPath: '', title: 'Tasks', kind: 'table' });
    expect(page.id).not.toBe(storage.stableUlid(space, page.path));
    await rebuildIndex(space);
    const after = await idsByPath(space);
    expect([...after.values()]).toEqual(expect.arrayContaining([page.id, board.id, table.id]));
  });

  it('FOLIO_STABLE_IDS: a space rebuilt by the same script gets the same ids, kind by kind', async () => {
    process.env.FOLIO_STABLE_IDS = '1';
    try {
      const name = `${RUN} Demo`;
      const build = async () => {
        const slug = (await storage.createSpace(name, admin.id, { starterTemplates: true })).slug;
        if (!spaces.includes(slug)) spaces.push(slug);
        const made = {
          doc: await storage.createPage({ space: slug, parentPath: '', title: 'Getting started', kind: 'doc' }),
          nested: await storage.createPage({ space: slug, parentPath: 'guides', title: 'Deep page', kind: 'doc' }),
          table: await storage.createPage({ space: slug, parentPath: '', title: 'Backlog', kind: 'table' }),
          board: await storage.createPage({ space: slug, parentPath: '', title: 'Whiteboard', kind: 'board' }),
          form: await storage.createPage({ space: slug, parentPath: '', title: 'Feedback', kind: 'form' }),
        };
        const fromTable = await storage.createFormFromTable(made.table.id);
        return { slug, made, fromTable, all: await idsByPath(slug) };
      };
      const first = await build();
      await deleteTestSpace(first.slug); // the reset: database rows and repository gone
      const second = await build();

      expect(second.slug).toBe(first.slug);
      expect(second.all).toEqual(first.all); // every path, including the home page, the starter templates and the form's own table
      for (const key of ['doc', 'nested', 'table', 'board', 'form'] as const) expect(second.made[key].id).toBe(first.made[key].id);
      expect(second.fromTable.id).toBe(first.fromTable.id);
      expect(new Set(first.all.values()).size).toBe(first.all.size); // distinct pages, distinct ids
      for (const id of first.all.values()) expect(id).toMatch(ULID_RE);
    } finally {
      delete process.env.FOLIO_STABLE_IDS;
    }
  });

  it('without FOLIO_STABLE_IDS a deleted page and a new one at its path do not share an id', async () => {
    const space = await newSpace('Plain ids');
    const a = await storage.createPage({ space, parentPath: '', title: 'Same name', kind: 'doc' });
    await storage.deletePage(a.id);
    const b = await storage.createPage({ space, parentPath: '', title: 'Same name', kind: 'doc' });
    expect(b.id).not.toBe(a.id);
  });

  describe('an old derived id points at the page it meant', () => {
    let space: string;
    let oldId: string;
    let current: storage.PageIndexEntry;
    const NEW_ID = '01HZZZZZZZZZZZZZZZZZZZZZZZ';

    beforeAll(async () => {
      space = await newSpace('Moved ids');
      const file = path.join(storage.getSpaceDir(space), 'board.md');
      await fs.writeFile(file, '# Board notes\n\nNo id yet.\n');
      await storage.scanSpace(space);
      oldId = storage.stableUlid(space, 'board.md');
      expect((await idsByPath(space)).get('board.md')).toBe(oldId);
      // The page is re-indexed elsewhere with an id its file carries now (another instance, a git pull): the old link is unknown.
      const raw = await fs.readFile(file, 'utf8');
      await fs.writeFile(file, raw.replace(`id: ${oldId}`, `id: ${NEW_ID}`));
      await rebuildIndex(space);
      current = await storage.requireEntry(NEW_ID);
      invalidatePublicSiteCache();
    });

    it('findMovedPage: by the path-derived id, in any of its shapes; nothing for a stranger', async () => {
      expect((await storage.findMovedPage(space, oldId))?.id).toBe(NEW_ID);
      const docHash = `doc-${createHash('sha1').update(`${space}\0board.md`).digest('hex').slice(0, 24)}`;
      expect((await storage.findMovedPage(space, docHash))?.id).toBe(NEW_ID);
      expect(await storage.findMovedPage(space, '01H0000000000000000000000X')).toBeUndefined();
      expect(await storage.findMovedPage(space, 'not-an-id')).toBeUndefined();
      expect(await storage.findMovedPage(space, NEW_ID)).toBeUndefined(); // a live id is not "moved"
      expect(await storage.findMovedPage(`${space}-other`, oldId)).toBeUndefined();
    });

    it('the app route follows an old id for a member and tells a stranger nothing', async () => {
      const member = await authStore.createUser({ email: `${RUN}-member@example.com`, name: 'Member', passwordHash: 'x', isAdmin: false });
      const stranger = await authStore.createUser({ email: `${RUN}-stranger@example.com`, name: 'Stranger', passwordHash: 'x', isAdmin: false });
      await authStore.setMembership(space, member.id, 'viewer');
      const cookieOf = async (user: User) => `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(user.id)).token}`;
      const app = Fastify();
      app.decorateRequest('authUser', null);
      app.setErrorHandler((err, _request, reply) => {
        if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
        return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
      });
      await app.register(fastifyCookieModule.default);
      await app.register(async (scope) => {
        scope.addHook('onRequest', session.requireSession);
        registerRoutes(scope);
      });
      await app.ready();
      try {
        const asMember = await app.inject({ method: 'GET', url: `/api/spaces/${space}/moved-page/${oldId}`, headers: { cookie: await cookieOf(member) } });
        expect(asMember.statusCode).toBe(200);
        expect((asMember.json() as { id: string }).id).toBe(NEW_ID);
        const missing = await app.inject({ method: 'GET', url: `/api/spaces/${space}/moved-page/01H0000000000000000000000X`, headers: { cookie: await cookieOf(member) } });
        expect(missing.statusCode).toBe(404);
        const asStranger = await app.inject({ method: 'GET', url: `/api/spaces/${space}/moved-page/${oldId}`, headers: { cookie: await cookieOf(stranger) } });
        expect(asStranger.statusCode).toBeGreaterThanOrEqual(403);
        expect(asStranger.body).not.toContain(NEW_ID);
      } finally {
        await app.close();
      }
    });

    it('the public site: the JSON answers with the current page, the HTML and the Markdown copy answer 301', async () => {
      await authStore.setSpaceVisibility(space, 'public');
      invalidatePublicSiteCache();
      const app = Fastify();
      app.decorateRequest('authUser', null);
      app.setErrorHandler((err, _request, reply) => {
        if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
        return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
      });
      registerPublicSiteRoutes(app);
      registerPublicLlmsRoutes(app);
      await app.ready();
      try {
        const api = await app.inject({ method: 'GET', url: `/api/public/spaces/${space}/pages/${oldId}`, headers: { host: 'folio.example.com' } });
        expect(api.statusCode).toBe(200);
        expect((api.json() as PublicPagePayload).page.id).toBe(NEW_ID);
        expect((await app.inject({ method: 'GET', url: `/api/public/spaces/${space}/pages/01H0000000000000000000000X`, headers: { host: 'folio.example.com' } })).statusCode).toBe(404);

        const head = await resolvePublicSiteHead('folio.example.com', `/public/${space}/p/${oldId}`, ORIGIN);
        expect(head?.redirectTo).toBe(`/public/${space}/p/${NEW_ID}`);
        const live = await resolvePublicSiteHead('folio.example.com', `/public/${space}/p/${NEW_ID}`, ORIGIN);
        expect(live?.status).toBe(200);
        expect(live?.redirectTo).toBeUndefined();
        const stranger = await resolvePublicSiteHead('folio.example.com', `/public/${space}/p/01H0000000000000000000000X`, ORIGIN);
        expect(stranger?.status).toBe(404);
        expect(stranger?.redirectTo).toBeUndefined();

        const md = await app.inject({ method: 'GET', url: `/public/${space}/p/${oldId}.md`, headers: { host: 'folio.example.com' } });
        expect(md.statusCode).toBe(301);
        expect(md.headers.location).toBe(`/public/${space}/p/${NEW_ID}.md`);
      } finally {
        await app.close();
      }
    });
  });
});
