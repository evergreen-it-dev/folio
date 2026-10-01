/**
 * DEV-PLAN Round 29 (DIAGRAMS) — the client half of the board's Y.Doc.
 *
 * No jsdom, no websocket, no server: every test here works against a bare
 * `new Y.Doc()` (or two, bridged by hand through `Y.applyUpdate` — the same
 * technique server/collabTables.test.ts's parity suite uses for tables),
 * exactly like web/src/tables/collab/ydoc.test.ts does for the table CRDT.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import {
  BOARD_LOCAL_ORIGIN,
  applyLocalElements,
  applyLocalFiles,
  boardFieldsFromMap,
  boardRoots,
  createThrottledElementsWriter,
  filesFromMap,
  isSyncableElement,
  orderedElementsFromMap,
  writeBoardFields,
  writeElementsToMap,
  writeFilesToMap,
} from './boardYdoc';

/**
 * Minimal element fixture — only the fields this module actually reads.
 * `index` is typed as a plain string here (Excalidraw brands it as
 * `FractionalIndex`) — boardYdoc.ts deliberately never imports that brand
 * (see its own docblock: no @excalidraw/excalidraw runtime dependency),
 * so a bare string is exactly what this module treats it as.
 */
interface ElementFixture {
  id: string;
  version?: number;
  versionNonce?: number;
  index?: string;
  isDeleted?: boolean;
  type?: string;
  updated?: number;
  /** Only used to make two fixtures with the same version distinguishable objects in one test. */
  x?: number;
}

function element(overrides: ElementFixture): ExcalidrawElement {
  return {
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    isDeleted: false,
    version: 1,
    versionNonce: 1,
    index: 'a0',
    updated: Date.now(),
    ...overrides,
  } as unknown as ExcalidrawElement;
}

/** Bridges two Y.Docs by hand, mirroring the real WebsocketProvider's relay: an update from one side is applied to the other under a distinct origin, and never bounced back. */
function link(a: Y.Doc, b: Y.Doc): void {
  a.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === 'bridge') return;
    Y.applyUpdate(b, update, 'bridge');
  });
  b.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === 'bridge') return;
    Y.applyUpdate(a, update, 'bridge');
  });
}

describe('writeElementsToMap', () => {
  it('writes a brand-new element (no existing entry)', () => {
    const map = boardRoots(new Y.Doc()).elements;
    writeElementsToMap(map, [element({ id: 'r1' })]);
    expect(map.get('r1')).toMatchObject({ id: 'r1', version: 1 });
  });

  it('skips a write when the version has not changed (pan/zoom-only onChange)', () => {
    const map = boardRoots(new Y.Doc()).elements;
    const first = element({ id: 'r1', version: 1 });
    writeElementsToMap(map, [first]);
    const second = element({ id: 'r1', version: 1, x: 999 }); // same version, different object — must not overwrite
    writeElementsToMap(map, [second]);
    // Content, not identity: the map deliberately holds a DETACHED copy (see
    // detach() — storing the live element is what broke sync), so the check is
    // "the second write did not land", not "the very same object is in there".
    expect(map.get('r1')).toMatchObject({ x: first.x, version: 1 });
    expect((map.get('r1') as { x: number }).x).not.toBe(999);
  });

  it('overwrites when the version is genuinely newer', () => {
    const map = boardRoots(new Y.Doc()).elements;
    writeElementsToMap(map, [element({ id: 'r1', version: 1, versionNonce: 1 })]);
    writeElementsToMap(map, [element({ id: 'r1', version: 2, versionNonce: 1 })]);
    expect(map.get('r1')).toMatchObject({ version: 2 });
  });

  it('breaks a tied version by the bigger versionNonce', () => {
    const map = boardRoots(new Y.Doc()).elements;
    writeElementsToMap(map, [element({ id: 'r1', version: 2, versionNonce: 5 })]);
    writeElementsToMap(map, [element({ id: 'r1', version: 2, versionNonce: 9 })]);
    expect(map.get('r1')).toMatchObject({ versionNonce: 9 });
    // a lower versionNonce at the same version must not win
    writeElementsToMap(map, [element({ id: 'r1', version: 2, versionNonce: 3 })]);
    expect(map.get('r1')).toMatchObject({ versionNonce: 9 });
  });

  it('never lets a stale (older-version) write clobber a newer entry — the tombstone-resurrection guard', () => {
    const map = boardRoots(new Y.Doc()).elements;
    writeElementsToMap(map, [element({ id: 'r1', version: 1, versionNonce: 1, isDeleted: false })]);
    // deleted elsewhere, version bumped
    writeElementsToMap(map, [element({ id: 'r1', version: 2, versionNonce: 1, isDeleted: true })]);
    // a stale echo of the pre-delete content arrives afterwards (e.g. a tab
    // that hadn't yet reconciled the remote delete into its own scene)
    writeElementsToMap(map, [element({ id: 'r1', version: 1, versionNonce: 1, isDeleted: false })]);
    expect(map.get('r1')).toMatchObject({ version: 2, isDeleted: true });
  });
});

