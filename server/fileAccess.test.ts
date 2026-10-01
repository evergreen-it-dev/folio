/**
 * Security review F-01: GET /files/<space>/<path> served any file of the
 * space to anyone with a viewer role there, and to anyone holding a share
 * link to ANY one page of it. Driven through app.inject against the exact
 * plugin server/index.ts registers (registerFileRoutes), real PG schema,
 * real files in the space's working tree.
 *
 * Fixture, space-relative:
 *   guide.md                 open; embeds guide/diagram.png, links files/report.zip,
 *                            embeds the repo-mode upload /files/<space>/assets/upload.png,
 *                            and the two boards below
 *   guide/chapter.md         open child of guide; embeds img/chapter.png
 *   guide/hidden.md          RESTRICTED child of guide; embeds hidden-shot.png
 *   secret.md                RESTRICTED (owner only); embeds secret/chart.png
 *                            AND guide/diagram.png (also shown on guide.md)
 *   other.md                 open; embeds other/pic.png
 *   whiteboard.excalidraw.svg        open board page
 *   private-board.excalidraw.svg     RESTRICTED board page
 *   misc/notes.txt           referenced by nothing
 *
 * Security review F-04 (second half): the response headers of a served file
 * come from the byte-derived policy of safeServe.ts — see the last describe.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { User } from '../shared/contracts.js';
import * as authStore from './auth/store.js';
import * as session from './auth/session.js';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import { HttpError } from './errors.js';
import { normalizeFilePath, referencedFiles, registerFileRoutes } from './fileAccess.js';
import * as pageAccess from './pageAccess.js';
import { SANDBOX_CSP } from './safeServe.js';
import * as shares from './shares.js';
import * as storage from './storage.js';

// The live-collaboration half of a page's references, without a WebSocket:
// fileAccess.ts reads exactly these two functions of collab.ts, and nothing
// else this file imports touches collab.ts at all.
const liveTexts = vi.hoisted(() => new Map<string, string>());
vi.mock('./collab.js', () => ({
  isDocLive: (id: string) => liveTexts.has(id),
  getLiveText: (id: string) => liveTexts.get(id),
}));

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('authUser', null);
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
  });
  await app.register(fastifyCookieModule.default);
  await app.register(registerFileRoutes); // exactly as server/index.ts registers it
  await app.ready();
  return app;
}

describe('pure helpers', () => {
  it('normalizeFilePath refuses dot segments, .folio metadata, NUL and backslashes; collapses empty segments', () => {
    expect(normalizeFilePath('guide/diagram.png')).toBe('guide/diagram.png');
    expect(normalizeFilePath('guide//diagram.png')).toBe('guide/diagram.png');
    for (const bad of ['.git/config', 'a/../b.png', './x.png', '.agent/rules.md', 'notes/.env', 'acme.folio', 'a\\b.png', 'a\0b', '', '/']) {
      expect(normalizeFilePath(bad), bad).toBeUndefined();
    }
  });

  it('referencedFiles resolves relative links/images, reference definitions, HTML src and app-absolute /files URLs of this space only', () => {
    const text = [
      '---',
      'cover: /files/acme/assets/cover.png',
      '---',
      '![shot](img/shot.png "Title") and [doc](../files/manual.pdf#page=2)',
      '![spaced](<my file.png>) [encoded](my%20other.png?x=1)',
      '[ref]: ../shared/logo.svg',
      '<img src="raw/html.png"> <a href=\'raw/link.zip\'>zip</a>',
      '![upload](/files/acme/assets/upload.png) ![foreign](/files/other-space/x.png)',
      '[outside](https://example.com/x.png) [escape](../../../etc/passwd) [git](.git/config) [anchor](#top)',
    ].join('\n');
    expect([...referencedFiles(text, 'docs/page.md', 'acme')].sort()).toEqual(
      [
        'assets/cover.png',
        'assets/upload.png',
        'docs/img/shot.png',
        'docs/my file.png',
        'docs/my other.png',
        'docs/raw/html.png',
        'docs/raw/link.zip',
        'files/manual.pdf',
        'shared/logo.svg',
      ].sort(),
    );
  });
});

describe('F-01: GET /files/:space/* follows page access and the share boundary', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let space: string;
  let spaceDir: string;
  let owner: User;
  let viewerCookie: string;
  let ownerCookie: string;
  let outsiderCookie: string;

  let guide: storage.PageIndexEntry;
  let chapter: storage.PageIndexEntry;
  let hidden: storage.PageIndexEntry;
  let secret: storage.PageIndexEntry;
  let other: storage.PageIndexEntry;
  let board: storage.PageIndexEntry;
  let privateBoard: storage.PageIndexEntry;

  async function doc(parentPath: string, title: string, body: string): Promise<storage.PageIndexEntry> {
    const meta = await storage.createPage({ space, parentPath, title, kind: 'doc' });
    await storage.writeDocBody(meta.id, `# ${title}\n\n${body}\n`);
    return storage.requireEntry(meta.id);
  }

  async function putFile(relPath: string, content: string | Buffer): Promise<void> {
    await fs.mkdir(path.dirname(path.join(spaceDir, relPath)), { recursive: true });
    await fs.writeFile(path.join(spaceDir, relPath), content);
  }

  function get(url: string, cookie?: string) {
    return app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
  }

  async function shareToken(rootId: string, includeChildren = false): Promise<string> {
    const link = await shares.createShareLink(rootId, owner.id, 'view', 'http://acme.example.com', includeChildren);
    return link.url.split('/share/')[1];
  }

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const stamp = Date.now();
    owner = await authStore.createUser({ email: `files-owner-${stamp}@example.com`, name: 'Owner', passwordHash: 'x', isAdmin: false });
    const viewer = await authStore.createUser({ email: `files-viewer-${stamp}@example.com`, name: 'Viewer', passwordHash: 'x', isAdmin: false });
    const outsider = await authStore.createUser({ email: `files-outsider-${stamp}@example.com`, name: 'Outsider', passwordHash: 'x', isAdmin: false });
    space = (await storage.createSpace(`Files ACL ${stamp}`, owner.id)).slug;
    spaceDir = storage.getSpaceDir(space);
    await authStore.setMembership(space, owner.id, 'admin');
    await authStore.setMembership(space, viewer.id, 'viewer');
    ownerCookie = `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(owner.id)).token}`;
    viewerCookie = `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(viewer.id)).token}`;
    outsiderCookie = `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(outsider.id)).token}`;

    board = await storage.requireEntry((await storage.createPage({ space, parentPath: '', title: 'Whiteboard', kind: 'board' })).id);
    privateBoard = await storage.requireEntry((await storage.createPage({ space, parentPath: '', title: 'Private Board', kind: 'board' })).id);
    guide = await doc(
      '',
      'Guide',
      [
        '![diagram](guide/diagram.png)',
        '![spaced](<guide/screen shot.png>) ![encoded](guide/%D0%B7%D0%BD%D1%96%D0%BC%D0%BE%D0%BA.png)',
        '[report](files/report.zip)',
        `![upload](/files/${space}/assets/upload.png)`,
        `![board](${board.relPath})`,
        `![private board](${privateBoard.relPath})`,
      ].join('\n\n'),
    );
    chapter = await doc('guide', 'Chapter', '![chapter](img/chapter.png)');
    hidden = await doc('guide', 'Hidden', '![hidden](hidden-shot.png)');
    secret = await doc('', 'Secret', 'Salary table text.\n\n![chart](secret/chart.png)\n\n![logo](guide/diagram.png)');
    other = await doc('', 'Other', 'Other text.\n\n![pic](other/pic.png)');
    await doc('.agent', 'Rules', 'Assistant rules.'); // admin-only: hidden from the viewer, not from the owner

    await putFile('guide/diagram.png', 'DIAGRAM');
    await putFile('guide/screen shot.png', 'SPACED');
    await putFile('guide/\u0437\u043d\u0456\u043c\u043e\u043a.png', 'CYRILLIC');
    await putFile('files/report.zip', 'REPORT');
    await putFile('assets/upload.png', 'UPLOAD');
    await putFile('guide/img/chapter.png', 'CHAPTER-IMG');
    await putFile('guide/hidden-shot.png', 'HIDDEN-SHOT');
    await putFile('secret/chart.png', 'SECRET-CHART');
    await putFile('other/pic.png', 'OTHER-PIC');
    await putFile('misc/notes.txt', 'NOTES');

    await pageAccess.setAccess(owner, secret, 'restricted', []);
    await pageAccess.setAccess(owner, hidden, 'restricted', []);
    await pageAccess.setAccess(owner, privateBoard, 'restricted', []);

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    await deleteTestSpace(space).catch(() => {});
    await teardownSchema();
  });

  describe('session caller', () => {
    it('a viewer cannot read the file of a page that page access hides from them (same verdict as the page API)', async () => {
      expect(await session.effectivePageRole((await authStore.findUserById(owner.id))!, secret)).toBe('editor');
      const res = await get(`/files/${space}/${secret.relPath}`, viewerCookie);
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain('Salary table text.');
      expect((await get(`/files/${space}/${privateBoard.relPath}`, viewerCookie)).statusCode).toBe(403);
    });

    it('nor an attachment only that hidden page references', async () => {
      const res = await get(`/files/${space}/secret/chart.png`, viewerCookie);
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain('SECRET-CHART');
    });

    it('a file the hidden page shares with a page the viewer CAN open is still served', async () => {
      const res = await get(`/files/${space}/guide/diagram.png`, viewerCookie);
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('DIAGRAM');
    });

    it('ordinary images and files of readable pages, repo-mode uploads and unreferenced files keep working', async () => {
      for (const [rel, body] of [
        [guide.relPath, 'Guide'],
        ['files/report.zip', 'REPORT'],
        ['assets/upload.png', 'UPLOAD'],
        ['guide/img/chapter.png', 'CHAPTER-IMG'],
        ['other/pic.png', 'OTHER-PIC'],
        ['misc/notes.txt', 'NOTES'],
        [board.relPath, '<svg'],
      ]) {
        const res = await get(`/files/${space}/${rel}`, viewerCookie);
        expect(res.statusCode, rel).toBe(200);
        expect(res.body, rel).toContain(body);
      }
    });

    it('the owner of the restricted page reads its file and its attachment', async () => {
      expect((await get(`/files/${space}/${secret.relPath}`, ownerCookie)).body).toContain('Salary table text.');
      expect((await get(`/files/${space}/secret/chart.png`, ownerCookie)).body).toBe('SECRET-CHART');
    });

    it('a case variant of the hidden page path does not slip through as "not a page"', async () => {
      const res = await get(`/files/${space}/${secret.relPath.toUpperCase()}`, viewerCookie);
      expect(res.statusCode).not.toBe(200);
      expect(res.body).not.toContain('Salary table text.');
    });

    it('pageAccess.hiddenPages is the exact complement of readablePageIds (the two must never disagree)', async () => {
      for (const cookie of [viewerCookie, ownerCookie]) {
        const userId = (await authStore.resolveSessionUserId(cookie.split('=')[1]))!;
        const user = (await authStore.findUserById(userId))!;
        const readable = await session.readablePageIds(user, space);
        const hiddenIds = new Set((await pageAccess.hiddenPages(user.id, space, await session.canAdministerSpace(user, space))).map((p) => p.id));
        const all = (await storage.listEntries(space)).map((e) => e.id);
        expect(all.filter((id) => !readable.has(id)).sort()).toEqual([...hiddenIds].sort());
      }
    });

    it('no session is 401; a session without a role in the space is 403', async () => {
      expect((await get(`/files/${space}/guide/diagram.png`)).statusCode).toBe(401);
      expect((await get(`/files/${space}/guide/diagram.png`, outsiderCookie)).statusCode).toBe(403);
    });
  });

  describe('share-token caller', () => {
    it('a link to ONE page serves that page, its attachments, its repo-mode upload and the open board it embeds', async () => {
      const token = await shareToken(guide.id);
      for (const [rel, body] of [
        [guide.relPath, 'Guide'],
        ['guide/diagram.png', 'DIAGRAM'],
        ['guide/screen%20shot.png', 'SPACED'],
        [`guide/${encodeURIComponent('\u0437\u043d\u0456\u043c\u043e\u043a')}.png`, 'CYRILLIC'],
        ['files/report.zip', 'REPORT'],
        ['assets/upload.png', 'UPLOAD'],
        [board.relPath, '<svg'],
      ]) {
        const res = await get(`/files/${space}/${rel}?share=${token}`);
        expect(res.statusCode, rel).toBe(200);
        expect(res.body, rel).toContain(body);
      }
    });

    it('…and nothing else of the space: other pages\' Markdown, their attachments, restricted pages, unreferenced files', async () => {
      const token = await shareToken(guide.id);
      for (const [rel, secretBody] of [
        [other.relPath, 'Other text.'],
        ['other/pic.png', 'OTHER-PIC'],
        [secret.relPath, 'Salary table text.'],
        ['secret/chart.png', 'SECRET-CHART'],
        ['misc/notes.txt', 'NOTES'],
        [chapter.relPath, 'Chapter'], // a child, but this link has no includeChildren
        ['guide/img/chapter.png', 'CHAPTER-IMG'],
        [privateBoard.relPath, '<svg'], // embedded by the shared page, but itself restricted
      ]) {
        const res = await get(`/files/${space}/${rel}?share=${token}`);
        expect(res.statusCode, rel).toBe(403);
        expect(res.body, rel).not.toContain(secretBody);
      }
    });

    it('a subtree link adds its open children and their attachments — not a restricted child or its attachment', async () => {
      const token = await shareToken(guide.id, true);
      expect((await get(`/files/${space}/${chapter.relPath}?share=${token}`)).statusCode).toBe(200);
      expect((await get(`/files/${space}/guide/img/chapter.png?share=${token}`)).body).toBe('CHAPTER-IMG');
      expect((await get(`/files/${space}/${hidden.relPath}?share=${token}`)).statusCode).toBe(403);
      expect((await get(`/files/${space}/guide/hidden-shot.png?share=${token}`)).statusCode).toBe(403);
    });

    it('an image that so far exists only in the live (not yet flushed) text of the shared page is served', async () => {
      const token = await shareToken(other.id);
      await putFile('other/live.png', 'LIVE');
      expect((await get(`/files/${space}/other/live.png?share=${token}`)).statusCode).toBe(403);
      liveTexts.set(other.id, '# Other\n\nOther text.\n\n![live](other/live.png)\n');
      try {
        expect((await get(`/files/${space}/other/live.png?share=${token}`)).body).toBe('LIVE');
      } finally {
        liveTexts.delete(other.id);
      }
    });

    it('a restricted page shared by its own link serves its own attachments', async () => {
      const token = await shareToken(secret.id);
      expect((await get(`/files/${space}/secret/chart.png?share=${token}`)).body).toBe('SECRET-CHART');
    });

    it('unknown and revoked tokens are 401; a token used against another space is 403', async () => {
      expect((await get(`/files/${space}/guide/diagram.png?share=deadbeef`)).statusCode).toBe(401);
      const link = await shares.createShareLink(guide.id, owner.id, 'view', 'http://acme.example.com');
      const token = link.url.split('/share/')[1];
      await shares.revokeShare(link.id);
      expect((await get(`/files/${space}/guide/diagram.png?share=${token}`)).statusCode).toBe(401);

      const elsewhere = (await storage.createSpace(`Files Elsewhere ${Date.now()}`, owner.id)).slug;
      try {
        await fs.writeFile(path.join(storage.getSpaceDir(elsewhere), 'x.png'), 'X');
        const res = await get(`/files/${elsewhere}/x.png?share=${await shareToken(guide.id)}`);
        expect(res.statusCode).toBe(403);
      } finally {
        await deleteTestSpace(elsewhere).catch(() => {});
      }
    });
  });

  describe('never served: Git internals, dotfiles, .folio metadata, traversal, symlinks', () => {
    it('.git/** and the space .folio file are 404 even for the space admin and for a share of a page that "links" them', async () => {
      await fs.access(path.join(spaceDir, '.git', 'config'));
      await fs.access(path.join(spaceDir, `${space}.folio`));
      const token = await shareToken(guide.id);
      for (const rel of ['.git/config', '.git/HEAD', `${space}.folio`, '.agent/rules.md', '%2Egit/config']) {
        expect((await get(`/files/${space}/${rel}`, ownerCookie)).statusCode, rel).toBe(404);
        expect((await get(`/files/${space}/${rel}?share=${token}`)).statusCode, rel).not.toBe(200);
      }
    });

    it('encoded traversal never leaves the space', async () => {
      for (const rel of ['..%2F..%2Fpackage.json', '%2E%2E/%2E%2E/package.json', 'guide/..%2F..%2F..%2Fpackage.json']) {
        const res = await get(`/files/${space}/${rel}`, ownerCookie);
        expect(res.statusCode, rel).not.toBe(200);
        expect(res.body, rel).not.toContain('"name": "folio"');
      }
    });

    it('a symlink inside the repository is not followed — not even to a page the caller may read', async () => {
      await fs.symlink(secret.relPath, path.join(spaceDir, 'alias.png'));
      await fs.symlink('guide/diagram.png', path.join(spaceDir, 'diagram-alias.png'));
      try {
        const res = await get(`/files/${space}/alias.png`, viewerCookie);
        expect(res.statusCode).toBe(404);
        expect(res.body).not.toContain('Salary table text.');
        expect((await get(`/files/${space}/diagram-alias.png`, ownerCookie)).statusCode).toBe(404);
      } finally {
        await fs.rm(path.join(spaceDir, 'alias.png'), { force: true });
        await fs.rm(path.join(spaceDir, 'diagram-alias.png'), { force: true });
      }
    });

    it('the file sent is the file authorized: a literal percent sequence in a name is not decoded a second time', async () => {
      await putFile('misc/%41.txt', 'LITERAL');
      await putFile('misc/A.txt', 'WRONG FILE');
      const res = await get(`/files/${space}/misc/%2541.txt`, viewerCookie);
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('LITERAL');
    });
  });
  describe('F-04: repository files are served with the safe headers (safeServe.ts)', () => {
    const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(24)]);
    const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(24)]);
    const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(16)]);
    const PDF = Buffer.from('%PDF-1.7\n%%EOF\n');
    const SCRIPTED_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(document.cookie)</script></svg>';
    const SCRIPTED_HTML = '<!doctype html><html><body><script>alert(document.cookie)</script></body></html>';

    function header(res: { headers: Record<string, unknown> }, name: string): string {
      return String(res.headers[name] ?? '');
    }

    async function fetchFile(rel: string, init: { cookie?: string; method?: 'GET' | 'HEAD'; headers?: Record<string, string> } = {}) {
      return app.inject({
        method: init.method ?? 'GET',
        url: `/files/${space}/${rel}`,
        headers: { cookie: init.cookie ?? viewerCookie, ...init.headers },
      });
    }

    it('a repository SVG is still an image: inline, image/svg+xml, nosniff and the sandbox CSP — scripts in it cannot run when opened directly', async () => {
      await putFile('safe/logo.svg', SCRIPTED_SVG);
      const res = await fetchFile('safe/logo.svg');
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(SCRIPTED_SVG);
      expect(header(res, 'content-type')).toBe('image/svg+xml');
      expect(header(res, 'content-disposition')).toMatch(/^inline;/);
      expect(header(res, 'x-content-type-options')).toBe('nosniff');
      expect(header(res, 'content-security-policy')).toBe(SANDBOX_CSP);
    });

    it('an SVG saved under a raster name is still recognised by its bytes and sandboxed', async () => {
      await putFile('safe/disguised-svg.png', SCRIPTED_SVG);
      const res = await fetchFile('safe/disguised-svg.png');
      expect(header(res, 'content-type')).toBe('image/svg+xml');
      expect(header(res, 'content-security-policy')).toBe(SANDBOX_CSP);
    });

    it('a board page (its .excalidraw.svg) keeps rendering inline under the sandbox, for a session and for a share link', async () => {
      const res = await fetchFile(board.relPath);
      expect(res.statusCode).toBe(200);
      expect(header(res, 'content-type')).toBe('image/svg+xml');
      expect(header(res, 'content-disposition')).toMatch(/^inline;/);
      expect(header(res, 'content-security-policy')).toBe(SANDBOX_CSP);

      const shared = await app.inject({ method: 'GET', url: `/files/${space}/${board.relPath}?share=${await shareToken(guide.id)}` });
      expect(shared.statusCode).toBe(200);
      expect(header(shared, 'content-type')).toBe('image/svg+xml');
      expect(header(shared, 'content-security-policy')).toBe(SANDBOX_CSP);
      expect(header(shared, 'x-content-type-options')).toBe('nosniff');
    });

    it('an HTML file is a download, never a page of this origin — by its name and under a raster name', async () => {
      await putFile('safe/page.html', SCRIPTED_HTML);
      await putFile('safe/fake.png', SCRIPTED_HTML);
      await putFile('safe/notes.xhtml', SCRIPTED_HTML);
      for (const rel of ['safe/page.html', 'safe/fake.png', 'safe/notes.xhtml']) {
        const res = await fetchFile(rel);
        expect(res.statusCode, rel).toBe(200);
        expect(header(res, 'content-type'), rel).toBe('application/octet-stream');
        expect(header(res, 'content-disposition'), rel).toMatch(/^attachment;/);
        expect(header(res, 'x-content-type-options'), rel).toBe('nosniff');
        expect(header(res, 'content-security-policy'), rel).toBe(SANDBOX_CSP);
      }
    });

    it('real rasters and PDF stay inline images/documents with their true type and no CSP', async () => {
      await putFile('safe/shot.png', PNG);
      await putFile('safe/photo.jpg', JPEG);
      await putFile('safe/anim.webp', WEBP);
      await putFile('safe/manual.pdf', PDF);
      for (const [rel, type] of [
        ['safe/shot.png', 'image/png'],
        ['safe/photo.jpg', 'image/jpeg'],
        ['safe/anim.webp', 'image/webp'],
        ['safe/manual.pdf', 'application/pdf'],
      ]) {
        const res = await fetchFile(rel);
        expect(res.statusCode, rel).toBe(200);
        expect(header(res, 'content-type'), rel).toBe(type);
        expect(header(res, 'content-disposition'), rel).toMatch(/^inline;/);
        expect(header(res, 'x-content-type-options'), rel).toBe('nosniff');
        expect(res.headers['content-security-policy'], rel).toBeUndefined();
      }
      expect((await fetchFile('safe/shot.png')).rawPayload.equals(PNG)).toBe(true);
    });

    it('text, data and unknown files are downloads with a stable type (UTF-8 declared for text)', async () => {
      await putFile('safe/readme.md', '# Title\n');
      await putFile('safe/plain.txt', 'text\n');
      await putFile('safe/data.json', '{"a":1}');
      await putFile('safe/rows.csv', 'a,b\n1,2\n');
      await putFile('safe/scene.excalidraw', '{"type":"excalidraw"}');
      await putFile('safe/blob.bin', Buffer.from([0, 1, 2, 3]));
      for (const [rel, type] of [
        ['safe/readme.md', 'text/markdown; charset=utf-8'],
        ['safe/plain.txt', 'text/plain; charset=utf-8'],
        ['safe/data.json', 'application/json'],
        ['safe/rows.csv', 'text/csv; charset=utf-8'],
        ['safe/scene.excalidraw', 'application/octet-stream'],
        ['safe/blob.bin', 'application/octet-stream'],
      ]) {
        const res = await fetchFile(rel);
        expect(res.statusCode, rel).toBe(200);
        expect(header(res, 'content-type'), rel).toBe(type);
        expect(header(res, 'content-disposition'), rel).toMatch(/^attachment;/);
        expect(header(res, 'x-content-type-options'), rel).toBe('nosniff');
      }
    });

    it('audio and video keep streaming: the type is exact and a Range request is answered 206 with the headers', async () => {
      const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(64, 7)]);
      await putFile('safe/clip.mp4', mp4);
      const res = await fetchFile('safe/clip.mp4', { headers: { range: 'bytes=0-9' } });
      expect(res.statusCode).toBe(206);
      expect(header(res, 'content-type')).toBe('video/mp4');
      expect(header(res, 'content-range')).toBe(`bytes 0-9/${mp4.length}`);
      expect(header(res, 'x-content-type-options')).toBe('nosniff');
      expect(res.rawPayload.equals(mp4.subarray(0, 10))).toBe(true);
    });

    it('a file with a non-ASCII name is served with a well-formed Content-Disposition', async () => {
      const res = await fetchFile(`guide/${encodeURIComponent('\u0437\u043d\u0456\u043c\u043e\u043a')}.png`);
      expect(res.statusCode).toBe(200);
      expect(header(res, 'content-disposition')).toContain("filename*=UTF-8''%D0%B7%D0%BD%D1%96%D0%BC%D0%BE%D0%BA.png");
      expect(header(res, 'content-disposition')).not.toMatch(/[^\x20-\x7e]/);
    });

    it('revalidation (304) and HEAD carry the same policy as the full response', async () => {
      await putFile('safe/cached.svg', SCRIPTED_SVG);
      const first = await fetchFile('safe/cached.svg');
      const etag = header(first, 'etag');
      expect(etag).not.toBe('');

      const revalidated = await fetchFile('safe/cached.svg', { headers: { 'if-none-match': etag } });
      expect(revalidated.statusCode).toBe(304);
      expect(header(revalidated, 'x-content-type-options')).toBe('nosniff');
      expect(header(revalidated, 'content-security-policy')).toBe(SANDBOX_CSP);
      expect(header(revalidated, 'content-type')).toBe('image/svg+xml');

      const head = await fetchFile('safe/cached.svg', { method: 'HEAD' });
      expect(head.statusCode).toBe(200);
      expect(head.body).toBe('');
      expect(header(head, 'content-type')).toBe('image/svg+xml');
      expect(header(head, 'content-security-policy')).toBe(SANDBOX_CSP);
      expect(header(head, 'x-content-type-options')).toBe('nosniff');
    });

    it('refusals carry no file headers: 401, 403 and 404 answer plain JSON errors', async () => {
      await putFile('safe/hidden-by-name.png', PNG);
      const refusals = [
        { res: await app.inject({ method: 'GET', url: `/files/${space}/safe/shot.png` }), status: 401 }, // no session
        { res: await fetchFile('safe/shot.png', { cookie: outsiderCookie }), status: 403 }, // no role in the space
        { res: await fetchFile(secret.relPath), status: 403 }, // hidden page
        { res: await fetchFile('safe/does-not-exist.png'), status: 404 },
        { res: await fetchFile('.git/config', { cookie: ownerCookie }), status: 404 }, // never served
        { res: await fetchFile('safe/%2e%2e/%2e%2e/package.json', { cookie: ownerCookie }), status: 404 },
      ];
      for (const { res, status } of refusals) {
        expect(res.statusCode).toBe(status);
        expect(header(res, 'content-type')).toContain('application/json');
        expect(res.headers['content-disposition']).toBeUndefined();
        expect(res.headers['content-security-policy']).toBeUndefined();
        expect(res.headers['x-content-type-options']).toBeUndefined();
      }
      const badToken = await app.inject({ method: 'GET', url: `/files/${space}/safe/shot.png?share=deadbeef` });
      expect(badToken.statusCode).toBe(401);
      expect(badToken.headers['content-disposition']).toBeUndefined();
    });

    it('the headers describe the file that was authorized: a literal %41 name is not decoded for the type check either', async () => {
      await putFile('safe/%41.png', PNG); // a real PNG at the literal name
      await putFile('safe/A.png', SCRIPTED_HTML); // what a second decoding would land on
      const res = await fetchFile('safe/%2541.png');
      expect(res.statusCode).toBe(200);
      expect(header(res, 'content-type')).toBe('image/png');
      expect(res.rawPayload.equals(PNG)).toBe(true);
    });
  });
});
