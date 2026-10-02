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
import { decodeScenePayload, extractScenePayload, renderSceneSvg, textEl } from './confluenceWhiteboard.js';
import { buildSceneFromSketch, type BoardSketch } from './boardSketch.js';
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

/** A text bound to `containerId`, without an index (the way create_board writes it). */
function makeLabel(id: string, containerId: string, text: string): ExcalidrawElement {
  return { ...textEl(() => 1, id, text, 0, 0, 80, 20, 16, '#1e1e1e', { container: containerId, align: 'center', valign: 'middle' }), index: null };
}

/** What create_board / update_board hand over: no `index` anywhere, the array is the z-order. 'zz-zone' is the bottom layer although its id sorts last; 'web' sorts after 't-web'. */
function layeredScene(): ExcalidrawScene {
  return makeScene([
    makeElement('zz-zone', { index: null, backgroundColor: '#ffe3e3', x: 0, y: 0, width: 600, height: 300 }),
    makeElement('web', { index: null, backgroundColor: '#a5d8ff', x: 40, y: 40, width: 180, height: 70, boundElements: [{ id: 't-web', type: 'text' }] }),
    makeLabel('t-web', 'web', 'Web shop'),
    makeElement('api', { index: null, backgroundColor: '#d0bfff', x: 300, y: 40, width: 180, height: 70, boundElements: [{ id: 't-api', type: 'text' }] }),
    makeLabel('t-api', 'api', 'API gateway'),
  ]);
}

const LAYERED_Z_ORDER = ['zz-zone', 'web', 't-web', 'api', 't-api'];

const liveIds = (scene: ExcalidrawScene): string[] => scene.elements.filter((e) => !e.isDeleted).map((e) => e.id);

/** True when the box with this fill is drawn before the text with this label in the markup. */
function labelAboveBox(svg: string, fill: string, text: string): boolean {
  const rect = svg.indexOf(`fill="${fill}"`);
  const label = svg.indexOf(`>${text}</tspan>`);
  return rect > -1 && label > rect;
}

/**
 * The file the OLD server wrote for a scene: the payload in id order and, in the picture, a box's label drawn BEFORE
 * the box (the fixed renderer no longer produces that, so the markup is rearranged here).
 */