describe('isSyncableElement / writeElementsToMap filtering (audit item 4 — mirrors excalidraw\'s own isSyncableElement)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  it('a fresh tombstone (isDeleted, updated just now) IS syncable', () => {
    expect(isSyncableElement(element({ id: 'r1', isDeleted: true, updated: Date.now() }))).toBe(true);
  });

  it('a tombstone updated 23h ago (inside the 24h window) is STILL syncable', () => {
    expect(isSyncableElement(element({ id: 'r1', isDeleted: true, updated: Date.now() - (DAY_MS - 60_000) }))).toBe(true);
  });

  it('a tombstone updated 25h ago (past the 24h window) is NOT syncable', () => {
    expect(isSyncableElement(element({ id: 'r1', isDeleted: true, updated: Date.now() - (DAY_MS + 60_000) }))).toBe(false);
  });

  it('a live (non-deleted) element is always syncable regardless of `updated`', () => {
    expect(isSyncableElement(element({ id: 'r1', isDeleted: false, updated: Date.now() - 10 * DAY_MS }))).toBe(true);
  });

  it('a `selection` pseudo-element is never syncable, deleted or not', () => {
    expect(isSyncableElement(element({ id: 'sel1', type: 'selection', isDeleted: false }))).toBe(false);
    expect(isSyncableElement(element({ id: 'sel1', type: 'selection', isDeleted: true }))).toBe(false);
  });

  it('writeElementsToMap: a fresh tombstone DOES get written (a delete must still reach the room)', () => {
    const map = boardRoots(new Y.Doc()).elements;
    writeElementsToMap(map, [element({ id: 'r1', isDeleted: true, version: 2, updated: Date.now() })]);
    expect(map.get('r1')).toMatchObject({ id: 'r1', isDeleted: true });
  });

  it('writeElementsToMap: a stale (>24h) tombstone does NOT get written at all', () => {
    const map = boardRoots(new Y.Doc()).elements;
    writeElementsToMap(map, [element({ id: 'r1', isDeleted: true, version: 2, updated: Date.now() - (DAY_MS + 60_000) })]);
    expect(map.get('r1')).toBeUndefined();
  });

  it('writeElementsToMap: a `selection` element is never written', () => {
    const map = boardRoots(new Y.Doc()).elements;
    writeElementsToMap(map, [element({ id: 'sel1', type: 'selection' })]);
    expect(map.get('sel1')).toBeUndefined();
  });
});

