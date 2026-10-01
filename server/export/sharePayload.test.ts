/**
 * R23 tail — child-page navigation in the PUBLIC share view, server half:
 * GET /api/share/:token now (a) carries `children`/`rootPageId` when the
 * token was created with includeChildren, and (b) accepts `?page=<id>` to
 * open a page of that subtree. Same fastify harness as ./routes.test.ts
 * (real PG schema, app.inject) because the things under test are HTTP facts:
 * which ids 404, which payloads carry which fields, and that revocation
 * kills the child path exactly as fast as the root one.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SharedPagePayload } from '../../shared/contracts.js';
import * as authStore from '../auth/store.js';
import { setUpTestSchema, deleteTestSpace } from '../db/testSchema.js';
import { HttpError } from '../errors.js';
import { registerPublicShareRoutes } from '../routes.js';
import * as shares from '../shares.js';
import * as storage from '../storage.js';
import { collectSubtree, subtreeFromCollected } from './collect.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('authUser', null);
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
  });
  await app.register(fastifyCookieModule.default);
  registerPublicShareRoutes(app); // public scope, exactly as index.ts registers it
  await app.ready();
  return app;
}

describe('R23 tail — share payload with children (real PG, fastify inject)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let space: string;
  let userId: string;

  let root: storage.PageIndexEntry;
  let child: storage.PageIndexEntry;
  let grandchild: storage.PageIndexEntry;
  let boardChild: storage.PageIndexEntry;
  let tableChild: storage.PageIndexEntry;
  let outsider: storage.PageIndexEntry;

  async function makeToken(mode: 'view' | 'edit', includeChildren: boolean): Promise<{ token: string; id: string }> {
    const link = await shares.createShareLink(root.id, userId, mode, 'http://ignored.test', includeChildren);
    return { token: link.url.split('/share/')[1], id: link.id };
  }

  function get(token: string, pageId?: string) {
    const url = pageId ? `/api/share/${token}?page=${encodeURIComponent(pageId)}` : `/api/share/${token}`;
    return app.inject({ method: 'GET', url });
  }

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();

    const user = await authStore.createUser({ email: `share-children-${Date.now()}@test.local`, name: 'Share Children', passwordHash: 'x', isAdmin: false });
    userId = user.id;
    const created = await storage.createSpace(`Share Children ${Date.now()}`, userId);
    space = created.slug;

    const rootMeta = await storage.createPage({ space, parentPath: '', title: 'Manual', kind: 'doc' });
    await storage.writeDocBody(rootMeta.id, '# Manual\n\nRoot text.\n');
    root = await storage.requireEntry(rootMeta.id);

    const childMeta = await storage.createPage({ space, parentPath: 'manual', title: 'Chapter One', kind: 'doc' });
    await storage.writeDocBody(childMeta.id, '# Chapter One\n\nChild text.\n');
    child = await storage.requireEntry(childMeta.id);

    const grandchildMeta = await storage.createPage({ space, parentPath: 'manual/chapter-one', title: 'Deep Note', kind: 'doc' });
    await storage.writeDocBody(grandchildMeta.id, '# Deep Note\n\nGrandchild text.\n');
    grandchild = await storage.requireEntry(grandchildMeta.id);

    const boardMeta = await storage.createPage({ space, parentPath: 'manual', title: 'Board Child', kind: 'board' });
    boardChild = await storage.requireEntry(boardMeta.id);

    const tableMeta = await storage.createPage({ space, parentPath: 'manual', title: 'Table Child', kind: 'table' });
    tableChild = await storage.requireEntry(tableMeta.id);

    // Sibling whose PATH starts with the root's — the `foo-bar` prefix trap.
    const outsiderMeta = await storage.createPage({ space, parentPath: '', title: 'Manual Extra', kind: 'doc' });
    await storage.writeDocBody(outsiderMeta.id, '# Manual Extra\n\nOutside text.\n');
    outsider = await storage.requireEntry(outsiderMeta.id);

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    await deleteTestSpace(space);
    await teardownSchema();
  });

  // -------------------------------------------------------------------------
  // The payload's children/rootPageId fields
  // -------------------------------------------------------------------------

  it('a token WITH includeChildren carries the subtree and rootPageId; the root itself is not among the children', async () => {
    const { token, id } = await makeToken('view', true);
    const res = await get(token);
    expect(res.statusCode).toBe(200);

    const payload = res.json() as SharedPagePayload;
    expect(payload.page.id).toBe(root.id);
    expect(payload.rootPageId).toBe(root.id);
    expect(payload.children).toBeDefined();

    const topIds = payload.children!.map((n) => n.id);
    expect(topIds).toContain(child.id);
    expect(topIds).toContain(boardChild.id);
    expect(topIds).toContain(tableChild.id);
    expect(topIds).not.toContain(root.id);
    expect(topIds).not.toContain(outsider.id); // prefix sibling is NOT a child

    // Tree shape, not a flat list: the grandchild nests under its parent.
    const chapter = payload.children!.find((n) => n.id === child.id)!;
    expect(chapter.children.map((n) => n.id)).toContain(grandchild.id);

    await shares.revokeShare(id);
  });

  it('a token WITHOUT includeChildren carries neither field at all (old payload shape, byte-compatible)', async () => {
    const { token, id } = await makeToken('view', false);
    const res = await get(token);
    expect(res.statusCode).toBe(200);
    const raw = res.json() as Record<string, unknown>;
    expect('children' in raw).toBe(false);
    expect('rootPageId' in raw).toBe(false);
    await shares.revokeShare(id);
  });

  // -------------------------------------------------------------------------
  // ?page=<id> — opening a child through the share
  // -------------------------------------------------------------------------

  it('fetches a CHILD page through a subtree token, and 404s the same child through a single-page token', async () => {
    const withKids = await makeToken('view', true);
    const withoutKids = await makeToken('view', false);

    const ok = await get(withKids.token, child.id);
    expect(ok.statusCode).toBe(200);
    const payload = ok.json() as SharedPagePayload;
    expect(payload.page.id).toBe(child.id);
    expect(payload.page.markdown).toContain('Child text.');
    // Navigation survives opening a child: the subtree rides along here too.
    expect(payload.rootPageId).toBe(root.id);
    expect(payload.children?.some((n) => n.id === child.id)).toBe(true);

    const denied = await get(withoutKids.token, child.id);
    expect(denied.statusCode).toBe(404); // not 403 — non-probing, same as an unknown token

    await shares.revokeShare(withKids.id);
    await shares.revokeShare(withoutKids.id);
  });

  it('the `foo-bar` prefix trap: a sibling whose path merely starts with the root slug is 404 through ?page=', async () => {
    const { token, id } = await makeToken('view', true);
    expect(outsider.relPath.startsWith('manual')).toBe(true); // the trap is live
    const res = await get(token, outsider.id);
    expect(res.statusCode).toBe(404);
    await shares.revokeShare(id);
  });

  it('deep descendants resolve too (grandchild), and ?page=<rootId> is just the root payload', async () => {
    const { token, id } = await makeToken('edit', true);

    const deep = await get(token, grandchild.id);
    expect(deep.statusCode).toBe(200);
    expect((deep.json() as SharedPagePayload).page.markdown).toContain('Grandchild text.');

    const rootAgain = await get(token, root.id);
    expect(rootAgain.statusCode).toBe(200);
    const rootPayload = rootAgain.json() as SharedPagePayload;
    expect(rootPayload.page.id).toBe(root.id);
    expect(rootPayload.mode).toBe('edit'); // the token's own page keeps the token's mode

    await shares.revokeShare(id);
  });

  it('a child payload is READ-ONLY even under an edit token (mode forced to view)', async () => {
    const { token, id } = await makeToken('edit', true);
    const res = await get(token, child.id);
    expect(res.statusCode).toBe(200);
    expect((res.json() as SharedPagePayload).mode).toBe('view');
    await shares.revokeShare(id);
  });

  it('board and table children come back with their own kind-specific content', async () => {
    const { token, id } = await makeToken('view', true);

    const board = await get(token, boardChild.id);
    expect(board.statusCode).toBe(200);
    const boardPayload = board.json() as SharedPagePayload;
    expect(boardPayload.page.kind).toBe('board');
    expect(boardPayload.page.svg).toContain('<svg');

    const table = await get(token, tableChild.id);
    expect(table.statusCode).toBe(200);
    const tablePayload = table.json() as SharedPagePayload;
    expect(tablePayload.page.kind).toBe('table');
    expect(typeof tablePayload.page.markdown).toBe('string');

    await shares.revokeShare(id);
  });

  it('REVOKING the token kills root and child access in the same instant, indistinguishable from an unknown token', async () => {
    const { token, id } = await makeToken('view', true);
    expect((await get(token)).statusCode).toBe(200);
    expect((await get(token, child.id)).statusCode).toBe(200);

    await shares.revokeShare(id);

    const rootAfter = await get(token);
    const childAfter = await get(token, child.id);
    expect(rootAfter.statusCode).toBe(404);
    expect(childAfter.statusCode).toBe(404);
    const unknown = await get('deadbeefdeadbeefdeadbeefdeadbeef', child.id);
    expect(unknown.statusCode).toBe(404);
    expect(childAfter.body).toBe(unknown.body); // no oracle for a prober
  });

  it('garbage ?page= values 404 without leaking anything', async () => {
    const { token, id } = await makeToken('view', true);
    for (const bad of ['nope', outsider.id, '../../etc/passwd', '']) {
      const res = await get(token, bad);
      // '' means "no param effectively" for queryString and serves the root — everything else 404s.
      if (bad === '') expect(res.statusCode).toBe(200);
      else expect(res.statusCode).toBe(404);
    }
    await shares.revokeShare(id);
  });

  // -------------------------------------------------------------------------
  // subtreeFromCollected — the tree builder itself
  // -------------------------------------------------------------------------

  describe('subtreeFromCollected', () => {
    it('rebuilds the DFS list as a nested tree in collation order, without the root', async () => {
      const collected = await collectSubtree(root);
      const tree = subtreeFromCollected(collected);

      // Depth-1 children only at the top, sorted by (order, title) — same as
      // the export collation. (A board's indexed title is its slug — boards
      // have no H1 — hence 'board-child' sorting before 'Chapter One'.)
      expect(tree.map((n) => n.id)).toEqual([boardChild.id, child.id, tableChild.id]);
      const chapter = tree.find((n) => n.id === child.id)!;
      expect(chapter.children.map((n) => n.title)).toEqual(['Deep Note']);
      expect(chapter.path).toBe(child.relPath);
      expect(chapter.space).toBe(space);
    });

    it('a capped collection yields a tree of exactly the collected pages (omitted ones are absent, not misplaced)', async () => {
      const collected = await collectSubtree(root, 2); // root + first child only
      expect(collected.truncation).not.toBeNull();
      const tree = subtreeFromCollected(collected);
      const flatten = (nodes: typeof tree): string[] => nodes.flatMap((n) => [n.id, ...flatten(n.children)]);
      expect(flatten(tree)).toHaveLength(1);
    });
  });
});
