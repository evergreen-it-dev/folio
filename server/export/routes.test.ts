/**
 * Round 23 (EXPORT), Stage 1 — HTTP-level tests for the two markdown routes,
 * driven through `app.inject()` against a real PostgreSQL test schema.
 *
 * This is the first Fastify harness in server/**: every other server test
 * calls module functions directly, which is fine for logic but cannot check
 * the four things DEV-PLAN names for this round as HTTP facts —
 * "markdown is served with the right content-type; a revoked token → 404/410;
 * an edit token does not write through this route; links are absolute". The app built
 * below mirrors server/index.ts's own scope structure (public routes outside
 * the requireSession hook, protected routes inside it) because that
 * structure IS the thing under test for `/share/:token.md`.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as yaml from 'js-yaml';
import type { TableDoc } from '../../shared/contracts.js';
import { encodeScenePayload } from '../confluenceWhiteboard.js';
import * as authStore from '../auth/store.js';
import { setUpTestSchema, deleteTestSpace } from '../db/testSchema.js';
import { HttpError } from '../errors.js';
import * as session from '../auth/session.js';
import * as shares from '../shares.js';
import * as storage from '../storage.js';
import { registerExportRoutes, registerPublicExportRoutes } from './routes.js';
import { shareGrantsPage } from './shareScope.js';

const PUBLIC_URL = 'https://folio.test';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('authUser', null);
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
  });
  await app.register(fastifyCookieModule.default);

  registerPublicExportRoutes(app);
  await app.register(async (protectedScope) => {
    protectedScope.addHook('onRequest', session.requireSession);
    registerExportRoutes(protectedScope);
  });

  await app.ready();
  return app;
}

describe('R23 export — HTTP routes (real PG, fastify inject)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let space: string;
  let userId: string;
  let sessionCookie: string;
  let originalPublicUrl: string | undefined;

  let root: storage.PageIndexEntry;
  let child: storage.PageIndexEntry;
  let outsider: storage.PageIndexEntry;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    originalPublicUrl = process.env.PUBLIC_URL;
    process.env.PUBLIC_URL = PUBLIC_URL;

    const user = await authStore.createUser({ email: `export-http-${Date.now()}@test.local`, name: 'HTTP Exporter', passwordHash: 'x', isAdmin: false });
    userId = user.id;
    const created = await storage.createSpace(`Export HTTP ${Date.now()}`, userId);
    space = created.slug;
    await authStore.setMembership(space, userId, 'admin');
    const { token } = await authStore.createSession(userId);
    sessionCookie = `${session.SESSION_COOKIE_NAME}=${token}`;

    const rootMeta = await storage.createPage({ space, parentPath: '', title: 'Manual', kind: 'doc' });
    await storage.writeDocBody(rootMeta.id, '# Manual\n\nRoot text.\n\n![pic](assets/pic.png)\n');
    root = await storage.requireEntry(rootMeta.id);

    const childMeta = await storage.createPage({ space, parentPath: 'manual', title: 'Chapter One', kind: 'doc' });
    await storage.writeDocBody(childMeta.id, '# Chapter One\n\nChild text.\n\n![sub](sub.png)\n');
    child = await storage.requireEntry(childMeta.id);

    // Sibling whose PATH starts with the root's — the prefix trap.
    const outsiderMeta = await storage.createPage({ space, parentPath: '', title: 'Manual Extra', kind: 'doc' });
    await storage.writeDocBody(outsiderMeta.id, '# Manual Extra\n\nOutside text.\n');
    outsider = await storage.requireEntry(outsiderMeta.id);

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    if (originalPublicUrl === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = originalPublicUrl;
    await deleteTestSpace(space);
    await teardownSchema();
  });

  // -------------------------------------------------------------------------
  // GET /share/:token.md — the agent link
  // -------------------------------------------------------------------------

  describe('GET /share/:token.md', () => {
    it('serves raw markdown with the right content-type, noindex, and NO frontmatter', async () => {
      const link = await shares.createShareLink(root.id, userId, 'view', 'http://ignored.test');
      const token = link.url.split('/share/')[1];

      const res = await app.inject({ method: 'GET', url: `/share/${token}.md` });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8');
      expect(res.headers['x-robots-tag']).toBe('noindex');
      expect(res.body).toContain('# Manual');
      expect(res.body).toContain('Root text.');
      expect(res.body.startsWith('---')).toBe(false);
      // The ShareLinkInfo the UI copies points at exactly this URL.
      expect(link.mdUrl).toBe(`${PUBLIC_URL}/share/${token}.md`);

      await shares.revokeShare(link.id);
    });

    it('rewrites links and images to absolute URLs, carrying the token so an agent can actually fetch them', async () => {
      const link = await shares.createShareLink(root.id, userId, 'view', 'http://ignored.test');
      const token = link.url.split('/share/')[1];

      const res = await app.inject({ method: 'GET', url: `/share/${token}.md` });
      expect(res.body).toContain(`![pic](${PUBLIC_URL}/files/${space}/assets/pic.png?share=${token})`);
      expect(/\]\((?!https?:|mailto:|#)/.test(res.body)).toBe(false);

      await shares.revokeShare(link.id);
    });

    it('a REVOKED token breaks the md link immediately (404, same as an unknown one)', async () => {
      const link = await shares.createShareLink(root.id, userId, 'view', 'http://ignored.test');
      const token = link.url.split('/share/')[1];

      expect((await app.inject({ method: 'GET', url: `/share/${token}.md` })).statusCode).toBe(200);
      await shares.revokeShare(link.id);
      const after = await app.inject({ method: 'GET', url: `/share/${token}.md` });
      expect(after.statusCode).toBe(404);

      const unknown = await app.inject({ method: 'GET', url: '/share/deadbeefdeadbeefdeadbeefdeadbeef.md' });
      expect(unknown.statusCode).toBe(404);
      // Indistinguishable from a revoked one — no oracle for a prober.
      expect(unknown.body).toBe(after.body);
    });

    it('an EDIT token reads through this route but cannot write through it', async () => {
      const link = await shares.createShareLink(root.id, userId, 'edit', 'http://ignored.test');
      const token = link.url.split('/share/')[1];

      const read = await app.inject({ method: 'GET', url: `/share/${token}.md` });
      expect(read.statusCode).toBe(200);
      expect(read.body).toContain('Root text.');

      for (const method of ['PUT', 'POST', 'PATCH', 'DELETE'] as const) {
        const res = await app.inject({ method, url: `/share/${token}.md`, payload: { markdown: '# Hacked\n' } });
        expect(res.statusCode).toBe(404); // no such route exists at all
      }
      // and the page is untouched
      expect(await storage.readFreshDocBody(root.id)).toContain('Root text.');

      await shares.revokeShare(link.id);
    });

    it('reports page count and truncation state in headers', async () => {
      const link = await shares.createShareLink(root.id, userId, 'view', 'http://ignored.test');
      const token = link.url.split('/share/')[1];
      const res = await app.inject({ method: 'GET', url: `/share/${token}.md` });
      expect(res.headers['x-folio-export-pages']).toBe('1');
      expect(res.headers['x-folio-export-truncated']).toBe('false');
      await shares.revokeShare(link.id);
    });
  });

  // -------------------------------------------------------------------------
  // includeChildren
  // -------------------------------------------------------------------------

  describe('includeChildren', () => {
    it('a token created WITHOUT the flag collates the single page only', async () => {
      const link = await shares.createShareLink(root.id, userId, 'view', 'http://ignored.test', false);
      const token = link.url.split('/share/')[1];
      expect(link.includeChildren).toBe(false);

      const res = await app.inject({ method: 'GET', url: `/share/${token}.md` });
      expect(res.body).toContain('Root text.');
      expect(res.body).not.toContain('Child text.');

      // `?children=1` cannot WIDEN a token — rights come from the token, not the query.
      const widened = await app.inject({ method: 'GET', url: `/share/${token}.md?children=1` });
      expect(widened.body).not.toContain('Child text.');

      await shares.revokeShare(link.id);
    });

    it('a token created WITH the flag collates the subtree, and `?children=0` narrows it back', async () => {
      const link = await shares.createShareLink(root.id, userId, 'view', 'http://ignored.test', true);
      const token = link.url.split('/share/')[1];
      expect(link.includeChildren).toBe(true);

      const full = await app.inject({ method: 'GET', url: `/share/${token}.md` });
      expect(full.body).toContain('Root text.');
      expect(full.body).toContain('Child text.');
      expect(full.body).toContain('## Chapter One'); // demoted one level
      expect(full.body).not.toContain('Outside text.'); // the `manual-extra` sibling is NOT a child
      expect(full.headers['x-folio-export-pages']).toBe('2');

      const narrowed = await app.inject({ method: 'GET', url: `/share/${token}.md?children=0` });
      expect(narrowed.body).toContain('Root text.');
      expect(narrowed.body).not.toContain('Child text.');

      const unflattened = await app.inject({ method: 'GET', url: `/share/${token}.md?flatten=0` });
      expect(unflattened.body).toContain('# Chapter One');

      await shares.revokeShare(link.id);
    });

    it('the flag persists on the token and comes back through listSharesForPage', async () => {
      const link = await shares.createShareLink(root.id, userId, 'view', 'http://ignored.test', true);
      const listed = await shares.listSharesForPage(root.id, 'http://ignored.test');
      expect(listed.find((s) => s.id === link.id)?.includeChildren).toBe(true);
      const resolved = await shares.resolveShareToken(link.url.split('/share/')[1]);
      expect(resolved?.includeChildren).toBe(true);
      await shares.revokeShare(link.id);
    });

    it('shareGrantsPage — the predicate the /files/ hook can narrow onto — is index-based, not prefix-based', async () => {
      const withKids = await shares.createShareLink(root.id, userId, 'view', 'http://ignored.test', true);
      const withoutKids = await shares.createShareLink(root.id, userId, 'view', 'http://ignored.test', false);
      const tokenWith = withKids.url.split('/share/')[1];
      const tokenWithout = withoutKids.url.split('/share/')[1];

      expect(outsider.relPath.startsWith('manual')).toBe(true); // the prefix trap is live

      expect(await shareGrantsPage(tokenWith, root.id)).toBe(true);
      expect(await shareGrantsPage(tokenWith, child.id)).toBe(true);
      expect(await shareGrantsPage(tokenWith, outsider.id)).toBe(false);

      expect(await shareGrantsPage(tokenWithout, root.id)).toBe(true);
      expect(await shareGrantsPage(tokenWithout, child.id)).toBe(false);

      await shares.revokeShare(withKids.id);
      expect(await shareGrantsPage(tokenWith, child.id)).toBe(false); // revocation is instant here too
      await shares.revokeShare(withoutKids.id);
    });

    it("a child page's own asset URL is served under the subtree share with the token attached", async () => {
      const link = await shares.createShareLink(root.id, userId, 'view', 'http://ignored.test', true);
      const token = link.url.split('/share/')[1];
      const res = await app.inject({ method: 'GET', url: `/share/${token}.md` });
      // The child's relative image resolves against the CHILD's directory and
      // comes back absolute + share-scoped, so `curl`ing it works.
      expect(res.body).toContain(`${PUBLIC_URL}/files/${space}/manual/sub.png?share=${token}`);
      await shares.revokeShare(link.id);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/pages/:id/export.md
  // -------------------------------------------------------------------------

  describe('GET /api/pages/:id/export.md', () => {
    it('requires a session', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/pages/${root.id}/export.md` });
      expect(res.statusCode).toBe(401);
    });

    it('serves text/markdown with a filename taken from the page slug', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/pages/${root.id}/export.md`, headers: { cookie: sessionCookie } });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8');
      expect(res.headers['content-disposition']).toContain('filename="manual.md"');
      expect(res.body).toContain('# Manual');
      expect(res.body).not.toContain('Child text.'); // no subtree unless asked
    });

    it('`?children=1` collates the subtree for an authenticated caller', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/pages/${root.id}/export.md?children=1`, headers: { cookie: sessionCookie } });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Child text.');
      expect(res.headers['x-folio-export-pages']).toBe('2');
    });

    it('404s for an unknown page id', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/pages/does-not-exist/export.md', headers: { cookie: sessionCookie } });
      expect(res.statusCode).toBe(404);
    });

  });

  // -------------------------------------------------------------------------
  // GET /api/pages/:id/export.yaml — owner follow-up
  // -------------------------------------------------------------------------

  describe('GET /api/pages/:id/export.yaml', () => {
    it('requires a session', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/pages/${root.id}/export.yaml` });
      expect(res.statusCode).toBe(401);
    });

    it('a doc page: application/yaml, filename from the slug, and a title/url/body envelope', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/pages/${root.id}/export.yaml`, headers: { cookie: sessionCookie } });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/yaml; charset=utf-8');
      expect(res.headers['content-disposition']).toContain('filename="manual.yaml"');

      const parsed = yaml.load(res.body) as Record<string, unknown>;
      expect(parsed.title).toBe('Manual');
      expect(parsed.url).toBe(`${PUBLIC_URL}/s/${space}/p/${root.id}`);
      expect(parsed.body).toContain('# Manual');
      expect(parsed.body).toContain(`${PUBLIC_URL}/files/${space}/`); // relative image rewritten absolute, same as export.md
      expect(parsed.pageCount).toBeUndefined(); // single page, not a collation
    });

    it('`?children=1` collates into ONE envelope naming pageCount, wrapping the same markdown export.md?children=1 would give', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/pages/${root.id}/export.yaml?children=1`, headers: { cookie: sessionCookie } });
      expect(res.statusCode).toBe(200);
      const parsed = yaml.load(res.body) as Record<string, unknown>;
      expect(parsed.pageCount).toBe(2);
      expect(parsed.body).toContain('Child text.');
    });

    it('a board page: the structured scene (frames/nodes/edges), not a flat caption dump', async () => {
      const board = await storage.createPage({ space, parentPath: '', title: `Yaml Board ${Date.now()}`, kind: 'board' });
      const scene = {
        type: 'excalidraw',
        version: 2,
        source: 'test',
        elements: [{ id: 't1', type: 'text', x: 0, y: 0, width: 80, height: 20, text: 'hello board', originalText: 'hello board', frameId: null, isDeleted: false }],
        appState: {},
        files: {},
      };
      const payload = encodeScenePayload(scene as never);
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">' +
        '<metadata><!-- payload-type:application/vnd.excalidraw+json -->' +
        `<!-- payload-start -->${payload}<!-- payload-end --></metadata></svg>\n`;
      await storage.writeBoardSvg(board.id, svg, true);
      const entry = await storage.requireEntry(board.id);

      const res = await app.inject({ method: 'GET', url: `/api/pages/${board.id}/export.yaml`, headers: { cookie: sessionCookie } });
      expect(res.statusCode).toBe(200);
      const parsed = yaml.load(res.body) as Record<string, unknown>;
      expect(parsed.title).toBe(entry.title);
      expect(parsed.image).toBe(`${PUBLIC_URL}/files/${space}/${entry.relPath}`);
      expect(parsed.scene).toEqual({ nodes: [{ id: 'n1', type: 'text', text: 'hello board' }] });
      expect(parsed.body).toBeUndefined(); // board pages get the kind-specific shape, not the doc envelope

      await storage.deletePage(board.id);
    });

    it('a table page: delegates VERBATIM to the canonical table YAML (server/tables/service.ts exportTable)', async () => {
      const page = await storage.createPage({ space, parentPath: '', title: `Yaml Table ${Date.now()}`, kind: 'table' });
      const doc: TableDoc = {
        meta: { id: page.id, version: 1, rowIds: 'column' },
        head: '',
        tail: '',
        columns: [{ id: 'name', name: 'Name', type: 'text' }],
        views: [{ id: 'v1', name: 'All', columns: { hidden: [], order: ['name'], width: {} }, sort: [], filter: { op: 'and', rules: [] }, frozen: 0, rowHeight: 'short' }],
        rows: [{ id: 'r1', values: { name: 'Alpha' } }],
      };
      await storage.writeTableDoc(page.id, doc);

      const res = await app.inject({ method: 'GET', url: `/api/pages/${page.id}/export.yaml`, headers: { cookie: sessionCookie } });
      expect(res.statusCode).toBe(200);
      const parsed = yaml.load(res.body) as Record<string, unknown>;
      // The canonical table dump's own shape — NOT wrapped in a title/url/body envelope.
      expect(parsed).toHaveProperty('columns');
      expect(parsed).toHaveProperty('rows');
      expect((parsed.rows as { values: { name: string } }[])[0].values.name).toBe('Alpha');
      expect(parsed.title).toBeUndefined();
      expect(parsed.body).toBeUndefined();

      await storage.deletePage(page.id);
    });

    it('404s for an unknown page id', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/pages/does-not-exist/export.yaml', headers: { cookie: sessionCookie } });
      expect(res.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // print route + short-lived ticket
  // -------------------------------------------------------------------------

  /**
   * The owner ticked the "Include child pages" checkbox under an already
   * created link, downloaded `/share/<token>.md` and got one page. The server
   * was right — the token had been created WITHOUT the flag, and the checkbox
   * referred to the next link. The trap was removed: the flag of a live link
   * can now be changed (shares.setShareIncludeChildren; the HTTP wrapper is
   * PATCH /api/shares/:id in server/routes.ts, which this harness does not
   * bring up, so what is checked here is what carries the meaning: the token
   * is alive and the md route listens to it).
   */
  describe('includeChildren is editable on a LIVE token', () => {
    it('flips a single-page token to subtree, and the md link follows immediately', async () => {
      const link = await shares.createShareLink(root.id, userId, 'view', 'http://ignored.test');
      const token = link.url.split('/share/')[1];

      const before = await app.inject({ method: 'GET', url: `/share/${token}.md` });
      expect(before.headers['x-folio-export-pages']).toBe('1');
      expect(before.body).not.toContain('Child text.');

      await shares.setShareIncludeChildren(link.id, true);

      const after = await app.inject({ method: 'GET', url: `/share/${token}.md` });
      expect(after.headers['x-folio-export-pages']).toBe('2');
      expect(after.body).toContain('Child text.');
    });

    it('narrows it back, so the change is not one-way', async () => {
      const link = await shares.createShareLink(root.id, userId, 'view', 'http://ignored.test', true);
      const token = link.url.split('/share/')[1];
      expect((await app.inject({ method: 'GET', url: `/share/${token}.md` })).headers['x-folio-export-pages']).toBe('2');

      await shares.setShareIncludeChildren(link.id, false);
      expect((await app.inject({ method: 'GET', url: `/share/${token}.md` })).headers['x-folio-export-pages']).toBe('1');
    });
  });

  describe('print route', () => {
    it('needs a session and returns the print HTML inline', async () => {
      expect((await app.inject({ method: 'GET', url: `/api/pages/${root.id}/print` })).statusCode).toBe(401);

      const res = await app.inject({ method: 'GET', url: `/api/pages/${root.id}/print`, headers: { cookie: sessionCookie } });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.headers['x-robots-tag']).toBe('noindex');
      expect(res.body).toContain('<!doctype html>');
      expect(res.body).toContain('Root text.');
    });

    it('`?ticket=1` mints a short-lived, SINGLE-USE URL the renderer can fetch without a session', async () => {
      const minted = await app.inject({ method: 'GET', url: `/api/pages/${root.id}/print?ticket=1`, headers: { cookie: sessionCookie } });
      expect(minted.statusCode).toBe(200);
      const { url, expiresInSeconds } = minted.json() as { url: string; expiresInSeconds: number };
      expect(url.startsWith(`${PUBLIC_URL}/api/export/print/`)).toBe(true);
      expect(expiresInSeconds).toBe(60);

      const ticketPath = url.slice(PUBLIC_URL.length);
      const first = await app.inject({ method: 'GET', url: ticketPath }); // no cookie at all
      expect(first.statusCode).toBe(200);
      expect(first.body).toContain('Root text.');

      const second = await app.inject({ method: 'GET', url: ticketPath });
      expect(second.statusCode).toBe(404); // consumed
    });

    it('an unknown ticket 404s', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/export/print/deadbeef' });
      expect(res.statusCode).toBe(404);
    });
  });
});
