/**
 * Copying and duplicating a page together with its children must not hand the
 * caller anything that page access (or the admin-only `.agent` folder) hides
 * from them. A copy gets fresh page ids, so it carries no `page_access` row:
 * whatever lands in the copy is open to the whole destination space.
 *
 * Fixture (space A; `owner` is its admin and the owner of every restriction):
 *
 *   leaf shape      handbook.md               open        LEAF-ROOT-BODY
 *                   handbook/onboarding.md    open        LEAF-OPEN-BODY
 *                   handbook/onboarding/first-week.md     LEAF-DEEP-OPEN-BODY
 *                   handbook/salaries.md      RESTRICTED  LEAF-SECRET-SALARIES
 *                   handbook/salaries/bonus.md  (open by itself, but below a hidden page)
 *                   handbook/salaries/chart.png            inside the hidden page's folder
 *                   handbook/img/{open,both,salary,orphan}.png
 *                                            shared folder: `salary.png` is used only by the
 *                                            hidden page, `both.png` also by an open one
 *   index shape     playbook/index.md         open        INDEX-ROOT-BODY
 *                   playbook/open.md          open        INDEX-OPEN-BODY
 *                   playbook/vault/index.md   RESTRICTED  INDEX-SECRET-VAULT
 *                   playbook/vault/inner.md   (open by itself, below a hidden page)
 *   .agent          .agent/rules.md + .agent/notes.txt    AGENT-SECRET-*
 *
 * `editor` (editor in A and in B) and `viewer` (viewer in A, editor in B) are
 * both members of A that the restricted pages are hidden from. Everything goes
 * through the real routes with real sessions (and one personal access token);
 * what the copy holds is read three ways — the files it wrote, the page index,
 * and what the page API serves the caller for each new page.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiTokenScope, User } from '../shared/contracts.js';
import * as authStore from './auth/store.js';
import * as session from './auth/session.js';
import { query } from './db/pool.js';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import { HttpError } from './errors.js';
import * as pageAccess from './pageAccess.js';
import { registerRoutes } from './routes.js';
import * as storage from './storage.js';

type Auth = Record<string, string>;

interface Snapshot {
  /** Every file of the space's working tree (never `.git`): space-relative path -> bytes as latin1 text. */
  files: Map<string, string>;
  ids: Set<string>;
}

interface Shape {
  label: string;
  rootId: () => string;
  /** Nothing the caller may not see: matched against new file names + contents, new index rows and the page API's answers. */
  forbidden: string[];
  /** What an ordinary copy must carry. */
  expected: string[];
  /** Titles of the root's descendants in the copy. */
  descendantTitles: string[];
}

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

