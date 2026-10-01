/**
 * Security review F-02: a subtree share (includeChildren) used to take every
 * page below its root, ignoring page-level access. An editor of a parent page
 * could publish — and read back as a guest — a child that page access hides
 * from that very editor, and the public navigation listed its title and id.
 *
 * Policy under test: a subtree share never includes a page that is not open
 * to the whole space (a `page_access` row, or a `.agent/**` page), nor
 * anything below such a page. The share's own root is always included — a
 * restricted page can be shared only by its own explicit link. The set is
 * computed per request by resolveShareScope, so restricting a page AFTER the
 * link was created removes it at the next request.
 *
 * Every public surface that consumes a share is checked against the same
 * set: the JSON payload (navigation + `?page=`), the Markdown link, and the
 * collab WebSocket admission (a real http server + real WS clients, same
 * pattern as server/shareCollab.test.ts).
 */
import * as http from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WS from 'ws';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import type { SharedPagePayload, User } from '../../shared/contracts.js';
import * as authStore from '../auth/store.js';
import * as session from '../auth/session.js';
import * as collab from '../collab.js';
import { setUpTestSchema, deleteTestSpace } from '../db/testSchema.js';
import { HttpError } from '../errors.js';
import * as pageAccess from '../pageAccess.js';
import { registerPublicShareRoutes } from '../routes.js';
import * as shares from '../shares.js';
import * as storage from '../storage.js';
import { registerPublicExportRoutes } from './routes.js';
import { resolveShareScope, shareGrantsPage } from './shareScope.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('authUser', null);
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
  });
  await app.register(fastifyCookieModule.default);
  registerPublicShareRoutes(app);
  registerPublicExportRoutes(app);
  await app.ready();
  return app;
}

