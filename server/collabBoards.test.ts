/**
 * Round 29 (BOARD COLLAB) — collab.ts's board-kind branches: bindState/
 * persistDoc seeding the three flat roots (elements/board/files) from a
 * board's `.excalidraw.svg`, and editBoardScene, the write API create_board/
 * update_board/board_ops and the legacy PUT{svg} route all funnel through.
 *
 * Same two-layer style as collabTables.test.ts's own round: real PG + real
 * files, calling bindState/persistDoc directly (the established pattern in
 * this codebase — see shareCollab.test.ts's P0 seatbelt test — never going
 * through ensureDocSeeded, which only a real WS upgrade exercises), plus a
 * couple of tests that register a Y.Doc into y-websocket's own `docs` map to
 * exercise the "live room open" branch of editBoardScene/getLiveBoardScene.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import WS from 'ws';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import * as storage from './storage.js';
import * as collab from './collab.js';
import * as authStore from './auth/store.js';
import * as shares from './shares.js';
import { query } from './db/pool.js';
import { decodeScenePayload, extractScenePayload, renderSceneSvg } from './confluenceWhiteboard.js';
import type { ExcalidrawElement, ExcalidrawScene } from './confluenceWhiteboard.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeElement(id: string, overrides: Partial<ExcalidrawElement> = {}): ExcalidrawElement {
  return {
    id,
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 100,
    height: 80,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: 'a0',
    roundness: null,
    seed: 1,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    ...overrides,
  };
}

function makeScene(elements: ExcalidrawElement[], appState: Record<string, unknown> = {}, files: Record<string, unknown> = {}): ExcalidrawScene {
  return { type: 'excalidraw', version: 2, source: 'test', elements, appState: { viewBackgroundColor: '#ffffff', ...appState }, files };
}

function fixtureScene(): ExcalidrawScene {
  // Deliberately out-of-order indices — bindState's seed must sort by `index`,
  // not by the array's own order.
  return makeScene(
    [
      makeElement('el-b', { index: 'a2', x: 100 }),
      makeElement('el-a', { index: 'a0', x: 0 }),
      makeElement('el-c', { index: 'a1', x: 200 }),
    ],
    { viewBackgroundColor: '#eeeeee' },
    { 'file-1': { mimeType: 'image/png', dataURL: 'data:image/png;base64,AAAA', id: 'file-1', created: 1 } },
  );
}

async function readFileScene(absPath: string): Promise<ExcalidrawScene> {
  const svg = await fs.readFile(absPath, 'utf8');
  const payload = extractScenePayload(svg);
  if (!payload) throw new Error('no embedded scene payload');
  return decodeScenePayload(payload);
}

function liveElementCount(scene: ExcalidrawScene): number {
  return scene.elements.filter((e) => !e.isDeleted).length;
}

describe('board bindState / persistDoc / editBoardScene (real PG + real files)', () => {
  let teardownSchema: () => Promise<void>;
  let liveDocs: Map<string, Y.Doc>;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const { createRequire } = await import('node:module');
    const nodeRequire = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    liveDocs = (nodeRequire('y-websocket/bin/utils') as { docs: Map<string, Y.Doc> }).docs;
  });
  afterAll(async () => {
    await teardownSchema();
  });

  /** Creates a real board page; when `scene` is given, seeds the file with it (bypassing the blank-overwrite guard — this is initial fixture setup, not a write under test). */
  async function makeBoardPage(label: string, scene?: ExcalidrawScene): Promise<{ space: string; id: string; absPath: string }> {
    const space = await storage.createSpace(`${label} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, null);
    const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'Board', kind: 'board' });
    if (scene) await storage.writeBoardSvg(page.id, renderSceneSvg(scene), true);
    const entry = await storage.requireEntry(page.id);
    expect(entry.kind).toBe('board');
    return { space: space.slug, id: page.id, absPath: entry.absPath };
  }

  /** bindState + register into y-websocket's own `docs` map, exactly collabTables.test.ts's makeLiveTable pattern — the only way isLiveBoard/getLiveBoardScene/editBoardScene's live branch can be exercised without a real WS server. */
  async function makeLiveBoard(label: string, scene?: ExcalidrawScene): Promise<{ space: string; id: string; ydoc: Y.Doc; absPath: string }> {
    const { space, id, absPath } = await makeBoardPage(label, scene);
    const ydoc = new Y.Doc();
    await collab.bindState(id, ydoc);
    liveDocs.set(id, ydoc);
    return { space, id, ydoc, absPath };
  }

  // -------------------------------------------------------------------------
  // (a) seed from file -> persist back gives an equivalent scene
  // -------------------------------------------------------------------------

  it('SEED: a blank room is populated from the file, sorted by `index` (not file order), tie-break by id', async () => {
    const scene = fixtureScene();
    const { space, id } = await makeBoardPage('Board Seed', scene);
    try {
      const ydoc = new Y.Doc();
      await collab.bindState(id, ydoc);

      const roots = collab.boardRoots(ydoc);
      expect(roots.elements.size).toBe(3);
      expect(roots.board.get('viewBackgroundColor')).toBe('#eeeeee');
      expect(roots.files.get('file-1')).toBeTruthy();

      // The first-ever bind of a non-blank file stores a snapshot immediately.
      expect(await collab.loadSnapshot(id)).toBeDefined();

      liveDocs.set(id, ydoc);
      const live = collab.getLiveBoardScene(id)!;
      expect(live.elements.map((e) => e.id)).toEqual(['el-a', 'el-c', 'el-b']); // index a0 < a1 < a2
    } finally {
      liveDocs.delete(id);
      await deleteTestSpace(space);
    }
  });

  it('SEED -> PERSIST round-trip: same element count, ids and index order come back out', async () => {
    const scene = fixtureScene();
    const { space, id, absPath } = await makeBoardPage('Board Seed Persist', scene);
    try {
      const ydoc = new Y.Doc();
      await collab.bindState(id, ydoc);
      await collab.persistDoc(id, ydoc);

      const onDisk = await readFileScene(absPath);
      expect(onDisk.elements.map((e) => e.id)).toEqual(['el-a', 'el-c', 'el-b']);
      expect(onDisk.elements).toHaveLength(3);
      expect((onDisk.appState as Record<string, unknown>).viewBackgroundColor).toBe('#eeeeee');
      expect(onDisk.files['file-1']).toBeTruthy();
    } finally {
      await deleteTestSpace(space);
    }
  });

  it('no embedded scene payload on the file (brand new, never drawn on): the room is left empty, not an error', async () => {
    const { space, id } = await makeBoardPage('Board No Payload'); // no scene: default blank starter file
    try {
      const ydoc = new Y.Doc();
      await expect(collab.bindState(id, ydoc)).resolves.not.toThrow();
      const roots = collab.boardRoots(ydoc);
      expect(roots.elements.size).toBe(0);
      expect(roots.board.size).toBe(0);
    } finally {
      await deleteTestSpace(space);
    }
  });

  // -------------------------------------------------------------------------
  // (b) editBoardScene: live room -> Y.Doc; no live room -> file
  // -------------------------------------------------------------------------

  it('editBoardScene: no live room -> writes straight to the file', async () => {
    const scene = fixtureScene();
    const { space, id, absPath } = await makeBoardPage('Board Edit No Room', scene);
    try {
      expect(collab.isLiveBoard(id)).toBe(false);
      const next = makeScene([makeElement('el-a', { index: 'a0' }), makeElement('el-new', { index: 'a1' })]);
      const meta = await collab.editBoardScene(id, next);
      expect(meta.id).toBe(id);

      const onDisk = await readFileScene(absPath);
      expect(onDisk.elements.map((e) => e.id).sort()).toEqual(['el-a', 'el-new']);
    } finally {
      await deleteTestSpace(space);
    }
  });

  it('editBoardScene: a live room updates the Y.Doc immediately (tombstoning an omitted element)', async () => {
    // Y.Doc-level only, deliberately: this room was seeded via a direct
    // bindState call (this file's established pattern — see the module doc
    // comment), never through ensureDocSeeded, so collab.isDocSeeded(id) is
    // naturally false here and persistBoardDoc's seatbelt (correctly) refuses
    // to shrink the FILE from an unconfirmed-seeded room — same rule the
    // doc/table seatbelts already apply, see shareCollab.test.ts's own P0
    // seatbelt test. The "a legitimate delete really does reach disk" half of
    // this is the LIVE websocket describe block below, where a real
    // connection makes isDocSeeded true exactly the way collabTables.test.ts's
    // "went through ensureDocSeeded" bulk-delete test does.
    const scene = fixtureScene();
    const { space, id, ydoc } = await makeLiveBoard('Board Edit Live', scene);
    try {
      expect(collab.isLiveBoard(id)).toBe(true);

      const next = makeScene([
        makeElement('el-a', { index: 'a0', backgroundColor: '#ff0000' }), // changed
        makeElement('el-c', { index: 'a1' }), // unchanged
        // el-b omitted -> must become a tombstone, not vanish
      ]);
      await collab.editBoardScene(id, next);

      const roots = collab.boardRoots(ydoc);
      expect(roots.elements.get('el-a')!.backgroundColor).toBe('#ff0000');
      expect(roots.elements.get('el-b')!.isDeleted).toBe(true); // tombstoned, key still present
      expect(roots.elements.has('el-b')).toBe(true);
      expect(roots.elements.get('el-c')!.isDeleted).toBe(false);
    } finally {
      liveDocs.delete(id);
      await deleteTestSpace(space);
    }
  });

  // -------------------------------------------------------------------------
  // (c) delete -> tombstone -> never resurrected on a later edit
  // -------------------------------------------------------------------------

  it('a deleted element stays tombstoned across repeated edits — never resurrected', async () => {
    const scene = fixtureScene();
    const { space, id, ydoc } = await makeLiveBoard('Board Tombstone', scene);
    try {
      await collab.editBoardScene(id, makeScene([makeElement('el-a', { index: 'a0' }), makeElement('el-c', { index: 'a1' })]));
      expect(collab.boardRoots(ydoc).elements.get('el-b')!.isDeleted).toBe(true);

      // A second edit that STILL doesn't mention el-b — it must stay a
      // tombstone, not get "re-tombstoned" with a fresh version bump each time.
      const nonceAfterFirst = collab.boardRoots(ydoc).elements.get('el-b')!.versionNonce;
      await collab.editBoardScene(id, makeScene([makeElement('el-a', { index: 'a0' }), makeElement('el-c', { index: 'a1' })]));
      const tombstone = collab.boardRoots(ydoc).elements.get('el-b')!;
      expect(tombstone.isDeleted).toBe(true);
      expect(tombstone.versionNonce).toBe(nonceAfterFirst); // untouched the second time — already a tombstone
    } finally {
      liveDocs.delete(id);
      await deleteTestSpace(space);
    }
  });

  // -------------------------------------------------------------------------
  // (d) blank scene never overwrites a non-blank board
  // -------------------------------------------------------------------------

  it('editBoardScene refuses an empty scene over a non-empty LIVE room', async () => {
    const scene = fixtureScene();
    const { space, id, ydoc } = await makeLiveBoard('Board Blank Guard Live', scene);
    try {
      await expect(collab.editBoardScene(id, makeScene([]))).rejects.toThrow(/empty scene over a non-empty board/);
      // Untouched — the refused write left every element exactly as it was.
      expect(collab.boardRoots(ydoc).elements.size).toBe(3);
    } finally {
      liveDocs.delete(id);
      await deleteTestSpace(space);
    }
  });

  it('editBoardScene refuses an empty scene over a non-empty FILE when no room is live', async () => {
    const scene = fixtureScene();
    const { space, id, absPath } = await makeBoardPage('Board Blank Guard File', scene);
    try {
      await expect(collab.editBoardScene(id, makeScene([]))).rejects.toThrow(/empty scene over a non-empty board/);
      const onDisk = await readFileScene(absPath);
      expect(onDisk.elements).toHaveLength(3); // untouched
    } finally {
      await deleteTestSpace(space);
    }
  });

  it('persistDoc never writes an empty scene over a non-empty file, even from a live room (writeBoardSvg guard stays active)', async () => {
    // A pathological room state (not reachable through editBoardScene's own
    // guard, but persistDoc must not rely on that being the only caller):
    // seed from a real file, then clear every element directly on the CRDT.
    const scene = fixtureScene();
    const { space, id, absPath } = await makeBoardPage('Board Persist Blank Guard', scene);
    try {
      const ydoc = new Y.Doc();
      await collab.bindState(id, ydoc);
      const roots = collab.boardRoots(ydoc);
      ydoc.transact(() => {
        for (const key of [...roots.elements.keys()]) roots.elements.delete(key);
      });

      await collab.persistDoc(id, ydoc);
      const onDisk = await readFileScene(absPath);
      expect(onDisk.elements).toHaveLength(3); // storage.writeBoardSvg refused the write; file untouched
    } finally {
      await deleteTestSpace(space);
    }
  });

  // -------------------------------------------------------------------------
  // Reconciliation: a stored snapshot resumes, and the file moved on
  // independently (server down / external edit) — file wins, BY VERSION.
  // -------------------------------------------------------------------------

  it('RECONCILE: bindState applies a higher-version element from the file over what the resumed room already holds', async () => {
    const scene = fixtureScene();
    const { space, id, absPath } = await makeBoardPage('Board Reconcile Version', scene);
    try {
      const first = new Y.Doc();
      await collab.bindState(id, first); // seeds + stores the initial snapshot

      // "Server down": the file is rewritten externally with a NEWER version of el-a.
      const onDisk = await readFileScene(absPath);
      const updated: ExcalidrawScene = {
        ...onDisk,
        elements: onDisk.elements.map((e) => (e.id === 'el-a' ? { ...e, backgroundColor: '#00ff00', version: e.version + 1, versionNonce: 999 } : e)),
      };
      await fs.writeFile(absPath, renderSceneSvg(updated), 'utf8');

      const afterRestart = new Y.Doc();
      await collab.bindState(id, afterRestart); // resumes from the stored snapshot, then reconciles

      const roots = collab.boardRoots(afterRestart);
      expect(roots.elements.get('el-a')!.backgroundColor).toBe('#00ff00');
      expect(roots.elements.get('el-a')!.version).toBe(2);
      // Untouched elements are not rewritten by the reconcile pass.
      expect(roots.elements.get('el-c')!.version).toBe(1);
    } finally {
      await deleteTestSpace(space);
    }
  });

  it("RECONCILE: a stale (lower-version) file copy never overwrites what the resumed room already holds", async () => {
    const scene = fixtureScene();
    const { space, id, absPath } = await makeBoardPage('Board Reconcile Stale', scene);
    try {
      const first = new Y.Doc();
      await collab.bindState(id, first);

      // The room "moved on" with a newer version of el-a than the file has —
      // simulated directly on the CRDT the way a real client edit would.
      collab.boardRoots(first).elements.set('el-a', { ...collab.boardRoots(first).elements.get('el-a')!, backgroundColor: '#0000ff', version: 5, versionNonce: 1 });
      await collab.storeSnapshot(id, first);

      const afterRestart = new Y.Doc();
      await collab.bindState(id, afterRestart); // file still holds version 1 for el-a

      expect(collab.boardRoots(afterRestart).elements.get('el-a')!.backgroundColor).toBe('#0000ff');
      expect(collab.boardRoots(afterRestart).elements.get('el-a')!.version).toBe(5);
    } finally {
      await deleteTestSpace(space);
    }
  });

  // -------------------------------------------------------------------------
  // SEATBELT: mirrors shareCollab.test.ts's doc-kind "P0 seatbelt" test.
  // -------------------------------------------------------------------------

  it('SEATBELT: persistDoc refuses to shrink live-element count for a room never confirmed seeded', async () => {
    const scene = fixtureScene(); // 3 live elements on disk
    const { space, id, absPath } = await makeBoardPage('Board Seatbelt', scene);
    try {
      // A bare Y.Doc that never went through ensureDocSeeded (collab.isDocSeeded
      // is naturally false), holding just ONE element — fewer than the file.
      const rogue = new Y.Doc();
      rogue.getMap<ExcalidrawElement>('elements').set('rogue-el', makeElement('rogue-el'));
      expect(collab.isDocSeeded(id)).toBe(false);

      await collab.persistDoc(id, rogue);

      const onDisk = await readFileScene(absPath);
      // Untouched: the fixture's own (unsorted) literal element order —
      // the write was refused, never reaching persistBoardDoc's own sort.
      expect(onDisk.elements.map((e) => e.id)).toEqual(['el-b', 'el-a', 'el-c']);
    } finally {
      await deleteTestSpace(space);
    }
  });
});

// ---------------------------------------------------------------------------
// LIVE over real websockets — the only way to exercise a room that went
// through the real ensureDocSeeded lifecycle (so collab.isDocSeeded(id) is
// genuinely true), matching collabTables.test.ts's own "went through
// ensureDocSeeded, so a genuine bulk delete ... is ALLOWED" precedent. This
// is also the direct evidence for round 29's actual acceptance criteria: an
// agent's editBoardScene reaches an already-open tab instantly, and a
// legitimate deletion really does reach the file.
// ---------------------------------------------------------------------------

function waitSynced(provider: WebsocketProvider, timeoutMs = 10_000): Promise<void> {
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

async function pollUntil(check: () => Promise<boolean> | boolean, timeoutMs = 15_000, intervalMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`pollUntil: condition not met within ${timeoutMs}ms`);
}

/** Same trick collabTables.test.ts's cookieWs uses — attach a cookie session to y-websocket's own `new WebSocketPolyfill(url)` construction. */
function cookieWs(token: string): typeof globalThis.WebSocket {
  return class extends WS {
    constructor(url: string, protocols?: string | string[]) {
      super(url, protocols, { headers: { Cookie: `folio_session=${token}` } });
    }
  } as unknown as typeof globalThis.WebSocket;
}

describe('LIVE board editing over real websockets (round 29)', () => {
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
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await teardownSchema();
  });

  it("an agent's editBoardScene reaches an already-open tab instantly, and a genuine (seeded) delete passes the seatbelt onto disk", async () => {
    const owner = await authStore.createUser({ email: `b-owner-${Date.now()}@collab-test.local`, name: 'Owner', passwordHash: 'x', isAdmin: false });
    const space = await storage.createSpace(`Live Board ${Date.now()}`, owner.id);
    await authStore.setMembership(space.slug, owner.id, 'editor');
    const scene = fixtureScene();
    const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'Board', kind: 'board' });
    await storage.writeBoardSvg(page.id, renderSceneSvg(scene), true);
    const session = await authStore.createSession(owner.id);

    const clientDoc = new Y.Doc();
    const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/collab`, page.id, clientDoc, {
      WebSocketPolyfill: cookieWs(session.token),
      connect: true,
      disableBc: true,
    });
    try {
      await waitSynced(provider);
      await pollUntil(() => collab.boardRoots(clientDoc).elements.size === 3);
      // The room went through a real ensureDocSeeded — unlike this file's
      // direct-bindState tests above, a legitimate shrink is now allowed.
      expect(collab.isDocSeeded(page.id)).toBe(true);

      await collab.editBoardScene(page.id, makeScene([makeElement('el-a', { index: 'a0', backgroundColor: '#123456' }), makeElement('el-c', { index: 'a1' })]));

      // The already-connected client sees the tombstone and the change
      // WITHOUT doing anything itself — the room's normal update broadcast.
      await pollUntil(() => collab.boardRoots(clientDoc).elements.get('el-b')?.isDeleted === true);
      expect(collab.boardRoots(clientDoc).elements.get('el-a')!.backgroundColor).toBe('#123456');

      // And it really did reach the file — the seatbelt does not block a
      // legitimate, seeded delete.
      const entry = await storage.requireEntry(page.id);
      await pollUntil(async () => {
        const svg = await fs.readFile(entry.absPath, 'utf8');
        const payload = extractScenePayload(svg);
        if (!payload) return false;
        return decodeScenePayload(payload).elements.find((e) => e.id === 'el-b')?.isDeleted === true;
      });
      const finalScene = await readFileScene(entry.absPath);
      expect(liveElementCount(finalScene)).toBe(2);
    } finally {
      provider.destroy();
      await query('DELETE FROM ydoc_state WHERE page_id = $1', [page.id]).catch(() => undefined);
      await deleteTestSpace(space.slug);
    }
  }, 20_000);

  // -------------------------------------------------------------------------
  // Fix/share-identity, part B: even for a genuinely anonymous guest, a
  // read-only (view-mode) share connection must not be able to persist a
  // board change. server/collab.ts's makeReadOnly intercepts a viewer's
  // update/syncStep2 frames BEFORE setupWSConnection's own listener ever
  // sees them (never applied to the shared Y.Doc, never broadcast, never
  // reaches persistBoardDoc) — this is the board-kind analogue of
  // shareCollab.test.ts's existing doc-kind "view-mode is read-only" check.
  // -------------------------------------------------------------------------

  it("fix/share-identity: a read-only (view-mode) share connection cannot persist a board change", async () => {
    const owner = await authStore.createUser({ email: `b-view-${Date.now()}@collab-test.local`, name: 'Owner', passwordHash: 'x', isAdmin: false });
    const space = await storage.createSpace(`View Board ${Date.now()}`, owner.id);
    await authStore.setMembership(space.slug, owner.id, 'editor');
    const scene = fixtureScene();
    const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'View Board', kind: 'board' });
    await storage.writeBoardSvg(page.id, renderSceneSvg(scene), true);

    const viewLink = await shares.createShareLink(page.id, owner.id, 'view', 'http://fallback.test');
    const viewToken = viewLink.url.split('/share/')[1];

    const clientDoc = new Y.Doc();
    const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/collab`, page.id, clientDoc, {
      params: { share: viewToken },
      WebSocketPolyfill: WS as unknown as typeof globalThis.WebSocket,
      connect: true,
      disableBc: true,
    });
    try {
      await waitSynced(provider);
      await pollUntil(() => collab.boardRoots(clientDoc).elements.size === 3);

      // The guest's own client still applies the edit locally (CRDTs always
      // do — that's exactly the "looks like it worked" half of the bug) —
      // what matters is whether it ever reaches the server/file.
      const roots = collab.boardRoots(clientDoc);
      const before = roots.elements.get('el-a')!;
      clientDoc.transact(() => {
        roots.elements.set('el-a', { ...before, backgroundColor: '#ff0000', version: before.version + 1 });
      });
      expect(collab.boardRoots(clientDoc).elements.get('el-a')!.backgroundColor).toBe('#ff0000'); // local apply did happen

      // Give the (refused) write every chance to land server-side if it were going to.
      await new Promise((r) => setTimeout(r, 700));

      const entry = await storage.requireEntry(page.id);
      const onDiskScene = await readFileScene(entry.absPath);
      const onDiskEl = onDiskScene.elements.find((e) => e.id === 'el-a');
      expect(onDiskEl?.backgroundColor).not.toBe('#ff0000'); // never persisted
    } finally {
      provider.destroy();
      await query('DELETE FROM ydoc_state WHERE page_id = $1', [page.id]).catch(() => undefined);
      await deleteTestSpace(space.slug);
    }
  }, 20_000);
});
