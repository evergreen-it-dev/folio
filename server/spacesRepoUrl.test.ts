/**
 * QA-3 P0 — "any authenticated user reads ANY private space by cloning its
 * repository over file://".
 *
 * The hole: POST /api/spaces accepted any string as `repoUrl` and handed it
 * straight to `git clone`. git treats `file:///…`, `/abs/path`, `./rel` and
 * `~/x` alike as "clone this LOCAL repository", so a user with no role at all
 * in space X could `POST /api/spaces {repoUrl: "file:///…/data/repos/X"}`,
 * get a 201, and be admin of a full copy of X's content. Reproduced against
 * the running dev server before the fix: 201 + a complete `GET
 * /api/spaces/<new>/tree`.
 *
 * Two layers are asserted here, because the fix is deliberately in two
 * places (server/git.ts's doc comment explains why):
 *  - the ROUTE (this file's HTTP cases) — unconditional, the trust boundary;
 *  - git.ts's own clone family — the backstop, so a future caller can't
 *    reopen it by forgetting the route call.
 *
 * This file must NEVER call git.__allowLocalRepoPathsForTests(): it is the
 * one place that asserts the DEFAULT (closed) behavior. Its "a real remote
 * still works" case uses an actual http:// git remote (server/testGitHttp.ts)
 * instead of the local bare dirs the other git tests use.
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
import * as git from './git.js';
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

/** Every spelling of "a local repository" git accepts, plus the two argv-level tricks. */
function forbiddenRepoUrls(localRepo: string): string[] {
  return [
    `file://${localRepo}`,
    `FILE://${localRepo}`,
    localRepo, // schemeless absolute path — exactly as capable as file://
    './data/repos/some-other-space',
    '../../etc',
    '~/private-notes.git',
    'C:\\Users\\someone\\repo',
    'ext::sh -c id',
    '--upload-pack=/bin/sh',
    '-u payload',
  ];
}