function oldServerSvg(scene: ExcalidrawScene): string {
  const byId = makeScene([...scene.elements].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), scene.appState);
  const svg = renderSceneSvg(byId);
  const text = /<text [^>]*><tspan [^>]*>Web shop<\/tspan><\/text>/.exec(svg)![0];
  const rect = /<rect [^>]*fill="#a5d8ff"[^>]*\/>/.exec(svg)![0];
  const old = svg.replace(text, '').replace(rect, text + rect);
  if (labelAboveBox(old, '#a5d8ff', 'Web shop')) throw new Error('the fixture did not reproduce the old picture');
  return old;
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

  /** Like makeLiveBoard, but the file is exactly `svg` (a file some other version of the server wrote). */
  async function makeLiveBoardFromSvg(label: string, svg: string): Promise<{ space: string; id: string; ydoc: Y.Doc; absPath: string }> {
    const { space, id, absPath } = await makeBoardPage(label);
    await storage.writeBoardSvg(id, svg, true);
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

  // -------------------------------------------------------------------------
  // Z-ORDER: the order of the scene (not id order) reaches the room, the file
  // and the picture. A box whose id sorts after its label's id used to be drawn
  // OVER its label ("Web shop" box with no text) in the SVG of the file.
  // -------------------------------------------------------------------------

  it('Z-ORDER: an index-less scene written into a live room is saved in the order of the scene, with every label drawn above its box', async () => {
    const { space, id, ydoc, absPath } = await makeLiveBoard('Board ZOrder Edit', fixtureScene());
    try {
      await collab.editBoardScene(id, layeredScene());
      await collab.persistDoc(id, ydoc);

      const saved = await readFileScene(absPath);
      expect(liveIds(saved)).toEqual(LAYERED_Z_ORDER);

      const svg = await fs.readFile(absPath, 'utf8');
      expect(labelAboveBox(svg, '#a5d8ff', 'Web shop')).toBe(true);
      expect(labelAboveBox(svg, '#d0bfff', 'API gateway')).toBe(true);
      // the bottom layer is drawn first, although its id sorts last
      expect(svg.indexOf('fill="#ffe3e3"')).toBeLessThan(svg.indexOf('fill="#a5d8ff"'));
    } finally {
      liveDocs.delete(id);
      await deleteTestSpace(space);
    }
  }, 20_000);

  it('Z-ORDER: a room seeded from a file whose elements have no index follows the array order of the file', async () => {
    const { space, id } = await makeLiveBoard('Board ZOrder Seed', layeredScene());
    try {
      expect(liveIds(collab.getLiveBoardScene(id)!)).toEqual(LAYERED_Z_ORDER);
      // the room carries real z-order keys now, so every client reads the same order
      const keys = collab.getLiveBoardScene(id)!.elements.map((e) => e.index);
      expect(keys.every((k) => typeof k === 'string' && k.length > 0)).toBe(true);
      expect(new Set(keys).size).toBe(keys.length);
    } finally {
      liveDocs.delete(id);
      await deleteTestSpace(space);
    }
  }, 20_000);

  it('Z-ORDER: elements an agent adds without an index land on top of the board', async () => {
    const { space, id, ydoc } = await makeLiveBoard('Board ZOrder Added', fixtureScene());
    try {
      const live = collab.getLiveBoardScene(id)!;
      expect(liveIds(live)).toEqual(['el-a', 'el-c', 'el-b']);
      await collab.editBoardScene(id, makeScene([...live.elements, makeElement('added', { index: null, x: 500 })]));
      const after = collab.getLiveBoardScene(id)!;
      expect(liveIds(after)).toEqual(['el-a', 'el-c', 'el-b', 'added']);
      // the elements the user already had keep their keys
      expect(collab.boardRoots(ydoc).elements.get('el-b')!.index).toBe('a2');
    } finally {
      liveDocs.delete(id);
      await deleteTestSpace(space);
    }
  }, 20_000);

  it('Z-ORDER: a board saved by the old server (id order, label under the box) is not rewritten just because it was opened or persisted', async () => {
    const { space, id, ydoc, absPath } = await makeLiveBoardFromSvg('Board ZOrder Legacy NoChurn', oldServerSvg(layeredScene()));
    try {
      const before = await fs.readFile(absPath, 'utf8');
      await collab.persistDoc(id, ydoc);
      expect(await fs.readFile(absPath, 'utf8')).toBe(before);
    } finally {
      liveDocs.delete(id);
      await deleteTestSpace(space);
    }
  }, 20_000);

  it('Z-ORDER: that same legacy board is fixed by the next real edit: the label is drawn above its box again', async () => {
    const { space, id, ydoc, absPath } = await makeLiveBoardFromSvg('Board ZOrder Legacy Fix', oldServerSvg(layeredScene()));
    try {
      expect(labelAboveBox(await fs.readFile(absPath, 'utf8'), '#a5d8ff', 'Web shop')).toBe(false); // the bug, as written by the old server

      const roots = collab.boardRoots(ydoc);
      const cur = roots.elements.get('api')!;
      ydoc.transact(() => roots.elements.set('api', { ...cur, backgroundColor: '#00ff00', version: cur.version + 1, versionNonce: cur.versionNonce + 1 }));
      await collab.persistDoc(id, ydoc);

      const svg = await fs.readFile(absPath, 'utf8');
      expect(labelAboveBox(svg, '#a5d8ff', 'Web shop')).toBe(true);
      const ids = liveIds(await readFileScene(absPath));
      expect(ids.indexOf('web')).toBeLessThan(ids.indexOf('t-web'));
    } finally {
      liveDocs.delete(id);
      await deleteTestSpace(space);
    }
  }, 20_000);

  it('Z-ORDER: a sketch whose node ids sort after their labels\' ids (a demo starting board) is saved with every label above its box after a first live edit', async () => {
    // A small architecture sketch as the assistant's create_board takes it. Ids like 'web' sort after their label's id
    // ('t-web'); every node gets a distinct fill so that its box can be found in the markup.
    const fill = (i: number): string => `#${(0x100000 + i * 0x1111).toString(16)}`;
    const nodes: BoardSketch['nodes'] = [
      { id: 'web', type: 'rectangle', label: 'Web shop', x: 0, y: 30, w: 180, h: 70 },
      { id: 'mobile', type: 'rectangle', label: 'Mobile app', x: 0, y: 180, w: 180, h: 70 },
      { id: 'gateway', type: 'rectangle', label: 'API gateway', x: 300, y: 105, w: 180, h: 70 },
      { id: 'orders', type: 'rectangle', label: 'Orders', x: 600, y: 105, w: 180, h: 70 },
      { id: 'payments', type: 'rectangle', label: 'Payments', x: 900, y: 30, w: 180, h: 70 },
      { id: 'inventory', type: 'rectangle', label: 'Inventory', x: 900, y: 180, w: 180, h: 70 },
      { id: 'db', type: 'ellipse', label: 'Postgres', x: 900, y: 330, w: 180, h: 90 },
    ].map((n, i) => ({ ...n, background: fill(i) })) as BoardSketch['nodes'];
    const sketch: BoardSketch = {
      nodes,
      edges: [
        { from: 'web', to: 'gateway', label: 'HTTPS', elbowed: false },
        { from: 'mobile', to: 'gateway', label: 'HTTPS', elbowed: false },
        { from: 'gateway', to: 'orders', label: 'REST', elbowed: false },
        { from: 'orders', to: 'payments', label: 'charge', elbowed: false },
        { from: 'orders', to: 'inventory', label: 'reserve', elbowed: false },
        { from: 'inventory', to: 'db', label: 'stock', elbowed: false },
      ],
    };
    const built = buildSceneFromSketch(sketch);

    // create_board: no room yet, straight to the file; then the board is opened and somebody draws a box.
    const { space, id, absPath } = await makeBoardPage('Board ZOrder Video5', makeScene([makeElement('seed')]));
    try {
      await collab.editBoardScene(id, built);
      const ydoc = new Y.Doc();
      await collab.bindState(id, ydoc);
      liveDocs.set(id, ydoc);
      const roots = collab.boardRoots(ydoc);
      ydoc.transact(() => roots.elements.set('drawn', makeElement('drawn', { index: 'b00', x: 1200, backgroundColor: '#b2f2bb' })));
      await collab.persistDoc(id, ydoc);

      // the file keeps the order the scene was built in, the new box on top
      const saved = await readFileScene(absPath);
      expect(liveIds(saved)).toEqual([...built.elements.map((e) => e.id), 'drawn']);

      // and the picture is drawn in that order: shape, then its label — never a label before its box
      const svg = await fs.readFile(absPath, 'utf8');
      const body = svg.slice(svg.indexOf('</defs>'));
      const drawn = [...body.matchAll(/<(rect|ellipse|polygon|polyline|text)\b/g)].map((m) => m[1]).slice(1); // [0] is the page background
      const arrowIds = new Set(built.elements.filter((e) => e.type === 'arrow').map((e) => e.id));
      const expected = built.elements.flatMap((e) => {
        if (e.type === 'rectangle') return ['rect'];
        if (e.type === 'ellipse') return ['ellipse'];
        if (e.type === 'arrow') return ['polyline'];
        return e.containerId && arrowIds.has(e.containerId) ? ['rect', 'text'] : ['text'];
      });
      expect(drawn).toEqual([...expected, 'rect']);
      for (let i = 0; i < nodes.length; i++) {
        expect(labelAboveBox(svg, fill(i), nodes[i].label!)).toBe(true);
      }
    } finally {
      liveDocs.delete(id);
      await deleteTestSpace(space);
    }
  }, 20_000);

  it('Z-ORDER: a board that is already in order is never rewritten by a persist that has nothing new to say', async () => {
    const indexed = makeScene([
      makeElement('zz-zone', { index: 'a0', backgroundColor: '#ffe3e3', width: 600, height: 300 }),
      makeElement('web', { index: 'a1', backgroundColor: '#a5d8ff', boundElements: [{ id: 't-web', type: 'text' }] }),
      { ...makeLabel('t-web', 'web', 'Web shop'), index: 'a2' },
    ]);
    const { space, id, ydoc, absPath } = await makeLiveBoard('Board ZOrder InOrder NoChurn', indexed);
    try {
      const before = await fs.readFile(absPath, 'utf8');
      await collab.persistDoc(id, ydoc);
      await collab.persistDoc(id, ydoc);
      expect(await fs.readFile(absPath, 'utf8')).toBe(before);
    } finally {
      liveDocs.delete(id);
      await deleteTestSpace(space);
    }
  }, 20_000);

  it('Z-ORDER: handing over the same index-less scene again changes nothing in the room (no Yjs update, no churn in Git)', async () => {
    const { space, id, ydoc, absPath } = await makeLiveBoard('Board ZOrder Repeat', fixtureScene());
    try {
      await collab.editBoardScene(id, layeredScene());
      await collab.persistDoc(id, ydoc);
      const before = await fs.readFile(absPath, 'utf8');

      let updates = 0;
      ydoc.on('update', () => {
        updates += 1;
      });
      await collab.editBoardScene(id, layeredScene());
      await collab.persistDoc(id, ydoc);

      expect(updates).toBe(0);
      expect(await fs.readFile(absPath, 'utf8')).toBe(before);
    } finally {
      liveDocs.delete(id);
      await deleteTestSpace(space);
    }
  }, 20_000);

  it('Z-ORDER: "take the version from Git" on an open room puts the room in the order of the file and leaves the file byte for byte as it was', async () => {
    const { space, id, ydoc, absPath } = await makeLiveBoard('Board ZOrder Reset', fixtureScene());
    try {
      // The file moves on under the open room (a reset to the remote writes straight to disk).
      await fs.writeFile(absPath, renderSceneSvg(layeredScene()), 'utf8');
      const written = await fs.readFile(absPath, 'utf8');

      await collab.reconcileLiveRoomsAfterReset([id]);
      expect(liveIds(collab.getLiveBoardScene(id)!)).toEqual(LAYERED_Z_ORDER);

      await collab.persistDoc(id, ydoc);
      expect(await fs.readFile(absPath, 'utf8')).toBe(written);
    } finally {
      liveDocs.delete(id);
      await deleteTestSpace(space);
    }
  }, 20_000);
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

  it("Z-ORDER: an agent's index-less scene reaches an open tab as z-order keys and lands in the file with every label above its box", async () => {
    const owner = await authStore.createUser({ email: `b-zorder-${Date.now()}@collab-test.local`, name: 'Owner', passwordHash: 'x', isAdmin: false });
    const space = await storage.createSpace(`ZOrder Board ${Date.now()}`, owner.id);
    await authStore.setMembership(space.slug, owner.id, 'editor');
    const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'Board', kind: 'board' });
    await storage.writeBoardSvg(page.id, renderSceneSvg(fixtureScene()), true);
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

      await collab.editBoardScene(page.id, layeredScene());

      // The open tab reads the z-order from the elements themselves: a key on each.
      await pollUntil(() => collab.boardRoots(clientDoc).elements.get('t-api') !== undefined);
      const clientEls = [...collab.boardRoots(clientDoc).elements.values()].filter((e) => !e.isDeleted);
      const byKey = [...clientEls].sort((a, b) => ((a.index ?? '') < (b.index ?? '') ? -1 : 1));
      expect(byKey.map((e) => e.id)).toEqual(LAYERED_Z_ORDER);

      // And the file: the order of the scene, the label above its box in the picture.
      const entry = await storage.requireEntry(page.id);
      await pollUntil(async () => (await fs.readFile(entry.absPath, 'utf8')).includes('API gateway'));
      const svg = await fs.readFile(entry.absPath, 'utf8');
      expect(liveIds(await readFileScene(entry.absPath))).toEqual(LAYERED_Z_ORDER);
      expect(labelAboveBox(svg, '#a5d8ff', 'Web shop')).toBe(true);
      expect(labelAboveBox(svg, '#d0bfff', 'API gateway')).toBe(true);
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
