/**
 * DEV-PLAN Round 29 (DIAGRAMS) — the CLIENT half of the board's Y.Doc.
 *
 * ┌─ READ THIS BEFORE CHANGING ANYTHING HERE ─────────────────────────────┐
 * │ This module MUST describe the SAME three-root layout as the server's  │
 * │ board branch of server/collab.ts (bindState/persistDoc), or the       │
 * │ server and the browser read each other's CRDT as garbage. They are    │
 * │ separate files only because server/collab.ts imports fastify/pg and   │
 * │ cannot be loaded in a browser — mirrors web/src/tables/collab/ydoc.ts's│
 * │ own docblock on the same split for tables.                            │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 *   elements: Y.Map<string, ExcalidrawElement>  — key = element.id, value =
 *             the FLAT element JSON, tombstones (`isDeleted: true`) included.
 *   board:    Y.Map<string, unknown>            — scene-level fields
 *             (`viewBackgroundColor` today). Local viewport (scrollX/scrollY/
 *             zoom) never lives here — see boardViewport.ts for why that
 *             stays per-browser localStorage instead.
 *   files:    Y.Map<string, BinaryFileData>     — embedded images, keyed by
 *             their content-addressed fileId.
 *   reactions: Y.Map<string, { at: number }>    — emoji reactions, one key per
 *             (element, emoji, user): see reactionsModel.ts. CLIENT-ONLY root:
 *             the server never reads it, but it persists it anyway because the
 *             room snapshot (ydoc_state) encodes every root of the doc.
 *
 * Pure Yjs — no React, no @excalidraw/excalidraw runtime import (only
 * `import type`, erased at compile time) — so this file is testable with a
 * bare `new Y.Doc()`, no websocket, no server, no jsdom. See boardYdoc.test.ts,
 * including its two-Y.Doc bridge test (the CRDT-level counterpart of
 * server/collabBoards.test.ts's parity suite, once that lands).
 */
import * as Y from 'yjs';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { BinaryFileData } from '@excalidraw/excalidraw/types';

/**
 * Transaction origin for edits made by THIS browser tab. Used two ways:
 *  - passed to `doc.transact(fn, BOARD_LOCAL_ORIGIN)` for every local write,
 *    so a Y.Map observer can tell "I just wrote this" from "this landed from
 *    somewhere else" (BoardCanvas.tsx's remote-sync effect skips its own
 *    echoes this way instead of re-feeding them back into Excalidraw).
 *  - NOT tracked by any Y.UndoManager here: unlike documents/tables, the
 *    board's own undo is Excalidraw's built-in history (it already knows how
 *    to undo a local drag/resize), so there is nothing analogous to wire up.
 */
export const BOARD_LOCAL_ORIGIN = 'folio:board:local';

export interface BoardRoots {
  elements: Y.Map<unknown>;
  board: Y.Map<unknown>;
  files: Y.Map<unknown>;
  reactions: Y.Map<unknown>;
}

export function boardRoots(doc: Y.Doc): BoardRoots {
  return {
    elements: doc.getMap('elements'),
    board: doc.getMap('board'),
    files: doc.getMap('files'),
    reactions: doc.getMap('reactions'),
  };
}

// ---------------------------------------------------------------------------
// elements
// ---------------------------------------------------------------------------

type VersionedElement = Pick<ExcalidrawElement, 'id' | 'version' | 'versionNonce'>;

/** DEV-PLAN's reconciliation rule, also used as the write guard below: bigger `version` wins; tied versions fall back to the bigger `versionNonce`. */
function isNotOlderThan(a: VersionedElement, b: VersionedElement): boolean {
  const av = a.version ?? 0;
  const bv = b.version ?? 0;
  if (av !== bv) return av > bv;
  return (a.versionNonce ?? 0) >= (b.versionNonce ?? 0);
}

/**
 * Mirrors @excalidraw/excalidraw's own (unexported) `isSyncableElement` —
 * confirmed by reading the installed 0.18.1's collaboration example, since
 * the package doesn't export the constant or the predicate itself. Two kinds
 * of element must never enter the shared doc:
 *  - `type: 'selection'` — a purely local UI artifact (the marquee-select
 *    rectangle), never meant to be persisted or broadcast at all.
 *  - a tombstone stale enough that re-syncing it serves no purpose. A FRESH
 *    tombstone (`isDeleted: true`, `updated` within the timeout) still MUST
 *    pass — that's the one case DEV-PLAN cares about most: skipping it here
 *    would mean a delete never reaches anyone.
 */
