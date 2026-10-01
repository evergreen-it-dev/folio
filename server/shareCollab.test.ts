/**
 * Round 8: WS /collab's share-token auth alternative, against a REAL http
 * server + real WS clients (ws/yjs/y-websocket) — the same libraries and
 * protocol a browser's collaborative editor speaks, not a simulated Y.Doc
 * exchange. Mirrors the live two-real-WS-client verification used for the
 * round-6 doubling-fix work, now automated here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import WS from 'ws';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import * as storage from './storage.js';
import * as authStore from './auth/store.js';
import * as shares from './shares.js';
import * as collab from './collab.js';
import * as gitSync from './gitSync.js';
import * as git from './git.js';

function wsPolyfill() {
  return WS as unknown as typeof globalThis.WebSocket;
}

/**
 * P0 postmortem note: `initialText`, if passed, is inserted into the CLIENT's
 * doc BEFORE it ever connects — realistic for a test that only cares about
 * auth enforcement (view/edit/wrong-page/revoked below), but NEVER pass it in
 * a test that's actually checking content fidelity. A client that already
 * locally holds the "expected" text can make assertions pass whether or not
 * the server's own seeding worked correctly — which is exactly how the
 * original version of this file's main test missed the round-8 P0 (guest
 * synced an empty doc, its write-back wiped a real page's body): the guest
 * client here was pre-seeded with the same real body it was supposed to
 * receive FROM the server, so a `.toContain(...)` check on the eventual file
 * content passed regardless of which source — the client's own pre-loaded
 * text, or a correctly-seeded server doc — actually won the race. The
 * content-fidelity regression tests further down deliberately connect with
 * NO `initialText` (a genuinely empty local doc, like a real first-time
 * guest) and assert exact equality against the real body after sync.
 */
async function connectShareClient(port: number, pageId: string, shareToken: string, initialText?: string): Promise<{ doc: Y.Doc; provider: WebsocketProvider }> {
  const doc = new Y.Doc();
  if (initialText !== undefined) doc.getText('content').insert(0, initialText);
  const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/collab`, pageId, doc, {
    params: { share: shareToken },
    WebSocketPolyfill: wsPolyfill(),
    connect: true,
    disableBc: true,
  });
  return { doc, provider };
}

/**
 * Fix/share-identity: same as connectShareClient, but ALSO attaches a real
 * session cookie to the WS upgrade request — same trick collabBoards.test.ts's
 * cookieWs uses (a WS subclass that injects the Cookie header y-websocket's
 * own WebSocketPolyfill construction has no other hook for). Lets a test
 * open one connection carrying BOTH a session AND a `?share=` token, exactly
 * the shape server/collab.ts's attachToServer must resolve in favour of the
 * session.
 */
function connectAuthedShareClient(port: number, pageId: string, shareToken: string, sessionToken: string): { doc: Y.Doc; provider: WebsocketProvider } {
  const doc = new Y.Doc();
  const cookieWs = class extends WS {
    constructor(url: string, protocols?: string | string[]) {
      super(url, protocols, { headers: { Cookie: `folio_session=${sessionToken}` } });
    }
  } as unknown as typeof globalThis.WebSocket;
  const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/collab`, pageId, doc, {
    params: { share: shareToken },
    WebSocketPolyfill: cookieWs,
    connect: true,
    disableBc: true,
  });
  return { doc, provider };
}

function waitSynced(provider: WebsocketProvider, timeoutMs = 8000): Promise<void> {
  if (provider.synced) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('sync timeout')), timeoutMs);
    const onSync = (isSynced: boolean) => {
      if (isSynced) {
        clearTimeout(t);
        provider.off('sync', onSync);
        resolve();
      }
    };
    provider.on('sync', onSync);
  });
}

/** Polls `check` until it returns true or `timeoutMs` elapses — used instead of a fixed
 * sleep for the write-back debounce (800ms nominal, but a fixed margin over that is
 * exactly the kind of timing assumption that gets flaky under real system load). */
async function pollUntil(check: () => Promise<boolean>, timeoutMs = 5000, intervalMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`pollUntil: condition not met within ${timeoutMs}ms`);
}

function waitClosed(provider: WebsocketProvider, timeoutMs = 8000): Promise<{ code: number }> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('close timeout')), timeoutMs);
    provider.on('connection-close', (event: { code: number }) => {
      clearTimeout(t);
      resolve({ code: event?.code ?? 0 });
    });
  });
}