describe('QA-3 P0: repoUrl may never name a local repository (real PG + real git, fastify inject)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let outsiderCookie: string;
  let outsiderId: string;
  let gitHttp: GitHttpServer;
  let repoSeq = 0;

  /** A private space belonging to somebody else — the thing the exploit was after. */
  let victimSlug: string;

  const createdSpaces: string[] = [];
  const tmpDirs: string[] = [];

  function createSpace(body: unknown, cookie?: string) {
    return app.inject({ method: 'POST', url: '/api/spaces', payload: body as Record<string, unknown>, headers: cookie ? { cookie } : {} });
  }

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    gitHttp = await startGitHttpServer();

    const outsider = await authStore.createUser({ email: `p0-outsider-${Date.now()}@test.local`, name: 'Outsider', passwordHash: 'x', isAdmin: false });
    const victimOwner = await authStore.createUser({ email: `p0-owner-${Date.now()}@test.local`, name: 'Owner', passwordHash: 'x', isAdmin: false });
    outsiderId = outsider.id;
    outsiderCookie = `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(outsider.id)).token}`;

    const victim = await storage.createSpace(`P0 Victim ${Date.now()}`, victimOwner.id);
    await authStore.setMembership(victim.slug, victimOwner.id, 'admin');
    victimSlug = victim.slug;
    createdSpaces.push(victim.slug);
    await storage.createPage({ space: victim.slug, parentPath: '', title: 'Top Secret Roadmap', kind: 'doc' });

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    for (const slug of createdSpaces) await deleteTestSpace(slug).catch(() => {});
    await teardownSchema();
    await gitHttp?.close();
    await Promise.all(tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})));
  });

  /** Anything a test accidentally DID manage to create gets cleaned up, so a regression can't leak between cases. */
  afterEach(async () => {
    for (const s of await storage.listSpaces()) {
      if (s.slug !== victimSlug && !createdSpaces.includes(s.slug)) await deleteTestSpace(s.slug).catch(() => {});
    }
  });

  // -------------------------------------------------------------------------
  // The route
  // -------------------------------------------------------------------------

  it('POST /api/spaces 400s every local-path spelling of repoUrl, and creates nothing', async () => {
    const before = (await storage.listSpaces()).length;

    for (const repoUrl of forbiddenRepoUrls(storage.getRepoDir(victimSlug))) {
      const res = await createSpace({ name: `p0 attempt ${repoSeq++}`, repoUrl, branch: 'main' }, outsiderCookie);
      expect(res.statusCode, `repoUrl ${JSON.stringify(repoUrl)}`).toBe(400);
      expect(res.json().error, `repoUrl ${JSON.stringify(repoUrl)}`).toMatch(/invalid repository URL/i);
    }

    // Not "a space that fails to sync" — no space row and no directory at all.
    expect((await storage.listSpaces()).length).toBe(before);
  });

  it('the original exploit: an outsider cannot clone a private space and read its pages', async () => {
    // Baseline: the outsider genuinely has no access to the victim space.
    const denied = await app.inject({ method: 'GET', url: `/api/spaces/${victimSlug}/tree`, headers: { cookie: outsiderCookie } });
    expect(denied.statusCode).toBe(403);

    const res = await createSpace(
      { name: `p0 leak ${Date.now()}`, repoUrl: `file://${storage.getRepoDir(victimSlug)}`, branch: 'main' },
      outsiderCookie,
    );
    expect(res.statusCode).toBe(400);

    // And nothing was created for them to read.
    const mine = await app.inject({ method: 'GET', url: '/api/spaces', headers: { cookie: outsiderCookie } });
    expect(mine.json().spaces).toEqual([]);
  });

  it('a real http(s) remote still works end to end — 201, cloned content, caller is admin', async () => {
    const repoUrl = await gitHttp.createSeededRepo(`ok-${repoSeq++}`, { 'index.md': '# Imported\n', 'notes/index.md': '# Notes\n' });

    const res = await createSpace({ name: `p0 legit ${Date.now()}`, repoUrl, branch: 'main' }, outsiderCookie);
    expect(res.statusCode).toBe(201);

    const created = res.json();
    createdSpaces.push(created.slug);
    expect(created.myRole).toBe('admin');
    expect(created.git.repoUrl).toBe(repoUrl);

    const tree = await app.inject({ method: 'GET', url: `/api/spaces/${created.slug}/tree`, headers: { cookie: outsiderCookie } });
    expect(tree.statusCode).toBe(200);
    expect(JSON.stringify(tree.json().tree)).toContain('Notes');
  }, 30_000);

  it('an https URL that simply does not resolve fails as "could not clone", NOT as "invalid repository URL"', async () => {
    // Proves the guard rejects on SHAPE, not by refusing everything: a
    // well-formed https URL gets past it and fails later, at git.
    const res = await createSpace(
      { name: `p0 unreachable ${Date.now()}`, repoUrl: 'https://127.0.0.1:1/nope.git', branch: 'main' },
      outsiderCookie,
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/could not clone/i);
  }, 30_000);

  // -------------------------------------------------------------------------
  // The backstop: git.ts itself, with no route involved
  // -------------------------------------------------------------------------

  describe('git.ts refuses a local repository even when called directly', () => {
    let localRepo: string;

    beforeAll(async () => {
      localRepo = path.join(os.tmpdir(), `folio-test-p0-local-${Date.now()}.git`);
      await execFileAsync('git', ['init', '--bare', '-q', '-b', 'main', localRepo]);
      tmpDirs.push(localRepo);
    });

    it('validateRepoUrl accepts only http(s)/ssh/git@ and rejects every local-path spelling', () => {
      expect(() => git.validateRepoUrl('https://gitlab.example.com/org/repo.git')).not.toThrow();
      expect(() => git.validateRepoUrl('ssh://git@example.com/org/repo.git')).not.toThrow();
      expect(() => git.validateRepoUrl('git@example.com:org/repo.git')).not.toThrow();

      for (const url of [...forbiddenRepoUrls(localRepo), '']) {
        expect(() => git.validateRepoUrl(url), `url ${JSON.stringify(url)}`).toThrow(/invalid repository URL/);
      }
    });

    it('clone() rejects them before shelling out — nothing is written to the destination', async () => {
      const dest = path.join(os.tmpdir(), `folio-test-p0-dest-${Date.now()}`);
      tmpDirs.push(dest);
      for (const url of forbiddenRepoUrls(localRepo)) {
        await expect(git.clone(url, dest, 'main'), `url ${JSON.stringify(url)}`).rejects.toThrow(/invalid repository URL/);
      }
      await expect(fs.stat(dest)).rejects.toThrow();
    });

    it('isEmptyRemote(), cloneEmptyAndBootstrap() and addRemote() reject them too', async () => {
      const dest = path.join(os.tmpdir(), `folio-test-p0-dest2-${Date.now()}`);
      tmpDirs.push(dest);
      await expect(git.isEmptyRemote(`file://${localRepo}`)).rejects.toThrow(/invalid repository URL/);
      await expect(git.isEmptyRemote(localRepo)).rejects.toThrow(/invalid repository URL/);
      await expect(git.cloneEmptyAndBootstrap(localRepo, dest, 'main', '# x\n')).rejects.toThrow(/invalid repository URL/);
      await expect(git.addRemote('.', `file://${localRepo}`)).rejects.toThrow(/invalid repository URL/);
    });

    it('storage.createSpaceFromRepo — the function POST /api/spaces calls — refuses one too', async () => {
      await expect(
        storage.createSpaceFromRepo({ name: `P0 Direct ${Date.now()}`, repoUrl: `file://${localRepo}`, branch: 'main', rootPath: '', createdBy: outsiderId }),
      ).rejects.toThrow(/invalid repository URL/);
    });

    it('__allowLocalRepoPathsForTests keeps `-`-prefixed and remote-helper URLs closed even when armed', async () => {
      // Not armed in this file, so assert the property on the guard itself:
      // these two are argv-level dangers, never a legitimate "local repo
      // standing in for a remote", so the escape hatch must not cover them.
      expect(() => git.assertRemoteAllowed('ext::sh -c id')).toThrow(/invalid repository URL/);
      expect(() => git.assertRemoteAllowed('--upload-pack=/bin/sh')).toThrow(/invalid repository URL/);
      expect(() => git.assertRemoteAllowed('https://example.com/ok.git')).not.toThrow();
    });
  });
});