const DELETED_ELEMENT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export function isSyncableElement(element: Pick<ExcalidrawElement, 'type' | 'isDeleted' | 'updated'>): boolean {
  if (element.type === 'selection') return false;
  if (element.isDeleted) {
    // No timestamp at all (a hand-built fixture, or a genuinely malformed
    // element) — err on the side of syncing it rather than silently eating
    // a delete; only a KNOWN-old `updated` can mark a tombstone stale.
    const updated = typeof element.updated === 'number' ? element.updated : Date.now();
    return Date.now() - updated < DELETED_ELEMENT_TIMEOUT_MS;
  }
  return true;
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * The elements map read back as an ordered array: sort by fractional `index`,
 * tie-break `id` — DEV-PLAN's normative order, independent of the Y.Map's own
 * (insertion) iteration order. Includes tombstones (`isDeleted: true`) — the
 * caller decides whether to filter them (Excalidraw's own updateScene wants
 * them present; DEV-PLAN's whole point is that dropping them lets two clients
 * resurrect a deletion).
 */
export function orderedElementsFromMap(map: Y.Map<unknown>): ExcalidrawElement[] {
  const elements = Array.from(map.values()) as ExcalidrawElement[];
  return elements.slice().sort((a, b) => {
    const byIndex = compareStrings((a as { index?: string | null }).index ?? '', (b as { index?: string | null }).index ?? '');
    if (byIndex !== 0) return byIndex;
    return compareStrings(a.id, b.id);
  });
}

/**
 * Writes the given scene elements (typically `getSceneElementsIncludingDeleted()`)
 * into the map, one key per element id. Per DEV-PLAN: only elements whose
 * `version` differs from what's already stored are written at all — a
 * pan/zoom-only onChange with unchanged element content is a complete no-op
 * here, and a genuinely stale write (this tab's own scene lagging behind a
 * remote update it hasn't reconciled into itself yet — see BoardCanvas.tsx's
 * remote-sync effect) can never clobber a newer entry, so a tombstone that
 * already landed can't be resurrected by an out-of-order echo.
 *
 * Caller wraps this in `doc.transact(fn, BOARD_LOCAL_ORIGIN)` — kept out of
 * this function so it's trivial to unit test against a bare map.
 */
/**
 * A DETACHED copy of an element.
 *
 * Excalidraw mutates its element objects IN PLACE and only bumps `version`.
 * Yjs, for a local doc, keeps whatever JS value you `set` — the very same
 * reference — and encodes it into an update at that moment. Handing it the
 * live element therefore breaks synchronisation in a way that looks like it
 * works: the first write leaves correctly, excalidraw then mutates that same
 * object, so `map.get(id)` reports the NEW version (it is the same object),
 * the version check below concludes "nothing changed", and every later state
 * of that element stays in this tab forever. Peers and the file keep the
 * first snapshot — a 0×0 draft for a shape that was just being drawn.
 *
 * Verified 10.09.2026 with two tabs: author's map showed 272×159 v3, the peer
 * and the file on disk both showed 0×0 v2.
 */
function detach(el: ExcalidrawElement): ExcalidrawElement {
  return structuredClone(el) as ExcalidrawElement;
}

export function writeElementsToMap(map: Y.Map<unknown>, sceneElements: readonly ExcalidrawElement[]): void {
  for (const el of sceneElements) {
    if (!isSyncableElement(el)) continue;
    const existing = map.get(el.id) as ExcalidrawElement | undefined;
    if (!existing) {
      map.set(el.id, detach(el));
      continue;
    }
    if (existing.version === el.version && existing.versionNonce === el.versionNonce) continue; // nothing changed
    if (isNotOlderThan(el, existing)) map.set(el.id, detach(el));
    // else: this tab's own copy is stale relative to what's already in the
    // room (a race with a remote write) — leave the newer entry alone; the
    // remote-sync effect reconciles this tab's own scene from it regardless.
  }
}

/** Convenience wrapper: one local-origin transaction per call, for the common "write everything that changed" case. */
export function applyLocalElements(doc: Y.Doc, map: Y.Map<unknown>, sceneElements: readonly ExcalidrawElement[]): void {
  if (sceneElements.length === 0) return;
  doc.transact(() => writeElementsToMap(map, sceneElements), BOARD_LOCAL_ORIGIN);
}

export interface ThrottledElementsWriter {
  /** Queue a write — coalesced with any pending one, never lost. */
  write(sceneElements: readonly ExcalidrawElement[]): void;
  /** Commit a still-pending write immediately (call on unmount/teardown). */
  flush(): void;
  /** Drop a still-pending write without committing it (call when the session itself is gone). */
  cancel(): void;
}

/**
 * Coalesces rapid-fire local element writes — e.g. one onChange per pointer
 * move during an active drag/resize, each carrying a bigger `version` than
 * the last — into at most one Y.Doc transaction per `intervalMs`, always
 * carrying forward the LATEST scene snapshot (never a stale mid-drag one).
 *
 * Exists because two genuinely separate `doc.transact()` calls landing only
 * milliseconds apart from the SAME client (exactly what an interactive
 * resize produces: one transaction for the freshly-created, still-0×0
 * element, a second moments later for its final committed size) were observed to
 * reach the server but not both survive to an already-connected peer's own
 * Y.Doc — even minutes later, even across this client's own periodic
 * `resyncInterval` ticks — while a SINGLE, isolated write with normal
 * separation from anything else always got through cleanly. Collapsing a
 * burst into one transaction removes the trigger for that gap entirely,
 * regardless of where in the stack it actually lives (see the DEV-PLAN
 * follow-up this round's report files against server/collab.ts).
 */
export function createThrottledElementsWriter(
  doc: Y.Doc,
  map: Y.Map<unknown>,
  intervalMs: number,
): ThrottledElementsWriter {
  let lastWrite = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: readonly ExcalidrawElement[] | null = null;

  const commit = () => {
    timer = null;
    lastWrite = Date.now();
    const scene = pending;
    pending = null;
    if (scene) applyLocalElements(doc, map, scene);
  };

  return {
    write(sceneElements) {
      pending = sceneElements;
      const now = Date.now();
      const elapsed = now - lastWrite;
      if (elapsed >= intervalMs) {
        commit();
        return;
      }
      if (timer === null) timer = setTimeout(commit, intervalMs - elapsed);
    },
    flush() {
      if (timer !== null) {
        clearTimeout(timer);
        commit();
      }
    },
    cancel() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pending = null;
    },
  };
}