describe('orderedElementsFromMap', () => {
  it('orders by fractional index, not Y.Map insertion order', () => {
    const map = boardRoots(new Y.Doc()).elements;
    writeElementsToMap(map, [element({ id: 'c', index: 'a2' }), element({ id: 'a', index: 'a0' }), element({ id: 'b', index: 'a1' })]);
    expect(orderedElementsFromMap(map).map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('breaks a tied (or missing) index by id', () => {
    const map = boardRoots(new Y.Doc()).elements;
    writeElementsToMap(map, [element({ id: 'z', index: 'a0' }), element({ id: 'a', index: 'a0' })]);
    expect(orderedElementsFromMap(map).map((e) => e.id)).toEqual(['a', 'z']);
  });

  it('includes tombstones — the caller decides whether to filter them, this function never silently drops isDeleted elements', () => {
    const map = boardRoots(new Y.Doc()).elements;
    writeElementsToMap(map, [element({ id: 'r1', isDeleted: true, version: 2 })]);
    expect(orderedElementsFromMap(map)).toHaveLength(1);
  });
});

describe('board fields', () => {
  it('round-trips viewBackgroundColor', () => {
    const map = boardRoots(new Y.Doc()).board;
    writeBoardFields(map, { viewBackgroundColor: '#abcdef' });
    expect(boardFieldsFromMap(map)).toEqual({ viewBackgroundColor: '#abcdef' });
  });

  it('is a no-op when the value has not changed', () => {
    const doc = new Y.Doc();
    const map = boardRoots(doc).board;
    let updates = 0;
    doc.on('update', () => updates++);
    writeBoardFields(map, { viewBackgroundColor: '#ffffff' });
    expect(updates).toBe(1);
    writeBoardFields(map, { viewBackgroundColor: '#ffffff' });
    expect(updates).toBe(1); // still one — the second call wrote nothing
  });
});

describe('files', () => {
  it('writes a file once and never rewrites it on a later call (content-addressed, immutable)', () => {
    const doc = new Y.Doc();
    const map = boardRoots(doc).files;
    const file = { id: 'f1', mimeType: 'image/png', dataURL: 'data:image/png;base64,AAA', created: 1 } as never;
    writeFilesToMap(map, { f1: file });
    let updates = 0;
    doc.on('update', () => updates++);
    writeFilesToMap(map, { f1: file });
    expect(updates).toBe(0);
    expect(filesFromMap(map)).toEqual({ f1: file });
  });
});

describe('two Y.Docs bridged like a real collab room (DEV-PLAN acceptance: two Y.Doc linked by hand via Y.applyUpdate)', () => {
  it('an element created on one side appears in the ordered scene read from the other', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    link(docA, docB);

    applyLocalElements(docA, boardRoots(docA).elements, [element({ id: 'rect-1', index: 'a0' })]);

    expect(orderedElementsFromMap(boardRoots(docB).elements).map((e) => e.id)).toEqual(['rect-1']);
  });

  it('an element deleted on one side lands as a tombstone on the other, and a later stale re-write from the other side does not resurrect it', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    link(docA, docB);
    const rootsA = boardRoots(docA);
    const rootsB = boardRoots(docB);

    applyLocalElements(docA, rootsA.elements, [element({ id: 'rect-1', version: 1, versionNonce: 1 })]);
    expect(orderedElementsFromMap(rootsB.elements)[0]).toMatchObject({ isDeleted: false });

    // A deletes it: same id, isDeleted: true, version bumped.
    applyLocalElements(docA, rootsA.elements, [element({ id: 'rect-1', version: 2, versionNonce: 1, isDeleted: true })]);
    expect(orderedElementsFromMap(rootsB.elements)[0]).toMatchObject({ isDeleted: true, version: 2 });

    // B's tab hadn't reconciled the delete into its own scene yet and its
    // next onChange still reports the old (pre-delete) element — exactly the
    // hazard writeElementsToMap's version guard exists for.
    applyLocalElements(docB, rootsB.elements, [element({ id: 'rect-1', version: 1, versionNonce: 1, isDeleted: false })]);

    expect(orderedElementsFromMap(rootsA.elements)[0]).toMatchObject({ isDeleted: true, version: 2 });
    expect(orderedElementsFromMap(rootsB.elements)[0]).toMatchObject({ isDeleted: true, version: 2 });
  });

  it('board fields and files created on one side sync to the other', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    link(docA, docB);
    const rootsA = boardRoots(docA);
    const rootsB = boardRoots(docB);

    docA.transact(() => writeBoardFields(rootsA.board, { viewBackgroundColor: '#112233' }), BOARD_LOCAL_ORIGIN);
    expect(boardFieldsFromMap(rootsB.board)).toEqual({ viewBackgroundColor: '#112233' });

    const file = { id: 'f1', mimeType: 'image/png', dataURL: 'data:image/png;base64,AAA', created: 1 } as never;
    applyLocalFiles(docA, rootsA.files, { f1: file });
    expect(filesFromMap(rootsB.files)).toEqual({ f1: file });
  });
});

