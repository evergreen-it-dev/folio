/**
 * Owner ask #2 ("git cannot be connected to a local space") — HTTP-level
 * test for POST /api/spaces/:space/connect-git, same Fastify-inject harness
 * as server/export/spaceSettings.test.ts / server/export/routes.test.ts
 * (mirrors server/index.ts's own scope structure: registerRoutes mounted
 * inside a protected scope whose onRequest hook is session.requireSession).
 * storage.connectSpaceToRepo's own success/refusal/content-preservation
 * behavior is covered directly, against real git repos, in
 * server/gitNative.test.ts — this file is specifically about the route's own
 * HTTP facts: the 401/403/200 role gate (space-level git configuration is
 * admin-only, same gate as the existing manual-sync route), that the route
 * surfaces storage's 409 as an actual 409 rather than a generic 400/500, and
 * (QA-3 P0) that a local-filesystem "remote" is refused outright.
 *
 * The remotes here are REAL http:// git remotes (server/testGitHttp.ts), not
 * the local bare dirs the rest of the git tests use: a route now rejects a
 * schemeless local path or a file:// URL before it reaches git at all, so a
 * local bare dir could no longer test the success path even in principle.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as authStore from './auth/store.js';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import { HttpError } from './errors.js';
import * as session from './auth/session.js';
import * as storage from './storage.js';
import { registerRoutes } from './routes.js';
import { startGitHttpServer, type GitHttpServer } from './testGitHttp.js';

const execFileAsync = promisify(execFile);

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('authUser', null);
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
  });
  await app.register(fastifyCookieModule.default);
  await app.register(async (protectedScope) => {
    protectedScope.addHook('onRequest', session.requireSession);
    registerRoutes(protectedScope);
  });
  await app.ready();
  return app;
}

describe('POST /api/spaces/:space/connect-git — HTTP routes (real PG + real git, fastify inject)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let adminCookie: string;
  let editorCookie: string;
  let viewerCookie: string;
  let adminId: string;
  let editorId: string;
  let viewerId: string;
  let gitHttp: GitHttpServer;
  let repoSeq = 0;

  function connect(space: string, body: unknown, cookie?: string) {
    return app.inject({
      method: 'POST',
      url: `/api/spaces/${space}/connect-git`,
      payload: body as Record<string, unknown>,
      headers: cookie ? { cookie } : {},
    });
  }

  /** A real, empty, pushable http:// remote — the shape the route actually accepts. */
  function makeEmptyRemote(name: string): Promise<string> {
    return gitHttp.createEmptyRepo(`${name}-${repoSeq++}`);
  }

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    gitHttp = await startGitHttpServer();

    const admin = await authStore.createUser({ email: `cg-admin-${Date.now()}@test.local`, name: 'CG Admin', passwordHash: 'x', isAdmin: false });
    const editor = await authStore.createUser({ email: `cg-editor-${Date.now()}@test.local`, name: 'CG Editor', passwordHash: 'x', isAdmin: false });
    const viewer = await authStore.createUser({ email: `cg-viewer-${Date.now()}@test.local`, name: 'CG Viewer', passwordHash: 'x', isAdmin: false });

    adminCookie = `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(admin.id)).token}`;
    editorCookie = `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(editor.id)).token}`;
    viewerCookie = `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(viewer.id)).token}`;
    adminId = admin.id;
    editorId = editor.id;
    viewerId = viewer.id;

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    await teardownSchema();
    await gitHttp?.close();
  });

  const createdSpaces: string[] = [];
  afterEach(async () => {
    await Promise.all(createdSpaces.splice(0).map((s) => deleteTestSpace(s).catch(() => {})));
  });

  async function newLocalSpace(name: string): Promise<string> {
    const created = await storage.createSpace(name, adminId);
    await authStore.setMembership(created.slug, adminId, 'admin');
    await authStore.setMembership(created.slug, editorId, 'editor');
    await authStore.setMembership(created.slug, viewerId, 'viewer');
    createdSpaces.push(created.slug);
    return created.slug;
  }

  it('is gated: 401 without a session, 403 for a viewer AND an editor, 200 for the space admin', async () => {
    const space = await newLocalSpace(`Gate ${Date.now()}`);
    const repoUrl = await makeEmptyRemote('gate');

    expect((await connect(space, { repoUrl, branch: 'main' })).statusCode).toBe(401);
    expect((await connect(space, { repoUrl, branch: 'main' }, viewerCookie)).statusCode).toBe(403);
    expect((await connect(space, { repoUrl, branch: 'main' }, editorCookie)).statusCode).toBe(403);

    const res = await connect(space, { repoUrl, branch: 'main' }, adminCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().git.repoUrl).toBe(repoUrl);
  });

  it('a NON-empty remote 409s for the space admin too, and the space stays local', async () => {
    const space = await newLocalSpace(`Gate NonEmpty ${Date.now()}`);
    // seeded with unrelated content, so it's genuinely non-empty
    const repoUrl = await gitHttp.createSeededRepo(`nonempty-${repoSeq++}`, { 'stranger.md': '# Stranger\n' });

    const res = await connect(space, { repoUrl, branch: 'main' }, adminCookie);
    expect(res.statusCode).toBe(409);

    const info = await storage.getSpaceInfo(space);
    expect(info?.git?.repoUrl).toBeNull();
    expect(info?.git?.status).toBe('local');
  });

  it('a missing repoUrl 400s (schema validation) rather than reaching storage', async () => {
    const space = await newLocalSpace(`Gate BadBody ${Date.now()}`);
    const res = await connect(space, {}, adminCookie);
    expect(res.statusCode).toBe(400);
  });

  it('an unknown space 404s — same requireSpaceRole existence check every other space-scoped route uses', async () => {
    const repoUrl = gitHttp.url('never-created');
    const res = await connect('definitely-not-a-space', { repoUrl, branch: 'main' }, viewerCookie);
    expect(res.statusCode).toBe(404);
  });

  // QA-3 P0 (server/git.ts's validateRepoUrl): the same hole POST /api/spaces
  // had. Connecting a space to a local directory would make that directory
  // the space's origin and push the space's content into it.
  it('refuses a local-filesystem "remote" (file://, absolute, relative) with 400, leaving the space local', async () => {
    const space = await newLocalSpace(`Gate LocalPath ${Date.now()}`);
    const localBare = path.join(os.tmpdir(), `folio-test-connectgit-forbidden-${Date.now()}.git`);
    await execFileAsync('git', ['init', '--bare', '-q', '-b', 'main', localBare]);

    try {
      for (const repoUrl of [`file://${localBare}`, localBare, './data/repos/somebody-else', '~/secrets.git', 'ext::sh -c id', '--upload-pack=/bin/sh']) {
        const res = await connect(space, { repoUrl, branch: 'main' }, adminCookie);
        expect(res.statusCode, `repoUrl ${repoUrl}`).toBe(400);
        expect(res.json().error).toMatch(/invalid repository URL/i);
      }

      const info = await storage.getSpaceInfo(space);
      expect(info?.git?.repoUrl).toBeNull();
      expect(info?.git?.status).toBe('local');
    } finally {
      await fs.rm(localBare, { recursive: true, force: true }).catch(() => {});
    }
  });
});