describe('copy and duplicate leave out what page access and .agent hide from the caller', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let owner: User;
  let editor: User;
  let viewer: User;
  let grantee: User;
  let spaceA: string;
  let spaceB: string;
  let ownerAuth: Auth;
  let editorAuth: Auth;
  let viewerAuth: Auth;
  let granteeAuth: Auth;
  let editorPatAuth: Auth;

  let spaceRootId: string;
  let handbook: storage.PageIndexEntry;
  let salaries: storage.PageIndexEntry;
  let playbook: storage.PageIndexEntry;
  let vault: storage.PageIndexEntry;
  let agentRules: storage.PageIndexEntry;

  async function doc(parentPath: string, title: string, body: string): Promise<storage.PageIndexEntry> {
    const meta = await storage.createPage({ space: spaceA, parentPath, title, kind: 'doc' });
    await storage.writeDocBody(meta.id, `# ${title}\n\n${body}\n`);
    return storage.requireEntry(meta.id);
  }

  async function putFile(relPath: string, content: string): Promise<void> {
    const abs = path.join(storage.getSpaceDir(spaceA), relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }

  async function snapshot(space: string): Promise<Snapshot> {
    const files = new Map<string, string>();
    async function walk(dir: string, rel: string): Promise<void> {
      for (const dirent of await fs.readdir(dir, { withFileTypes: true })) {
        if (dirent.name === '.git') continue;
        const abs = path.join(dir, dirent.name);
        const relPath = rel ? `${rel}/${dirent.name}` : dirent.name;
        if (dirent.isDirectory()) await walk(abs, relPath);
        else if (dirent.isFile()) files.set(relPath, await fs.readFile(abs, 'latin1'));
      }
    }
    await walk(storage.getSpaceDir(space), '');
    return { files, ids: new Set((await storage.listEntries(space)).map((e) => e.id)) };
  }

  function post(url: string, payload: Record<string, unknown> | undefined, headers: Auth) {
    return app.inject({ method: 'POST', url, payload, headers });
  }

  const duplicate = (id: string, headers: Auth) => post(`/api/pages/${id}/duplicate`, { title: 'Copied' }, headers);
  const copyTo = (id: string, toSpace: string, toParentPath: string, headers: Auth) =>
    post(`/api/pages/${id}/copy`, { toSpace, toParentPath, includeChildren: true }, headers);

  /** Everything a copy wrote into `dest`, seen through its files, the page index and the caller's own page reads. */
  async function whatLanded(before: Snapshot, dest: string, caller: Auth) {
    const after = await snapshot(dest);
    const newFiles = [...after.files].filter(([rel]) => !before.files.has(rel));
    const newEntries = (await storage.listEntries(dest)).filter((e) => !before.ids.has(e.id));
    let served = '';
    for (const entry of newEntries) {
      const res = await app.inject({ method: 'GET', url: `/api/pages/${entry.id}`, headers: caller });
      served += `${entry.id} ${res.statusCode}\n${res.body}\n`;
    }
    return {
      disk: newFiles.map(([rel, text]) => `${rel}\n${text}`).join('\n--\n'),
      index: newEntries.map((e) => `${e.relPath}\n${e.title}\n${e.body ?? ''}`).join('\n--\n'),
      served,
      entries: newEntries,
    };
  }

  /** The copy has what the caller may have, and not one byte of what they may not. */
  async function expectNoLeak(shape: Shape, before: Snapshot, dest: string, caller: Auth, copyRootId: string) {
    const landed = await whatLanded(before, dest, caller);
    const leaks = {
      disk: shape.forbidden.filter((f) => landed.disk.includes(f)),
      index: shape.forbidden.filter((f) => landed.index.includes(f)),
      served: shape.forbidden.filter((f) => landed.served.includes(f)),
    };
    expect(leaks).toEqual({ disk: [], index: [], served: [] });
    expect(shape.expected.filter((e) => !landed.disk.includes(e))).toEqual([]);
    const descendants = landed.entries.filter((e) => e.id !== copyRootId).map((e) => e.title);
    expect(descendants.sort()).toEqual([...shape.descendantTitles].sort());
  }

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const stamp = Date.now();
    const mk = (name: string) => authStore.createUser({ email: `copy-acl-${name}-${stamp}@example.com`, name, passwordHash: 'x', isAdmin: false });
    owner = await mk('Owner');
    editor = await mk('Editor');
    viewer = await mk('Viewer');
    grantee = await mk('Grantee');
    spaceA = (await storage.createSpace(`Copy ACL A ${stamp}`, owner.id)).slug;
    spaceB = (await storage.createSpace(`Copy ACL B ${stamp}`, owner.id)).slug;
    await authStore.setMembership(spaceA, owner.id, 'admin');
    await authStore.setMembership(spaceA, editor.id, 'editor');
    await authStore.setMembership(spaceA, viewer.id, 'viewer');
    await authStore.setMembership(spaceA, grantee.id, 'editor');
    await authStore.setMembership(spaceB, owner.id, 'admin');
    await authStore.setMembership(spaceB, editor.id, 'editor');
    await authStore.setMembership(spaceB, viewer.id, 'editor');
    await authStore.setMembership(spaceB, grantee.id, 'editor');

    const cookie = async (user: User): Promise<Auth> => ({ cookie: `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(user.id)).token}` });
    ownerAuth = await cookie(owner);
    editorAuth = await cookie(editor);
    viewerAuth = await cookie(viewer);
    granteeAuth = await cookie(grantee);
    editorPatAuth = { authorization: `Bearer ${(await authStore.createApiToken(editor.id, 'copy test', ['read', 'write'] as ApiTokenScope[])).token}` };

    spaceRootId = (await storage.getEntryIdByExactPath(spaceA, 'index.md'))!;

    // Leaf shape: handbook.md + the folder handbook/ holding its children.
    handbook = await doc('', 'Handbook', 'LEAF-ROOT-BODY');
    await doc('handbook', 'Onboarding', 'LEAF-OPEN-BODY\n\n![a](img/open.png) ![b](img/both.png)');
    await doc('handbook/onboarding', 'First Week', 'LEAF-DEEP-OPEN-BODY');
    salaries = await doc('handbook', 'Salaries', 'LEAF-SECRET-SALARIES\n\n![s](img/salary.png) ![b](img/both.png)');
    await doc('handbook/salaries', 'Bonus', 'LEAF-SECRET-BONUS');
    await putFile('handbook/img/open.png', 'LEAF-OPEN-IMG');
    await putFile('handbook/img/both.png', 'LEAF-BOTH-IMG');
    await putFile('handbook/img/salary.png', 'LEAF-SECRET-SALARY-IMG');
    await putFile('handbook/img/orphan.png', 'LEAF-ORPHAN-IMG');
    await putFile('handbook/salaries/chart.png', 'LEAF-SECRET-CHART');
    await putFile('handbook/.private/dot.txt', 'DOT-SECRET-HANDBOOK');

    // Index shape: playbook/index.md is the page of the folder itself.
    await putFile('playbook/index.md', '# Playbook\n\nINDEX-ROOT-BODY\n');
    await putFile('playbook/open.md', '# Open\n\nINDEX-OPEN-BODY\n\n![o](img/open.png) ![b](img/both.png)\n');
    await putFile('playbook/vault/index.md', '# Vault\n\nINDEX-SECRET-VAULT\n\n![v](../img/vault.png) ![b](../img/both.png)\n');
    await putFile('playbook/vault/inner.md', '# Inner\n\nINDEX-SECRET-INNER\n');
    await putFile('playbook/vault/key.png', 'INDEX-SECRET-KEY');
    await putFile('playbook/img/open.png', 'INDEX-OPEN-IMG');
    await putFile('playbook/img/both.png', 'INDEX-BOTH-IMG');
    await putFile('playbook/img/vault.png', 'INDEX-SECRET-VAULT-IMG');

    // Admin-only assistant rules, and a dot folder at the space root.
    agentRules = await doc('.agent', 'Rules', 'AGENT-SECRET-RULES');
    await putFile('.agent/notes.txt', 'AGENT-SECRET-NOTES');
    await putFile('.github/workflows/ci.yml', 'DOT-SECRET-CI');

    await storage.scanSpace(spaceA);
    const entries = await storage.listEntries(spaceA);
    playbook = entries.find((e) => e.relPath === 'playbook/index.md')!;
    vault = entries.find((e) => e.relPath === 'playbook/vault/index.md')!;

    // "Only me" for the owner: hidden from the editor, the viewer and the grantee.
    await pageAccess.setAccess(owner, salaries, 'restricted', []);
    await pageAccess.setAccess(owner, vault, 'restricted', []);

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    await deleteTestSpace(spaceA).catch(() => {});
    await deleteTestSpace(spaceB).catch(() => {});
    await teardownSchema();
  });

  const leaf: Shape = {
    label: 'leaf page with a children folder',
    rootId: () => handbook.id,
    forbidden: ['LEAF-SECRET', 'DOT-SECRET', 'salar', 'bonus'],
    expected: ['LEAF-ROOT-BODY', 'LEAF-OPEN-BODY', 'LEAF-DEEP-OPEN-BODY', 'LEAF-OPEN-IMG', 'LEAF-BOTH-IMG', 'LEAF-ORPHAN-IMG'],
    descendantTitles: ['First Week', 'Onboarding'],
  };
  const index: Shape = {
    label: 'directory-index page',
    rootId: () => playbook.id,
    forbidden: ['INDEX-SECRET', 'vault'],
    expected: ['INDEX-ROOT-BODY', 'INDEX-OPEN-BODY', 'INDEX-OPEN-IMG', 'INDEX-BOTH-IMG'],
    descendantTitles: ['Open'],
  };

  it('precondition: page access hides the restricted pages from the editor and the viewer, not from the owner', async () => {
    for (const hiddenFrom of [editor, viewer, grantee]) {
      expect(await session.effectivePageRole(hiddenFrom, salaries)).toBeUndefined();
      expect(await session.effectivePageRole(hiddenFrom, vault)).toBeUndefined();
      expect(await session.effectivePageRole(hiddenFrom, handbook)).toBeDefined();
      expect(await session.effectivePageRole(hiddenFrom, playbook)).toBeDefined();
    }
    expect(await session.effectivePageRole(owner, salaries)).toBe('editor');
    expect(await session.effectivePageRole(editor, agentRules)).toBeUndefined();
  });

  describe.each([leaf, index])('$label', (shape) => {
    it('Duplicate by an editor copies the open children and nothing below a page hidden from them', async () => {
      const before = await snapshot(spaceA);
      const res = await duplicate(shape.rootId(), editorAuth);
      expect(res.statusCode).toBe(201);
      await expectNoLeak(shape, before, spaceA, editorAuth, (res.json() as { id: string }).id);
    });

    it('Copy to another folder of the same space, by an editor', async () => {
      const before = await snapshot(spaceA);
      const res = await copyTo(shape.rootId(), spaceA, 'archive', editorAuth);
      expect(res.statusCode).toBe(201);
      await expectNoLeak(shape, before, spaceA, editorAuth, (res.json() as { id: string }).id);
    });

    it('Copy to another space where the editor is an editor', async () => {
      const before = await snapshot(spaceB);
      const res = await copyTo(shape.rootId(), spaceB, '', editorAuth);
      expect(res.statusCode).toBe(201);
      await expectNoLeak(shape, before, spaceB, editorAuth, (res.json() as { id: string }).id);
    });

    it('Copy by a viewer of the source space who is an editor of the destination', async () => {
      const before = await snapshot(spaceB);
      const res = await copyTo(shape.rootId(), spaceB, 'from-viewer', viewerAuth);
      expect(res.statusCode).toBe(201);
      await expectNoLeak(shape, before, spaceB, viewerAuth, (res.json() as { id: string }).id);
    });
  });

  it('Duplicate with a personal access token goes through the same check', async () => {
    const before = await snapshot(spaceA);
    const res = await duplicate(handbook.id, editorPatAuth);
    expect(res.statusCode).toBe(201);
    await expectNoLeak(leaf, before, spaceA, editorPatAuth, (res.json() as { id: string }).id);
  });

  it('a hidden page itself cannot be copied or duplicated by id — and nothing is written', async () => {
    for (const hidden of [salaries, vault]) {
      for (const [who, auth] of [
        ['editor', editorAuth],
        ['viewer', viewerAuth],
      ] as const) {
        const read = await app.inject({ method: 'GET', url: `/api/pages/${hidden.id}`, headers: auth });
        expect(read.statusCode, `${who} reads ${hidden.relPath}`).toBeGreaterThanOrEqual(400);
        const before = await snapshot(spaceB);
        const copy = await copyTo(hidden.id, spaceB, '', auth);
        const dup = await duplicate(hidden.id, auth);
        expect([copy.statusCode, dup.statusCode], `${who} copies ${hidden.relPath}`).toEqual([read.statusCode, read.statusCode]);
        const after = await snapshot(spaceB);
        expect([...after.files.keys()].filter((rel) => !before.files.has(rel)), `${who} / ${hidden.relPath}`).toEqual([]);
        expect(after.ids.size).toBe(before.ids.size);
      }
    }
  });

  it('an .agent page cannot be copied or duplicated by a non-admin — it answers like a page that does not exist', async () => {
    const before = await snapshot(spaceA);
    expect((await duplicate(agentRules.id, editorAuth)).statusCode).toBe(404);
    expect((await copyTo(agentRules.id, spaceB, '', editorAuth)).statusCode).toBe(404);
    expect([...(await snapshot(spaceA)).files.keys()].filter((rel) => !before.files.has(rel))).toEqual([]);
  });

  describe('the space root, which holds .agent and every other page of the space', () => {
    const everything: Shape = {
      label: 'space root',
      rootId: () => spaceRootId,
      forbidden: [...leaf.forbidden, ...index.forbidden, 'AGENT-SECRET', '.agent', 'notes.txt', 'DOT-SECRET'],
      expected: [...leaf.expected, ...index.expected],
      descendantTitles: [],
    };

    it('cannot be duplicated: there is no "next to it" — and nothing is written', async () => {
      const before = await snapshot(spaceA);
      const res = await duplicate(spaceRootId, editorAuth);
      expect(res.statusCode).toBe(400);
      expect([...(await snapshot(spaceA)).files.keys()].filter((rel) => !before.files.has(rel))).toEqual([]);
    });

    for (const [who, authOf] of [
      ['an editor', () => editorAuth],
      ['a viewer of the source space', () => viewerAuth],
    ] as const) {
      it(`copied into another space by ${who}: no .agent folder, no hidden page, no dot folder`, async () => {
        const auth = authOf();
        const before = await snapshot(spaceB);
        const res = await copyTo(spaceRootId, spaceB, `root-of-a-${who.split(' ')[1]}`, auth);
        expect(res.statusCode).toBe(201);
        const landed = await whatLanded(before, spaceB, auth);
        const leaks = {
          disk: everything.forbidden.filter((f) => landed.disk.includes(f)),
          index: everything.forbidden.filter((f) => landed.index.includes(f)),
          served: everything.forbidden.filter((f) => landed.served.includes(f)),
        };
        expect(leaks).toEqual({ disk: [], index: [], served: [] });
        expect(everything.expected.filter((e) => !landed.disk.includes(e))).toEqual([]);
        // The open pages of every shape came along: handbook (+2), playbook (+1), the root, and the rest of the fixture's copies so far.
        const titles = landed.entries.map((e) => e.title);
        expect(titles).toEqual(expect.arrayContaining(['Handbook', 'Onboarding', 'First Week', 'Playbook', 'Open']));
        expect(titles).not.toEqual(expect.arrayContaining(['Salaries']));
        expect(titles).not.toEqual(expect.arrayContaining(['Vault']));
        expect(titles).not.toEqual(expect.arrayContaining(['Rules']));
      });
    }
  });

  describe('the owner, who may read everything', () => {
    async function ownerCopy(shape: Shape, how: 'duplicate' | 'copy-to-b') {
      const before = await snapshot(how === 'duplicate' ? spaceA : spaceB);
      const res = how === 'duplicate' ? await duplicate(shape.rootId(), ownerAuth) : await copyTo(shape.rootId(), spaceB, 'owner-copies', ownerAuth);
      expect(res.statusCode).toBe(201);
      const dest = how === 'duplicate' ? spaceA : spaceB;
      const landed = await whatLanded(before, dest, ownerAuth);
      return { landed, copyRootId: (res.json() as { id: string }).id };
    }

    async function accessRow(pageId: string): Promise<{ ownerId: string; grants: number } | undefined> {
      const rows = await query<{ owner_id: string }>('SELECT owner_id FROM page_access WHERE page_id = $1', [pageId]);
      if (rows.length === 0) return undefined;
      const grants = await query('SELECT user_id FROM page_access_grants WHERE page_id = $1', [pageId]);
      return { ownerId: rows[0].owner_id, grants: grants.length };
    }

    for (const how of ['duplicate', 'copy-to-b'] as const) {
      it(`copies everything of the leaf shape (${how}); the copy of a restricted page stays restricted — to the owner alone`, async () => {
        const { landed, copyRootId } = await ownerCopy(leaf, how);
        for (const marker of [...leaf.expected, 'LEAF-SECRET-SALARIES', 'LEAF-SECRET-BONUS', 'LEAF-SECRET-CHART', 'LEAF-SECRET-SALARY-IMG']) expect(landed.disk).toContain(marker);
        expect(landed.disk).not.toContain('DOT-SECRET');
        expect(landed.entries.filter((e) => e.id !== copyRootId).map((e) => e.title).sort()).toEqual(['Bonus', 'First Week', 'Onboarding', 'Salaries']);

        const salariesCopy = landed.entries.find((e) => e.title === 'Salaries')!;
        const bonusCopy = landed.entries.find((e) => e.title === 'Bonus')!;
        expect(await accessRow(salariesCopy.id)).toEqual({ ownerId: owner.id, grants: 0 });
        expect(await accessRow(bonusCopy.id)).toBeUndefined(); // the original had no restriction
        expect(await session.effectivePageRole(owner, salariesCopy)).toBe('editor');
        for (const other of [editor, viewer, grantee]) expect(await session.effectivePageRole(other, salariesCopy)).toBeUndefined();
        expect(await session.effectivePageRole(editor, bonusCopy)).toBeDefined();
      });

      it(`copies everything of the index shape (${how}); the copy of the restricted folder page stays restricted`, async () => {
        const { landed, copyRootId } = await ownerCopy(index, how);
        for (const marker of [...index.expected, 'INDEX-SECRET-VAULT', 'INDEX-SECRET-INNER', 'INDEX-SECRET-KEY', 'INDEX-SECRET-VAULT-IMG']) expect(landed.disk).toContain(marker);
        expect(landed.entries.filter((e) => e.id !== copyRootId).map((e) => e.title).sort()).toEqual(['Inner', 'Open', 'Vault']);

        const vaultCopy = landed.entries.find((e) => e.title === 'Vault')!;
        expect(await accessRow(vaultCopy.id)).toEqual({ ownerId: owner.id, grants: 0 });
        for (const other of [editor, viewer, grantee]) expect(await session.effectivePageRole(other, vaultCopy)).toBeUndefined();
      });
    }

    it('the originals keep their restrictions and grants', async () => {
      expect(await accessRow(salaries.id)).toEqual({ ownerId: owner.id, grants: 0 });
      expect(await accessRow(vault.id)).toEqual({ ownerId: owner.id, grants: 0 });
      expect(await session.effectivePageRole(editor, salaries)).toBeUndefined();
    });
  });

  describe('a person the restricted page is shared with', () => {
    it('gets a copy of it that is private to them: the page is copied, not the other readers or the owner', async () => {
      await pageAccess.setAccess(owner, salaries, 'restricted', [{ userId: grantee.id, role: 'viewer' }]);
      try {
        expect(await session.effectivePageRole(grantee, salaries)).toBe('viewer');
        const before = await snapshot(spaceA);
        const res = await duplicate(handbook.id, granteeAuth);
        expect(res.statusCode).toBe(201);
        const landed = await whatLanded(before, spaceA, granteeAuth);

        // The grantee reads Salaries, so its text and its private files come along; Bonus is below it and rides with it.
        for (const marker of ['LEAF-SECRET-SALARIES', 'LEAF-SECRET-BONUS', 'LEAF-SECRET-SALARY-IMG', 'LEAF-SECRET-CHART']) expect(landed.disk).toContain(marker);
        expect(landed.disk).not.toContain('DOT-SECRET');

        const salariesCopy = landed.entries.find((e) => e.title === 'Salaries')!;
        const rows = await query<{ owner_id: string }>('SELECT owner_id FROM page_access WHERE page_id = $1', [salariesCopy.id]);
        expect(rows.map((r) => r.owner_id)).toEqual([grantee.id]);
        expect(await query('SELECT user_id FROM page_access_grants WHERE page_id = $1', [salariesCopy.id])).toEqual([]);
        expect(await session.effectivePageRole(grantee, salariesCopy)).toBe('editor');
        for (const other of [owner, editor, viewer]) expect(await session.effectivePageRole(other, salariesCopy)).toBeUndefined();
        // The original's rule is untouched.
        expect(await session.effectivePageRole(grantee, salaries)).toBe('viewer');
      } finally {
        await pageAccess.setAccess(owner, salaries, 'restricted', []);
      }
    });
  });
});