describe('createThrottledElementsWriter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes the very first call immediately (no artificial delay on an isolated edit)', () => {
    vi.useFakeTimers();
    const map = boardRoots(new Y.Doc()).elements;
    const doc = new Y.Doc();
    const writer = createThrottledElementsWriter(doc, map, 250);

    writer.write([element({ id: 'r1', version: 1 })]);

    expect(map.get('r1')).toMatchObject({ id: 'r1', version: 1 });
  });

  it('coalesces rapid successive writes within the window into a single transaction carrying the LATEST state', () => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    const map = boardRoots(doc).elements;
    const writer = createThrottledElementsWriter(doc, map, 250);
    let updates = 0;
    doc.on('update', () => updates++);

    writer.write([element({ id: 'r1', version: 1, versionNonce: 1 })]); // fires immediately
    expect(updates).toBe(1);

    // Two more edits to the SAME element land inside the throttle window —
    // neither should produce its own transaction.
    writer.write([element({ id: 'r1', version: 2, versionNonce: 2 })]);
    writer.write([element({ id: 'r1', version: 3, versionNonce: 3 })]);
    expect(updates).toBe(1); // still just the first — nothing committed yet
    expect(map.get('r1')).toMatchObject({ version: 1 }); // not yet visible

    vi.advanceTimersByTime(250);

    expect(updates).toBe(2); // exactly one more transaction for both coalesced writes
    expect(map.get('r1')).toMatchObject({ version: 3 }); // the LATEST state, not version 2
  });

  it('a write after the window has elapsed fires immediately again, not throttled forever', () => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    const map = boardRoots(doc).elements;
    const writer = createThrottledElementsWriter(doc, map, 250);

    writer.write([element({ id: 'r1', version: 1 })]);
    vi.advanceTimersByTime(300); // window fully elapsed, nothing pending
    writer.write([element({ id: 'r1', version: 2 })]);

    expect(map.get('r1')).toMatchObject({ version: 2 }); // committed without waiting again
  });

  it('flush() commits a still-pending write immediately (e.g. on unmount)', () => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    const map = boardRoots(doc).elements;
    const writer = createThrottledElementsWriter(doc, map, 250);

    writer.write([element({ id: 'r1', version: 1 })]); // immediate
    writer.write([element({ id: 'r1', version: 2 })]); // queued
    expect(map.get('r1')).toMatchObject({ version: 1 });

    writer.flush();

    expect(map.get('r1')).toMatchObject({ version: 2 });
  });

  it('cancel() drops a still-pending write without ever committing it', () => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    const map = boardRoots(doc).elements;
    const writer = createThrottledElementsWriter(doc, map, 250);

    writer.write([element({ id: 'r1', version: 1 })]); // immediate
    writer.write([element({ id: 'r1', version: 2 })]); // queued

    writer.cancel();
    vi.advanceTimersByTime(1000);

    expect(map.get('r1')).toMatchObject({ version: 1 }); // version 2 never landed
  });
});

describe('elements are stored detached from excalidraw', () => {
  it('a later state of an element still reaches the map after excalidraw mutates it in place', () => {
    // Excalidraw mutates its element objects IN PLACE and bumps `version`.
    // Yjs keeps whatever JS value it was handed, so storing the live element
    // made `map.get(id)` and the element the SAME object: the version check
    // then always concluded "nothing changed" and every state after the first
    // stayed in the authoring tab. Two tabs showed 272×159 v3 vs 0×0 v2.
    const doc = new Y.Doc();
    const map = doc.getMap('elements');
    const live = element({ id: 'e1', version: 2 }) as unknown as Record<string, unknown>;
    live.width = 0;
    live.height = 0;

    writeElementsToMap(map, [live as never]);
    expect((map.get('e1') as { width: number }).width).toBe(0);

    // …excalidraw finishes the drag on the very same object.
    live.width = 272;
    live.height = 159;
    live.version = 3;
    writeElementsToMap(map, [live as never]);

    const stored = map.get('e1') as { width: number; height: number; version: number };
    expect(stored.width).toBe(272);
    expect(stored.height).toBe(159);
    expect(stored.version).toBe(3);
    // …and the stored copy must not be the live object any more.
    expect(stored).not.toBe(live);
    doc.destroy();
  });
});