/** Opens a guest WS to `pageId`'s room and reports whether the server let it in. */
async function wsAdmits(port: number, pageId: string, token: string): Promise<boolean> {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/collab`, pageId, doc, {
    params: { share: token },
    WebSocketPolyfill: WS as unknown as typeof globalThis.WebSocket,
    connect: true,
    disableBc: true,
  });
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('neither synced nor closed in time')), 8000);
      provider.on('sync', (synced: boolean) => {
        if (!synced) return;
        clearTimeout(timer);
        resolve(true);
      });
      provider.on('connection-close', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  } finally {
    provider.destroy();
  }
}

describe('F-02: a subtree share excludes restricted pages and everything below them', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let server: http.Server;
  let port: number;
  let space: string;
  let owner: User;
  let editor: User;

  let spaceRoot: storage.PageIndexEntry;
  let root: storage.PageIndexEntry;
  let open: storage.PageIndexEntry;
  let openDeep: storage.PageIndexEntry;
  let secret: storage.PageIndexEntry;
  let belowSecret: storage.PageIndexEntry;
  let agentRules: storage.PageIndexEntry;

  async function page(parentPath: string, title: string, body: string): Promise<storage.PageIndexEntry> {
    const meta = await storage.createPage({ space, parentPath, title, kind: 'doc' });
    await storage.writeDocBody(meta.id, `# ${title}\n\n${body}\n`);
    return storage.requireEntry(meta.id);
  }

  async function link(rootId: string, createdBy: string, includeChildren: boolean): Promise<{ id: string; token: string }> {
    const created = await shares.createShareLink(rootId, createdBy, 'edit', 'http://acme.example.com', includeChildren);
    return { id: created.id, token: created.url.split('/share/')[1] };
  }

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    collab.initCollab();
    server = http.createServer();
    collab.attachToServer(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;

    const stamp = Date.now();
    owner = await authStore.createUser({ email: `acl-share-owner-${stamp}@example.com`, name: 'Owner', passwordHash: 'x', isAdmin: false });
    editor = await authStore.createUser({ email: `acl-share-editor-${stamp}@example.com`, name: 'Editor', passwordHash: 'x', isAdmin: false });
    space = (await storage.createSpace(`Share ACL ${stamp}`, owner.id)).slug;
    await authStore.setMembership(space, owner.id, 'admin');
    await authStore.setMembership(space, editor.id, 'editor');

    spaceRoot = await storage.requireEntry((await storage.getEntryIdByExactPath(space, 'index.md'))!);
    root = await page('', 'Handbook', 'Handbook intro.');
    open = await page('handbook', 'Onboarding', 'Onboarding text.');
    openDeep = await page('handbook/onboarding', 'First Week', 'First week text.');
    secret = await page('handbook', 'Salaries', 'Salary table text.');
    belowSecret = await page('handbook/salaries', 'Bonus Plan', 'Bonus plan text.');
    agentRules = await page('.agent', 'Assistant Rules', 'Assistant rules text.');

    // "Only me" for the owner: hidden from the editor who will create the link.
    await pageAccess.setAccess(owner, secret, 'restricted', []);

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    server?.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await deleteTestSpace(space).catch(() => {});
    await teardownSchema();
  });

  it('precondition: page access hides the restricted child from the editor, but not its (non-inheriting) descendant', async () => {
    expect(await session.effectivePageRole(editor, root)).toBe('editor');
    expect(await session.effectivePageRole(editor, secret)).toBeUndefined();
    expect(await session.effectivePageRole(editor, belowSecret)).toBe('editor');
  });

  it('the allowed set holds the root and the open descendants — not the restricted child, not anything below it', async () => {
    const { token, id } = await link(root.id, editor.id, true);
    const scope = await resolveShareScope(token);
    expect(scope).toBeDefined();
    expect([...scope!.collected.ids].sort()).toEqual([root.id, open.id, openDeep.id].sort());
    expect(await shareGrantsPage(token, secret.id)).toBe(false);
    expect(await shareGrantsPage(token, belowSecret.id)).toBe(false);
    await shares.revokeShare(id);
  });

  it('public JSON: navigation never names them, and ?page= for either 404s exactly like an unknown token', async () => {
    const { token, id } = await link(root.id, editor.id, true);

    const res = await app.inject({ method: 'GET', url: `/api/share/${token}` });
    expect(res.statusCode).toBe(200);
    const payload = res.json() as SharedPagePayload;
    expect(payload.children?.map((n) => n.id)).toEqual([open.id]);
    for (const leak of [secret.id, belowSecret.id, 'Salaries', 'Bonus Plan']) expect(res.body).not.toContain(leak);

    for (const hidden of [secret.id, belowSecret.id]) {
      const child = await app.inject({ method: 'GET', url: `/api/share/${token}?page=${hidden}` });
      expect(child.statusCode).toBe(404);
      expect(child.body).not.toContain('text.');
    }
    expect((await app.inject({ method: 'GET', url: `/api/share/${token}?page=${openDeep.id}` })).statusCode).toBe(200);
    await shares.revokeShare(id);
  });

  it('public Markdown: neither page is collated, with or without ?children=1', async () => {
    const { token, id } = await link(root.id, editor.id, true);
    for (const url of [`/share/${token}.md`, `/share/${token}.md?children=1`]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Onboarding text.');
      expect(res.body).toContain('First week text.');
      expect(res.body).not.toContain('Salary table text.');
      expect(res.body).not.toContain('Bonus plan text.');
    }
    await shares.revokeShare(id);
  });

  it('collab WebSocket: the subtree token opens an open child room but neither the restricted page nor the page below it', async () => {
    const { token, id } = await link(root.id, editor.id, true);
    expect(await wsAdmits(port, open.id, token)).toBe(true);
    expect(await wsAdmits(port, secret.id, token)).toBe(false);
    expect(await wsAdmits(port, belowSecret.id, token)).toBe(false);
    await shares.revokeShare(id);
  }, 30_000);

  it('restricting a page AFTER the link exists removes it and its subtree at the next request; lifting the restriction brings them back', async () => {
    const { token, id } = await link(root.id, editor.id, true);
    expect(await shareGrantsPage(token, open.id)).toBe(true);

    await pageAccess.setAccess(owner, open, 'restricted', []);
    try {
      const json = await app.inject({ method: 'GET', url: `/api/share/${token}` });
      expect((json.json() as SharedPagePayload).children).toEqual([]);
      expect(json.body).not.toContain(openDeep.id);
      const md = await app.inject({ method: 'GET', url: `/share/${token}.md` });
      expect(md.body).not.toContain('Onboarding text.');
      expect(md.body).not.toContain('First week text.');
      expect(await shareGrantsPage(token, open.id)).toBe(false);
      expect(await shareGrantsPage(token, openDeep.id)).toBe(false);
    } finally {
      await pageAccess.setAccess(owner, open, 'space', []);
    }
    expect(await shareGrantsPage(token, openDeep.id)).toBe(true);
    await shares.revokeShare(id);
  });

  it('the root is always included: a restricted page can still be shared by its own explicit link', async () => {
    const single = await link(secret.id, owner.id, false);
    const res = await app.inject({ method: 'GET', url: `/api/share/${single.token}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Salary table text.');
    await shares.revokeShare(single.id);

    // Its own subtree link covers what sits below it (the creator chose that
    // root explicitly); restricted pages further down would still be cut.
    const subtree = await link(secret.id, owner.id, true);
    expect([...(await resolveShareScope(subtree.token))!.collected.ids].sort()).toEqual([secret.id, belowSecret.id].sort());
    await shares.revokeShare(subtree.id);
  });

  it('.agent pages (admin-only) never ride along in a subtree share of the space home page', async () => {
    const { token, id } = await link(spaceRoot.id, owner.id, true);
    const ids = (await resolveShareScope(token))!.collected.ids;
    expect(ids.has(root.id)).toBe(true);
    expect(ids.has(open.id)).toBe(true);
    expect(ids.has(agentRules.id)).toBe(false);
    expect(ids.has(secret.id)).toBe(false);
    const md = await app.inject({ method: 'GET', url: `/share/${token}.md` });
    expect(md.body).toContain('Onboarding text.');
    expect(md.body).not.toContain('Assistant rules text.');
    expect(md.body).not.toContain('Salary table text.');
    await shares.revokeShare(id);
  });
});
