/**
 * Replacing the file of a pdf/office page with a new version, and getting an
 * older version back. Real PG + real fs + real git, through the real routes with
 * real sessions (multipart upload included).
 *
 * What is pinned here:
 *  - the page keeps its id, slug and place; the bytes change; the index row
 *    (size / updated_at) follows without waiting for a rescan;
 *  - a different extension renames the file, keeps the id, rewrites incoming
 *    links, and the title (what search finds) follows the new name;
 *  - a viewer gets 403, a read-only token gets 403, a non-file page 400, a
 *    name collision 409, a bad file 400 — and nothing changes in those cases;
 *  - every replace is its own commit, the replaced version is in the history,
 *    and restoring it (also across an extension change) brings it back.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import * as fastifyMultipartModule from '@fastify/multipart';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiTokenScope, PageAtShaResponse, PageHistoryEntry, PageMeta, ReplaceFilePageResponse, User } from '../shared/contracts.js';
import * as authStore from './auth/store.js';
import * as session from './auth/session.js';
import { query } from './db/pool.js';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import { HttpError } from './errors.js';
import { registerRoutes } from './routes.js';
import { searchPages } from './search.js';
import * as storage from './storage.js';

const execFileAsync = promisify(execFile);

type Auth = Record<string, string>;

function pdfBytes(marker: string): Buffer {
  return Buffer.from(`%PDF-1.4\n% ${marker}\ntrailer << /Root 1 0 R >>\n%%EOF\n`, 'latin1');
}
function zipBytes(marker: string): Buffer {
  return Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.from(marker, 'latin1'), Buffer.from([0, 1, 2, 255, 254, 253])]);
}

function multipart(filename: string, bytes: Buffer): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----folioTestBoundary7MA4YWxkTrZu0gW';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, bytes, tail]), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('authUser', null);
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
  });
  await app.register(fastifyMultipartModule.default, { limits: { fileSize: 50 * 1024 * 1024 } });
  await app.register(fastifyCookieModule.default);
  await app.register(async (protectedScope) => {
    protectedScope.addHook('onRequest', session.requireSession);
    registerRoutes(protectedScope);
  });
  await app.ready();
  return app;
}

describe('replace the file of a file page (real PG + fs + git, through the routes)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let owner: User;
  let editor: User;
  let viewer: User;
  let space: string;
  let editorAuth: Auth;
  let viewerAuth: Auth;
  let readOnlyAuth: Auth;

  const spaceDir = () => storage.getSpaceDir(space);

  async function gitLog(): Promise<string[]> {
    const { stdout } = await execFileAsync('git', ['log', '--pretty=format:%s'], { cwd: storage.getRepoDir(space) });
    return stdout.split('\n').filter(Boolean);
  }

  /** Creates a file page the way the product does (upload route's storage call). */
  async function newFilePage(parent: string, filename: string, ext: string, bytes: Buffer): Promise<PageMeta> {
    return storage.uploadFilePage(space, parent, filename, ext, bytes);
  }

  async function replace(id: string, filename: string, bytes: Buffer, headers: Auth = editorAuth) {
    const body = multipart(filename, bytes);
    return app.inject({ method: 'POST', url: `/api/pages/${id}/file`, payload: body.payload, headers: { ...headers, ...body.headers } });
  }

  async function history(id: string): Promise<PageHistoryEntry[]> {
    const res = await app.inject({ method: 'GET', url: `/api/pages/${id}/history`, headers: editorAuth });
    expect(res.statusCode).toBe(200);
    return (res.json() as { history: PageHistoryEntry[] }).history;
  }

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const stamp = Date.now();
    const mk = (name: string) => authStore.createUser({ email: `replace-file-${name}-${stamp}@example.com`, name, passwordHash: 'x', isAdmin: false });
    owner = await mk('Owner');
    editor = await mk('Editor');
    viewer = await mk('Viewer');
    space = (await storage.createSpace(`Replace File ${stamp}`, owner.id)).slug;
    await authStore.setMembership(space, owner.id, 'admin');
    await authStore.setMembership(space, editor.id, 'editor');
    await authStore.setMembership(space, viewer.id, 'viewer');
    const cookie = async (user: User): Promise<Auth> => ({ cookie: `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(user.id)).token}` });
    editorAuth = await cookie(editor);
    viewerAuth = await cookie(viewer);
    readOnlyAuth = { authorization: `Bearer ${(await authStore.createApiToken(editor.id, 'read only', ['read'] as ApiTokenScope[])).token}` };
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    await deleteTestSpace(space);
    await teardownSchema();
  });

  it('keeps the id, path, icon and order, swaps the bytes and refreshes the index row', async () => {
    const created = await newFilePage('', 'Quarterly Report.pdf', '.pdf', pdfBytes('first'));
    const entry = await storage.requireEntry(created.id);
    await storage.setBinaryPageIcon(entry, '📊');
    await storage.setBinaryPageOrder(await storage.requireEntry(created.id), 7);
    const before = await storage.requireEntry(created.id);

    // Same byte length on purpose: only the content differs, so a size-based skip would miss it.
    const next = pdfBytes('secnd');
    expect(next.length).toBe(pdfBytes('first').length);
    const res = await replace(created.id, 'Q3 final.pdf', next);
    expect(res.statusCode).toBe(200);
    const meta = res.json() as ReplaceFilePageResponse;

    expect(meta.id).toBe(created.id);
    // Undo target: the commit that holds the version just replaced.
    const fileAtPrevious = await app.inject({ method: 'GET', url: `/api/pages/${created.id}/history/${meta.previousSha}/file`, headers: editorAuth });
    expect(fileAtPrevious.rawPayload).toEqual(pdfBytes('first'));
    expect(meta.path).toBe(created.path); // the name of the new file does not rename the page
    expect(meta.kind).toBe('pdf');
    expect(await fs.readFile(path.join(spaceDir(), created.path))).toEqual(next);

    const after = await storage.requireEntry(created.id);
    expect(after.icon).toBe('📊');
    expect(after.explicitOrder).toBe(7);
    expect(after.title).toBe(before.title);
    const row = (await query<{ file_size: string; file_mtime: Date; updated_at: Date }>('SELECT file_size, file_mtime, updated_at FROM pages_index WHERE id = $1', [created.id]))[0];
    expect(Number(row.file_size)).toBe(next.length);
    expect(new Date(row.updated_at).toISOString()).toBe(new Date(row.file_mtime).toISOString());

    // The served file is the new one.
    const served = await app.inject({ method: 'GET', url: `/api/pages/${created.id}/file`, headers: editorAuth });
    expect(served.statusCode).toBe(200);
    expect(served.rawPayload).toEqual(next);

    // A rescan changes nothing about the identity.
    await storage.scanSpace(space);
    expect((await storage.requireEntry(created.id)).relPath).toBe(created.path);
  });

  it('makes each replace its own commit and keeps the replaced version in the history', async () => {
    const created = await newFilePage('', 'history-deck.pptx', '.pptx', zipBytes('v1'));
    await replace(created.id, 'history-deck.pptx', zipBytes('v2'));
    await replace(created.id, 'history-deck.pptx', zipBytes('v3'));

    const log = await gitLog();
    expect(log.filter((s) => s === 'files: replace history-deck.pptx')).toHaveLength(2);

    const entries = await history(created.id);
    const messages = entries.map((e) => e.message);
    expect(messages.slice(0, 2)).toEqual(['files: replace history-deck.pptx', 'files: replace history-deck.pptx']);
    // v1 was committed before v2 replaced it, so three versions are reachable.
    expect(entries.length).toBeGreaterThanOrEqual(3);

    // GET history/:sha describes the file; the bytes ride the /file sibling.
    const oldest = entries[2];
    const info = await app.inject({ method: 'GET', url: `/api/pages/${created.id}/history/${oldest.sha}`, headers: editorAuth });
    expect(info.statusCode).toBe(200);
    const body = info.json() as PageAtShaResponse;
    expect(body.file).toEqual({ path: 'history-deck.pptx', ext: '.pptx', size: zipBytes('v1').length });
    const bytes = await app.inject({ method: 'GET', url: `/api/pages/${created.id}/history/${oldest.sha}/file?download=1`, headers: viewerAuth });
    expect(bytes.statusCode).toBe(200);
    expect(bytes.rawPayload).toEqual(zipBytes('v1'));
    expect(String(bytes.headers['content-disposition'])).toContain('attachment');

    // Restoring v1 is one more commit and puts the old bytes back; the history is not rewritten.
    const restored = await app.inject({ method: 'POST', url: `/api/pages/${created.id}/restore/${oldest.sha}`, headers: editorAuth });
    expect(restored.statusCode).toBe(200);
    expect(await fs.readFile(path.join(spaceDir(), 'history-deck.pptx'))).toEqual(zipBytes('v1'));
    const afterRestore = await history(created.id);
    expect(afterRestore[0].message).toMatch(/^files: restore history-deck\.pptx to [0-9a-f]{7}$/);
    expect(afterRestore.length).toBe(entries.length + 1);
  });

  it('does not let a revision of another page be restored', async () => {
    const a = await newFilePage('', 'iso-a.pdf', '.pdf', pdfBytes('a1'));
    const b = await newFilePage('', 'iso-b.pdf', '.pdf', pdfBytes('b1'));
    await replace(a.id, 'iso-a.pdf', pdfBytes('a2'));
    await replace(b.id, 'iso-b.pdf', pdfBytes('b2'));
    const aHistory = await history(a.id);
    const res = await app.inject({ method: 'POST', url: `/api/pages/${b.id}/restore/${aHistory[0].sha}`, headers: editorAuth });
    expect(res.statusCode).toBe(404);
    expect(await fs.readFile(path.join(spaceDir(), 'iso-b.pdf'))).toEqual(pdfBytes('b2'));
    const bad = await app.inject({ method: 'POST', url: `/api/pages/${b.id}/restore/--output=x`, headers: editorAuth });
    expect(bad.statusCode).toBe(400);
  });

  describe('a different extension', () => {
    it('renames the file, keeps the id, rewrites incoming links, follows the title, and restores across the rename', async () => {
      const created = await newFilePage('', 'offer deck.pptx', '.pptx', zipBytes('pptx-one'));
      expect(created.path).toBe('offer-deck.pptx');
      expect(created.kind).toBe('office');
      const doc = await storage.createPage({ space, parentPath: '', title: 'Links to deck', kind: 'doc' });
      await storage.writeDocBody(doc.id, `# Links to deck\n\nSee [the deck](offer-deck.pptx) and [again](./offer-deck.pptx).\n`);
      await storage.scanSpace(space);
      await storage.setBinaryPageOrder(await storage.requireEntry(created.id), 3);

      const pdf = pdfBytes('exported');
      const res = await replace(created.id, 'offer deck export.pdf', pdf);
      expect(res.statusCode).toBe(200);
      const meta = res.json() as ReplaceFilePageResponse;

      expect(meta.id).toBe(created.id);
      // The undo target is the commit of the .pptx version, not the pure-rename commit in between.
      const undo = await app.inject({ method: 'POST', url: `/api/pages/${created.id}/restore/${meta.previousSha}`, headers: editorAuth });
      expect(undo.statusCode).toBe(200);
      expect((undo.json() as PageMeta).path).toBe('offer-deck.pptx');
      expect(await fs.readFile(path.join(spaceDir(), 'offer-deck.pptx'))).toEqual(zipBytes('pptx-one'));
      const again = await replace(created.id, 'offer deck export.pdf', pdf);
      expect(again.statusCode).toBe(200);
      expect(meta.path).toBe('offer-deck.pdf');
      expect(meta.kind).toBe('pdf');
      expect(meta.title).toBe('offer-deck.pdf');
      await expect(fs.access(path.join(spaceDir(), 'offer-deck.pptx'))).rejects.toThrow();
      expect(await fs.readFile(path.join(spaceDir(), 'offer-deck.pdf'))).toEqual(pdf);
      expect((await storage.requireEntry(created.id)).explicitOrder).toBe(3);

      // Incoming links follow the file.
      const body = await storage.readFreshDocBody(doc.id);
      expect(body).toContain('(offer-deck.pdf)');
      expect(body).not.toContain('offer-deck.pptx');
      const links = await query<{ target_page_id: string | null; kind: string }>('SELECT target_page_id, kind FROM links WHERE source_page_id = $1', [doc.id]);
      expect(links.length).toBeGreaterThan(0);
      for (const link of links) expect(link.target_page_id).toBe(created.id);

      // Search finds the page by its new name, not the old one.
      const hitsNew = await searchPages('offer-deck.pdf', { userId: owner.id, space });
      expect(hitsNew.map((h) => h.id)).toContain(created.id);
      const stale = await searchPages('offer-deck.pptx', { userId: owner.id, space });
      expect(stale.filter((h) => h.id === created.id && h.title.endsWith('.pptx'))).toEqual([]);

      // History: pure rename commit, then the content; git follows across the rename.
      const log = await gitLog();
      expect(log).toContain('docs: rename offer-deck.pptx -> offer-deck.pdf');
      expect(log).toContain('files: replace offer-deck.pdf');
      const entries = await history(created.id);
      const pptxVersion = entries[entries.length - 1];
      const info = await app.inject({ method: 'GET', url: `/api/pages/${created.id}/history/${pptxVersion.sha}`, headers: editorAuth });
      expect((info.json() as PageAtShaResponse).file).toMatchObject({ path: 'offer-deck.pptx', ext: '.pptx' });

      // Restoring the .pptx version brings the old extension, the old bytes and the old links back.
      const restored = await app.inject({ method: 'POST', url: `/api/pages/${created.id}/restore/${pptxVersion.sha}`, headers: editorAuth });
      expect(restored.statusCode).toBe(200);
      const back = restored.json() as PageMeta;
      expect(back.id).toBe(created.id);
      expect(back.path).toBe('offer-deck.pptx');
      expect(back.kind).toBe('office');
      expect(await fs.readFile(path.join(spaceDir(), 'offer-deck.pptx'))).toEqual(zipBytes('pptx-one'));
      expect(await storage.readFreshDocBody(doc.id)).toContain('(offer-deck.pptx)');
    });

    it('answers 409 and changes nothing when the new name is already taken', async () => {
      const deck = await newFilePage('', 'taken.pptx', '.pptx', zipBytes('deck'));
      await newFilePage('', 'taken.pdf', '.pdf', pdfBytes('other'));
      const res = await replace(deck.id, 'x.pdf', pdfBytes('new'));
      expect(res.statusCode).toBe(409);
      expect(await fs.readFile(path.join(spaceDir(), 'taken.pptx'))).toEqual(zipBytes('deck'));
      expect((await storage.requireEntry(deck.id)).relPath).toBe('taken.pptx');
    });

    it('treats a change of letter case as the same extension', async () => {
      const created = await newFilePage('', 'caps.pdf', '.pdf', pdfBytes('lower'));
      const res = await replace(created.id, 'CAPS.PDF', pdfBytes('upper'));
      expect(res.statusCode).toBe(200);
      expect((res.json() as PageMeta).path).toBe('caps.pdf');
    });
  });

  describe('permissions and bad input', () => {
    it('a viewer gets 403 and nothing changes', async () => {
      const created = await newFilePage('', 'viewer-test.pdf', '.pdf', pdfBytes('keep'));
      const res = await replace(created.id, 'viewer-test.pdf', pdfBytes('hack'), viewerAuth);
      expect(res.statusCode).toBe(403);
      expect(await fs.readFile(path.join(spaceDir(), 'viewer-test.pdf'))).toEqual(pdfBytes('keep'));
      const history = await app.inject({ method: 'GET', url: `/api/pages/${created.id}/history`, headers: viewerAuth });
      expect(history.statusCode).toBe(200); // reading the history stays viewer-level
      const sha = ((history.json() as { history: PageHistoryEntry[] }).history[0] ?? { sha: 'deadbeef' }).sha;
      const restore = await app.inject({ method: 'POST', url: `/api/pages/${created.id}/restore/${sha}`, headers: viewerAuth });
      expect(restore.statusCode).toBe(403);
    });

    it('a read-only token gets 403', async () => {
      const created = await newFilePage('', 'scope-test.pdf', '.pdf', pdfBytes('keep'));
      const res = await replace(created.id, 'scope-test.pdf', pdfBytes('hack'), readOnlyAuth);
      expect(res.statusCode).toBe(403);
      expect(await fs.readFile(path.join(spaceDir(), 'scope-test.pdf'))).toEqual(pdfBytes('keep'));
    });

    it('rejects a file whose bytes do not match its extension, an unsupported type, and a page that is not a file', async () => {
      const created = await newFilePage('', 'bad-input.pdf', '.pdf', pdfBytes('keep'));
      expect((await replace(created.id, 'fake.pdf', Buffer.from('not a pdf at all'))).statusCode).toBe(400);
      expect((await replace(created.id, 'fake.docx', Buffer.from('not a zip at all'))).statusCode).toBe(400);
      expect((await replace(created.id, 'notes.txt', Buffer.from('hello'))).statusCode).toBe(400);
      expect(await fs.readFile(path.join(spaceDir(), 'bad-input.pdf'))).toEqual(pdfBytes('keep'));

      const doc = await storage.createPage({ space, parentPath: '', title: 'Plain doc', kind: 'doc' });
      expect((await replace(doc.id, 'x.pdf', pdfBytes('x'))).statusCode).toBe(400);
      expect((await replace('does-not-exist', 'x.pdf', pdfBytes('x'))).statusCode).toBe(404);
    });
  });
});