describe('WS /collab share-token auth (round 8, real http server + real WS clients)', () => {
  let teardownSchema: () => Promise<void>;
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    collab.initCollab();
    server = http.createServer();
    collab.attachToServer(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  });

  afterAll(async () => {
    // closeAllConnections (Node 18.2+) is a safety net against this suite ever
    // hanging the whole run on a WS connection a failed assertion left open —
    // every code path below already destroys its own providers in a finally,
    // but this makes that guarantee independent of remembering to do so.
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await teardownSchema();
  });

  it('edit-mode share token gets real write access; view-mode is read-only; wrong page/revoked/absent tokens are all rejected', async () => {
    const owner = await authStore.createUser({ email: 'share-owner@collab-test.local', name: 'Owner', passwordHash: 'x', isAdmin: false });
    const space = await storage.createSpace(`Share Collab ${Date.now()}`, owner.id);
    const pageA = await storage.createPage({ space: space.slug, parentPath: '', title: 'Shared Page A', kind: 'doc' });
    const pageB = await storage.createPage({ space: space.slug, parentPath: '', title: 'Other Page B', kind: 'doc' });
    const initialBody = '# Shared Page A\n\nOriginal.\n';
    await storage.writeDocBody(pageA.id, initialBody);

    const editLink = await shares.createShareLink(pageA.id, owner.id, 'edit', 'http://fallback.test');
    const editToken = editLink.url.split('/share/')[1];
    const viewLink = await shares.createShareLink(pageA.id, owner.id, 'view', 'http://fallback.test');
    const viewToken = viewLink.url.split('/share/')[1];

    const openProviders: WebsocketProvider[] = [];
    try {
      // --- edit-mode: real write access -------------------------------------
      const editClient = await connectShareClient(port, pageA.id, editToken, initialBody);
      openProviders.push(editClient.provider);
      await waitSynced(editClient.provider);
      editClient.doc.transact(() => {
        const t = editClient.doc.getText('content');
        t.insert(t.length, '\n\nEdited by a guest via share link.\n');
      });
      // Poll rather than a fixed sleep — the write-back debounce is nominally 800ms,
      // but a fixed margin over that is exactly the kind of timing assumption that
      // gets flaky under real system load. Generous ceiling: under the FULL suite
      // (10 files' worth of concurrent PG schemas + fs + WS activity), this specific
      // wait was observed to occasionally exceed 5s even though it's near-instant in
      // isolation — contention, not a logic bug (verified: passes reliably alone and
      // paired with gitNative.test.ts, the other WS-heavy file).
      await pollUntil(async () => (await storage.readFreshDocBody(pageA.id)).includes('Edited by a guest via share link.'), 15_000);
      const raw = await storage.readFreshDocBody(pageA.id);
      expect(raw).toContain('Edited by a guest via share link.');

      // The debounced write-back only writes the FILE + arms the ~90s auto-commit
      // quiet timer (gitSync.noteActivity) — force an immediate commit here to
      // check attribution, the same way a manual/scheduled sync would.
      await gitSync.performSync(space.slug);

      // Guest git attribution (DEV-PLAN round 8: "Guest via share <id8>" <guest@folio.local>).
      const dir = storage.getRepoDir(space.slug);
      const history = await git.fileHistory(dir, 'shared-page-a.md', 1);
      expect(history[0]?.author).toBe(`Guest via share ${editLink.id.slice(0, 8)}`);

      // --- view-mode: connects and receives the edit, but can't write --------
      const viewClient = await connectShareClient(port, pageA.id, viewToken);
      openProviders.push(viewClient.provider);
      await waitSynced(viewClient.provider);
      await pollUntil(async () => viewClient.doc.getText('content').toString().includes('Edited by a guest via share link.'));
      expect(viewClient.doc.getText('content').toString()).toContain('Edited by a guest via share link.');

      const beforeViewerWrite = editClient.doc.getText('content').toString();
      viewClient.doc.transact(() => {
        viewClient.doc.getText('content').insert(0, 'VIEW-MODE SHOULD NOT BE ABLE TO WRITE THIS. ');
      });
      await new Promise((r) => setTimeout(r, 500));
      expect(editClient.doc.getText('content').toString()).toBe(beforeViewerWrite); // unaffected by the view-mode write attempt

      editClient.provider.destroy();
      viewClient.provider.destroy();
      openProviders.length = 0;

      // --- wrong page: an edit-mode token for page A must not open page B's room
      const wrongPageClient = await connectShareClient(port, pageB.id, editToken);
      openProviders.push(wrongPageClient.provider);
      const wrongPageClose = await waitClosed(wrongPageClient.provider);
      expect(wrongPageClose.code).not.toBe(1000); // abnormal/rejected close, not a clean handshake
      wrongPageClient.provider.destroy();
      openProviders.length = 0;

      // --- revoked token -------------------------------------------------
      await shares.revokeShare(editLink.id);
      const revokedClient = await connectShareClient(port, pageA.id, editToken);
      openProviders.push(revokedClient.provider);
      const revokedClose = await waitClosed(revokedClient.provider);
      expect(revokedClose.code).not.toBe(1000);
      revokedClient.provider.destroy();
      openProviders.length = 0;

      // --- no token at all, no cookie -------------------------------------
      const noAuthDoc = new Y.Doc();
      const noAuthProvider = new WebsocketProvider(`ws://127.0.0.1:${port}/collab`, pageA.id, noAuthDoc, {
        WebSocketPolyfill: wsPolyfill(),
        connect: true,
        disableBc: true,
      });
      openProviders.push(noAuthProvider);
      const noAuthClose = await waitClosed(noAuthProvider);
      expect(noAuthClose.code).not.toBe(1000);
      noAuthProvider.destroy();
      openProviders.length = 0;
    } finally {
      // Whatever failed, make sure nothing is left connected before this test
      // (or the whole file's afterAll) tries to move on.
      for (const p of openProviders) p.destroy();
      await deleteTestSpace(space.slug);
    }
  }, 40_000);

  // ---------------------------------------------------------------------
  // Fix/share-identity: a logged-in user opening a page through a share
  // link must stay themselves when their OWN session already grants access
  // — never fall back to the token's anonymous "Guest via share …" identity
  // — but a share token remains the correct fallback for a session that
  // grants NOTHING on this exact page (previously that case hit collab.ts's
  // unconditional `if (!session.roleAtLeast(role, 'viewer')) reject(403)`
  // instead of ever trying the token, stranding a logged-in visitor a plain
  // anonymous guest could have opened the link just fine). Git commit
  // authorship (gitSync.recordEditor, exercised the same way round 8's own
  // guest-attribution test above checks it) is the observable proof of
  // WHICH identity actually won the connection.
  // ---------------------------------------------------------------------

  it('fix/share-identity: session wins over a share token when it grants access; falls back to the token when the session has none; anonymous still gets the token role', async () => {
    const owner = await authStore.createUser({ email: `share-identity-owner-${Date.now()}@collab-test.local`, name: 'Owner', passwordHash: 'x', isAdmin: false });
    const space = await storage.createSpace(`Share Identity ${Date.now()}`, owner.id);
    await authStore.setMembership(space.slug, owner.id, 'editor');
    const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'Identity Page', kind: 'doc' });
    await storage.writeDocBody(page.id, '# Identity Page\n\nOriginal.\n');

    const editLink = await shares.createShareLink(page.id, owner.id, 'edit', 'http://fallback.test');
    const editToken = editLink.url.split('/share/')[1];
    const ownerSession = await authStore.createSession(owner.id);

    // A second, genuinely different Folio account — logged in, but with NO
    // membership in this space at all: "this session exists but isn't mine"
    // is the fallback case fix/share-identity adds.
    const outsider = await authStore.createUser({ email: `share-identity-outsider-${Date.now()}@collab-test.local`, name: 'Outsider', passwordHash: 'x', isAdmin: false });
    const outsiderSession = await authStore.createSession(outsider.id);

    const dir = storage.getRepoDir(space.slug);
    const openProviders: WebsocketProvider[] = [];
    try {
      // --- (a) session with real access WINS over the token: own identity ---
      const ownerClient = connectAuthedShareClient(port, page.id, editToken, ownerSession.token);
      openProviders.push(ownerClient.provider);
      await waitSynced(ownerClient.provider);
      ownerClient.doc.transact(() => {
        const t = ownerClient.doc.getText('content');
        t.insert(t.length, '\n\nEdited by the owner via their own session, with a share token also present.\n');
      });
      await pollUntil(async () => (await storage.readFreshDocBody(page.id)).includes('Edited by the owner'), 15_000);
      await gitSync.performSync(space.slug);
      const historyA = await git.fileHistory(dir, 'identity-page.md', 1);
      expect(historyA[0]?.author).toBe('Owner'); // session identity, NOT "Guest via share …"
      ownerClient.provider.destroy();
      openProviders.length = 0;

      // --- (b) session with NO access to this page: falls back to the share
      // token's role/identity instead of a hard 403 ------------------------
      const outsiderClient = connectAuthedShareClient(port, page.id, editToken, outsiderSession.token);
      openProviders.push(outsiderClient.provider);
      await waitSynced(outsiderClient.provider); // pre-fix: rejected (403), this would time out
      outsiderClient.doc.transact(() => {
        const t = outsiderClient.doc.getText('content');
        t.insert(t.length, '\n\nEdited by an outsider whose session has no access, via the share-token fallback.\n');
      });
      await pollUntil(async () => (await storage.readFreshDocBody(page.id)).includes('Edited by an outsider'), 15_000);
      await gitSync.performSync(space.slug);
      const historyB = await git.fileHistory(dir, 'identity-page.md', 1);
      // Guest identity, not the outsider's real name — the fallback never
      // borrows an unrelated session's identity for access it doesn't have.
      expect(historyB[0]?.author).toBe(`Guest via share ${editLink.id.slice(0, 8)}`);
      outsiderClient.provider.destroy();
      openProviders.length = 0;

      // --- (c) genuinely anonymous (no cookie at all): same token role as
      // (b), for direct contrast with (a) ----------------------------------
      const anonDoc = new Y.Doc();
      const anonProvider = new WebsocketProvider(`ws://127.0.0.1:${port}/collab`, page.id, anonDoc, {
        params: { share: editToken },
        WebSocketPolyfill: wsPolyfill(),
        connect: true,
        disableBc: true,
      });
      openProviders.push(anonProvider);
      await waitSynced(anonProvider);
      expect(anonDoc.getText('content').toString()).toContain('Edited by an outsider');
      anonProvider.destroy();
      openProviders.length = 0;
    } finally {
      for (const p of openProviders) p.destroy();
      await deleteTestSpace(space.slug);
    }
  }, 40_000);

  // ---------------------------------------------------------------------
  // Round 8 P0 regression: a live repro found a share-link guest could sync
  // an EMPTY doc on a page with real, substantial pre-existing content, then
  // have its own tiny edit's write-back overwrite the file — wiping the real
  // body. Root cause: y-websocket's own getYDoc() fires persistence.bindState()
  // WITHOUT awaiting it, then immediately starts the connecting client's sync
  // handshake using whatever state the doc has at that instant. A client whose
  // edit reaches the doc before that fire-and-forget seed resolves lands on a
  // doc bindState hasn't populated yet; bindState's own "did a concurrent
  // update already land" guard then sees non-empty text and skips seeding —
  // permanently. Fixed in collab.ts via ensureDocSeeded (awaited before ANY
  // connection, cookie or share, is handed to setupWSConnection) plus a
  // seatbelt in persistDoc (refuses to shrink on-disk content for a doc that
  // was never confirmed-seeded). These tests connect with NO `initialText` —
  // a genuinely empty local doc, like a real first-time guest — and assert
  // EXACT content equality (not `.toContain`) against the real body, which is
  // what would have caught the original bug immediately.
  // ---------------------------------------------------------------------

  it('P0 regression: guest sees the FULL pre-existing body via the restore-from-snapshot branch, not an empty doc', async () => {
    const owner = await authStore.createUser({ email: `share-seed-snap-${Date.now()}@collab-test.local`, name: 'Owner', passwordHash: 'x', isAdmin: false });
    const space = await storage.createSpace(`Share Seed Snapshot ${Date.now()}`, owner.id);
    const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'Seed Snapshot Page', kind: 'doc' });
    const originalBody = `# Seed Snapshot Page\n\n${'Real pre-existing content that must survive a guest reopen. '.repeat(15)}\n`;
    await storage.writeDocBody(page.id, originalBody);

    const editLink = await shares.createShareLink(page.id, owner.id, 'edit', 'http://fallback.test');
    const editToken = editLink.url.split('/share/')[1];

    const openProviders: WebsocketProvider[] = [];
    try {
      // First connection (itself a share client, but with no pre-seeded local text) opens
      // the page for the very first time, runs bindState's file-seed branch, and stores a
      // snapshot — exactly what a real first editing session leaves behind.
      const seeder = await connectShareClient(port, page.id, editToken);
      openProviders.push(seeder.provider);
      await waitSynced(seeder.provider);
      await pollUntil(async () => seeder.doc.getText('content').toString() === originalBody, 8000);
      seeder.provider.destroy();
      openProviders.length = 0;
      // Wait for the snapshot to actually land AND for full eviction from the live docs
      // map — only then is the next connection a genuine cold reopen through the
      // restore-from-snapshot branch, not a lingering write-back still in flight.
      await pollUntil(async () => (await collab.loadSnapshot(page.id)) !== undefined, 8000);
      await pollUntil(async () => !collab.isDocLive(page.id), 8000);

      // --- the actual regression: a genuinely empty guest client reopening a page that
      // now has a real ydoc_state snapshot -----------------------------------------
      const guest = await connectShareClient(port, page.id, editToken); // no initialText
      openProviders.push(guest.provider);
      await waitSynced(guest.provider);
      // Pre-fix, this read '' (length 0) right after 'sync' fired.
      await pollUntil(async () => guest.doc.getText('content').toString() === originalBody, 8000);
      expect(guest.doc.getText('content').toString()).toBe(originalBody);

      guest.doc.transact(() => {
        const t = guest.doc.getText('content');
        t.insert(t.length, '\n\nAppended by guest.\n');
      });
      await pollUntil(async () => (await storage.readFreshDocBody(page.id)).includes('Appended by guest.'), 15_000);
      const onDisk = await storage.readFreshDocBody(page.id);
      expect(onDisk.startsWith(originalBody)).toBe(true); // original body intact, not replaced
      expect(onDisk).toContain('Appended by guest.'); // ...with the guest's edit appended
    } finally {
      for (const p of openProviders) p.destroy();
      await deleteTestSpace(space.slug);
    }
  }, 40_000);

  it('P0 regression: guest as the very first-ever opener (no snapshot yet) still sees the FULL pre-existing body, not an empty doc', async () => {
    const owner = await authStore.createUser({ email: `share-seed-file-${Date.now()}@collab-test.local`, name: 'Owner', passwordHash: 'x', isAdmin: false });
    const space = await storage.createSpace(`Share Seed File ${Date.now()}`, owner.id);
    const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'Seed File Page', kind: 'doc' });
    const originalBody = `# Seed File Page\n\n${'Body written straight to disk, never opened live before. '.repeat(15)}\n`;
    await storage.writeDocBody(page.id, originalBody); // file only — no live doc has EVER touched this page, no ydoc_state row

    const editLink = await shares.createShareLink(page.id, owner.id, 'edit', 'http://fallback.test');
    const editToken = editLink.url.split('/share/')[1];
    expect(collab.isDocLive(page.id)).toBe(false); // confirms this really is a cold doc before the guest connects
    expect(await collab.loadSnapshot(page.id)).toBeUndefined();

    const openProviders: WebsocketProvider[] = [];
    try {
      const guest = await connectShareClient(port, page.id, editToken); // empty local doc: a real, first-ever visitor
      openProviders.push(guest.provider);
      await waitSynced(guest.provider);
      await pollUntil(async () => guest.doc.getText('content').toString() === originalBody, 8000);
      expect(guest.doc.getText('content').toString()).toBe(originalBody);

      guest.doc.transact(() => {
        const t = guest.doc.getText('content');
        t.insert(t.length, '\n\nAppended by first-opener guest.\n');
      });
      await pollUntil(async () => (await storage.readFreshDocBody(page.id)).includes('Appended by first-opener guest.'), 15_000);
      const onDisk = await storage.readFreshDocBody(page.id);
      expect(onDisk.startsWith(originalBody)).toBe(true);
      expect(onDisk).toContain('Appended by first-opener guest.');
    } finally {
      for (const p of openProviders) p.destroy();
      await deleteTestSpace(space.slug);
    }
  }, 40_000);

  // ---------------------------------------------------------------------
  // R23 tail (child navigation in the public share): an includeChildren
  // token opens its CHILD rooms — VIEWER-ONLY, whatever the token's mode —
  // via the same index-based membership the payload route uses
  // (shareGrantsPage). Everything outside that set stays a 401, prefix
  // lookalikes included.
  // ---------------------------------------------------------------------

  it('R23 tail: subtree token opens a CHILD room read-only; prefix siblings and single-page tokens stay rejected; revocation is instant', async () => {
    const owner = await authStore.createUser({ email: `share-child-ws-${Date.now()}@collab-test.local`, name: 'Owner', passwordHash: 'x', isAdmin: false });
    const space = await storage.createSpace(`Share Child WS ${Date.now()}`, owner.id);
    const root = await storage.createPage({ space: space.slug, parentPath: '', title: 'Manual', kind: 'doc' });
    const child = await storage.createPage({ space: space.slug, parentPath: 'manual', title: 'Chapter', kind: 'doc' });
    const outsider = await storage.createPage({ space: space.slug, parentPath: '', title: 'Manual Extra', kind: 'doc' });
    const childBody = '# Chapter\n\nChild body.\n';
    await storage.writeDocBody(child.id, childBody);

    // EDIT mode on purpose: even the strongest token must yield a read-only child room.
    const subtreeLink = await shares.createShareLink(root.id, owner.id, 'edit', 'http://fallback.test', true);
    const subtreeToken = subtreeLink.url.split('/share/')[1];
    const singleLink = await shares.createShareLink(root.id, owner.id, 'edit', 'http://fallback.test', false);
    const singleToken = singleLink.url.split('/share/')[1];

    const openProviders: WebsocketProvider[] = [];
    try {
      // --- child room via the subtree token: connects, syncs, cannot write ---
      const guest = await connectShareClient(port, child.id, subtreeToken);
      openProviders.push(guest.provider);
      await waitSynced(guest.provider);
      await pollUntil(async () => guest.doc.getText('content').toString() === childBody, 8000);

      guest.doc.transact(() => {
        guest.doc.getText('content').insert(0, 'CHILD ROOMS MUST BE READ-ONLY. ');
      });
      await new Promise((r) => setTimeout(r, 700));
      expect(await storage.readFreshDocBody(child.id)).toBe(childBody); // write refused, file untouched
      guest.provider.destroy();
      openProviders.length = 0;

      // --- the prefix trap: `manual-extra` is NOT a child of `manual` --------
      const trapped = await connectShareClient(port, outsider.id, subtreeToken);
      openProviders.push(trapped.provider);
      expect((await waitClosed(trapped.provider)).code).not.toBe(1000);
      trapped.provider.destroy();
      openProviders.length = 0;

      // --- a single-page token opens no child room at all --------------------
      const denied = await connectShareClient(port, child.id, singleToken);
      openProviders.push(denied.provider);
      expect((await waitClosed(denied.provider)).code).not.toBe(1000);
      denied.provider.destroy();
      openProviders.length = 0;

      // --- revocation kills new child connections instantly ------------------
      await shares.revokeShare(subtreeLink.id);
      const revoked = await connectShareClient(port, child.id, subtreeToken);
      openProviders.push(revoked.provider);
      expect((await waitClosed(revoked.provider)).code).not.toBe(1000);
      revoked.provider.destroy();
      openProviders.length = 0;
    } finally {
      for (const p of openProviders) p.destroy();
      await deleteTestSpace(space.slug);
    }
  }, 40_000);

  it('P0 seatbelt: persistDoc refuses to shrink on-disk content for a doc that was never confirmed-seeded', async () => {
    const owner = await authStore.createUser({ email: `seatbelt-${Date.now()}@collab-test.local`, name: 'Owner', passwordHash: 'x', isAdmin: false });
    const space = await storage.createSpace(`Seatbelt ${Date.now()}`, owner.id);
    const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'Seatbelt Page', kind: 'doc' });
    const originalBody = 'Substantial real content that must never be silently discarded.\n'.repeat(5);
    await storage.writeDocBody(page.id, originalBody);

    // Simulate the exact failure shape without any WS connection at all: a bare Y.Doc that
    // never went through ensureDocSeeded (so collab.isDocSeeded(page.id) is naturally
    // false, exactly as if caught mid-race), carrying only a tiny amount of text —
    // structurally identical to "a guest's first keystroke landed before seeding".
    const rogueDoc = new Y.Doc();
    rogueDoc.getText('content').insert(0, 'x');
    expect(collab.isDocSeeded(page.id)).toBe(false);

    await collab.persistDoc(page.id, rogueDoc);

    const onDisk = await storage.readFreshDocBody(page.id);
    expect(onDisk).toBe(originalBody); // untouched — the write was refused, not "eventually corrected"

    await deleteTestSpace(space.slug);
  });
});
