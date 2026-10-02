/**
 * A page that page access hides (a `page_access` row: "only me" or "specific
 * people") must come back from the trash exactly as hidden as it went in.
 * Deleting a page drops its index row, and the access rows hang off that row
 * (ON DELETE CASCADE), so the trash has to carry them and put them back with
 * the page; otherwise a restored page is open to the whole space again.
 *
 * Everything goes through the real routes with real sessions: the delete and
 * the access routes of server/routes.ts, the trash routes, the undo route of
 * the personal history and the raw-file route. What a person can see is read
 * four ways - the page API, `/files/<space>/<path>`, the tree and search.
 *
 * Fixture (space A; `owner` administers it and makes every restriction):
 *   owner       admin of A             makes the restrictions
 *   otherAdmin  admin of A             neither owner nor grantee
 *   editor      editor of A
 *   viewer      viewer of A
 *   grantee     editor of A            gets grants
 *   instAdmin   instance admin         no membership in A
 * Tests that change membership create their own people, so the rest stays put.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SpaceRole, User } from '../../shared/contracts.js';
import * as authStore from '../auth/store.js';
import * as session from '../auth/session.js';
import { query } from '../db/pool.js';
import { setUpTestSchema, deleteTestSpace } from '../db/testSchema.js';
import { HttpError } from '../errors.js';
import { registerFileRoutes } from '../fileAccess.js';
import * as gitSync from '../gitSync.js';
import { registerPageChangeRoutes } from '../pageChangesRoutes.js';
import { registerRoutes } from '../routes.js';
import * as storage from '../storage.js';
import { registerTrashRoutes } from './routes.js';

// The route plugin records whatever already sits in the machine's real
// data/.trash into the (test) database when it is registered. This suite
// deletes and empties trash items, so it must only ever see its own.
vi.mock('./backfill.js', () => ({ backfillTrashFromDisk: async () => {} }));

type Auth = Record<string, string>;

interface TrashListed {
  id: string;
  pageId: string;
  title: string;
  origPath: string;
  kind: string;
  restricted?: boolean;
}

interface Probe {
  page: number;
  file: number;
  inTree: boolean;
  inSearch: boolean;
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('authUser', null);
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
  });
  await app.register(fastifyCookieModule.default);
  await app.register(registerFileRoutes); // exactly as server/index.ts registers it
  await app.register(async (protectedScope) => {
    protectedScope.addHook('onRequest', session.requireSession);
    registerRoutes(protectedScope);
    registerTrashRoutes(protectedScope);
    registerPageChangeRoutes(protectedScope);
  });
  await app.ready();
  return app;
}

describe('a restricted page keeps its restriction through the trash', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let stamp: number;
  let owner: User;
  let otherAdmin: User;
  let editor: User;
  let viewer: User;
  let grantee: User;
  let instAdmin: User;
  let space: string;
  let ownerAuth: Auth;
  let otherAdminAuth: Auth;
  let editorAuth: Auth;
  let viewerAuth: Auth;
  let granteeAuth: Auth;
  let instAdminAuth: Auth;
  let counter = 0;
  const extraSpaces: string[] = [];

  const cookieFor = async (user: User): Promise<Auth> => ({ cookie: `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(user.id)).token}` });
  const mkUser = (name: string, isAdmin = false) => authStore.createUser({ email: `trash-acl-${name}-${stamp}@example.com`, name, passwordHash: 'x', isAdmin });

  /** A unique word per page, so search and body checks cannot confuse two pages. */
  const word = (label: string) => `zq${label}${stamp.toString(36)}${counter++}`;

  async function doc(parentPath: string, title: string, body: string, inSpace = space): Promise<storage.PageIndexEntry> {
    const meta = await storage.createPage({ space: inSpace, parentPath, title, kind: 'doc' });
    await storage.writeDocBody(meta.id, `# ${title}\n\n${body}\n`);
    return storage.requireEntry(meta.id);
  }

  async function putFile(relPath: string, content: string, inSpace = space): Promise<void> {
    const abs = path.join(storage.getSpaceDir(inSpace), relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }

  async function joinSpace(user: User, role: SpaceRole, inSpace = space): Promise<void> {
    await authStore.setMembership(inSpace, user.id, role);
  }

  function inject(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, headers: Auth, payload?: Record<string, unknown>) {
    return app.inject({ method, url, headers, payload });
  }

  /** Restricts a page through the real route; `visibility: 'restricted'` with no grants is "only me". */
  async function restrict(pageId: string, as: Auth, grants: Array<{ userId: string; role: 'viewer' | 'editor' }> = []) {
    const res = await inject('PUT', `/api/pages/${pageId}/access`, as, { visibility: 'restricted', grants });
    expect(res.statusCode).toBe(200);
  }

  /** Deletes through the real route and returns the trash item it created. */
  async function trash(pageId: string, as: Auth = ownerAuth): Promise<string> {
    const res = await inject('DELETE', `/api/pages/${pageId}`, as);
    expect(res.statusCode).toBe(200);
    const rows = await query<{ id: string }>('SELECT id FROM trash_items WHERE page_id = $1 ORDER BY deleted_at DESC', [pageId]);
    expect(rows.length).toBeGreaterThan(0);
    return rows[0].id;
  }

  const restore = (itemId: string, as: Auth) => inject('POST', `/api/trash/${itemId}/restore`, as);

  async function listTrash(as: Auth, inSpace = space) {
    const res = await inject('GET', `/api/trash?space=${inSpace}&limit=500`, as);
    return { status: res.statusCode, items: ((res.json() as { items?: TrashListed[] }).items ?? []) as TrashListed[], body: res.body };
  }

  /** What `who` gets for one page: the page API, the raw file, the tree and search. */
  async function probe(pageId: string, searchWord: string | undefined, who: Auth, inSpace = space): Promise<Probe> {
    const entry = await storage.getEntry(pageId);
    const page = await inject('GET', `/api/pages/${pageId}`, who);
    const file = entry ? await inject('GET', `/files/${inSpace}/${encodeURI(entry.relPath)}`, who) : undefined;
    const tree = await inject('GET', `/api/spaces/${inSpace}/tree`, who);
    const search = searchWord ? await inject('GET', `/api/search?q=${searchWord}&space=${inSpace}`, who) : undefined;
    return {
      page: page.statusCode,
      file: file?.statusCode ?? 0,
      inTree: tree.body.includes(pageId),
      inSearch: search ? search.body.includes(pageId) : false,
    };
  }

  /** The page access of one page as the database holds it; undefined = open to the whole space. */
  async function accessOf(pageId: string): Promise<{ ownerId: string; grants: Array<{ userId: string; role: string }> } | undefined> {
    const rows = await query<{ owner_id: string }>('SELECT owner_id FROM page_access WHERE page_id = $1', [pageId]);
    if (rows.length === 0) return undefined;
    const grants = await query<{ user_id: string; role: string }>('SELECT user_id, role FROM page_access_grants WHERE page_id = $1 ORDER BY user_id', [pageId]);
    return { ownerId: rows[0].owner_id, grants: grants.map((g) => ({ userId: g.user_id, role: g.role })) };
  }

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    stamp = Date.now();
    owner = await mkUser('Owner');
    otherAdmin = await mkUser('OtherAdmin');
    editor = await mkUser('Editor');
    viewer = await mkUser('Viewer');
    grantee = await mkUser('Grantee');
    instAdmin = await mkUser('InstAdmin', true);
    space = (await storage.createSpace(`Trash ACL ${stamp}`, owner.id)).slug;
    await joinSpace(owner, 'admin');
    await joinSpace(otherAdmin, 'admin');
    await joinSpace(editor, 'editor');
    await joinSpace(viewer, 'viewer');
    await joinSpace(grantee, 'editor');
    ownerAuth = await cookieFor(owner);
    otherAdminAuth = await cookieFor(otherAdmin);
    editorAuth = await cookieFor(editor);
    viewerAuth = await cookieFor(viewer);
    granteeAuth = await cookieFor(grantee);
    instAdminAuth = await cookieFor(instAdmin);
    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    await gitSync.flushAllPendingSyncs();
    await deleteTestSpace(space).catch(() => {});
    for (const extra of extraSpaces) await deleteTestSpace(extra).catch(() => {});
    await teardownSchema();
  });

  // -------------------------------------------------------------------------

  describe('a single page', () => {
    it('"only me": after delete and restore an editor and a viewer still cannot read it, the owner can, and the rule is exactly as before', async () => {
      const secret = word('only');
      const page = await doc('', 'Only Me Page', `body ${secret}`);
      await restrict(page.id, ownerAuth);

      const before = {
        owner: await probe(page.id, secret, ownerAuth),
        editor: await probe(page.id, secret, editorAuth),
        viewer: await probe(page.id, secret, viewerAuth),
      };
      expect(before.owner).toEqual({ page: 200, file: 200, inTree: true, inSearch: true });
      for (const hidden of [before.editor, before.viewer]) expect(hidden).toEqual({ page: 403, file: 403, inTree: false, inSearch: false });
      const accessBefore = await accessOf(page.id);
      expect(accessBefore).toEqual({ ownerId: owner.id, grants: [] });

      const itemId = await trash(page.id);
      expect((await restore(itemId, ownerAuth)).statusCode).toBe(200);

      expect(await probe(page.id, secret, editorAuth)).toEqual(before.editor);
      expect(await probe(page.id, secret, viewerAuth)).toEqual(before.viewer);
      expect(await probe(page.id, secret, ownerAuth)).toEqual(before.owner);
      expect(await accessOf(page.id)).toEqual(accessBefore);
      const raw = await inject('GET', `/files/${space}/${encodeURI((await storage.requireEntry(page.id)).relPath)}`, editorAuth);
      expect(raw.body).not.toContain(secret);
    });

    it('"specific people": the grantee reads it after the restore, the others cannot, and the grant is exactly as before', async () => {
      const secret = word('people');
      const page = await doc('', 'Specific People Page', `body ${secret}`);
      await restrict(page.id, ownerAuth, [{ userId: grantee.id, role: 'viewer' }]);

      const before = {
        owner: await probe(page.id, secret, ownerAuth),
        grantee: await probe(page.id, secret, granteeAuth),
        editor: await probe(page.id, secret, editorAuth),
        viewer: await probe(page.id, secret, viewerAuth),
      };
      expect(before.grantee).toEqual({ page: 200, file: 200, inTree: true, inSearch: true });
      expect(before.editor.page).toBe(403);
      const accessBefore = await accessOf(page.id);
      expect(accessBefore).toEqual({ ownerId: owner.id, grants: [{ userId: grantee.id, role: 'viewer' }] });

      const itemId = await trash(page.id);
      expect((await restore(itemId, ownerAuth)).statusCode).toBe(200);

      expect(await probe(page.id, secret, editorAuth)).toEqual(before.editor);
      expect(await probe(page.id, secret, viewerAuth)).toEqual(before.viewer);
      expect(await probe(page.id, secret, ownerAuth)).toEqual(before.owner);
      expect(await probe(page.id, secret, granteeAuth)).toEqual(before.grantee);
      expect(await accessOf(page.id)).toEqual(accessBefore);
      // The grant keeps its role: a viewer grant does not become an editor grant.
      const putByGrantee = await inject('PUT', `/api/pages/${page.id}`, granteeAuth, { markdown: '# Specific People Page\n\nchanged\n' });
      expect(putByGrantee.statusCode).toBe(403);
    });

    it('the undo of a delete (personal history) brings the restriction back too', async () => {
      const secret = word('undo');
      const page = await doc('', 'Undo Page', `body ${secret}`);
      await restrict(page.id, ownerAuth);
      await trash(page.id);
      expect(await accessOf(page.id)).toBeUndefined(); // the index row, and with it the rule, is gone while the page is in the trash

      const changes = (await inject('GET', `/api/spaces/${space}/changes`, ownerAuth)).json() as { changes: Array<{ id: string; action: string; pageId: string }> };
      const change = changes.changes.find((c) => c.action === 'page.delete' && c.pageId === page.id);
      expect(change).toBeDefined();
      expect((await inject('POST', `/api/spaces/${space}/changes/${change!.id}/undo`, ownerAuth)).statusCode).toBe(200);

      expect((await probe(page.id, secret, editorAuth)).page).toBe(403);
      expect((await probe(page.id, secret, ownerAuth)).page).toBe(200);
      expect(await accessOf(page.id)).toEqual({ ownerId: owner.id, grants: [] });
    });

    it('the index row of a restored restricted page is never committed without its rule: there is no moment at which it is open', async () => {
      const page = await doc('', 'Atomic Restore', 'body');
      await restrict(page.id, ownerAuth);
      const itemId = await trash(page.id);
      // Fails any transaction that commits this page's index row while the page has no rule.
      const guard = `trash_acl_guard_${stamp}_${counter++}`;
      await query(
        `CREATE FUNCTION ${guard}() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
           IF NOT EXISTS (SELECT 1 FROM page_access WHERE page_id = NEW.id) THEN
             RAISE EXCEPTION 'index row committed without its page access rule';
           END IF;
           RETURN NULL;
         END $$`,
      );
      await query(`CREATE CONSTRAINT TRIGGER ${guard} AFTER INSERT ON pages_index DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.id = '${page.id}') EXECUTE FUNCTION ${guard}()`);
      try {
        expect((await restore(itemId, ownerAuth)).statusCode).toBe(200);
        expect(await storage.getEntry(page.id)).toBeDefined(); // the row was not refused
        expect(await accessOf(page.id)).toEqual({ ownerId: owner.id, grants: [] });
      } finally {
        await query(`DROP TRIGGER IF EXISTS ${guard} ON pages_index`);
        await query(`DROP FUNCTION IF EXISTS ${guard}()`);
      }
    });

    it('a page that was never restricted stays open (no rule invented)', async () => {
      const page = await doc('', 'Open Page', 'open body');
      const itemId = await trash(page.id);
      expect((await restore(itemId, ownerAuth)).statusCode).toBe(200);
      expect(await accessOf(page.id)).toBeUndefined();
      expect((await probe(page.id, undefined, editorAuth)).page).toBe(200);
    });
  });

  describe('every kind of page that goes through the trash', () => {
    async function board(title: string) {
      return storage.requireEntry((await storage.createPage({ space, parentPath: '', title, kind: 'board' })).id);
    }
    async function table(title: string) {
      return storage.requireEntry((await storage.createPage({ space, parentPath: '', title, kind: 'table' })).id);
    }
    async function form(title: string) {
      return storage.requireEntry((await storage.createPage({ space, parentPath: '', title, kind: 'form' })).id);
    }
    async function pdf(name: string) {
      await putFile(name, '%PDF-1.4 restricted');
      await storage.scanSpace(space);
      return storage.requireEntry((await storage.getEntryIdByExactPath(space, name))!);
    }

    it.each([
      ['board', board],
      ['table', table],
      ['form', form],
      ['pdf file', pdf],
    ] as const)('%s: restricted before the delete, restricted after the restore', async (label, make) => {
      const page = await make(label === 'pdf file' ? `kind-${counter++}.pdf` : `Kind ${label} ${counter++}`);
      await restrict(page.id, ownerAuth, [{ userId: grantee.id, role: 'editor' }]);
      const accessBefore = await accessOf(page.id);
      expect(accessBefore).toBeDefined();
      expect((await probe(page.id, undefined, editorAuth)).page).toBe(403);

      const itemId = await trash(page.id);
      expect((await restore(itemId, ownerAuth)).statusCode).toBe(200);

      expect(await probe(page.id, undefined, editorAuth)).toMatchObject({ page: 403, file: 403, inTree: false });
      expect(await probe(page.id, undefined, viewerAuth)).toMatchObject({ page: 403, file: 403, inTree: false });
      expect(await probe(page.id, undefined, ownerAuth)).toMatchObject({ page: 200, file: 200, inTree: true });
      expect(await probe(page.id, undefined, granteeAuth)).toMatchObject({ page: 200, file: 200, inTree: true });
      expect(await accessOf(page.id)).toEqual(accessBefore);
    });
  });

  describe.each([
    {
      label: 'a page with a children folder',
      build: async (tag: string) => {
        const parent = await doc('', `Parent ${tag}`, 'parent body');
        const stem = parent.relPath.replace(/\.md$/, '');
        return { parent, dir: stem };
      },
    },
    {
      label: 'a directory-index page',
      build: async (tag: string) => {
        await putFile(`dir-${tag}/index.md`, `# Parent ${tag}\n\nparent body\n`);
        await storage.scanSpace(space);
        const parent = await storage.requireEntry((await storage.getEntryIdByExactPath(space, `dir-${tag}/index.md`))!);
        return { parent, dir: `dir-${tag}` };
      },
    },
  ])('$label deleted with its descendants', ({ build }) => {
    it('a restricted child (and a restricted grandchild under it) is still restricted after the parent is restored', async () => {
      const tag = `t${counter++}`;
      const { parent, dir } = await build(tag);
      const openWord = word('openchild');
      const secretWord = word('secretchild');
      const deepWord = word('deepgrand');
      const openChild = await doc(dir, 'Open Child', `body ${openWord}`);
      const secretChild = await doc(dir, 'Secret Child', `body ${secretWord}`);
      const deepGrand = await doc(`${dir}/secret-child`, 'Deep Grandchild', `body ${deepWord}`);
      await restrict(secretChild.id, ownerAuth);
      await restrict(deepGrand.id, ownerAuth, [{ userId: grantee.id, role: 'viewer' }]);

      const ids = [parent.id, openChild.id, secretChild.id, deepGrand.id];
      const words = [undefined, openWord, secretWord, deepWord];
      const people = { owner: ownerAuth, grantee: granteeAuth, editor: editorAuth, viewer: viewerAuth };
      const read = async () => {
        const out: Record<string, Probe[]> = {};
        for (const [name, auth] of Object.entries(people)) out[name] = await Promise.all(ids.map((id, i) => probe(id, words[i], auth)));
        return out;
      };
      const before = await read();
      const accessBefore = await Promise.all(ids.map((id) => accessOf(id)));
      // Sanity of the fixture: the restricted ones are hidden, the open ones are not.
      expect(before.editor.map((p) => p.page)).toEqual([200, 200, 403, 403]);
      expect(before.grantee.map((p) => p.page)).toEqual([200, 200, 403, 200]);
      expect(accessBefore.map((a) => a !== undefined)).toEqual([false, false, true, true]);

      const itemId = await trash(parent.id);
      for (const id of ids) expect(await storage.getEntry(id)).toBeUndefined();
      expect((await restore(itemId, ownerAuth)).statusCode).toBe(200);

      // The leak in plain words.
      expect((await probe(secretChild.id, secretWord, editorAuth)).page).toBe(403);
      expect((await probe(deepGrand.id, deepWord, editorAuth)).page).toBe(403);
      expect((await probe(deepGrand.id, deepWord, granteeAuth)).page).toBe(200);
      expect(await read()).toEqual(before);
      expect(await Promise.all(ids.map((id) => accessOf(id)))).toEqual(accessBefore);
    });

    it('a restricted parent: it comes back restricted, its open child as open as before (the rule is not inherited), and the list keeps its name from an admin it was hidden from', async () => {
      const tag = `t${counter++}`;
      const { parent, dir } = await build(tag);
      const parentWord = word('restrictedparent');
      const childWord = word('openkid');
      await storage.writeDocBody(parent.id, `# Parent ${tag}\n\nbody ${parentWord}\n`);
      const child = await doc(dir, 'Open Kid', `body ${childWord}`);
      await restrict(parent.id, ownerAuth);
      const parentBefore = await probe(parent.id, parentWord, editorAuth);
      expect(parentBefore.page).toBe(403);
      expect((await probe(child.id, childWord, editorAuth)).page).toBe(200);

      const itemId = await trash(parent.id);
      const seenByStranger = (await listTrash(otherAdminAuth)).items.find((i) => i.id === itemId);
      expect(seenByStranger).toMatchObject({ title: '', origPath: '', restricted: true, childrenCount: 1 });
      expect((await listTrash(ownerAuth)).items.find((i) => i.id === itemId)?.title).toBe(`Parent ${tag}`);
      expect((await restore(itemId, ownerAuth)).statusCode).toBe(200);

      expect(await probe(parent.id, parentWord, editorAuth)).toEqual(parentBefore);
      expect((await probe(parent.id, parentWord, ownerAuth)).page).toBe(200);
      expect((await probe(child.id, childWord, editorAuth)).page).toBe(200);
      expect(await accessOf(parent.id)).toEqual({ ownerId: owner.id, grants: [] });
      expect(await accessOf(child.id)).toBeUndefined();
    });

    it('restored by an admin who is not the owner: the restrictions stay with the owner as before, not with the admin', async () => {
      const tag = `t${counter++}`;
      const { parent, dir } = await build(tag);
      const secretWord = word('adminchild');
      const secretChild = await doc(dir, 'Admin Secret Child', `body ${secretWord}`);
      await restrict(secretChild.id, ownerAuth, [{ userId: grantee.id, role: 'viewer' }]);
      const accessBefore = await accessOf(secretChild.id);

      const itemId = await trash(parent.id, ownerAuth);
      // An open page: a space admin sees it and may restore it.
      const listed = await listTrash(otherAdminAuth);
      expect(listed.items.find((i) => i.id === itemId)?.title).toBe(`Parent ${tag}`);
      expect((await restore(itemId, otherAdminAuth)).statusCode).toBe(200);

      expect((await probe(secretChild.id, secretWord, otherAdminAuth)).page).toBe(403); // the restoring admin gained nothing
      expect((await probe(secretChild.id, secretWord, editorAuth)).page).toBe(403);
      expect((await probe(secretChild.id, secretWord, granteeAuth)).page).toBe(200);
      expect((await probe(secretChild.id, secretWord, ownerAuth)).page).toBe(200);
      expect(await accessOf(secretChild.id)).toEqual(accessBefore);
    });
  });

  describe('while the page is in the trash', () => {
    it('an editor and a viewer see nothing in the trash and can neither restore nor delete it; there is no way to read its content from the trash', async () => {
      const secret = word('intrash');
      const page = await doc('', 'Hidden In Trash', `body ${secret}`);
      await restrict(page.id, ownerAuth);
      const itemId = await trash(page.id);
      const row = (await query<{ trash_path: string }>('SELECT trash_path FROM trash_items WHERE id = $1', [itemId]))[0];

      for (const [who, auth] of [
        ['editor', editorAuth],
        ['viewer', viewerAuth],
        ['grantee', granteeAuth],
      ] as const) {
        const list = await listTrash(auth);
        expect(list.status, who).toBe(200);
        expect(list.items, who).toEqual([]);
        expect(list.body, who).not.toContain('Hidden In Trash');
        expect((await restore(itemId, auth)).statusCode, `${who} restore`).toBe(403);
        expect((await inject('DELETE', `/api/trash/${itemId}`, auth)).statusCode, `${who} delete`).toBe(403);
        // No preview route: the item id answers nothing at all.
        expect((await inject('GET', `/api/trash/${itemId}`, auth)).statusCode, `${who} preview`).toBe(404);
        expect((await inject('GET', `/api/trash/${itemId}/content`, auth)).statusCode, `${who} content`).toBe(404);
        const emptied = await inject('DELETE', `/api/trash?space=${space}`, auth);
        expect((emptied.json() as { removed?: number }).removed ?? 0, `${who} empty`).toBe(0);
      }
      // Nothing happened to it, and nobody reaches it through the page or file routes either.
      expect(await query('SELECT 1 FROM trash_items WHERE id = $1', [itemId])).toHaveLength(1);
      expect(await fs.stat(path.join(storage.TRASH_DIR, row.trash_path)).then(() => true, () => false)).toBe(true);
      for (const auth of [editorAuth, viewerAuth, ownerAuth]) {
        expect((await inject('GET', `/api/pages/${page.id}`, auth)).statusCode).toBe(404);
        const raw = await inject('GET', `/files/${space}/${encodeURI(page.relPath)}`, auth);
        expect(raw.statusCode).not.toBe(200);
        expect(raw.body).not.toContain(secret);
      }
    });

    it('an admin who may not read the page sees that something was deleted, but neither its title nor its path; an entitled person sees both', async () => {
      const page = await doc('', 'Confidential Salaries', 'body');
      await restrict(page.id, ownerAuth);
      const sharedWithAdmin = await doc('', 'Shared With The Other Admin', 'body');
      await restrict(sharedWithAdmin.id, ownerAuth, [{ userId: otherAdmin.id, role: 'viewer' }]);
      const openPage = await doc('', 'Ordinary Notes', 'body');
      const itemId = await trash(page.id);
      const sharedItemId = await trash(sharedWithAdmin.id);
      const openItemId = await trash(openPage.id);

      for (const [who, auth] of [
        ['space admin', otherAdminAuth],
        ['instance admin', instAdminAuth],
      ] as const) {
        const listed = await listTrash(auth);
        const item = listed.items.find((i) => i.id === itemId);
        expect(item, `${who} still sees the item`).toBeDefined();
        expect(item!.title, who).toBe('');
        expect(item!.origPath, who).toBe('');
        expect(item!.restricted, who).toBe(true);
        expect(listed.body, who).not.toContain('Confidential');
        expect(listed.body, who).not.toContain('confidential-salaries');
        // Ordinary items are untouched.
        expect(listed.items.find((i) => i.id === openItemId)?.title, who).toBe('Ordinary Notes');
      }
      // The owner, and an admin the page was shared with, may read it.
      const mine = (await listTrash(ownerAuth)).items.find((i) => i.id === itemId);
      expect(mine?.title).toBe('Confidential Salaries');
      expect(mine?.origPath).toBe(page.relPath);
      expect(mine?.restricted).toBeUndefined();
      const sharedView = (await listTrash(otherAdminAuth)).items.find((i) => i.id === sharedItemId);
      expect(sharedView?.title).toBe('Shared With The Other Admin');
      expect(sharedView?.restricted).toBeUndefined();
      // A person who left the space is no longer entitled, whatever the rule says.
      expect((await listTrash(instAdminAuth)).items.find((i) => i.id === sharedItemId)?.title).toBe('');
    });

    it('an admin who may not read the page can restore it, and gains nothing by it: the rule stays with the owner as before, and the answer does not give the path away', async () => {
      const secret = word('adminrestore');
      const page = await doc('', 'Restored By Stranger', `body ${secret}`);
      await restrict(page.id, ownerAuth, [{ userId: grantee.id, role: 'editor' }]);
      const accessBefore = await accessOf(page.id);
      const itemId = await trash(page.id);

      const res = await restore(itemId, otherAdminAuth);
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('restored-by-stranger');
      expect(res.body).not.toContain('Restored By Stranger');

      expect((await probe(page.id, secret, otherAdminAuth)).page).toBe(403);
      expect((await probe(page.id, secret, instAdminAuth)).page).toBe(403);
      expect((await probe(page.id, secret, editorAuth)).page).toBe(403);
      expect((await probe(page.id, secret, granteeAuth)).page).toBe(200);
      expect((await probe(page.id, secret, ownerAuth)).page).toBe(200);
      expect(await accessOf(page.id)).toEqual(accessBefore);
    });
  });

  describe('restored into a changed situation', () => {
    it('a grantee who left the space meanwhile: the restore works, the page stays restricted, that grant is dropped and the others stay', async () => {
      const secret = word('leftgrantee');
      const leaver = await mkUser(`LeavingGrantee${counter++}`);
      await joinSpace(leaver, 'editor');
      const leaverAuth = await cookieFor(leaver);
      const page = await doc('', 'Grantee Leaves', `body ${secret}`);
      await restrict(page.id, ownerAuth, [
        { userId: leaver.id, role: 'editor' },
        { userId: grantee.id, role: 'viewer' },
      ]);
      expect((await probe(page.id, secret, leaverAuth)).page).toBe(200);

      const itemId = await trash(page.id);
      await authStore.removeMembership(space, leaver.id);
      const res = await restore(itemId, ownerAuth);
      expect(res.statusCode).toBe(200);

      expect((await probe(page.id, secret, leaverAuth)).page).toBe(403);
      expect((await probe(page.id, secret, editorAuth)).page).toBe(403);
      expect((await probe(page.id, secret, viewerAuth)).page).toBe(403);
      expect((await probe(page.id, secret, granteeAuth)).page).toBe(200);
      expect((await probe(page.id, secret, ownerAuth)).page).toBe(200);
      expect(await accessOf(page.id)).toEqual({ ownerId: owner.id, grants: [{ userId: grantee.id, role: 'viewer' }] });
      // A person who is re-added later does not get the old grant back.
      await joinSpace(leaver, 'editor');
      expect((await probe(page.id, secret, leaverAuth)).page).toBe(403);
    });

    it('the owner left the space meanwhile: the restore works and the page stays hidden from everyone else; it is still theirs if they come back', async () => {
      const secret = word('leftowner');
      const leaver = await mkUser(`LeavingOwner${counter++}`);
      await joinSpace(leaver, 'editor');
      const leaverAuth = await cookieFor(leaver);
      const page = await doc('', 'Owner Leaves', `body ${secret}`);
      await restrict(page.id, leaverAuth);
      expect((await probe(page.id, secret, leaverAuth)).page).toBe(200);
      expect((await probe(page.id, secret, otherAdminAuth)).page).toBe(403);

      const itemId = await trash(page.id, leaverAuth);
      await authStore.removeMembership(space, leaver.id);
      const res = await restore(itemId, otherAdminAuth);
      expect(res.statusCode).toBe(200);

      for (const [who, auth] of [
        ['space admin', otherAdminAuth],
        ['other space admin', ownerAuth],
        ['editor', editorAuth],
        ['viewer', viewerAuth],
        ['instance admin', instAdminAuth],
        ['the former owner, no longer a member', leaverAuth],
      ] as const) {
        expect((await probe(page.id, secret, auth)).page, who).toBe(403);
      }
      expect(await accessOf(page.id)).toEqual({ ownerId: leaver.id, grants: [] });
      await joinSpace(leaver, 'editor');
      expect((await probe(page.id, secret, leaverAuth)).page).toBe(200);
    });

    it('the account of the owner is gone: the restore works and the page stays restricted, to the admin who restored it', async () => {
      const secret = word('goneowner');
      const gone = await mkUser(`GoneOwner${counter++}`);
      await joinSpace(gone, 'editor');
      const goneAuth = await cookieFor(gone);
      const page = await doc('', 'Account Deleted', `body ${secret}`);
      await restrict(page.id, goneAuth, [{ userId: grantee.id, role: 'viewer' }]);
      const itemId = await trash(page.id, goneAuth);
      await query('DELETE FROM users WHERE id = $1', [gone.id]);

      const res = await restore(itemId, otherAdminAuth);
      expect(res.statusCode).toBe(200);

      expect((await probe(page.id, secret, editorAuth)).page).toBe(403);
      expect((await probe(page.id, secret, ownerAuth)).page).toBe(403);
      expect((await probe(page.id, secret, otherAdminAuth)).page).toBe(200);
      expect((await probe(page.id, secret, granteeAuth)).page).toBe(200);
      expect(await accessOf(page.id)).toEqual({ ownerId: otherAdmin.id, grants: [{ userId: grantee.id, role: 'viewer' }] });
    });

    it('the restore lands under a new name (the old path is taken): the restriction goes with the page, not with the path', async () => {
      const secret = word('renamed');
      const page = await doc('', 'Taken Name', `body ${secret}`);
      await restrict(page.id, ownerAuth);
      const itemId = await trash(page.id);
      const squatter = await doc('', 'Taken Name', 'a new page that took the path');
      expect(squatter.relPath).toBe(page.relPath);

      const res = (await restore(itemId, ownerAuth)).json() as { renamed: boolean; restoredPath: string };
      expect(res.renamed).toBe(true);
      expect(res.restoredPath).not.toBe(page.relPath);

      expect((await probe(page.id, secret, editorAuth)).page).toBe(403);
      expect((await probe(squatter.id, undefined, editorAuth)).page).toBe(200);
      expect(await accessOf(squatter.id)).toBeUndefined();
      expect(await accessOf(page.id)).toEqual({ ownerId: owner.id, grants: [] });
    });

    it('a restricted PDF inside a folder that is restored under a new name keeps its restriction, whatever id the rescan gives the file', async () => {
      const tag = `p${counter++}`;
      await putFile(`bundle-${tag}/index.md`, `# Bundle ${tag}\n\nbundle body\n`);
      await putFile(`bundle-${tag}/contract.pdf`, '%PDF-1.4 contract');
      await storage.scanSpace(space);
      const bundle = await storage.requireEntry((await storage.getEntryIdByExactPath(space, `bundle-${tag}/index.md`))!);
      const contract = await storage.requireEntry((await storage.getEntryIdByExactPath(space, `bundle-${tag}/contract.pdf`))!);
      await restrict(contract.id, ownerAuth, [{ userId: grantee.id, role: 'viewer' }]);
      const accessBefore = await accessOf(contract.id);

      const itemId = await trash(bundle.id);
      await putFile(`bundle-${tag}/index.md`, `# Squatter ${tag}\n\nsquatter\n`); // takes the folder's place
      await storage.scanSpace(space);
      const res = (await restore(itemId, ownerAuth)).json() as { renamed: boolean };
      expect(res.renamed).toBe(true);

      const restoredPdf = (await storage.listEntries(space)).find((e) => e.relPath === `bundle-${tag}-restored/contract.pdf`);
      expect(restoredPdf).toBeDefined();
      const rule = await accessOf(restoredPdf!.id);
      expect(rule).toEqual(accessBefore ? { ownerId: accessBefore.ownerId, grants: accessBefore.grants } : undefined);
      expect((await probe(restoredPdf!.id, undefined, editorAuth)).page).toBe(403);
      expect((await probe(restoredPdf!.id, undefined, granteeAuth)).page).toBe(200);
    });
  });

  describe('permanent deletion', () => {
    async function trashedRestricted(title: string) {
      const page = await doc('', title, `body ${word('purge')}`);
      await restrict(page.id, ownerAuth, [{ userId: grantee.id, role: 'viewer' }]);
      const itemId = await trash(page.id);
      const row = (await query<{ trash_path: string }>('SELECT trash_path FROM trash_items WHERE id = $1', [itemId]))[0];
      return { page, itemId, trashPath: row.trash_path };
    }
    /** No trace of the page's access anywhere in the database. */
    async function accessTraces(pageId: string): Promise<number> {
      const direct = await query('SELECT 1 FROM page_access WHERE page_id = $1', [pageId]);
      const grants = await query('SELECT 1 FROM page_access_grants WHERE page_id = $1', [pageId]);
      const remembered = await query('SELECT 1 FROM trash_items WHERE payload::text LIKE $1', [`%${pageId}%`]);
      return direct.length + grants.length + remembered.length;
    }
    const exists = (rel: string) => fs.stat(path.join(storage.TRASH_DIR, rel)).then(() => true, () => false);

    it('deleting one item for good removes the item, its files and the remembered access rules', async () => {
      const { page, itemId, trashPath } = await trashedRestricted('Purge One');
      expect(await accessTraces(page.id)).toBeGreaterThan(0); // the rules are being kept in the trash item
      expect((await inject('DELETE', `/api/trash/${itemId}`, ownerAuth)).statusCode).toBe(200);
      expect(await exists(trashPath)).toBe(false);
      expect(await accessTraces(page.id)).toBe(0);
      expect((await restore(itemId, ownerAuth)).statusCode).toBe(404);
    });

    it('emptying the trash of the space removes them too', async () => {
      const first = await trashedRestricted('Purge Many 1');
      const second = await trashedRestricted('Purge Many 2');
      const res = await inject('DELETE', `/api/trash?space=${space}`, ownerAuth);
      expect(res.statusCode).toBe(200);
      for (const gone of [first, second]) {
        expect(await exists(gone.trashPath)).toBe(false);
        expect(await accessTraces(gone.page.id)).toBe(0);
      }
    });

    it('the retention purge removes them too', async () => {
      const { page, itemId, trashPath } = await trashedRestricted('Purge By Age');
      expect((await inject('PUT', '/api/trash/settings', instAdminAuth, { retentionDays: 1 })).statusCode).toBe(200);
      try {
        await query(`UPDATE trash_items SET deleted_at = now() - interval '3 days' WHERE id = $1`, [itemId]);
        await listTrash(ownerAuth); // the purge is lazy: it runs when the list is opened
        expect(await query('SELECT 1 FROM trash_items WHERE id = $1', [itemId])).toHaveLength(0);
        expect(await exists(trashPath)).toBe(false);
        expect(await accessTraces(page.id)).toBe(0);
      } finally {
        await inject('PUT', '/api/trash/settings', instAdminAuth, { retentionDays: null });
      }
    });
  });

  describe('items that were already in the trash before the rules were kept', () => {
    it('restore without failing and without inventing a rule: what was not recorded cannot be brought back', async () => {
      const secret = word('legacy');
      const page = await doc('', 'Deleted Long Ago', `body ${secret}`);
      await restrict(page.id, ownerAuth);
      const itemId = await trash(page.id);
      await query('UPDATE trash_items SET payload = NULL WHERE id = $1', [itemId]); // what a row written before this change looks like
      const res = await restore(itemId, ownerAuth);
      expect(res.statusCode).toBe(200);
      expect(await accessOf(page.id)).toBeUndefined();
      expect((await probe(page.id, secret, ownerAuth)).page).toBe(200);
    });
  });

  describe('a whole space deleted and restored', () => {
    it('its restricted pages are still restricted', async () => {
      const spaceC = (await storage.createSpace(`Trash ACL C ${stamp}`, owner.id)).slug;
      extraSpaces.push(spaceC);
      await joinSpace(owner, 'admin', spaceC);
      await joinSpace(editor, 'editor', spaceC);
      await joinSpace(grantee, 'editor', spaceC);
      const secret = word('wholespace');
      const page = await doc('', 'Secret In Space', `body ${secret}`, spaceC);
      const openPage = await doc('', 'Open In Space', 'open body', spaceC);
      await restrict(page.id, ownerAuth, [{ userId: grantee.id, role: 'viewer' }]);
      const accessBefore = await accessOf(page.id);
      expect((await probe(page.id, secret, editorAuth, spaceC)).page).toBe(403);

      expect((await inject('DELETE', `/api/admin/spaces/${spaceC}`, instAdminAuth)).statusCode).toBe(200);
      const row = (await query<{ id: string }>(`SELECT id FROM trash_items WHERE kind = 'space' AND space_slug = $1`, [spaceC]))[0];
      const res = await restore(row.id, instAdminAuth);
      expect(res.statusCode).toBe(200);

      expect((await probe(page.id, secret, editorAuth, spaceC)).page).toBe(403);
      expect((await probe(page.id, secret, granteeAuth, spaceC)).page).toBe(200);
      expect((await probe(page.id, secret, ownerAuth, spaceC)).page).toBe(200);
      expect((await probe(openPage.id, undefined, editorAuth, spaceC)).page).toBe(200);
      expect(await accessOf(openPage.id)).toBeUndefined();
      expect(await accessOf(page.id)).toEqual(accessBefore);
    });
  });
});