// ---------------------------------------------------------------------------
// board (scene-level fields)
// ---------------------------------------------------------------------------

/** The only scene-level field DEV-PLAN names concretely; kept as a whitelist so a stray appState key never leaks into the shared doc. */
const BOARD_SCENE_FIELDS = ['viewBackgroundColor'] as const;
type BoardSceneField = (typeof BOARD_SCENE_FIELDS)[number];

export function writeBoardFields(map: Y.Map<unknown>, appState: Partial<Record<BoardSceneField, unknown>>): void {
  for (const key of BOARD_SCENE_FIELDS) {
    if (!(key in appState)) continue;
    const value = appState[key];
    if (map.get(key) !== value) map.set(key, value);
  }
}

export function applyLocalBoardFields(doc: Y.Doc, map: Y.Map<unknown>, appState: Partial<Record<BoardSceneField, unknown>>): void {
  doc.transact(() => writeBoardFields(map, appState), BOARD_LOCAL_ORIGIN);
}

export function boardFieldsFromMap(map: Y.Map<unknown>): { viewBackgroundColor?: string } {
  const vbg = map.get('viewBackgroundColor');
  return typeof vbg === 'string' ? { viewBackgroundColor: vbg } : {};
}

// ---------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------

/**
 * Files are content-addressed (Excalidraw's own `FileId` is a hash of the
 * bytes) and immutable once uploaded, so "write if absent" is not a
 * simplification — a re-check-every-key write here would mean re-encoding
 * every embedded image's dataURL into the CRDT on every single onChange,
 * which is the one part of this round genuinely worth avoiding.
 */
export function writeFilesToMap(map: Y.Map<unknown>, files: Record<string, BinaryFileData>): void {
  for (const [id, file] of Object.entries(files)) {
    if (!map.has(id)) map.set(id, file);
  }
}

export function applyLocalFiles(doc: Y.Doc, map: Y.Map<unknown>, files: Record<string, BinaryFileData>): void {
  if (Object.keys(files).length === 0) return;
  doc.transact(() => writeFilesToMap(map, files), BOARD_LOCAL_ORIGIN);
}

export function filesFromMap(map: Y.Map<unknown>): Record<string, BinaryFileData> {
  const out: Record<string, BinaryFileData> = {};
  for (const [id, file] of map.entries()) out[id] = file as BinaryFileData;
  return out;
}
