/**
 * Yjs / y-websocket bridge.
 *
 * One Y.Doc per open page, keyed by page id (the room name). We use the
 * reference y-websocket server implementation (setupWSConnection/docs/
 * setPersistence from its bin/utils.cjs) wired manually onto Fastify's
 * underlying http.Server, since this project doesn't depend on
 * @fastify/websocket. That module ships no types, so it's loaded via
 * createRequire and cast to a small local interface describing only the
 * surface we use.
 *
 * The Y.Text named "content" holds the markdown BODY (frontmatter is never
 * part of the CRDT). Persistence:
 *  - bindState: on first open, if the doc is empty, seed it from the file.
 *  - on every update (from any client, or from our own applyMarkdownUpdate/
 *    applyH1Rename below), debounce ~800ms and write the body back to disk
 *    via storage.writeDocBody (which also patches the in-memory index so
 *    title changes show up immediately).
 *  - writeState: flush immediately when the last connection to a doc closes.
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import * as Y from 'yjs';
import * as WS from 'ws';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as storage from './storage.js';
import * as session from './auth/session.js';
import * as gitSync from './gitSync.js';
import { translitSlug } from './translit.js';
import * as links from './links.js';
import * as shares from './shares.js';
import { shareGrantsPage } from './export/shareScope.js';
import { query, queryOne } from './db/pool.js';
import type { GitIdentity } from './git.js';
import { badRequest } from './errors.js';
import { tableColumnSchema, tableViewSchema } from '../shared/contracts.js';
import type { PageKind, PageMeta, TableCellValue, TableColumn, TableDoc, TableRow, TableView } from '../shared/contracts.js';
import { isOverHardRowLimit, isTableParseError, parseTableFile, serializeTableFile } from '../shared/tables/index.js';
import { decodeScenePayload, extractScenePayload, renderSceneSvg } from './confluenceWhiteboard.js';
import { orderBoardElements, placeBoundTexts, withBoardIndexes } from './boardOrder.js';
import type { ExcalidrawElement, ExcalidrawScene } from './confluenceWhiteboard.js';

interface PersistenceHooks {
  bindState: (docName: string, doc: Y.Doc) => Promise<void> | void;
  writeState: (docName: string, doc: Y.Doc) => Promise<void>;
  provider?: unknown;
}
interface YWebsocketUtilsModule {
  // `conn` is really a ws.WebSocket, but `import * as WS from 'ws'` (needed for CJS
  // interop without esModuleInterop) can't be used as a type — see attachToServer,
  // where the real ws.WebSocket instance from wss.handleUpgrade flows in here.
  setupWSConnection: (conn: unknown, req: IncomingMessage, opts?: { docName?: string; gc?: boolean }) => void;
  setPersistence: (hooks: PersistenceHooks) => void;
  docs: Map<string, Y.Doc>;
  /** The exact class y-websocket's own (fire-and-forget) getYDoc() constructs internally.
   *  Round-8 P0 fix (ensureDocSeeded below) needs to pre-create + fully AWAIT a doc's
   *  seeding itself, before any connection can reach it — which means constructing it
   *  ourselves via this same class rather than going through getYDoc. */
  WSSharedDoc: new (name: string) => Y.Doc;
}

const require = createRequire(import.meta.url);
// The package's exports map only defines the extensionless "./bin/utils" subpath
// (it resolves to bin/utils.cjs internally) — requiring the ".cjs" path directly
// is rejected under strict exports-map resolution (e.g. Vitest/Vite).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ywsUtils = require('y-websocket/bin/utils') as YWebsocketUtilsModule;
const { setupWSConnection, setPersistence, docs, WSSharedDoc } = ywsUtils;

/**
 * P0 FIX (round 8 postmortem, second bug): `yjs` ships as a genuine dual
 * ESM/CJS package — its package.json "exports" map points "import" at
 * dist/yjs.mjs and "require" at dist/yjs.cjs, two SEPARATE build artifacts
 * with two SEPARATE module-level class hierarchies (hence the "Yjs was
 * already imported. This breaks constructor checks" warning this test suite
 * has always printed). `y-websocket/bin/utils.cjs` — required above, CJS —
 * does its own internal `require('yjs')`, and every LIVE (production) doc in
 * this file is constructed via ITS `WSSharedDoc` class (whether by
 * y-websocket's own getYDoc, or by ensureDocSeeded below). Meanwhile this
 * file's `import * as Y from 'yjs'` further down resolves the OTHER (ESM)
 * build — and gitNative.test.ts's "THE DOUBLING fix" suite deliberately
 * calls bindState directly with a plain `new Y.Doc()` (that SAME ESM build)
 * to test its content logic cheaply, without a real WS server.
 *
 * Y.Text/Y.Doc INSTANCE methods (ytext.insert/.delete/.toString, doc.getText,
 * doc.transact, …) are fine regardless of which copy's `Y` you got the
 * object from — they dispatch on the object's own prototype. But STATIC
 * functions that take a doc/update as a plain argument and decode it
 * internally — Y.applyUpdate, Y.encodeStateAsUpdate — are NOT fine: calling
 * one copy's version on a doc the OTHER copy constructed silently corrupts
 * it. Confirmed empirically while building the tests below: after
 * Y.applyUpdate(cjsDoc, snapshot) using the ESM Y, `ytext.length` reported
 * the correct restored length while `ytext.toString()` came back empty for
 * that exact Text — the update's byte-level length bookkeeping applied, but
 * the actual content items weren't recognized as readable content. bindState's
 * own "file differs from restored doc" reconcile then "fixed" the (falsely)
 * apparent mismatch by inserting the real body a second time on top of the
 * still-counted-but-unreadable original — silently doubling `.length`
 * without doubling anything a client's toString() could ever see, and
 * corrupting what got sent over the wire.
 *
 * This mismatch is NOT new to round 8 — bindState has always used the ESM
 * `Y` for these two calls — but it had never been exercised END-TO-END
 * against a REAL, WSSharedDoc-constructed doc with an actual pre-existing
 * snapshot before: gitNative.test.ts's suite always used matching ESM docs
 * on both sides (test doc AND bindState's internal calls happened to be the
 * same instance, so the mismatch never manifested there), and no earlier
 * live-WS test opened a share/collab connection to a page that already had a
 * stored snapshot. The round-8 P0 tests below are the first to do both at
 * once, which is what surfaced it.
 *
 * Fix: `yEngineFor` (right below) picks whichever loaded instance actually
 * constructed a given doc and dispatches through THAT one — correct for
 * production (always WSSharedDoc/CJS) and for gitNative.test.ts's direct
 * plain-`Y.Doc`/ESM unit tests alike, rather than hardcoding either side.
 * This `require('yjs')` call itself resolves to the SAME module-cache entry
 * (keyed by resolved file path) that y-websocket/bin/utils.cjs's own
 * internal require('yjs') already loaded — i.e. genuinely the CJS side of
 * the split, not a third copy.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const YCjs = require('yjs') as typeof Y;

/**
 * Picks whichever of the two loaded Yjs module instances actually
 * constructed `ydoc`, so a static Y.* call on it always dispatches through
 * matching classes — needed because bindState/storeSnapshot are legitimately
 * called with either "flavor" of doc depending on the caller: production
 * docs are always WSSharedDoc (CJS, via ensureDocSeeded → getYDoc), but
 * tests that exercise bindState's content logic directly and cheaply —
 * without spinning up a real WS server — construct a plain `new Y.Doc()`
 * from this file's own ESM import instead (see gitNative.test.ts's "THE
 * DOUBLING fix" suite). Both are legitimate callers; this dispatches
 * correctly for either rather than assuming one.
 */
function yEngineFor(ydoc: Y.Doc): typeof Y {
  return ydoc instanceof YCjs.Doc ? YCjs : Y;
}

const WRITE_DEBOUNCE_MS = 800;

interface DebouncedWriter {
  schedule(): void;
  flush(): Promise<void>;
  /** Cancels any pending timer WITHOUT running `fn` — unlike flush(), the scheduled write never happens. Used by reconcileLiveRoomsAfterReset below: a reset-to-remote just rewrote the file, and flushing a stale in-memory write over it would silently reintroduce whatever the reset just threw away. */
  cancel(): void;
  /** Runs a scheduled write now, or waits for one already running, until neither is left — and unlike flush(), never writes when nothing is pending. Used by settleRoomsForSync below. */
  settle(): Promise<void>;
}

/** Debounces `fn`; `flush()` cancels any pending timer and runs `fn` immediately; `cancel()` cancels it and does NOT run `fn`. Exported for tests. */
export function createDebouncedWriter(fn: () => void | Promise<void>, ms: number): DebouncedWriter {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  const run = (): Promise<void> => {
    const p = Promise.resolve(fn()).finally(() => {
      if (inFlight === p) inFlight = undefined;
    });
    inFlight = p;
    return p;
  };
  const flush = async (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    await run();
  };
  return {
    schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        run().catch((err) => {
          // eslint-disable-next-line no-console
          console.error('[collab] debounced write failed:', err);
        });
      }, ms);
    },
    flush,
    async settle() {
      // Bounded: someone typing during the write re-arms the timer each time.
      for (let i = 0; i < 5 && (timer || inFlight); i++) {
        if (timer) await flush();
        else await inFlight;
      }
    },
    cancel() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

const writers = new Map<string, DebouncedWriter>();

/**
 * Round 8 P0 fix: tracks which docs have been FULLY seeded from persisted
 * state (snapshot or file) via a completed bindState call — read by
 * persistDoc's seatbelt below, written only by ensureDocSeeded once its own
 * bindState call has actually resolved. A docName absent here has either
 * never been opened, or is CURRENTLY being seeded (see seedingPromises) —
 * either way, its content isn't yet trustworthy as "the real thing".
 */
const seededDocs = new Map<string, boolean>();

/** True once `docName`'s doc has been through a completed seed (see ensureDocSeeded). */
export function isDocSeeded(docName: string): boolean {
  return seededDocs.get(docName) === true;
}

/**
 * In-flight seed promises, keyed by docName — lets a SECOND connection that
 * arrives while the first one's seed is still running await that SAME
 * promise, instead of either (a) racing ahead into setupWSConnection before
 * seeding finishes (the original P0 bug), or (b) independently constructing
 * a second WSSharedDoc and running bindState a second time (which would
 * reintroduce "THE DOUBLING": two independently-seeded copies of the same
 * content with different, non-merging CRDT op identity).
 */
const seedingPromises = new Map<string, Promise<void>>();

/**
 * Round 8 P0 FIX (root cause). Confirmed via live repro: a share-link guest
 * connecting as the first opener of a page with a real ~650-char body synced
 * an EMPTY doc, typed one sentence, and the debounced write-back replaced
 * the file with just that sentence — real content permanently lost.
 *
 * Root cause: y-websocket's own getYDoc() — called from INSIDE
 * setupWSConnection, i.e. as part of a connection's sync handshake already
 * starting — creates a doc and fires persistence.bindState() WITHOUT
 * awaiting it, then immediately proceeds to speak sync protocol using
 * whatever state the doc happens to have at that exact synchronous instant.
 * For an already-live doc (already in y-websocket's `docs` map) this is
 * harmless — there's nothing left to seed. But for a doc's FIRST open since
 * server boot (or since its last connection closed and evicted it), a
 * client whose own edit reaches the doc before that fire-and-forget
 * bindState promise resolves lands it on a doc bindState hasn't seeded yet.
 * bindState's own "did a concurrent update already land" guard (added for
 * THE DOUBLING fix, above) then sees non-empty text and — reasonably, from
 * its own local point of view — skips seeding entirely, assuming someone
 * else already handled it. In reality no one did: the real persisted
 * content is never restored, and the next debounced write-back overwrites
 * the FILE with just the new client's tiny edit.
 *
 * This was never really a "share vs cookie" divergence — both funnel
 * through the exact same setupWSConnection call in attachToServer below —
 * just a race that a share visit reliably exercises (very often literally
 * the first live open of a rarely-touched page, and a genuine guest's
 * client starts truly empty with nothing to coincidentally mask the race)
 * while routine cookie usage on an already-warm page rarely does.
 *
 * Fix: call this and AWAIT it before ever handing a connection to
 * setupWSConnection. It pre-creates the doc and its `docs` map entry (so
 * setupWSConnection's OWN getYDoc() call later is a pure map hit —
 * map.setIfUndefined never calls its factory when the key is already
 * present, so bindState is not invoked a second time) and waits for
 * bindState to fully complete before returning — so by the time any
 * client's sync handshake can possibly begin, the doc is guaranteed fully
 * seeded. Applies identically to cookie and share-token connections.
 */
async function ensureDocSeeded(docName: string): Promise<void> {
  if (docs.has(docName)) {
    const inFlight = seedingPromises.get(docName);
    if (inFlight) await inFlight;
    return;
  }
  const doc = new WSSharedDoc(docName);
  docs.set(docName, doc);
  const seed = bindState(docName, doc)
    .then(() => {
      seededDocs.set(docName, true);
    })
    .finally(() => {
      seedingPromises.delete(docName);
    });
  seedingPromises.set(docName, seed);
  await seed;
}

/**
 * Writes a doc's current text to disk and stores its Yjs snapshot — the
 * same work the debounced writer below runs on every update, extracted into
 * its own exported function so a test can call it directly against a
 * hand-built doc/scenario.
 *
 * Also home to the round-8 P0 seatbelt: refuses to shrink a page's on-disk
 * body down to something smaller when this doc was never confirmed-seeded
 * (isDocSeeded) — the exact signature of the cold-doc race above landing an
 * edit before bindState could restore the real content. Analogous to the
 * board write path's blank-scene guard (storage.writeBoardSvg): both refuse
 * a write whose shape strongly suggests "real content about to be silently
 * replaced by something clearly incomplete", not any particular size.
 *
 * A LEGITIMATE "select all, delete, save" never trips this: the user can
 * only see/select content that was actually loaded into the doc, which only
 * happens through a completed bindState — so that doc is always already
 * marked seeded by the time a human could act on it. Only a doc that skipped
 * seeding entirely (which ensureDocSeeded above should now make impossible
 * in normal operation — this is a defense-in-depth backstop, not the
 * primary fix) can be both unseeded AND shorter than the file.
 */
export async function persistDoc(docName: string, ydoc: Y.Doc): Promise<boolean> {
  let current: storage.PageIndexEntry | undefined;
  try {
    current = await storage.getEntry(docName);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[collab] could not look up page ${docName} to persist it:`, err);
    // Same rule as a failed file write: the room state must not live only in this process.
    await storeSnapshot(docName, ydoc).catch((snapErr) => {
      // eslint-disable-next-line no-console
      console.error(`[collab] ALSO failed to store the snapshot of page ${docName}; its latest text is only in memory:`, snapErr);
    });
    return false;
  }
  if (!current) return true; // page deleted; nothing to persist to
  // Round 26: a table page's body is not a Y.Text at all — it is the six-root
  // structured Y.Doc above, serialized through shared/tables. Everything below
  // this branch is the ORIGINAL doc-kind path, unchanged.
  if (isTableEntry(current)) {
    try {
      await persistTableDoc(docName, ydoc, current);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[collab] failed to persist table ${docName}:`, err);
    }
    return true;
  }
  if (isBoardEntry(current)) {
    try {
      await persistBoardDoc(docName, ydoc, current);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[collab] failed to persist board ${docName}:`, err);
    }
    return true;
  }
  if (current.kind !== 'doc') return true;
  try {
    const newBody = ydoc.getText('content').toString();
    if (!isDocSeeded(docName)) {
      const onDisk = await storage.readFreshDocBody(docName).catch(() => '');
      if (newBody.length < onDisk.length) {
        // eslint-disable-next-line no-console
        console.error(
          `[collab] SEATBELT: refusing to persist page ${docName} — new content is ${newBody.length} chars, ` +
            `shorter than the ${onDisk.length} chars currently on disk, and this doc was never confirmed fully ` +
            `seeded from its persisted state. This is the exact signature of the cold-doc race (an edit landing ` +
            `before bindState could restore the real content) — refusing the write to avoid clobbering real data. ` +
            `If this page genuinely has no meaningful prior content, this is a false trip worth investigating ` +
            `(isDocSeeded should have been true by now).`,
        );
        return true;
      }
    }
    // File first, snapshot second: if the snapshot write fails, the file (the
    // git-tracked source of truth) is still correct and up to date, and the next
    // bindState's reconcile-with-file step self-heals the (now stale) snapshot.
    // The reverse order risks the opposite: a snapshot ahead of a failed file
    // write would look, to bindState, like the FILE needs to "catch up" to it —
    // silently regressing content that was really just never written.
    const titleBefore = current.title ?? null;
    try {
      await storage.writeDocBody(docName, newBody);
    } catch (err) {
      // The file write failed: the room's text must not live only in this
      // process. Store the snapshot anyway, WITHOUT moving its file marker —
      // bindState then knows the file is older than the snapshot and keeps the
      // snapshot (see docFileWins). The caller retries the whole write.
      // eslint-disable-next-line no-console
      console.error(`[collab] failed to write page ${docName} to its file — keeping the room state in ydoc_state and retrying:`, err);
      await storeSnapshot(docName, ydoc).catch((snapErr) => {
        // eslint-disable-next-line no-console
        console.error(`[collab] ALSO failed to store the snapshot of page ${docName}; its latest text is only in memory:`, snapErr);
      });
      return false;
    }
    await storeSnapshot(docName, ydoc, storage.docFileBody(newBody)); // same cadence as the file write
    gitSync.noteActivity(current.space); // starts/resets the ~90s quiet-period auto-commit
    // Title edited in the H1 (the usual way a new page gets its name): follow
    // with the slug while it is still the auto-derived one — see maybeAutoRenameSlug.
    const titleAfter = storage.extractH1(newBody);
    if (titleAfter && titleAfter !== titleBefore) {
      void maybeAutoRenameSlug(docName, titleBefore, titleAfter, gitSync.authorFor(current.space));
    }
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[collab] failed to persist page ${docName}:`, err);
    return false;
  }
}

/**
 * A doc room's text never holds a carriage return. CodeMirror normalizes
 * "\r\n" to "\n" in every editor, so a "\r" in the Y.Text puts each editor's
 * positions out of step with the document from that character on: remote
 * edits land in the wrong place, and the editor's own consistency repair
 * (web/src/editor/collab-sync.ts) then rewrites the span — with two clients at
 * once, that doubled the page (review of 54d4e76). Every path that puts text
 * into a doc room goes through this.
 */
export function normalizeEol(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;
}

/**
 * Removes every "\r" a room already holds (a snapshot stored before
 * normalizeEol existed) — one character at a time, as ordinary deletes, never
 * a whole-text replace: a client reconnecting with the old characters merges
 * these like any concurrent edit (deleting the same character twice is a no-op).
 * A lone "\r" becomes "\n", the way an editor reads it.
 */
export function stripCarriageReturns(ytext: Y.Text): void {
  const text = ytext.toString();
  if (!text.includes('\r')) return;
  ytext.doc!.transact(() => {
    for (let i = text.length - 1; i >= 0; i--) {
      if (text[i] !== '\r') continue;
      ytext.delete(i, 1);
      if (text[i + 1] !== '\n') ytext.insert(i, '\n');
    }
  });
}

/** sha256 of a body as written to a page's file — ydoc_state.file_body_sha256. */
export function fileBodyHash(fileBody: string): string {
  return createHash('sha256').update(fileBody, 'utf8').digest('hex');
}

/**
 * Should the page's FILE replace a resumed room's text? Only when the file
 * changed after this room last wrote it — an external edit, a git pull/merge or
 * reset applied while the room was closed. A file that still hashes to the
 * marker stored with the snapshot is exactly what the room last wrote; if the
 * snapshot's text differs from it, the snapshot is the newer one (its file
 * write failed — persistDoc) and replacing it would throw away real typing.
 * No marker (a snapshot from before 06.10.2026): the file wins, as it always did.
 */
export function docFileWins(fileBody: string, marker: string | null | undefined): boolean {
  return !marker || fileBodyHash(normalizeEol(fileBody)) !== marker;
}

/** How many backups one page keeps, and for how long (page_text_backups). */
const BACKUPS_PER_PAGE = 50;
const BACKUP_RETENTION = '30 days';

/**
 * Keeps `body` — a room's whole text, right before the server replaces all of
 * it — in page_text_backups. Never throws: a failed backup is logged, and the
 * caller's own operation goes on as it did before backups existed. Empty text
 * is not kept (nothing to lose).
 */
export async function backupRoomText(pageId: string, reason: string, body: string): Promise<void> {
  if (!body.trim()) return;
  try {
    await query('INSERT INTO page_text_backups (page_id, reason, body) VALUES ($1, $2, $3)', [pageId, reason, body]);
    await query(
      `DELETE FROM page_text_backups
        WHERE page_id = $1
          AND (created_at < now() - $2::interval
               OR id NOT IN (SELECT id FROM page_text_backups WHERE page_id = $1 ORDER BY created_at DESC, id DESC LIMIT $3))`,
      [pageId, BACKUP_RETENTION, BACKUPS_PER_PAGE],
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[collab] failed to back up the text of page ${pageId} before "${reason}":`, err);
  }
}

/**
 * Loads a doc's persisted Yjs state (round: "THE DOUBLING" fix). Returns
 * undefined if this doc has never had a snapshot stored (pre-existing page
 * from before this migration, or a page that's never been opened live).
 */
export async function loadSnapshot(pageId: string): Promise<Uint8Array | undefined> {
  return (await loadSnapshotRow(pageId))?.snapshot;
}

/** loadSnapshot plus the snapshot's file marker (see docFileWins). */
export async function loadSnapshotRow(pageId: string): Promise<{ snapshot: Uint8Array; fileBodySha256: string | null } | undefined> {
  const row = await queryOne<{ snapshot: Buffer; file_body_sha256: string | null }>(
    'SELECT snapshot, file_body_sha256 FROM ydoc_state WHERE page_id = $1',
    [pageId],
  );
  return row ? { snapshot: new Uint8Array(row.snapshot), fileBodySha256: row.file_body_sha256 } : undefined;
}

/**
 * Persists a doc's full Yjs state. encodeStateAsUpdate() is already a
 * compact MERGED snapshot (not an ever-growing update log), so a plain
 * upsert here is enough — no GC/compaction machinery needed.
 */
export async function storeSnapshot(pageId: string, ydoc: Y.Doc, writtenFileBody?: string): Promise<void> {
  // yEngineFor, not the plain ESM `Y` import directly — see its doc comment up top.
  // Encoding via the WRONG copy's encodeStateAsUpdate silently produces bytes
  // inconsistent with the doc's actual internal structure.
  await upsertSnapshotRow(pageId, yEngineFor(ydoc).encodeStateAsUpdate(ydoc), writtenFileBody === undefined ? undefined : fileBodyHash(writtenFileBody));
}

/**
 * The one upsert every snapshot write goes through — storeSnapshot (a live room's own state) and storeClientSnapshot (a client's, below).
 * `fileMarker`: the hash of the body just written to the file alongside this snapshot; `undefined` keeps the row's current marker (the file did not change).
 */
async function upsertSnapshotRow(pageId: string, snapshot: Uint8Array, fileMarker?: string): Promise<void> {
  await query(
    `INSERT INTO ydoc_state (page_id, snapshot, updated_at, file_body_sha256) VALUES ($1, $2, now(), $3)
     ON CONFLICT (page_id) DO UPDATE SET snapshot = EXCLUDED.snapshot, updated_at = now(),
       file_body_sha256 = CASE WHEN $4 THEN EXCLUDED.file_body_sha256 ELSE ydoc_state.file_body_sha256 END`,
    [pageId, Buffer.from(snapshot), fileMarker ?? null, fileMarker !== undefined],
  );
}

// ---------------------------------------------------------------------------
// OFFLINE CREATION (29.09.2026) — a page made in the browser without a network
// arrives at POST /api/pages with its final id and the state of its local
// Y.Doc (`ydocState`). Everything below turns that state into (a) the initial
// file content and (b) the room's snapshot.
//
// Why the snapshot has to be the CLIENT'S bytes and not something the server
// re-encodes: THE DOUBLING (see bindState). After the create the browser
// connects its EXISTING doc to the room. If the room resumes from a snapshot
// made of these very bytes, both sides hold the SAME CRDT operations and the
// sync is a no-op. If the server instead seeded a fresh doc from the file, it
// would insert the text under a new client id, and the browser's copy would
// merge in as an unrelated second document: body + body.
// ---------------------------------------------------------------------------

/** What `createPage` needs, plus the bytes to store as the room's snapshot. */
export interface DecodedClientState {
  /** kind 'doc': the Y.Text('content') — the markdown body, no frontmatter. */
  docBody?: string;
  /** kind 'board' with at least one element: the scene rendered as an .excalidraw.svg. Absent for a blank board (the blank starter file is right for it). */
  boardSvg?: string;
  /** The client's own update, byte for byte — apply-able to a fresh doc and identical in CRDT history to the client's. */
  snapshot: Uint8Array;
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Decodes a client's `ydocState` (base64 of `Y.encodeStateAsUpdate(doc)`).
 * Anything that is not a complete, well-formed Yjs update is a 400 — never a
 * 500: this is untrusted input straight off the wire, and lib0's decoders
 * throw plain RangeErrors/Errors on garbage.
 *
 * The doc is built and read through `yEngineFor` like every other doc in this
 * file (see its doc comment — static Y.* calls must go through the copy that
 * constructed the doc). Only instance methods read it afterwards, which are
 * safe for either copy.
 */
export function decodeClientState(kind: PageKind, base64: string): DecodedClientState {
  // Buffer.from(_, 'base64') never fails — it silently skips characters it does not
  // understand — so garbage has to be rejected up front, before it decodes to
  // "something".
  if (!base64 || !BASE64_RE.test(base64) || base64.length % 4 === 1) throw badRequest('ydocState is not valid base64');
  const snapshot = new Uint8Array(Buffer.from(base64, 'base64'));

  const ydoc = new Y.Doc();
  try {
    try {
      yEngineFor(ydoc).applyUpdate(ydoc, snapshot);
    } catch {
      throw badRequest('ydocState is not a valid Yjs update');
    }
    // An update that refers to operations it does not contain (truncated, or a diff
    // against a state we do not have) is applied "as far as possible" and the rest
    // parked as pending. `Y.encodeStateAsUpdate(doc)` from a whole doc never leaves any.
    if (ydoc.store.pendingStructs || ydoc.store.pendingDs) throw badRequest('ydocState is an incomplete Yjs update');

    if (kind === 'doc') return { docBody: ydoc.getText('content').toString(), snapshot };
    if (kind === 'board') {
      let scene: ExcalidrawScene;
      try {
        scene = boardSceneFromYDoc(ydoc);
      } catch {
        throw badRequest('ydocState does not hold a board');
      }
      // No elements at all (tombstones count — they are elements the room keeps): a board
      // that was created and never drawn on. The blank starter file is the right file.
      return { boardSvg: scene.elements.length > 0 ? renderSceneSvg(scene) : undefined, snapshot };
    }
    return { snapshot };
  } finally {
    ydoc.destroy();
  }
}

/**
 * Stores the client's own bytes as page `pageId`'s room snapshot (the same
 * `ydoc_state` row storeSnapshot writes), so the room's first bindState
 * RESUMES from the client's CRDT history instead of seeding a new one.
 *
 * The page must already be indexed — `ydoc_state.page_id` references
 * `pages_index`. That fixes the order for POST /api/pages: create the file
 * FIRST, store the snapshot second. If this then fails (the caller logs and
 * carries on), the page and its content are still correct — the room simply
 * seeds from the file, as any never-opened page's does. The one thing lost is
 * the CRDT continuity: a client reconnecting with its old local doc would
 * merge as a second copy (the doubling) — a rare, recoverable degradation, and
 * strictly better than failing a create the file already satisfied.
 */
export async function storeClientSnapshot(pageId: string, snapshot: Uint8Array): Promise<void> {
  await upsertSnapshotRow(pageId, snapshot);
}

// ===========================================================================
// Round 26 (DATA TABLES) — structured Y.Doc for `<slug>.table.md` pages.
// See docs/spec-tables.md §6 (normative) for everything below.
//
// A `doc`-kind page's whole CRDT is one `Y.Text('content')`. A `table`-kind
// page can't be: a table is a keyed, ordered, typed structure, and collapsing
// it into one text blob would make every concurrent scenario in spec §6.1
// resolve as "last full-file write wins". So a table room gets SIX root types
// instead of one, exactly as the spec's diagram lays them out:
//
//   meta:    Y.Map                  { id, version, rowIds, seeded }
//   head:    Y.Text                 prose above the table (incl. the H1)
//   tail:    Y.Text                 prose below the table
//   columns: Y.Array<Y.Map>         { id, name, type, …, options: Y.Array<Y.Map> }
//   rows:    Y.Array<Y.Map>         { id, <colId>: scalar | Y.Text (longtext) }
//   views:   Y.Array<Y.Map>         { id, name, columns, sort, filter, … }
//
// WHY Y.Array<Y.Map> rather than a Y.Map keyed by id, for all three
// collections — the brief left this open, the spec's own diagram picks
// arrays, and there is a real reason to agree with it:
//   * Row ORDER is data (spec §2.2 rule 5: file order == default view order;
//     §6.1: "The order of rows is a Y.Array, not a sort field"). A
//     Y.Map<id, row> would have to carry order in a side channel — a separate
//     `order` array or a fractional index per row — and every concurrent
//     insert would then be a concurrent write to THAT, which is strictly
//     worse than letting Yjs's own sequence CRDT resolve it. Column order and
//     view (tab) order have the same property.
//   * Reconciliation-by-key does not actually need a keyed container: the key
//     lives INSIDE each element (`id`), so an O(n) index built at the top of
//     the reconcile pass gives the same by-key matching, while leaving order
//     to be applied separately as a permutation (see reorderByKey).
// The rule that matters is therefore not "which container" but "never address
// an element by position" — every function below looks elements up through an
// id index, and the ONE place that touches positions (reorderByKey) computes
// a minimal permutation instead of rewriting the array.
//
// WHY head/tail are Y.Text and cells are mostly plain values: prose and
// `longtext` cells are where two people genuinely type into the same string
// at the same time, and spec §6.1 requires character-level merging there. A
// scalar cell (number, date, select label, checkbox) has no meaningful
// character-level merge — the spec's own outcome for it is "last writer by
// CRDT order wins", which is exactly what a plain Y.Map value already does.
// View config (`columns`/`sort`/`filter`) is stored as plain JSON inside its
// view's Y.Map for the same reason: spec §6.1's outcome for two people
// editing one view is "last one wins", which is what that gets us.
// ===========================================================================

/** Transaction origin for edits this server makes on a table's behalf (REST/MCP writes). */
export const TABLE_EDIT_ORIGIN = 'folio:table:edit';
/**
 * Transaction origin for the server's own seed/reconcile passes. Clients
 * scope their Y.UndoManager to their OWN origin (spec §6 rule 7), so tagging
 * these separately keeps "the file changed while you were away" out of every
 * collaborator's undo stack.
 */
export const TABLE_SEED_ORIGIN = 'folio:table:seed';

/** Marker inside `meta` recording that this Y.Doc was really populated from a file/snapshot. */
const TABLE_SEEDED_KEY = 'seeded';

type TableOption = NonNullable<TableColumn['options']>[number];
type YMapAny = Y.Map<unknown>;

/**
 * The one mutation shape the whole round speaks, mirroring
 * `web/src/tables/types.ts`'s `TablePatch` field-for-field (TABLES-UI owns
 * that declaration; it is the client's, and a web module cannot be imported
 * from the server). Structurally identical on purpose, so a patch built by
 * the grid and a patch built by a REST handler are the same value.
 *
 * DUPLICATION, FLAGGED: two copies of this union exist. The right long-term
 * home is `shared/tables/` (TABLES-CORE's zone, off-limits this round) —
 * moving it there is a mechanical follow-up that would delete both copies.
 */
export type TablePatch =
  | { kind: 'rows:create'; at: number; rows: TableRow[] }
  | { kind: 'rows:update'; rows: { id: string; values: Record<string, TableCellValue> }[] }
  | { kind: 'rows:delete'; ids: string[] }
  | { kind: 'rows:move'; id: string; to: number }
  | { kind: 'columns:create'; at: number; column: TableColumn }
  | { kind: 'columns:update'; id: string; patch: Partial<TableColumn> }
  | { kind: 'columns:delete'; id: string }
  | { kind: 'views:create'; view: TableView }
  | { kind: 'views:update'; id: string; patch: Partial<TableView> }
  | { kind: 'views:delete'; id: string };

/**
 * The REST/MCP write path's patch shape, mirroring `TableDocPatch` in
 * server/tables/service.ts (SERVER-TABLES owns that declaration; importing it
 * here would make collab.ts <-> service.ts a require cycle, since service.ts
 * imports this module). Structurally identical on purpose.
 *
 * Two patch vocabularies genuinely exist and both are legitimate: the grid
 * speaks in positional, single-row operations (it has a cursor and a
 * selection), while REST speaks in id sets (it has a request body). Rather
 * than force one caller to translate into the other's idiom — which is where
 * "the grid deleted the wrong rows" bugs come from — editTableDoc accepts
 * both and applies each natively over the same Y.Doc.
 *
 * DUPLICATION, FLAGGED: as with TablePatch above, the right long-term home
 * for both unions is `shared/tables/` (TABLES-CORE's zone, off-limits this
 * round).
 */
export type TableDocPatch =
  | { type: 'insertRows'; rows: TableRow[] }
  | { type: 'replaceRows'; rows: TableRow[] }
  | { type: 'updateRows'; rowIds: string[]; values: Record<string, TableCellValue> }
  | { type: 'deleteRows'; rowIds: string[] }
  | { type: 'addColumn'; column: TableColumn }
  | { type: 'updateColumn'; columnId: string; column: Partial<Omit<TableColumn, 'id'>>; rowValues?: Record<string, TableCellValue> }
  | { type: 'deleteColumn'; columnId: string }
  | { type: 'addView'; view: TableView }
  | { type: 'updateView'; viewId: string; view: Partial<Omit<TableView, 'id'>> }
  | { type: 'deleteView'; viewId: string }
  // `head`/`tail` optional: absent = "leave the prose alone" (YAML import),
  // present = replace it (restore-to-sha). Kept in sync by hand with
  // server/tables/service.ts's canonical copy — see this type's doc comment.
  | { type: 'replaceAll'; columns: TableColumn[]; views: TableView[]; rows: TableRow[]; head?: string; tail?: string };

/** Either patch vocabulary — see TableDocPatch's comment for why there are two. */
export type TableEditPatch = TablePatch | TableDocPatch;

/** Narrows a page index entry to a table page, so the branches below read as branches, not casts. */
type TableEntry = storage.PageIndexEntry & { kind: 'table' };
function isTableEntry(entry: storage.PageIndexEntry | undefined): entry is TableEntry {
  return entry !== undefined && entry.kind === 'table';
}

// ---------------------------------------------------------------------------
// Y-type guards that survive the ESM/CJS split
//
// `v instanceof Y.Text` answers "was this built by the ESM copy of Yjs" — for
// a production doc (always WSSharedDoc, i.e. CJS) that is FALSE for every
// nested type it holds. Same dual-instance hazard yEngineFor exists for, one
// level down. Checking BOTH copies is the whole fix.
// ---------------------------------------------------------------------------

function isYText(v: unknown): v is Y.Text {
  return v instanceof Y.Text || v instanceof YCjs.Text;
}
function isYMap(v: unknown): v is YMapAny {
  return v instanceof Y.Map || v instanceof YCjs.Map;
}
function isYArray(v: unknown): v is Y.Array<unknown> {
  return v instanceof Y.Array || v instanceof YCjs.Array;
}

export interface TableRoots {
  meta: YMapAny;
  head: Y.Text;
  tail: Y.Text;
  columns: Y.Array<YMapAny>;
  rows: Y.Array<YMapAny>;
  views: Y.Array<YMapAny>;
}

/** The six root types of a table room. Instance methods only — safe for either Yjs copy. */
export function tableRoots(ydoc: Y.Doc): TableRoots {
  return {
    meta: ydoc.getMap<unknown>('meta'),
    head: ydoc.getText('head'),
    tail: ydoc.getText('tail'),
    columns: ydoc.getArray<YMapAny>('columns'),
    rows: ydoc.getArray<YMapAny>('rows'),
    views: ydoc.getArray<YMapAny>('views'),
  };
}

/** True once seedTableYDoc/reconcileTableYDoc has actually run against this doc. */
export function isTableYDocSeeded(ydoc: Y.Doc): boolean {
  return tableRoots(ydoc).meta.get(TABLE_SEEDED_KEY) === true;
}

/** True when nothing has ever been written into this doc's table roots. */
function tableYDocIsBlank(roots: TableRoots): boolean {
  return (
    roots.meta.size === 0 &&
    roots.head.length === 0 &&
    roots.tail.length === 0 &&
    roots.columns.length === 0 &&
    roots.rows.length === 0 &&
    roots.views.length === 0
  );
}

// ---------------------------------------------------------------------------
// Builders (plain value -> Y types). EVERY constructor goes through the `E`
// engine handed in by yEngineFor — see yEngineFor's doc comment. A Y.Map built
// by the wrong copy and inserted into a doc built by the other one is the
// silent-corruption case that comment describes, one level down.
// ---------------------------------------------------------------------------

function newText(E: typeof Y, value: string): Y.Text {
  const t = new E.Text();
  if (value) t.insert(0, value);
  return t;
}

function buildOptionMap(E: typeof Y, opt: TableOption): YMapAny {
  const m = new E.Map<unknown>();
  m.set('value', opt.value);
  m.set('color', opt.color);
  if (opt.description !== undefined) m.set('description', opt.description);
  return m;
}

function buildColumnMap(E: typeof Y, col: TableColumn): YMapAny {
  const m = new E.Map<unknown>();
  m.set('id', col.id);
  applyColumnFields(E, m, col);
  return m;
}

/** Optional column fields, written only when present so `toJSON()` doesn't grow `undefined`s. */
const COLUMN_SCALAR_FIELDS = ['name', 'type', 'description', 'width', 'align', 'multiple', 'allowCreate', 'precision', 'time', 'default'] as const;

function applyColumnFields(E: typeof Y, m: YMapAny, patch: Partial<TableColumn>): void {
  for (const key of COLUMN_SCALAR_FIELDS) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value === undefined) m.delete(key);
    else if (m.get(key) !== value) m.set(key, value);
  }
  if ('options' in patch) {
    if (patch.options === undefined) m.delete('options');
    else {
      const arr = new E.Array<YMapAny>();
      arr.push(patch.options.map((o) => buildOptionMap(E, o)));
      m.set('options', arr);
    }
  }
}

function cellToY(E: typeof Y, col: TableColumn, value: TableCellValue): unknown {
  if (col.type === 'longtext') return newText(E, value == null ? '' : String(value));
  return value ?? null;
}

function buildRowMap(E: typeof Y, columns: readonly TableColumn[], row: TableRow): YMapAny {
  const m = new E.Map<unknown>();
  m.set('id', row.id);
  for (const col of columns) m.set(col.id, cellToY(E, col, row.values[col.id] ?? null));
  return m;
}

const VIEW_FIELDS = ['name', 'icon', 'columns', 'sort', 'filter', 'frozen', 'rowHeight'] as const;

function buildViewMap(E: typeof Y, view: TableView): YMapAny {
  const m = new E.Map<unknown>();
  m.set('id', view.id);
  applyViewFields(m, view);
  return m;
}

function applyViewFields(m: YMapAny, patch: Partial<TableView>): void {
  for (const key of VIEW_FIELDS) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value === undefined) m.delete(key);
    // Plain JSON for the nested config objects — spec §6.1's outcome for two
    // people editing one view is "last one wins", which is what this gives.
    else if (!deepEquals(m.get(key), value)) m.set(key, structuredClone(value));
  }
}

// ---------------------------------------------------------------------------
// Readers (Y types -> plain values)
// ---------------------------------------------------------------------------

function plainOf(v: unknown): unknown {
  if (isYText(v)) return v.toString();
  if (isYMap(v) || isYArray(v)) return (v as { toJSON: () => unknown }).toJSON();
  return v;
}

function columnFromY(m: YMapAny): TableColumn {
  const raw: Record<string, unknown> = {};
  for (const [k, v] of m.entries()) raw[k] = plainOf(v);
  const parsed = tableColumnSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`table Y.Doc holds an invalid column ${JSON.stringify(raw.id)}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}

function viewFromY(m: YMapAny): TableView {
  const raw: Record<string, unknown> = {};
  for (const [k, v] of m.entries()) raw[k] = plainOf(v);
  const parsed = tableViewSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`table Y.Doc holds an invalid view ${JSON.stringify(raw.id)}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}

function cellFromY(col: TableColumn, raw: unknown): TableCellValue {
  if (isYText(raw)) {
    const s = raw.toString();
    return s === '' ? null : s;
  }
  if (raw === undefined) return null;
  return raw as TableCellValue;
}

/**
 * One row, projected through the CURRENT column set. Keys in the Y.Map that
 * no column claims are simply not read — that is the whole mechanism behind
 * spec §6.1's "one person deletes a column, another writes into its cell": the orphaned
 * value stays in the CRDT (so undoing the column deletion brings it back) and
 * is dropped at serialization, never written to the file.
 */
function rowFromY(m: YMapAny, columns: readonly TableColumn[]): TableRow {
  const values: Record<string, TableCellValue> = {};
  for (const col of columns) values[col.id] = cellFromY(col, m.get(col.id));
  return { id: String(m.get('id') ?? ''), values };
}

/**
 * The live Y.Doc as a `TableDoc` — the exact value that gets handed to
 * serializeTableFile, returned from getLiveTable, and sent to REST callers.
 * Throws if the doc holds a structurally invalid column/view: writing a
 * half-understood schema to the file is precisely the silent-data-destruction
 * mode shared/tables/codec.ts refuses on the way in, so this refuses it on
 * the way out too. Callers catch (see persistTableDoc's seatbelt).
 */
export function tableDocFromYDoc(ydoc: Y.Doc): TableDoc {
  const r = tableRoots(ydoc);
  const columns = r.columns.toArray().map(columnFromY);
  const columnIds = new Set(columns.map((c) => c.id));
  const rowIds = r.meta.get('rowIds');
  return {
    meta: {
      id: String(r.meta.get('id') ?? ''),
      version: 1,
      rowIds: rowIds === 'none' ? 'none' : 'column',
    },
    head: r.head.toString(),
    tail: r.tail.toString(),
    columns,
    views: r.views.toArray().map((m) => pruneDanglingColumnRefs(viewFromY(m), columnIds)),
    rows: r.rows.toArray().map((m) => rowFromY(m, columns)),
  };
}

/**
 * Drops a view's references to columns that no longer exist. The same rule
 * rowFromY applies to cell values, one level up: when one user deletes a
 * column while another has it hidden/sorted/filtered in their view, the
 * reference stays in the CRDT (so undoing the deletion restores the view
 * exactly) but is never SERIALIZED — a `sort:` or `filter:` entry naming a
 * column the schema doesn't have would make the file's own frontmatter
 * self-inconsistent, and every reader of it would have to guess.
 */
function pruneDanglingColumnRefs(view: TableView, columnIds: ReadonlySet<string>): TableView {
  const hidden = view.columns.hidden.filter((id) => columnIds.has(id));
  const order = view.columns.order.filter((id) => columnIds.has(id));
  const width = Object.fromEntries(Object.entries(view.columns.width).filter(([id]) => columnIds.has(id)));
  const sort = view.sort.filter((s) => columnIds.has(s.column));
  const rules = view.filter.rules.filter((rule) => columnIds.has(rule.column));
  const unchanged =
    hidden.length === view.columns.hidden.length &&
    order.length === view.columns.order.length &&
    Object.keys(width).length === Object.keys(view.columns.width).length &&
    sort.length === view.sort.length &&
    rules.length === view.filter.rules.length;
  if (unchanged) return view;
  return { ...view, columns: { hidden, order, width }, sort, filter: { ...view.filter, rules } };
}

// ---------------------------------------------------------------------------
// Small value helpers
// ---------------------------------------------------------------------------

function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEquals(x, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEquals((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

/**
 * Rewrites `t` to `next` touching only the part that actually differs
 * (common prefix/suffix trimmed off). Matters for two reasons: an unchanged
 * head/tail produces ZERO CRDT ops (no spurious remote update, no phantom
 * undo entry), and a one-word change to a paragraph doesn't blow away every
 * collaborator's cursor inside it the way a whole-text replace would.
 */
function setYText(t: Y.Text, next: string): void {
  const cur = t.toString();
  if (cur === next) return;
  const max = Math.min(cur.length, next.length);
  let prefix = 0;
  while (prefix < max && cur[prefix] === next[prefix]) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && cur[cur.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
  const removed = cur.length - prefix - suffix;
  const inserted = next.slice(prefix, next.length - suffix);
  if (removed > 0) t.delete(prefix, removed);
  if (inserted) t.insert(prefix, inserted);
}

/** Deep copy of a Y.Map into a fresh, unintegrated one built by `E` — a Y type can only be integrated once. */
function cloneYMap(E: typeof Y, m: YMapAny): YMapAny {
  const out = new E.Map<unknown>();
  for (const [k, v] of m.entries()) out.set(k, cloneYValue(E, v));
  return out;
}

function cloneYValue(E: typeof Y, v: unknown): unknown {
  if (isYText(v)) return newText(E, v.toString());
  if (isYMap(v)) return cloneYMap(E, v);
  if (isYArray(v)) {
    const arr = new E.Array<unknown>();
    arr.push(v.toArray().map((x) => cloneYValue(E, x)));
    return arr;
  }
  return v;
}

// ---------------------------------------------------------------------------
// Reconciliation "file vs snapshot", BY KEY (spec §6 rule 4, normative)
//
// bindState can find two disagreeing versions of the same table: the Yjs
// snapshot in `ydoc_state` (what the last live session left behind) and the
// file on disk (which a `git pull`, an external editor, or another process
// may have rewritten while nothing was live). THE FILE WINS — but *how* it
// wins is the entire risk of this round:
//
//   * Matching is by `id` — rows by row id, columns by column id, views by
//     view id — NEVER by array position. Matching by position means a single
//     row inserted at the top of the file re-attributes every subsequent
//     row's content to the wrong row, which reads to every connected client
//     as "everyone's data shifted by one".
//   * Only genuinely-differing values are written. An unchanged row emits
//     ZERO Yjs operations, so a collaborator watching it sees nothing — this
//     is why reconcileRowMap compares before it sets.
//   * ORDER is applied afterwards as a minimal PERMUTATION (reorderByKey),
//     never as "clear the array and reinsert in file order". The naive
//     version destroys the CRDT identity of every row, including rows nobody
//     moved, discarding any concurrent edit that was mid-flight on them.
// ---------------------------------------------------------------------------

/**
 * Ids that should keep their current slot: a longest increasing subsequence
 * of `current` ordered by each id's position in `target`. Everything else is
 * the minimal set that has to move. O(n log n) — a naive LCS is O(n·m), which
 * at the spec's 20 000-row hard limit is 4·10^8 cell updates inside a
 * blocking transaction.
 */
function stableKeepSet(current: readonly string[], target: readonly string[]): Set<string> {
  const targetPos = new Map<string, number>();
  target.forEach((id, i) => targetPos.set(id, i));

  const positions: number[] = [];
  const ids: string[] = [];
  for (const id of current) {
    const p = targetPos.get(id);
    if (p === undefined) continue; // not in target: it gets deleted, never "kept"
    positions.push(p);
    ids.push(id);
  }

  const tails: number[] = []; // indices into `positions`
  const prev = new Array<number>(positions.length).fill(-1);
  for (let i = 0; i < positions.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (positions[tails[mid]] < positions[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    if (lo === tails.length) tails.push(i);
    else tails[lo] = i;
  }

  const keep = new Set<string>();
  let k = tails.length > 0 ? tails[tails.length - 1] : -1;
  while (k !== -1) {
    keep.add(ids[k]);
    k = prev[k];
  }
  return keep;
}

/** Element id of an array member, as stored in its own Y.Map. */
function idOf(m: YMapAny): string {
  return String(m.get('id') ?? '');
}

/**
 * Permutes `arr` into `targetIds` order by moving as few elements as
 * possible. Yjs 13 has no Y.Array move operation, so a moved element must be
 * deleted and reinserted as a fresh clone — which costs it its CRDT identity.
 * That cost is why this computes the minimal move set instead of reordering
 * everything: rows nobody moved are never touched at all, and keep every
 * in-flight concurrent edit. (KNOWN LIMITATION, flagged: a row that DID move
 * loses concurrent character-level edits to its `longtext` cells made in the
 * same instant. Only reachable via an external file reorder during a live
 * session; a real Y.Array move op would remove it entirely.)
 */
function reorderByKey(E: typeof Y, arr: Y.Array<YMapAny>, targetIds: readonly string[]): void {
  const current = arr.toArray().map(idOf);
  if (current.length === targetIds.length && current.every((id, i) => id === targetIds[i])) return;

  const keep = stableKeepSet(current, targetIds);

  // Clone the movers BEFORE deleting them — a deleted Y.Map reads back empty.
  const movers = new Map<string, YMapAny>();
  for (let i = 0; i < arr.length; i++) {
    const m = arr.get(i);
    const id = idOf(m);
    if (!keep.has(id)) movers.set(id, cloneYMap(E, m));
  }
  for (let i = arr.length - 1; i >= 0; i--) {
    if (!keep.has(idOf(arr.get(i)))) arr.delete(i, 1);
  }

  let cursor = 0;
  for (const id of targetIds) {
    if (keep.has(id)) {
      cursor++;
      continue;
    }
    const m = movers.get(id);
    if (m) {
      arr.insert(cursor, [m]);
      cursor++;
    }
  }
}

/**
 * By-key upsert of one collection: delete elements the file no longer has,
 * merge the ones it still has IN PLACE, append the new ones. Order is left
 * alone here on purpose — reorderByKey applies it afterwards as a permutation.
 */
function upsertByKey<T>(
  arr: Y.Array<YMapAny>,
  items: readonly T[],
  keyOf: (item: T) => string,
  build: (item: T) => YMapAny,
  merge: (m: YMapAny, item: T) => void,
): void {
  const wanted = new Map<string, T>();
  for (const item of items) wanted.set(keyOf(item), item);

  for (let i = arr.length - 1; i >= 0; i--) {
    if (!wanted.has(idOf(arr.get(i)))) arr.delete(i, 1);
  }

  const present = new Set<string>();
  for (let i = 0; i < arr.length; i++) {
    const m = arr.get(i);
    const item = wanted.get(idOf(m));
    if (item !== undefined) {
      merge(m, item);
      present.add(idOf(m));
    }
  }

  for (const item of items) {
    if (!present.has(keyOf(item))) arr.push([build(item)]);
  }
}

/** In-place cell merge. Compares before writing so an unchanged row emits no operations at all. */
function reconcileRowMap(E: typeof Y, m: YMapAny, columns: readonly TableColumn[], row: TableRow): void {
  for (const col of columns) {
    const want = row.values[col.id] ?? null;
    const cur = m.get(col.id);
    if (col.type === 'longtext') {
      const wantText = want == null ? '' : String(want);
      if (isYText(cur)) setYText(cur, wantText);
      else m.set(col.id, newText(E, wantText));
      continue;
    }
    // A Y.Text left over from a type change back out of longtext still reads
    // as a plain string through cellFromY, so compare against that.
    const curPlain = isYText(cur) ? cur.toString() : cur;
    if (cur === undefined || !deepEquals(curPlain, want)) m.set(col.id, want);
  }
  // Orphaned keys (columns that no longer exist) are deliberately left alone — spec §6.1.
}

function reconcileColumnMap(E: typeof Y, m: YMapAny, col: TableColumn): void {
  // Pass the full column so absent optional fields are explicitly removed
  // rather than lingering from an older revision of the schema.
  const full: Partial<TableColumn> = { options: undefined };
  for (const key of COLUMN_SCALAR_FIELDS) (full as Record<string, unknown>)[key] = col[key];
  if (col.options !== undefined) full.options = col.options;
  const currentOptions = m.get('options');
  const currentPlain = isYArray(currentOptions) ? currentOptions.toJSON() : undefined;
  if (deepEquals(currentPlain, col.options)) delete full.options; // unchanged: don't rebuild the Y.Array
  applyColumnFields(E, m, full);
}

function reconcileViewMap(m: YMapAny, view: TableView): void {
  applyViewFields(m, view);
}

/** Wholesale population of a blank Y.Doc from a parsed file. Only ever runs when tableYDocIsBlank. */
export function seedTableYDoc(ydoc: Y.Doc, file: TableDoc): void {
  const E = yEngineFor(ydoc);
  const r = tableRoots(ydoc);
  r.meta.set('id', file.meta.id);
  r.meta.set('version', file.meta.version);
  r.meta.set('rowIds', file.meta.rowIds);
  if (file.head) r.head.insert(0, file.head);
  if (file.tail) r.tail.insert(0, file.tail);
  r.columns.push(file.columns.map((c) => buildColumnMap(E, c)));
  r.rows.push(file.rows.map((row) => buildRowMap(E, file.columns, row)));
  r.views.push(file.views.map((v) => buildViewMap(E, v)));
}

/** "File vs snapshot" reconciliation — see the section comment above. The file wins, by key. */
export function reconcileTableYDoc(ydoc: Y.Doc, file: TableDoc): void {
  const E = yEngineFor(ydoc);
  const r = tableRoots(ydoc);

  if (r.meta.get('id') !== file.meta.id) r.meta.set('id', file.meta.id);
  if (r.meta.get('version') !== file.meta.version) r.meta.set('version', file.meta.version);
  if (r.meta.get('rowIds') !== file.meta.rowIds) r.meta.set('rowIds', file.meta.rowIds);

  setYText(r.head, file.head);
  setYText(r.tail, file.tail);

  upsertByKey(r.columns, file.columns, (c) => c.id, (c) => buildColumnMap(E, c), (m, c) => reconcileColumnMap(E, m, c));
  reorderByKey(E, r.columns, file.columns.map((c) => c.id));

  // Rows are reconciled against the FILE's columns, which the pass above has
  // just made authoritative — so a column the file dropped is already gone
  // from `columns` and its per-row values are already orphans by this point.
  upsertByKey(r.rows, file.rows, (row) => row.id, (row) => buildRowMap(E, file.columns, row), (m, row) => reconcileRowMap(E, m, file.columns, row));
  reorderByKey(E, r.rows, file.rows.map((row) => row.id));

  upsertByKey(r.views, file.views, (v) => v.id, (v) => buildViewMap(E, v), (m, v) => reconcileViewMap(m, v));
  reorderByKey(E, r.views, file.views.map((v) => v.id));
}

// ---------------------------------------------------------------------------
// File IO for table pages
//
// The FILE write goes through storage.writeTableDoc — the same function
// server/tables/service.ts uses when no room is open — so the live path and
// the direct path can never serialize or reindex a table differently. What
// stays here is the READ side, because bindState needs the non-throwing form:
// storage.readFreshTableDoc throws on a structurally invalid file (correct for
// its callers, which are about to render or mutate), whereas an unparseable
// file is something bindState has to survive and refuse to overwrite.
// ---------------------------------------------------------------------------

/** The file's current content, and its parse — `undefined` for unreadable or invalid. */
async function readTableFileState(entry: TableEntry): Promise<{ raw?: string; doc?: TableDoc; error?: string }> {
  let raw: string;
  try {
    raw = await fs.readFile(entry.absPath, 'utf8');
  } catch (err) {
    return { error: `unreadable file (${String(err)})` };
  }
  const parsed = parseTableFile(raw);
  if (isTableParseError(parsed)) return { raw, error: parsed.message };
  return { raw, doc: parsed };
}

/**
 * serializeTableFile writes `${head}<!-- folio:table:begin -->`, relying on
 * parseTableFile's own invariant that `head` is either empty or ends with a
 * newline. A collaborator who deletes the last newline of the prose above the
 * table would otherwise glue the marker onto their sentence — and the marker
 * line no longer being a marker line means the NEXT parse fails and the whole
 * table opens as a raw file. One character of normalization closes that.
 */
function withSerializableProse(doc: TableDoc): TableDoc {
  if (doc.head === '' || doc.head.endsWith('\n')) return doc;
  return { ...doc, head: `${doc.head}\n` };
}

// ---------------------------------------------------------------------------
// The table write path + its seatbelt
// ---------------------------------------------------------------------------

/**
 * The table-kind analogue of persistDoc's round-8 seatbelt — and deliberately
 * NOT the same test. The doc-kind guard is "is the new body shorter than the
 * file"; spec §6 asks for something stronger than a string-length heuristic
 * for tables, because a table's catastrophic failure mode is structural, not
 * short: a Y.Doc that lost its rows array but kept a long `head` is not
 * "shorter", and a legitimate bulk row delete IS.
 *
 * The signal that actually separates them is whether this Y.Doc was ever
 * populated with the real thing:
 *
 *  (a) NO in-CRDT `seeded` marker — this doc never went through a completed
 *      seed/reconcile, so whatever it holds is not authoritative. Refused
 *      unconditionally. This is the "server restarted mid-sync and an empty
 *      Y.Doc got treated as the truth" case, and it is refused whether the
 *      row count went down, up, or nowhere.
 *  (b) The doc's `meta.id` disagrees with the file's — this is not that
 *      file's document at all.
 *  (c) The doc fails schema validation — writing a half-understood schema is
 *      the same class of silent destruction the codec refuses on read.
 *  (d) The process-level seed flag is false (isDocSeeded — the cold-doc race
 *      of round 8) AND the doc has strictly fewer rows or columns than the
 *      file. A user can only delete rows they were shown, which requires a
 *      completed seed, so a legitimate delete never reaches this branch.
 *  (e) BOTH rows and columns are empty while the file has both. No single
 *      user action produces that: deleting every row keeps the schema,
 *      deleting every column keeps the rows. It is only ever the signature of
 *      a blank/partial doc, so it is refused even for a seeded doc.
 *
 * Returns the refusal reason, or undefined to allow the write.
 */
function tableWriteRefusal(docName: string, ydoc: Y.Doc, doc: TableDoc | undefined, file: TableDoc | undefined): string | undefined {
  if (!isTableYDocSeeded(ydoc)) {
    return 'this Y.Doc carries no `seeded` marker — it was never populated from the file or a snapshot';
  }
  if (!doc) return 'the Y.Doc does not hold a structurally valid table';
  if (file) {
    if (doc.meta.id !== file.meta.id) {
      return `the Y.Doc's table id (${doc.meta.id || '<empty>'}) does not match the file's (${file.meta.id})`;
    }
    if (!isDocSeeded(docName) && (doc.rows.length < file.rows.length || doc.columns.length < file.columns.length)) {
      return (
        `the Y.Doc has ${doc.rows.length} row(s)/${doc.columns.length} column(s) against the file's ` +
        `${file.rows.length}/${file.columns.length}, and this doc was never confirmed fully seeded`
      );
    }
    if (doc.rows.length === 0 && doc.columns.length === 0 && (file.rows.length > 0 || file.columns.length > 0)) {
      return 'the Y.Doc has no rows AND no columns while the file has both — the signature of a blank/partial doc, not of any single user action';
    }
  }
  return undefined;
}

/**
 * A sync merge left git conflict markers in the file (same test as
 * git.listConflictedFiles). A doc room carries them as ordinary text, but a
 * table or board room cannot hold them at all: writing the room out would
 * silently resolve the conflict in the room's favour and drop the remote side.
 * Such a file waits for "Take the version from Git" (or a fix in git) instead.
 */
const GIT_CONFLICT_MARKER_RE = /^(<<<<<<<|>>>>>>>) /m;

/** Table-kind branch of persistDoc: structured Y.Doc -> TableDoc -> storage.writeTableDoc. */
async function persistTableDoc(docName: string, ydoc: Y.Doc, entry: TableEntry): Promise<void> {
  const { raw, doc: file } = await readTableFileState(entry);
  if (raw !== undefined && GIT_CONFLICT_MARKER_RE.test(raw)) {
    // eslint-disable-next-line no-console
    console.error(`[collab] refusing to persist table ${docName}: its file has unresolved git conflict markers.`);
    return;
  }

  let doc: TableDoc | undefined;
  let materializeError: unknown;
  try {
    doc = withSerializableProse(tableDocFromYDoc(ydoc));
  } catch (err) {
    materializeError = err;
  }

  const refusal = tableWriteRefusal(docName, ydoc, doc, file);
  if (refusal || !doc) {
    // eslint-disable-next-line no-console
    console.error(
      `[collab] TABLE SEATBELT: refusing to persist table ${docName} — ${refusal ?? 'unknown reason'}.` +
        (materializeError ? ` (${String(materializeError)})` : '') +
        ' Refusing the write rather than replacing real data with a doc that cannot be trusted.',
    );
    return;
  }

  if (isOverHardRowLimit(doc.rows.length)) {
    // eslint-disable-next-line no-console
    console.warn(`[collab] table ${docName} has ${doc.rows.length} rows, over the hard limit (spec §13).`);
  }

  // Skip an identical write: a debounce window that produced no net change to
  // the file (e.g. only orphaned-key writes) shouldn't bump the mtime or arm
  // the auto-commit timer. The snapshot still gets stored — the CRDT moved
  // even when its serialization didn't.
  const changed = serializeTableFile(doc) !== raw;
  // File first, snapshot second — same ordering rationale as persistDoc's.
  if (changed) await storage.writeTableDoc(docName, doc);
  await storeSnapshot(docName, ydoc);
  if (changed) gitSync.noteActivity(entry.space);
}

/** Table-kind branch of bindState: restore the snapshot, then let the FILE win, by key. */
async function bindTableState(docName: string, ydoc: Y.Doc, entry: TableEntry): Promise<void> {
  const snapshot = await loadSnapshot(docName).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[collab] failed to load snapshot for table ${docName}:`, err);
    return undefined;
  });
  // yEngineFor, not the plain ESM `Y` import — see its doc comment up top.
  if (snapshot) yEngineFor(ydoc).applyUpdate(ydoc, snapshot);

  const { doc: parsed, error } = await readTableFileState(entry);
  if (!parsed) {
    // Spec §1: a `.table.md` with broken frontmatter opens in "raw file" mode
    // with a warning — it must NEVER be silently reinterpreted. Leaving the
    // doc unmarked means tableWriteRefusal (a) refuses every subsequent
    // write, so a file we could not read can never be overwritten by a doc we
    // half-understand.
    // eslint-disable-next-line no-console
    console.error(
      `[collab] table ${docName} could not be parsed (${error ?? 'unknown error'}) — ` +
        'leaving the Y.Doc unseeded; the write seatbelt will refuse to overwrite it.',
    );
    return;
  }

  const roots = tableRoots(ydoc);
  const blank = tableYDocIsBlank(roots);
  ydoc.transact(() => {
    // Wholesale seeding ONLY into a genuinely blank doc — running it on top of
    // a restored snapshot is THE DOUBLING, one structure level up.
    if (blank) seedTableYDoc(ydoc, parsed);
    else reconcileTableYDoc(ydoc, parsed);
    roots.meta.set(TABLE_SEEDED_KEY, true);
  }, TABLE_SEED_ORIGIN);

  await storeSnapshot(docName, ydoc).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[collab] failed to store snapshot for table ${docName}:`, err);
  });
}

// ---------------------------------------------------------------------------
// Patch application — the write API SERVER-TABLES calls
// ---------------------------------------------------------------------------

function findIndexById(arr: Y.Array<YMapAny>, id: string): number {
  for (let i = 0; i < arr.length; i++) if (idOf(arr.get(i)) === id) return i;
  return -1;
}

function applyTablePatch(E: typeof Y, ydoc: Y.Doc, patch: TablePatch): void {
  const r = tableRoots(ydoc);
  const columns = () => r.columns.toArray().map(columnFromY);

  switch (patch.kind) {
    case 'rows:create': {
      const cols = columns();
      const at = Math.max(0, Math.min(patch.at, r.rows.length));
      r.rows.insert(at, patch.rows.map((row) => buildRowMap(E, cols, row)));
      return;
    }
    case 'rows:update': {
      const cols = columns();
      const byId = new Map(cols.map((c) => [c.id, c]));
      for (const update of patch.rows) {
        const i = findIndexById(r.rows, update.id);
        if (i === -1) continue; // row deleted concurrently: the edit dissolves (spec §6.1)
        const m = r.rows.get(i);
        for (const [colId, value] of Object.entries(update.values)) {
          const col = byId.get(colId);
          if (!col) continue; // column deleted concurrently: don't mint an orphan key
          if (col.type === 'longtext') {
            const cur = m.get(colId);
            const next = value == null ? '' : String(value);
            if (isYText(cur)) setYText(cur, next);
            else m.set(colId, newText(E, next));
            continue;
          }
          m.set(colId, value ?? null);
        }
      }
      return;
    }
    case 'rows:delete': {
      const doomed = new Set(patch.ids);
      for (let i = r.rows.length - 1; i >= 0; i--) if (doomed.has(idOf(r.rows.get(i)))) r.rows.delete(i, 1);
      return;
    }
    case 'rows:move': {
      const from = findIndexById(r.rows, patch.id);
      if (from === -1) return;
      // No Y.Array move op in Yjs 13 — clone, delete, reinsert. See reorderByKey.
      const clone = cloneYMap(E, r.rows.get(from));
      r.rows.delete(from, 1);
      r.rows.insert(Math.max(0, Math.min(patch.to, r.rows.length)), [clone]);
      return;
    }
    case 'columns:create': {
      if (findIndexById(r.columns, patch.column.id) !== -1) return; // id already taken
      r.columns.insert(Math.max(0, Math.min(patch.at, r.columns.length)), [buildColumnMap(E, patch.column)]);
      return;
    }
    case 'columns:update': {
      const i = findIndexById(r.columns, patch.id);
      if (i === -1) return;
      applyColumnFields(E, r.columns.get(i), patch.patch);
      return;
    }
    case 'columns:delete': {
      const i = findIndexById(r.columns, patch.id);
      if (i === -1) return;
      r.columns.delete(i, 1);
      // Per-row values for this column are LEFT in their Y.Maps on purpose —
      // spec §6.1: they stop being serialized, and undoing this deletion
      // brings them back.
      return;
    }
    case 'views:create': {
      if (findIndexById(r.views, patch.view.id) !== -1) return;
      r.views.push([buildViewMap(E, patch.view)]);
      return;
    }
    case 'views:update': {
      const i = findIndexById(r.views, patch.id);
      if (i === -1) return;
      applyViewFields(r.views.get(i), patch.patch);
      return;
    }
    case 'views:delete': {
      if (r.views.length <= 1) return; // spec §5: the last view can't be deleted
      const i = findIndexById(r.views, patch.id);
      if (i === -1) return;
      r.views.delete(i, 1);
      return;
    }
    default:
      return;
  }
}

/** The REST/MCP patch vocabulary, applied natively over the same Y.Doc. */
function applyTableDocPatch(E: typeof Y, ydoc: Y.Doc, patch: TableDocPatch): void {
  const r = tableRoots(ydoc);
  const columns = () => r.columns.toArray().map(columnFromY);

  switch (patch.type) {
    case 'insertRows': {
      const cols = columns();
      r.rows.push(patch.rows.map((row) => buildRowMap(E, cols, row)));
      return;
    }
    case 'replaceRows':
    case 'replaceAll': {
      // A whole-collection replace is still applied BY KEY, not as "clear and
      // reinsert": a row/column/view whose id survives the replace keeps its
      // CRDT identity (and any concurrent in-flight edit to it), and only
      // genuinely-changed values produce operations. For an import of all-new
      // ids this degrades to a full replace anyway — it just never destroys
      // more than it has to.
      if (patch.type === 'replaceAll') {
        upsertByKey(r.columns, patch.columns, (c) => c.id, (c) => buildColumnMap(E, c), (m, c) => reconcileColumnMap(E, m, c));
        reorderByKey(E, r.columns, patch.columns.map((c) => c.id));
        upsertByKey(r.views, patch.views, (v) => v.id, (v) => buildViewMap(E, v), (m, v) => reconcileViewMap(m, v));
        reorderByKey(E, r.views, patch.views.map((v) => v.id));
        // Prose, when the patch carries it (a restore does, a YAML import
        // doesn't — see the patch type). setYText, not clear-and-reinsert, so
        // a collaborator's cursor in the untouched part of the prose survives.
        if (patch.head !== undefined) setYText(r.head, patch.head);
        if (patch.tail !== undefined) setYText(r.tail, patch.tail);
      }
      const cols = columns();
      upsertByKey(r.rows, patch.rows, (row) => row.id, (row) => buildRowMap(E, cols, row), (m, row) => reconcileRowMap(E, m, cols, row));
      reorderByKey(E, r.rows, patch.rows.map((row) => row.id));
      return;
    }
    case 'updateRows': {
      const rows = patch.rowIds.map((id) => ({ id, values: patch.values }));
      applyTablePatch(E, ydoc, { kind: 'rows:update', rows });
      return;
    }
    case 'deleteRows':
      applyTablePatch(E, ydoc, { kind: 'rows:delete', ids: patch.rowIds });
      return;
    case 'addColumn':
      applyTablePatch(E, ydoc, { kind: 'columns:create', at: r.columns.length, column: patch.column });
      return;
    case 'updateColumn': {
      applyTablePatch(E, ydoc, { kind: 'columns:update', id: patch.columnId, patch: patch.column });
      // A type change arrives with every affected row's re-derived value in
      // the SAME patch (service.ts folds them together deliberately), so the
      // schema change and the values it implies land in one transaction —
      // there is never an instant where the column says `number` and the
      // cells still hold select labels.
      if (patch.rowValues) {
        const cols = columns();
        const col = cols.find((c) => c.id === patch.columnId);
        if (col) {
          for (const [rowId, value] of Object.entries(patch.rowValues)) {
            const i = findIndexById(r.rows, rowId);
            if (i === -1) continue;
            const m = r.rows.get(i);
            if (col.type === 'longtext') {
              const cur = m.get(col.id);
              const next = value == null ? '' : String(value);
              if (isYText(cur)) setYText(cur, next);
              else m.set(col.id, newText(E, next));
            } else {
              m.set(col.id, value ?? null);
            }
          }
        }
      }
      return;
    }
    case 'deleteColumn':
      applyTablePatch(E, ydoc, { kind: 'columns:delete', id: patch.columnId });
      return;
    case 'addView':
      applyTablePatch(E, ydoc, { kind: 'views:create', view: patch.view });
      return;
    case 'updateView':
      applyTablePatch(E, ydoc, { kind: 'views:update', id: patch.viewId, patch: patch.view });
      return;
    case 'deleteView':
      applyTablePatch(E, ydoc, { kind: 'views:delete', id: patch.viewId });
      return;
    default:
      return;
  }
}

function applyEitherPatch(E: typeof Y, ydoc: Y.Doc, patch: TableEditPatch): void {
  if ('kind' in patch) applyTablePatch(E, ydoc, patch);
  else applyTableDocPatch(E, ydoc, patch);
}

/**
 * True when page `id` has a live collab room holding a fully-seeded table.
 * `isDocLive` alone only says "some room is open"; this additionally says
 * "and editTableDoc will work on it", which is the condition callers actually
 * want before routing a write through the CRDT.
 */
export function isLiveTable(id: string): boolean {
  const ydoc = docs.get(id);
  return ydoc !== undefined && isTableYDocSeeded(ydoc);
}

/**
 * The live `TableDoc` for a page, or undefined when no room is open for it
 * (or the doc isn't a trustworthy table yet). SERVER-TABLES' read path uses
 * this the way the doc path uses getLiveText: live room -> the CRDT is the
 * truth; nothing live -> read the file.
 */
export function getLiveTable(id: string): TableDoc | undefined {
  const ydoc = docs.get(id);
  if (!ydoc || !isTableYDocSeeded(ydoc)) return undefined;
  try {
    return tableDocFromYDoc(ydoc);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[collab] live table ${id} is not structurally valid:`, err);
    return undefined;
  }
}

/**
 * ==== SERVER-TABLES' DEPENDENCY — this signature is the contract. ====
 *
 *   editTableDoc(
 *     id: string,
 *     patch: TableEditPatch | readonly TableEditPatch[],
 *   ): Promise<TableDoc>
 *
 * Applies one patch — or a batch, as ONE Yjs transaction, i.e. one undo step,
 * one debounce window, one commit — to the LIVE Y.Doc of table page `id`, and
 * returns the resulting structural snapshot. `TableEditPatch` accepts BOTH
 * patch vocabularies: server/tables/service.ts's `type`-discriminated
 * `TableDocPatch` and the grid's `kind`-discriminated `TablePatch`.
 *
 * The debounced write-back armed by bindState carries the change to disk;
 * callers never write the file themselves.
 *
 * THROWS when `id` has no live, seeded table room. Guard with `isLiveTable(id)`
 * (or the coarser `isDocLive(id)`) and take the direct-file path instead — the
 * throw is for the genuinely broken cases: no room open at all, the page isn't
 * a table, or bindState could not parse the file and deliberately left the doc
 * unseeded so the seatbelt would refuse to overwrite it. Silently returning a
 * stale doc in any of those would let a caller believe a write landed when it
 * did not.
 *
 * Unknown row/column/view ids inside an otherwise-valid patch are ignored
 * rather than erroring: by the time a REST patch lands, a collaborator may
 * legitimately have deleted its target, and spec §6.1's outcome for that is
 * "the edit dissolves", not a 500.
 */
export async function editTableDoc(id: string, patch: TableEditPatch | readonly TableEditPatch[]): Promise<TableDoc> {
  const ydoc = docs.get(id);
  if (!ydoc) throw new Error(`[collab] editTableDoc: no live collab room for page ${id} — guard with isLiveTable(id)`);
  const entry = await storage.getEntry(id);
  if (!isTableEntry(entry)) throw new Error(`[collab] editTableDoc: page ${id} is not a data table`);
  if (!isTableYDocSeeded(ydoc)) {
    throw new Error(`[collab] editTableDoc: table ${id} is not seeded — its file could not be parsed, so writing to it is refused`);
  }

  const patches: readonly TableEditPatch[] = Array.isArray(patch) ? (patch as readonly TableEditPatch[]) : [patch as TableEditPatch];
  const E = yEngineFor(ydoc);
  ydoc.transact(() => {
    for (const p of patches) applyEitherPatch(E, ydoc, p);
  }, TABLE_EDIT_ORIGIN);

  return tableDocFromYDoc(ydoc);
}

// ===========================================================================
// Round 29 (BOARD COLLAB) — structured Y.Doc for `kind:'board'` pages. See
// DEV-PLAN.md "Round 29 — live collaboration on whiteboards" (normative) for the full
// contract. Three flat root types instead of table's six — a board's
// concurrency story is much simpler than a table's: elements are addressed
// by id, and the CRDT-level unit of conflict resolution is the WHOLE element
// (a plain JSON blob), never a field inside it. The one thing both rounds
// share is "matching by id, never by position" and "tombstone, never delete".
//
//   elements: Y.Map<string, ExcalidrawElement>  key = element.id, value = the
//             element's flat JSON (INCLUDING isDeleted:true — tombstones are
//             never removed, so two clients can never resurrect what a third
//             one just deleted) and `index` (fractional index — z-order).
//   board:    Y.Map<string, unknown>            viewBackgroundColor and other
//             SCENE-level appState fields — never the local viewport
//             (scrollX/scrollY/zoom), which stays per-client.
//   files:    Y.Map<string, unknown>             embedded image blobs, keyed
//             by their excalidraw fileId.
//
// Reconciliation rule (normative, client AND server): the element with the
// bigger `version` wins; equal `version` -> bigger `versionNonce` wins. This
// server only actually needs that rule in one place — bindBoardState's
// restore-vs-file merge below, when a room resumes from a stored snapshot and
// the FILE may have moved on independently (server down, external edit,
// restore-to-sha) while nothing was live to see it as a Yjs update. A live
// client's own concurrent edits are already resolved by Yjs itself at the
// Y.Map-key level; the version/versionNonce rule is what makes that
// resolution deterministic and excalidraw-meaningful rather than an
// arbitrary last-writer-by-CRDT-clock.
//
// editBoardScene (an agent's full-scene write, or a legacy PUT{svg} routed
// live) is deliberately NOT version-gated: it is a genuine "replace the
// scene" intent (update_board/board_ops rebuild elements from scratch,
// ending up with fresh version:1 objects that would always LOSE against a
// version-gate), so it always wins — same as writeBoardSvg always won
// unconditionally before this round.
// ===========================================================================

/** Narrows a page index entry to a board page — mirrors isTableEntry. */
type BoardEntry = storage.PageIndexEntry & { kind: 'board' };
function isBoardEntry(entry: storage.PageIndexEntry | undefined): entry is BoardEntry {
  return entry !== undefined && entry.kind === 'board';
}

/** Transaction origin for a full-scene write on an agent's/legacy PUT's behalf. */
export const BOARD_EDIT_ORIGIN = 'folio:board:edit';
/** Transaction origin for the server's own seed/reconcile passes (see TABLE_SEED_ORIGIN's rationale). */
export const BOARD_SEED_ORIGIN = 'folio:board:seed';

export interface BoardRoots {
  elements: Y.Map<ExcalidrawElement>;
  board: YMapAny;
  files: YMapAny;
}

/** The three root types of a board room. Instance methods only — safe for either Yjs copy (see isYText/isYMap/isYArray's comment). */
export function boardRoots(ydoc: Y.Doc): BoardRoots {
  return {
    elements: ydoc.getMap<ExcalidrawElement>('elements'),
    board: ydoc.getMap<unknown>('board'),
    files: ydoc.getMap<unknown>('files'),
  };
}

/**
 * Board-kind alias of isDocSeeded. Unlike a table room, a board room needs no
 * separate IN-CRDT seeded marker: a table's marker has to survive being read
 * back out of a Y.Doc reconstructed from nothing but a stored snapshot
 * (tableWriteRefusal must still work after that reconstruction), but a
 * board's seatbelt (persistBoardDoc, below) only ever needs to ask "did THIS
 * PROCESS finish seeding THIS room" — exactly what the doc-kind branch's
 * per-process `seededDocs` map already answers, and its lifetime already
 * coincides 1:1 with the room's lifetime in y-websocket's own `docs` map (see
 * ensureDocSeeded / writeState's `seededDocs.delete`).
 */
export function isBoardYDocSeeded(docName: string): boolean {
  return isDocSeeded(docName);
}

/** Local-only viewport fields that never leave a client's own view — see the section comment's `board` bullet. */
const BOARD_LOCAL_VIEWPORT_KEYS = new Set(['scrollX', 'scrollY', 'zoom', 'width', 'height', 'offsetLeft', 'offsetTop', 'shouldCacheIgnoreZoom']);

function boardAppStateEntries(appState: Record<string, unknown> | undefined): [string, unknown][] {
  return Object.entries(appState ?? {}).filter(([k]) => !BOARD_LOCAL_VIEWPORT_KEYS.has(k));
}

/** True while this room holds at least one non-tombstoned element — the same "was there really something to lose" question writeBoardSvg's own guard asks of the FILE. */
function boardHasLiveElements(roots: BoardRoots): boolean {
  for (const el of roots.elements.values()) {
    if (!el.isDeleted) return true;
  }
  return false;
}

/**
 * Wholesale population of a blank room from a parsed file/payload. Only ever runs when the room is genuinely empty.
 *
 * The room is a Y.Map and has no order of its own, so elements the file carries
 * without an `index` are given one here, from the array order of the file
 * (withBoardIndexes) — otherwise their z-order would be lost the moment they
 * are put in the room, and every reader would fall back to id order.
 */
function seedBoardYDoc(roots: BoardRoots, scene: ExcalidrawScene): void {
  for (const el of withBoardIndexes(scene.elements)) roots.elements.set(el.id, el);
  for (const [k, v] of boardAppStateEntries(scene.appState)) roots.board.set(k, v);
  for (const [fid, f] of Object.entries(scene.files ?? {})) roots.files.set(fid, f);
}

/**
 * "Snapshot vs file", BY VERSION (see the section comment's reconciliation
 * rule) — bindBoardState's restore path, when the room resumes from a stored
 * snapshot and the FILE may have moved on independently. Only ever touches an
 * element when the file's copy actually wins; never tombstones an element the
 * file doesn't mention (the live room may simply be ahead of a stale/
 * debounce-lagging file — that is not evidence the element was deleted).
 * Board-level fields are last-file-wins (they carry no version at all); files
 * merge additively (an embedded image blob is immutable once created, so
 * there is nothing to "reconcile" about one, only to add).
 */
function reconcileBoardYDoc(roots: BoardRoots, file: ExcalidrawScene): void {
  for (const el of withBoardIndexes(file.elements)) {
    const cur = roots.elements.get(el.id);
    if (!cur) {
      roots.elements.set(el.id, el);
      continue;
    }
    if (deepEquals(cur, el)) continue;
    const fileWins = el.version > cur.version || (el.version === cur.version && el.versionNonce > cur.versionNonce);
    if (fileWins) roots.elements.set(el.id, el);
  }
  for (const [k, v] of boardAppStateEntries(file.appState)) {
    if (!deepEquals(roots.board.get(k), v)) roots.board.set(k, v);
  }
  for (const [fid, f] of Object.entries(file.files ?? {})) {
    if (!roots.files.has(fid)) roots.files.set(fid, f);
  }
}

/** An element without the counters Excalidraw bumps on every change (and the timestamp that goes with them): what is left is what the element IS. */
function elementContent(el: ExcalidrawElement): Record<string, unknown> {
  const content: Record<string, unknown> = { ...el };
  delete content.version;
  delete content.versionNonce;
  delete content.updated;
  return content;
}

/** Monotonic, in-process tombstone versionNonce — see applyAgentBoardScene. Doesn't need to be globally unique, only to differ from whatever the element already held. */
let boardTombstoneNonce = 1;

/**
 * The write API `editBoardScene` applies inside a live room: upsert every
 * element the new scene carries (only when it actually differs — an
 * unchanged element emits zero Yjs ops, exactly like a table's cell), then
 * tombstone (never delete the key) every element the room still holds that
 * the new scene DOESN'T mention — spec: "mark with isDeleted: true those that
 * are not in the new scene". Deliberately NOT version-gated — see the section
 * comment for why a full-scene write always wins.
 *
 * Z-order: the room keeps it in each element's `index`, and a scene built on the
 * server (a sketch, a Confluence import, board_ops adding a shape) carries none
 * on some or all of its elements — so the missing ones are given keys from the
 * array order of the scene (withBoardIndexes), new elements landing on top.
 * An element that only changes because it got a key is written with a version
 * above the room's: with equal versions a peer may keep the element it holds
 * (the nonce decides), so a key written without raising the version might
 * never reach an open tab. It is compared WITHOUT the change counters, so
 * handing over the same scene again changes nothing in the room.
 */
function applyAgentBoardScene(roots: BoardRoots, scene: ExcalidrawScene): void {
  const given = new Map(scene.elements.map((e) => [e.id, e]));
  const elements = withBoardIndexes(scene.elements);
  const nextIds = new Set(elements.map((e) => e.id));
  for (const el of elements) {
    const cur = roots.elements.get(el.id);
    if (!cur) {
      roots.elements.set(el.id, el);
      continue;
    }
    const gotKey = given.get(el.id) !== el;
    if (!gotKey) {
      if (!deepEquals(cur, el)) roots.elements.set(el.id, el);
      continue;
    }
    if (deepEquals(elementContent(cur), elementContent(el))) continue;
    const version = Math.max(cur.version ?? 0, el.version ?? 0) + 1;
    roots.elements.set(el.id, { ...el, version, versionNonce: boardTombstoneNonce++ });
  }
  for (const key of [...roots.elements.keys()]) {
    if (nextIds.has(key)) continue;
    const cur = roots.elements.get(key);
    if (cur && !cur.isDeleted) {
      roots.elements.set(key, { ...cur, isDeleted: true, version: (cur.version ?? 0) + 1, versionNonce: boardTombstoneNonce++, updated: Date.now() });
    }
  }
  for (const [k, v] of boardAppStateEntries(scene.appState)) {
    if (!deepEquals(roots.board.get(k), v)) roots.board.set(k, v);
  }
  for (const [fid, f] of Object.entries(scene.files ?? {})) {
    if (!deepEquals(roots.files.get(fid), f)) roots.files.set(fid, f);
  }
}

/**
 * Makes the room hold exactly the board `file` says — the opposite of
 * reconcileBoardYDoc, which lets the room win wherever its element version is
 * higher. "Take the version from Git" (reconcileLiveRoomsAfterReset) cannot use
 * that gate: the user's edits since the last sync have pushed the room's
 * versions above the ones in the file Git holds, and a client that holds those
 * higher versions drops the lower ones it is sent (excalidraw's reconcileElements
 * keeps a local element whose version is higher). So an element is written
 * with a version ABOVE both sides — the one thing every client adopts — and
 * only when its content differs from the room's; a room element the file
 * does not have becomes a tombstone, like in applyAgentBoardScene. Board-level
 * fields follow the file, embedded images are added (they are immutable).
 *
 * The file is not touched: persistBoardDoc keeps it as it is for as long as
 * the room's scene is the file's scene, so these version counters reach Git
 * only together with the next real edit. Elements the file carries without an
 * `index` get one from the array order of the file (withBoardIndexes), like on
 * seeding; the file does not need them to be "the same scene" (see
 * boardSceneHasFileContent).
 */
function resetBoardYDoc(roots: BoardRoots, file: ExcalidrawScene): void {
  const inFile = new Set<string>();
  for (const el of withBoardIndexes(file.elements)) {
    inFile.add(el.id);
    const cur = roots.elements.get(el.id);
    if (!cur) {
      roots.elements.set(el.id, el);
      continue;
    }
    if (deepEquals(elementContent(cur), elementContent(el))) continue;
    roots.elements.set(el.id, { ...el, version: Math.max(cur.version ?? 0, el.version ?? 0) + 1, versionNonce: boardTombstoneNonce++ });
  }
  for (const [key, cur] of [...roots.elements.entries()]) {
    if (inFile.has(key) || cur.isDeleted) continue;
    roots.elements.set(key, { ...cur, isDeleted: true, version: (cur.version ?? 0) + 1, versionNonce: boardTombstoneNonce++, updated: Date.now() });
  }
  const fileFields = new Map(boardAppStateEntries(file.appState));
  for (const [k, v] of fileFields) {
    if (!deepEquals(roots.board.get(k), v)) roots.board.set(k, v);
  }
  for (const k of [...roots.board.keys()]) {
    if (fileFields.has(k)) continue;
    // A file without a background colour means white (boardSceneFromYDoc's default).
    if (k === 'viewBackgroundColor') roots.board.set(k, '#ffffff');
    else roots.board.delete(k);
  }
  for (const [fid, f] of Object.entries(file.files ?? {})) {
    if (!roots.files.has(fid)) roots.files.set(fid, f);
  }
}

/**
 * Element order of the room = z-order (server/boardOrder.ts): by `index`
 * (fractional), a bound text right after its container, ties by `id`.
 *
 * The room's Y.Map has no order of its own, so the elements are first put in id
 * order — the one deterministic order available — and orderBoardElements keeps
 * that order wherever indexes are missing or equal. A room whose elements all
 * carry an `index` (every scene put in a room since elements are given keys on
 * the way in) comes out as it always did, except that a bound text now follows
 * its container.
 */
function sortBoardElements(elements: ExcalidrawElement[]): ExcalidrawElement[] {
  return orderBoardElements([...elements].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
}

/** The live room as an ExcalidrawScene — includes tombstones, in z-order. Used by persistBoardDoc and by getLiveBoardScene. */
function boardSceneFromYDoc(ydoc: Y.Doc): ExcalidrawScene {
  const roots = boardRoots(ydoc);
  const elements = sortBoardElements([...roots.elements.values()]);
  const appState: Record<string, unknown> = { viewBackgroundColor: '#ffffff', ...roots.board.toJSON() };
  const files = roots.files.toJSON() as Record<string, unknown>;
  return { type: 'excalidraw', version: 2, source: 'folio-board', elements, appState, files };
}

/** Board-kind branch of bindState: restore the snapshot, seed a blank room from the file, or reconcile a resumed one against it (file wins, by version). */
async function bindBoardState(docName: string, ydoc: Y.Doc, _entry: BoardEntry): Promise<void> {
  const snapshot = await loadSnapshot(docName).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[collab] failed to load snapshot for board ${docName}:`, err);
    return undefined;
  });
  // yEngineFor, not the plain ESM `Y` import — see its doc comment up top.
  if (snapshot) yEngineFor(ydoc).applyUpdate(ydoc, snapshot);

  let scene: ExcalidrawScene | undefined;
  try {
    const svg = await storage.readBoardSvg(docName);
    const payload = extractScenePayload(svg);
    if (payload) scene = decodeScenePayload(payload);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[collab] failed to read board ${docName} for seeding:`, err);
  }

  const roots = boardRoots(ydoc);
  const blank = roots.elements.size === 0 && roots.board.size === 0 && roots.files.size === 0;

  if (blank) {
    // No payload: leave the room empty, deliberately not an error — a brand
    // new board (created, never drawn on) has no embedded scene at all yet.
    if (!scene) return;
    const seededScene = scene;
    ydoc.transact(() => seedBoardYDoc(roots, seededScene), BOARD_SEED_ORIGIN);
    await storeSnapshot(docName, ydoc).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[collab] failed to store initial snapshot for board ${docName}:`, err);
    });
    return;
  }

  // Resumed from a stored snapshot: the file may have moved on independently
  // (server down, external edit, restore-to-sha) while nothing was live to
  // see it as a Yjs update — reconcile it in, by version, same idea as the
  // doc-kind branch's own "file changed while server was down" diff-apply.
  if (scene) {
    const reconciledScene = scene;
    ydoc.transact(() => reconcileBoardYDoc(roots, reconciledScene), BOARD_SEED_ORIGIN);
  }
}

/** Number of live (non-tombstoned) elements in the board file currently on disk, or null when unreadable/no payload — mirrors storage.ts's own excalidrawLiveElementCount, used only by persistBoardDoc's seatbelt below. */
async function boardLiveElementCountOnDisk(docName: string): Promise<number | null> {
  try {
    const svg = await storage.readBoardSvg(docName);
    const payload = extractScenePayload(svg);
    if (!payload) return null;
    const scene = decodeScenePayload(payload);
    return scene.elements.filter((e) => !e.isDeleted).length;
  } catch {
    return null;
  }
}

/**
 * True when the board file `svg` already holds what `scene` (the room) holds:
 * the same live elements, in the same order, with the same content, and the
 * same scene-level fields. What it deliberately ignores: the change counters and
 * timestamps of an element (version, versionNonce, updated), tombstones, and
 * embedded images — a room that only differs in those has nothing the file
 * lacks. False for a file it cannot read as a scene (a new board's bare
 * skeleton included), and for one whose elements merely sit in another order:
 * that is still rewritten, which puts them back in z-order.
 *
 * Two things are deliberately NOT a difference: the `index` strings (what
 * counts is which element sits above which, not what the keys are called), and
 * where a bound text sits (the file's list is compared with every bound text
 * moved to its container, as the room's list already has). That is what keeps a
 * board written before elements got keys (no `index`, a label under its box)
 * from being rewritten just because it was opened or "taken from Git": it
 * differs from its room only in those two ways, and the next real edit puts
 * them right. The order of everything else is still compared as the file has it.
 */
function boardSceneHasFileContent(scene: ExcalidrawScene, svg: string): boolean {
  let file: ExcalidrawScene;
  try {
    const payload = extractScenePayload(svg);
    if (!payload) return false;
    file = decodeScenePayload(payload);
  } catch {
    return false;
  }
  const live = (elements: ExcalidrawElement[]): Record<string, unknown>[] =>
    placeBoundTexts(elements.filter((e) => !e.isDeleted)).map((el) => {
      const content = elementContent(el);
      delete content.index;
      return content;
    });
  if (!deepEquals(live(scene.elements), live(file.elements))) return false;
  return deepEquals({ viewBackgroundColor: '#ffffff', ...Object.fromEntries(boardAppStateEntries(file.appState)) }, scene.appState);
}

/**
 * Board-kind branch of persistDoc: collect the scene from the room (including
 * tombstones, in z-order: boardOrder.ts) -> renderSceneSvg -> storage.writeBoardSvg
 * (its blank-overwrite guard stays fully active — never `force`) ->
 * storeSnapshot -> gitSync.noteActivity.
 *
 * Round-8 seatbelt, board-shaped: exactly the doc branch's OWN rule (refuse
 * only when the write would SHRINK on-disk content AND this process never
 * confirmed the room fully seeded) — not an unconditional "must be seeded"
 * gate. A room this process built via bindState directly (the pattern every
 * collab test in this codebase uses, never going through ensureDocSeeded)
 * must still be able to persist a legitimate, non-shrinking write; only a
 * write that would LOSE live elements from an unconfirmed room is refused —
 * the exact signature of the cold-doc race (an edit landing before bindState
 * could restore the real content).
 */
async function persistBoardDoc(docName: string, ydoc: Y.Doc, entry: BoardEntry): Promise<void> {
  const scene = boardSceneFromYDoc(ydoc);
  const newLiveCount = scene.elements.filter((e) => !e.isDeleted).length;
  if (!isBoardYDocSeeded(docName)) {
    const onDiskLiveCount = await boardLiveElementCountOnDisk(docName);
    if (onDiskLiveCount !== null && newLiveCount < onDiskLiveCount) {
      // eslint-disable-next-line no-console
      console.error(
        `[collab] BOARD SEATBELT: refusing to persist board ${docName} — new scene has ${newLiveCount} live element(s), ` +
          `fewer than the ${onDiskLiveCount} currently on disk, and this room was never confirmed fully seeded from its ` +
          'persisted state. This is the exact signature of the cold-doc race (an edit landing before bindState could ' +
          'restore the real content) — refusing the write to avoid clobbering real data.',
      );
      return;
    }
  }
  const onDisk = await storage.readBoardSvg(docName).catch(() => '');
  if (GIT_CONFLICT_MARKER_RE.test(onDisk)) {
    // eslint-disable-next-line no-console
    console.error(`[collab] refusing to persist board ${docName}: its file has unresolved git conflict markers.`);
    return;
  }
  if (boardSceneHasFileContent(scene, onDisk)) {
    // Nothing to write: the file already says what the room says. This is what
    // keeps the file byte-for-byte the one Git holds after "Take the version
    // from Git" (resetBoardYDoc raised the room's version counters above the
    // file's) until somebody really edits the board. The snapshot still follows
    // the room, so a reopened room starts from the same versions.
    await storeSnapshot(docName, ydoc);
    return;
  }
  const svg = renderSceneSvg(scene);
  try {
    await storage.writeBoardSvg(docName, svg);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[collab] board ${docName} write refused:`, err instanceof Error ? err.message : err);
    return;
  }
  await storeSnapshot(docName, ydoc);
  gitSync.noteActivity(entry.space);
}

/**
 * True when page `id` has a live board room open — the board analogue of
 * isDocLive (deliberately NOT gated on isBoardYDocSeeded: an incoming EDIT
 * landing on a room this process hasn't finished seeding yet is fine — same
 * as applyMarkdownUpdate/editDocBody for docs — the risk is handled entirely
 * at the PERSIST layer, by persistBoardDoc's own seatbelt above).
 */
export function isLiveBoard(id: string): boolean {
  return docs.has(id);
}

/**
 * The live scene for a board page, or undefined when no room is open for it
 * — the board analogue of getLiveTable/getLiveText. read_page (MCP) consults
 * this before falling back to disk.
 */
export function getLiveBoardScene(id: string): ExcalidrawScene | undefined {
  const ydoc = docs.get(id);
  if (!ydoc) return undefined;
  return boardSceneFromYDoc(ydoc);
}

/**
 * ==== The write API create_board/update_board/board_ops (MCP) and the
 * legacy PUT{svg} route call — this signature is the contract. ====
 *
 *   editBoardScene(id: string, scene: ExcalidrawScene): Promise<PageMeta>
 *
 * Live room open -> one Yjs transaction: upsert every element the new scene
 * carries, tombstone every element the room holds that the new scene no
 * longer mentions (spec: "an update is mandatory when an agent has made one" — every
 * open tab sees this the instant the transaction commits, via the room's
 * normal update broadcast). No live room -> straight to storage.writeBoardSvg
 * (never `force` — see the section comment).
 *
 * The blank-overwrite guard applies identically on both paths: an agent (or
 * a legacy PUT) handing over a scene with zero live elements while the
 * current scene (room or file) has some is refused with the same message
 * writeBoardSvg's own guard uses — never silently wipes a board.
 */
export async function editBoardScene(id: string, scene: ExcalidrawScene): Promise<PageMeta> {
  const ydoc = docs.get(id);
  if (ydoc) {
    const entry = await storage.getEntry(id);
    if (!isBoardEntry(entry)) throw badRequest('page is not a board');
    const roots = boardRoots(ydoc);
    const nextHasLive = scene.elements.some((e) => !e.isDeleted);
    if (!nextHasLive && boardHasLiveElements(roots)) {
      throw badRequest('empty scene over a non-empty board; reload the board');
    }
    ydoc.transact(() => applyAgentBoardScene(roots, scene), BOARD_EDIT_ORIGIN);
    await flushDoc(id); // synchronous durability for the caller's response, same spirit as editDocBody/patchEntryContent
    return storage.toPageMeta(await storage.requireEntry(id));
  }
  return storage.writeBoardSvg(id, renderSceneSvg(scene));
}

/**
 * THE DOUBLING fix: re-seeding a FRESH Y.Doc from the file on every restart
 * (tsx watch restarts constantly in dev) gave the seed insert NEW CRDT
 * operation identity each time. A client that held the page open across the
 * restart still has its OWN copy of the OLD identity's insert ops; on
 * reconnect, Yjs has no way to know the two inserts represent "the same"
 * text — they're structurally independent edits from its point of view — so
 * they merge as two real edits: body+body.
 *
 * Fix: restore the doc's ACTUAL prior state (Y.applyUpdate from a stored
 * snapshot) so identity survives a restart — a reconnecting client merges
 * into the SAME ops, not a parallel copy. Only fall back to reseeding from
 * the file for a doc that's never had a snapshot at all, and in that case
 * store the resulting snapshot immediately, closing the restart window for
 * this doc from that point on.
 */
export async function bindState(docName: string, ydoc: Y.Doc): Promise<void> {
  const entry = await storage.getEntry(docName);
  const ytext = ydoc.getText('content');
  let snapshotAheadOfFile = false;

  if (isTableEntry(entry)) {
    // Round 26 table branch. Same three guarantees as the doc branch below —
    // awaited seeding, snapshot-first restore, file-wins reconciliation — but
    // over the structured Y.Doc, and reconciling BY KEY (spec §6 rule 4).
    await bindTableState(docName, ydoc, entry);
  } else if (isBoardEntry(entry)) {
    // Round 29 board branch — see the "BOARD COLLAB" section below.
    await bindBoardState(docName, ydoc, entry);
  } else if (entry && entry.kind === 'doc') {
    const row = await loadSnapshotRow(docName).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[collab] failed to load snapshot for ${docName}:`, err);
      return undefined;
    });
    const snapshot = row?.snapshot;

    if (snapshot) {
      // yEngineFor, not the plain ESM `Y` import directly — see its doc comment up top.
      // Applying via the WRONG copy silently corrupts the doc (length bookkeeping
      // updates, but toString() reads back empty or duplicated).
      yEngineFor(ydoc).applyUpdate(ydoc, snapshot);
      const hadCarriageReturns = ytext.toString().includes('\r');
      stripCarriageReturns(ytext);
      // Stored once the writer exists (below): the cleaned text goes to the snapshot and the file.
      if (hadCarriageReturns) snapshotAheadOfFile = true;
      // An unreadable file is NOT an empty or an index-cached one: the
      // reconcile below would replace the restored text with whatever stood in
      // for it. Nothing is reconciled until the file can be read.
      const rawFileBody = await storage.readFreshDocBody(docName).catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[collab] could not read the file of ${docName} on open; keeping the stored room state:`, err);
        return undefined;
      });
      const fileBody = rawFileBody === undefined ? undefined : normalizeEol(rawFileBody);
      // Compared against what persisting this text WOULD write (docFileBody: the
      // same text with a trailing newline guaranteed), not the raw Y.Text. A page
      // typed to the end without a final "\n" has a file that is "different" by
      // that one character on every resume; the whole-body replace below would
      // then delete and reinsert every character under new CRDT identity — and a
      // client that kept typing on top of the old characters (an offline-created
      // page connecting its own doc for the first time is exactly that) merges the
      // replacement in next to its edits: the doubling, from a difference that
      // was never real.
      if (fileBody !== undefined && fileBody !== storage.docFileBody(ytext.toString()) && !docFileWins(fileBody, row?.fileBodySha256)) {
        // The snapshot is newer than the file (the file still holds exactly what
        // this room last wrote): keep it, and write it out as soon as the writer exists.
        // eslint-disable-next-line no-console
        console.warn(`[collab] ${docName}: stored room state is newer than its file; keeping it and rewriting the file`);
        snapshotAheadOfFile = true;
      } else if (fileBody !== undefined && fileBody !== storage.docFileBody(ytext.toString())) {
        await backupRoomText(docName, 'file changed while the room was closed', ytext.toString());
        // The file changed while the server was down (external edit, git pull/merge
        // applied straight to disk while nothing was live to see it as a Yjs update).
        // Apply the difference as a REAL EDIT on top of the restored doc — never a
        // reseed — so a concurrently-reconnecting client's ops still merge with this
        // correctly, the same as with any other live edit. Simplest correct approach
        // is a whole-body replace; a real text-diff would be gentler on any
        // concurrent cursors/selections but isn't needed for correctness — an
        // acceptable follow-up, not a gap in this fix.
        ydoc.transact(() => {
          ytext.delete(0, ytext.length);
          ytext.insert(0, fileBody);
        });
      }
    } else if (ytext.length === 0) {
      const body = normalizeEol(await storage.readFreshDocBody(docName).catch(() => entry.body ?? ''));
      // Re-check length: bindState is async, and a concurrent update could have raced ahead of us.
      if (ytext.length === 0 && body) {
        ydoc.transact(() => ytext.insert(0, body));
      }
      await storeSnapshot(docName, ydoc, ytext.length > 0 ? storage.docFileBody(ytext.toString()) : undefined).catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[collab] failed to store initial snapshot for ${docName}:`, err);
      });
    }
  }

  // A failed write is retried — with a growing pause — instead of waiting for
  // the next keystroke, which may never come. Only while THIS room is the open
  // one: a closed room's retry would write its old state over a newer room's
  // file and snapshot, or over a fresh git pull. A closed room needs no retry —
  // its snapshot was stored on the failure, without moving the file marker, so
  // the next open resumes it and rewrites the file (snapshotAheadOfFile).
  let failures = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const writer = createDebouncedWriter(async () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
    const ok = await persistDoc(docName, ydoc);
    if (ok) {
      failures = 0;
      return;
    }
    failures += 1;
    if (failures > PERSIST_MAX_RETRIES) {
      // eslint-disable-next-line no-console
      console.error(`[collab] giving up writing page ${docName} after ${failures} attempts; its state stays in ydoc_state`);
      // The next edit starts a fresh round of attempts.
      failures = 0;
      return;
    }
    if (!isOpenRoom(docName, ydoc)) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (isOpenRoom(docName, ydoc)) writer.schedule();
    }, Math.min(persistRetryBaseMs * 2 ** (failures - 1), PERSIST_RETRY_MAX_MS));
    retryTimer.unref?.();
  }, WRITE_DEBOUNCE_MS);
  writers.set(docName, writer);
  ydoc.on('update', () => writer.schedule());
  if (snapshotAheadOfFile) writer.schedule();
}

/** True while `ydoc` is the room y-websocket serves for `docName` — not one already closed (and maybe replaced). */
function isOpenRoom(docName: string, ydoc: Y.Doc): boolean {
  return docs.get(docName) === ydoc;
}

/** Retry cadence for a failed doc write-back (persistDoc returned false). */
let persistRetryBaseMs = 2_000;
/** Tests only. */
export function setPersistRetryBaseMsForTests(ms: number): void {
  persistRetryBaseMs = ms;
}
const PERSIST_RETRY_MAX_MS = 60_000;
const PERSIST_MAX_RETRIES = 8;

/**
 * Flushes the debounced writer immediately, which — since it's the SAME
 * closure bindState armed above — already covers storing the snapshot too;
 * no separate snapshot-store call is needed here.
 */
async function writeState(docName: string, _ydoc: Y.Doc): Promise<void> {
  const writer = writers.get(docName);
  if (writer) {
    await writer.flush();
    writers.delete(docName);
  }
  // The doc is about to be evicted from y-websocket's `docs` map (closeConn, right
  // after this resolves) — a future reopen is a genuinely fresh WSSharedDoc that
  // must go through ensureDocSeeded again, so this doc's "seeded" flag shouldn't
  // outlive it either.
  seededDocs.delete(docName);
}

/** Registers the persistence hooks with y-websocket. Call once at server boot. */
export function initCollab(): void {
  setPersistence({ bindState, writeState });
  // page_text_backups is pruned per page on insert; a page nobody touches
  // again keeps its rows, so everything past retention also goes at boot and daily.
  void pruneTextBackups();
  setInterval(() => void pruneTextBackups(), 24 * 60 * 60 * 1000).unref();
}

/** Deletes every page_text_backups row older than the retention period. Never throws. */
export async function pruneTextBackups(): Promise<void> {
  try {
    await query('DELETE FROM page_text_backups WHERE created_at < now() - $1::interval', [BACKUP_RETENTION]);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[collab] failed to prune old page text backups:', err);
  }
}

/**
 * server/gitSync.ts's resetSpaceToRemote ("Take the version from Git") rewrites a
 * space's files straight to disk, outside any Y.Doc. For every page whose file
 * the reset changed and whose room is OPEN right now, this brings the room up
 * to the file as a REAL EDIT — the same "file wins" step bindState runs when it
 * resumes from a snapshot — so connected clients get it as an ordinary update.
 *
 * Deliberately NOT dropping ydoc_state or force-closing the room: a fresh seed
 * mints new CRDT identity, and a client reconnecting with its old doc would
 * merge both copies — THE DOUBLING (see bindState). Pages with no open room
 * need nothing here: their next bindState reconciles snapshot against file —
 * except a board, whose reconcile is by element version and so would keep the
 * discarded local scene (resetStoredBoardAfterReset).
 *
 * A board is not reconciled but RESET (resetBoardYDoc): by version the room
 * would keep every element the user edited since the last sync, because those
 * versions are higher than the ones in the file from Git, and an open canvas
 * would keep them too. The file stays as the reset wrote it.
 *
 * A pending debounced write is cancelled first — it holds pre-reset text and
 * would put it straight back on disk. resetSpaceToRemote flushes every writer
 * BEFORE the reset, so nothing typed earlier is lost (it lands in the backup
 * branch). The reconcile edit re-arms the writer, which then writes the file's
 * own content back: a no-op on disk.
 */
export async function reconcileLiveRoomsAfterReset(pageIds: readonly string[]): Promise<void> {
  for (const id of pageIds) {
    const ydoc = docs.get(id);
    if (!ydoc) {
      await resetStoredBoardAfterReset(id);
      continue;
    }
    writers.get(id)?.cancel();
    try {
      const entry = await storage.getEntry(id);
      if (isTableEntry(entry)) {
        const { doc: parsed } = await readTableFileState(entry);
        if (parsed) ydoc.transact(() => reconcileTableYDoc(ydoc, parsed), TABLE_SEED_ORIGIN);
      } else if (isBoardEntry(entry)) {
        const scene = await readBoardFileScene(id);
        if (scene) {
          ydoc.transact(() => resetBoardYDoc(boardRoots(ydoc), scene), BOARD_SEED_ORIGIN);
          // Not waiting for the debounce: the room's new state goes into the snapshot now, so a restart right after the reset cannot bring the discarded scene back.
          await writers.get(id)?.flush();
        }
      } else if (entry && entry.kind === 'doc') {
        const body = normalizeEol(await storage.readFreshDocBody(id));
        const ytext = ydoc.getText('content');
        if (body !== ytext.toString()) {
          const before = ytext.toString();
          ydoc.transact(() => {
            ytext.delete(0, ytext.length);
            ytext.insert(0, body);
          });
          await backupRoomText(id, 'reset to the version from Git', before);
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[collab] failed to reconcile live room ${id} after reset-to-remote:`, err);
    }
  }
}

/** The scene embedded in board `id`'s file, or undefined when the file has none (a bare new board) or cannot be read. */
async function readBoardFileScene(id: string): Promise<ExcalidrawScene | undefined> {
  const payload = extractScenePayload(await storage.readBoardSvg(id));
  return payload ? decodeScenePayload(payload) : undefined;
}

/**
 * The reset's counterpart for a board nobody has open. Its stored room state is
 * what the next open resumes from, and bindBoardState lets that state win over
 * the file wherever its element versions are higher — exactly the discarded
 * local edits. So the stored state gets the same resetBoardYDoc a live room
 * would have got: loaded into a scratch doc (the CRDT history stays, nothing is
 * re-seeded), brought to the file, stored again. A board without stored state
 * needs nothing: it is seeded from the file when opened. A doc or table is not
 * touched — their reconcile on open already follows the file.
 */
async function resetStoredBoardAfterReset(id: string): Promise<void> {
  try {
    if (!isBoardEntry(await storage.getEntry(id))) return;
    const snapshot = await loadSnapshot(id);
    if (!snapshot) return;
    const scene = await readBoardFileScene(id);
    if (!scene) return;
    const scratch = new Y.Doc();
    try {
      yEngineFor(scratch).applyUpdate(scratch, snapshot);
      scratch.transact(() => resetBoardYDoc(boardRoots(scratch), scene), BOARD_SEED_ORIGIN);
      await storeSnapshot(id, scratch);
    } finally {
      scratch.destroy();
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[collab] failed to reset the stored state of board ${id} after reset-to-remote:`, err);
  }
}

/**
 * gitSync.performSync calls this BEFORE it commits: every open room of `space`
 * gets its pending write onto disk (settle — nothing is written for a room with
 * nothing pending), so the commit holds what was typed and git three-way-merges
 * it with the remote, instead of the room writing it over the merge result
 * afterwards. Returns each room's full state as of that write — the base
 * reconcileLiveRoomAfterMerge applies the merge on top of.
 */
export async function settleRoomsForSync(space: string): Promise<Map<string, Uint8Array>> {
  const bases = new Map<string, Uint8Array>();
  for (const id of [...docs.keys()]) {
    if ((await storage.getEntry(id))?.space !== space) continue;
    await seedingPromises.get(id);
    await writers.get(id)?.settle();
    const ydoc = docs.get(id);
    if (ydoc) bases.set(id, yEngineFor(ydoc).encodeStateAsUpdate(ydoc));
  }
  return bases;
}

/** Page ids with an open room right now. */
export function liveRoomIds(): string[] {
  return [...docs.keys()];
}

/**
 * An ordinary sync merge (gitSync.performSync) just changed `entry`'s file, and
 * its room is open: `raw` is the merged file. Without this the room keeps the
 * pre-merge content, and its next write — or the flush when the last client
 * leaves — puts that back over the merge (01.10.2026).
 *
 * The merge goes in as a REAL edit made on a fork of `base` (the room's state
 * when its text was last written, settleRoomsForSync), never as a reseed — see
 * reconcileLiveRoomsAfterReset for why. Forking matters for whatever reached the
 * room while git was fetching and merging: those edits are not in `base`, so the
 * fork's edit cannot undo them, and Yjs merges the two like any concurrent
 * edits. A room opened during the sync has no base; its current state stands
 * in for one.
 *
 * Doc: the body is rewritten touching only the span that differs (setYText) —
 * conflict markers included, so the room shows the conflict instead of writing
 * over it. Table/board: the same by-key/by-version reconcile bindState runs;
 * a file with conflict markers is left alone (persistTableDoc/persistBoardDoc
 * refuse to write over it). A board element the merge removed is tombstoned,
 * which is safe only against a real base.
 */
export function reconcileLiveRoomAfterMerge(entry: storage.PageIndexEntry, raw: string, base: Uint8Array | undefined): void {
  const ydoc = docs.get(entry.id);
  if (!ydoc) return;
  const E = yEngineFor(ydoc);
  const fork = new E.Doc();
  E.applyUpdate(fork, base ?? E.encodeStateAsUpdate(ydoc));
  const forkedAt = E.encodeStateVector(fork);
  if (isTableEntry(entry)) {
    // An unseeded room is one bindTableState could not parse (raw-file mode); it reseeds on reopen.
    if (GIT_CONFLICT_MARKER_RE.test(raw) || !isTableYDocSeeded(fork)) return;
    const parsed = parseTableFile(raw);
    if (isTableParseError(parsed)) return;
    fork.transact(() => reconcileTableYDoc(fork, parsed));
  } else if (isBoardEntry(entry)) {
    if (GIT_CONFLICT_MARKER_RE.test(raw)) return;
    const payload = extractScenePayload(raw);
    if (!payload) return;
    const scene = decodeScenePayload(payload);
    const roots = boardRoots(fork);
    fork.transact(() => {
      reconcileBoardYDoc(roots, scene);
      if (!base) return;
      const kept = new Set(scene.elements.map((e) => e.id));
      for (const [id, el] of [...roots.elements.entries()]) {
        if (kept.has(id) || el.isDeleted) continue;
        roots.elements.set(id, { ...el, isDeleted: true, version: (el.version ?? 0) + 1, versionNonce: boardTombstoneNonce++, updated: Date.now() });
      }
    });
  } else if (entry.kind === 'doc') {
    const body = normalizeEol(storage.splitLeadingFrontmatter(raw).body);
    const text = fork.getText('content');
    if (body === storage.docFileBody(text.toString())) return;
    fork.transact(() => setYText(text, body));
  } else {
    return;
  }
  E.applyUpdate(ydoc, E.encodeStateAsUpdate(fork, forkedAt));
}

export function isDocLive(id: string): boolean {
  return docs.has(id);
}

export function getLiveText(id: string): string | undefined {
  return docs.get(id)?.getText('content').toString();
}

/**
 * Routes a PUT's markdown through the live Y.Doc (full-text replace inside a
 * transaction) instead of writing the file directly. The doc's own 'update'
 * listener (attached in bindState) picks this up and debounces the disk
 * write; we additionally patch the in-memory index synchronously so the
 * caller's response (and any immediate GET/search) reflects it right away.
 */
export async function applyMarkdownUpdate(id: string, rawMarkdown: string, overrideIcon?: string | null, overrideCover?: string | null): Promise<void> {
  const markdown = normalizeEol(rawMarkdown);
  const doc = docs.get(id);
  if (!doc) return;
  const entry = await storage.getEntry(id);

  // icon/cover never ride the Yjs body (frontmatter isn't part of the CRDT), so an
  // icon/cover-only PUT (body text unchanged) would otherwise never trigger the
  // debounced write-back at all — persist it immediately instead of hoping a later
  // body edit happens to carry it to disk too. resolveIconCoverOverride keeps the
  // undefined=preserve / null=clear / string=set distinction correct — a naive
  // `overrideIcon ?? entry.icon` would treat null the SAME as undefined (both are
  // "nullish" to ??), silently turning an explicit clear into a no-op.
  if (entry && (overrideIcon !== undefined || overrideCover !== undefined)) {
    const icon = storage.resolveIconCoverOverride(overrideIcon, entry.icon);
    const cover = storage.resolveIconCoverOverride(overrideCover, entry.cover);
    await storage.setDocIconCover(entry, icon, cover, markdown);
  }

  const ytext = doc.getText('content');
  if (ytext.toString() !== markdown) {
    // A REST/MCP body write replaces the whole live text — including whatever
    // someone typed into the room after the caller read the page. Captured
    // before, stored after: no await between reading the text and replacing it.
    const before = ytext.toString();
    doc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, markdown);
    });
    await backupRoomText(id, 'body replaced through the API', before);
  }
  if (entry) await storage.patchEntryContent(entry, markdown);
}

/**
 * The live-doc-aware "set a doc's body" path, shared by the REST PUT route
 * and MCP's update_page tool (round 7: "update_page routes through the same
 * live-doc-aware path as REST PUT") — one function, so the two callers can
 * never silently diverge. Live doc open -> through the Y.Doc (merges
 * correctly with concurrent typing instead of stomping it); otherwise
 * straight to the file.
 */
export async function editDocBody(id: string, rawMarkdown: string, overrideIcon?: string | null, overrideCover?: string | null): Promise<PageMeta> {
  // Normalized for the file too: the next room opened on it is seeded from it.
  const markdown = normalizeEol(rawMarkdown);
  if (isDocLive(id)) {
    await applyMarkdownUpdate(id, markdown, overrideIcon, overrideCover);
    return storage.toPageMeta(await storage.requireEntry(id));
  }
  return storage.writeDocBody(id, markdown, overrideIcon, overrideCover);
}

/** Same idea as applyMarkdownUpdate, for H1-only renames. Returns false if no live doc is open. */
export async function applyH1Rename(id: string, title: string): Promise<boolean> {
  const doc = docs.get(id);
  const entry = await storage.getEntry(id);
  if (!doc || !entry) return false;

  // Round 26: a table's H1 lives in the `head` Y.Text (the prose above the
  // table), not in a `content` Y.Text — everything else about the rename is
  // identical, including the space-root special case below.
  if (isTableEntry(entry)) {
    if (!isTableYDocSeeded(doc)) return false;
    const head = tableRoots(doc).head;
    const updated = storage.replaceFirstH1(head.toString(), title);
    doc.transact(() => setYText(head, updated), TABLE_EDIT_ORIGIN);
    if (entry.isIndex && entry.dirPath === '') {
      await storage.noteSpaceNameChange(entry.space, storage.extractH1(updated) ?? title);
    }
    // Same reason the doc branch patches the index synchronously below: the
    // caller's response (and any immediate GET) has to show the new title now,
    // not after the ~800ms debounced write-back.
    const live = getLiveTable(id);
    if (live) await storage.patchEntryContent(entry, storage.tableDocToPlainText(live));
    return true;
  }

  if (entry.kind !== 'doc') return false;
  const ytext = doc.getText('content');
  const updated = storage.replaceFirstH1(ytext.toString(), normalizeEol(title));
  doc.transact(() => {
    ytext.delete(0, ytext.length);
    ytext.insert(0, updated);
  });
  // round 22: renaming the SPACE ROOT's title live is, today, the only existing way a
  // space's effective display name changes post-creation while it's open for editing —
  // see storage.noteSpaceNameChange's doc comment for the full "where does 'name' live" story.
  if (entry.isIndex && entry.dirPath === '') {
    await storage.noteSpaceNameChange(entry.space, storage.extractH1(updated) ?? title);
  }
  await storage.patchEntryContent(entry, updated);
  return true;
}

/**
 * Auto-rename the slug when the title changes and the slug was still the one
 * derived from the OLD title (06.09.2026, owner: "the slug is not renamed
 * after a rename"). A page created as "New page" lives in
 * `new-page.md`; once the user types a real title the file should follow —
 * exactly what the slug dialog would do, backlinks rewritten and all. A slug
 * the user customised (no longer matching the old title) is left alone, as is
 * a space root. Best-effort: a conflict (target exists) or any other failure
 * just keeps the old slug.
 */
export async function maybeAutoRenameSlug(id: string, oldTitle: string | null, newTitle: string | null, author: GitIdentity): Promise<void> {
  if (!oldTitle || !newTitle || oldTitle === newTitle) return;
  const entry = await storage.getEntry(id);
  if (!entry || entry.kind !== 'doc' || entry.isIndex) return;
  const currentSlug = entry.relPath.replace(/^.*\//, '').replace(/\.md$/i, '');
  const oldSlug = translitSlug(oldTitle);
  const newSlug = translitSlug(newTitle);
  // «new-page», «new-page-2», … — every uniqueRelPath variant of the old title counts as auto-derived.
  const derivedFromOld = currentSlug === oldSlug || new RegExp(`^${oldSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+$`).test(currentSlug);
  if (!oldSlug || !newSlug || !derivedFromOld || newSlug === currentSlug) return;
  try {
    storage.validateSlug(newSlug);
    await renamePageSlug(id, newSlug, author);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[collab] auto slug rename skipped for ${id} (${oldSlug} -> ${newSlug}):`, err instanceof Error ? err.message : err);
  }
}

/** Flushes every pending debounced write immediately. Used on graceful shutdown. */
export async function flushAll(): Promise<void> {
  await Promise.all([...writers.values()].map((w) => w.flush()));
}

/** Flushes ONE doc's pending debounced write immediately, if it has one — a no-op for a doc that isn't live or has nothing scheduled. Used by renamePageSlug below so a live backlinking page's rewritten link reaches disk (and the working tree) before that operation's own dedicated commit, instead of racing the normal ~800ms debounce. */
export async function flushDoc(id: string): Promise<void> {
  await writers.get(id)?.flush();
}

/**
 * Slug-rename orchestration (round 22): storage.renamePageSlug does the
 * mechanical fs-rename + reindex (and captures every moved id's backlinks
 * BEFORE its own rename/rescan — see SlugRenameMove.backlinks's doc comment
 * for why that ordering matters); this layer additionally rewrites every
 * INCOMING relative (and `[[`-picked, which are the same thing on disk —
 * see links.rewriteRelativeLinks) link across the space that pointed at
 * whatever moved — the renamed page itself, and, when renaming a
 * directory-index, every page nested under it too, since the whole subtree
 * moves together. Lives here (not storage.ts) so it can route each rewrite
 * through the SAME live-doc-aware path a normal edit uses (editDocBody):
 * without that, a backlinking page that's mid-edit right now would have its
 * file overwritten out from under its open Y.Doc session, exactly the
 * "doubling"/desync class of bug this module otherwise guards hard against.
 * flushDoc then forces that rewrite to disk immediately, so the ONE
 * dedicated commit at the end ("docs: rename <old> -> <new>", never folded
 * into a later generic 'folio: update') actually captures it. Pushing, like
 * every other structural mutation in this app, stays the next debounced/
 * manual sync's job, not this endpoint's.
 *
 * The renamed page's OWN live session (if any) needs no special handling at
 * all: its Yjs room is keyed by `id`, which never changes, and every future
 * read/write resolves the page fresh via storage.requireEntry(id) — so it
 * simply keeps writing to whatever file scanSpace just pointed that id at.
 * Exactly the same reason movePage never needed to touch collab.ts either.
 */
export async function renamePageSlug(id: string, newSlug: string, author: GitIdentity): Promise<PageMeta> {
  const { meta, moved } = await storage.renamePageSlug(id, newSlug);
  if (moved.length === 0) return meta; // same slug as before: nothing moved, nothing to relink or commit

  const rewritesBySource = new Map<string, Array<{ oldRelPath: string; newRelPath: string }>>();
  for (const m of moved) {
    for (const backlink of m.backlinks) {
      const list = rewritesBySource.get(backlink.id) ?? [];
      list.push({ oldRelPath: m.oldRelPath, newRelPath: m.newRelPath });
      rewritesBySource.set(backlink.id, list);
    }
  }

  for (const [sourceId, targets] of rewritesBySource) {
    const srcEntry = await storage.getEntry(sourceId);
    if (!srcEntry || srcEntry.kind !== 'doc') continue; // boards never carry markdown links (see scanSpace)
    const currentBody = isDocLive(sourceId) ? (getLiveText(sourceId) ?? (await storage.readFreshDocBody(sourceId))) : await storage.readFreshDocBody(sourceId);
    let rewritten = currentBody;
    for (const t of targets) rewritten = links.rewriteRelativeLinks(rewritten, srcEntry.dirPath, t.oldRelPath, t.newRelPath);
    if (rewritten !== currentBody) {
      await editDocBody(sourceId, rewritten);
      await flushDoc(sourceId);
    }
  }

  const primary = moved[0];
  await gitSync.commitNow(meta.space, `docs: rename ${primary.oldRelPath} -> ${primary.newRelPath}`, author);
  return meta;
}

// ---------------------------------------------------------------------------
// Auth: session + role on upgrade, and server-side read-only enforcement for
// viewer connections (the UI hiding edit controls is not a guard).
//
// y-protocols/sync.js multiplexes THREE things under top-level messageSync
// (0): messageYjsSyncStep1 (0, a peer announcing its state vector — pure
// information, never mutates anything), messageYjsSyncStep2 (1) and
// messageYjsUpdate (2). Both step2 and update end up calling
// `Y.applyUpdate(doc, ...)` — `readUpdate` is literally `readSyncStep2` under
// another name in that module — so BOTH are how a peer's own edits reach the
// shared doc. A read-only connection is therefore allowed to send: awareness
// frames (top-level type 1 — cursors/presence) and sync step 1 (so it still
// receives everyone else's edits) — never step 2 or update.
// ---------------------------------------------------------------------------

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const SYNC_STEP_1 = 0;

function isReadOnlySafeFrame(raw: ArrayBuffer | Uint8Array): boolean {
  try {
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    const decoder = decoding.createDecoder(bytes);
    const topType = decoding.readVarUint(decoder);
    if (topType === MESSAGE_AWARENESS) return true;
    if (topType === MESSAGE_SYNC) return decoding.readVarUint(decoder) === SYNC_STEP_1;
    return false; // unknown top-level type: fail closed
  } catch {
    return false; // malformed frame: fail closed
  }
}

/**
 * Make the clients' periodic resync (y-websocket `resyncInterval`) work in BOTH
 * directions.
 *
 * y-websocket assumes a reliable transport: a frame the socket swallows is
 * never retransmitted, and the two sides stay diverged until someone
 * reconnects. The client's resync tick sends sync step 1 (its state vector),
 * and the reference server answers with step 2 — which repairs only what the
 * CLIENT is missing. The opposite gap (the server missed the client's edit —
 * exactly what the vite dev proxy's `write EPIPE` produced) stays open.
 *
 * So: whenever a connection announces its state vector, announce ours back.
 * The client answers that with its own diff, and the gap closes. Cost is one
 * state-vector frame per client per resync tick.
 */
function replyWithOwnStateVector(conn: unknown, docName: string): void {
  const doc = docs.get(docName);
  const socket = conn as { readyState?: number; send?: (data: Uint8Array) => void };
  if (!doc || typeof socket.send !== 'function' || socket.readyState !== 1 /* OPEN */) return;
  try {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, doc as unknown as Y.Doc);
    socket.send(encoding.toUint8Array(encoder));
  } catch (err) {
    // Never let a reliability nicety break a live connection.
    // eslint-disable-next-line no-console
    console.error(`[collab] resync reply failed for ${docName}:`, err);
  }
}

/** True when the frame is a sync step 1 — a peer announcing its state vector. */
function isSyncStep1Frame(raw: ArrayBuffer | Uint8Array): boolean {
  try {
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    const decoder = decoding.createDecoder(bytes);
    if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return false;
    return decoding.readVarUint(decoder) === SYNC_STEP_1;
  } catch {
    return false;
  }
}

interface MinimalEmitter {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

/**
 * Patches `conn.on('message', ...)` in place so that when setupWSConnection
 * (below) registers its own listener, incoming update/syncStep2 frames never
 * reach it — they're dropped right here instead. Must run BEFORE
 * setupWSConnection is called for this connection.
 */
function makeReadOnly(conn: unknown): void {
  const emitter = conn as MinimalEmitter;
  const originalOn = emitter.on.bind(emitter);
  emitter.on = ((event: string, listener: (...args: unknown[]) => void) => {
    if (event !== 'message') return originalOn(event, listener);
    return originalOn('message', (data: unknown) => {
      if (isReadOnlySafeFrame(data as ArrayBuffer)) listener(data);
      // else: silently dropped — this is the actual read-only enforcement.
    });
  }) as MinimalEmitter['on'];
}

function rejectUpgrade(socket: { write: (chunk: string) => void; destroy: () => void }, status: number, statusText: string): void {
  socket.write(`HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/** Wires a ws.Server onto the Fastify http.Server for upgrade requests under /collab/<pageId>. */
export function attachToServer(httpServer: HttpServer): void {
  const wss = new WS.WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://internal');
      if (!url.pathname.startsWith('/collab')) return;
      const docName = decodeURIComponent(url.pathname.replace(/^\/collab\/?/, ''));
      if (!docName) {
        rejectUpgrade(socket, 400, 'Bad Request');
        return;
      }

      // The room name is a page id — there is no legitimate room for an unknown one.
      const entry = await storage.getEntry(docName);
      if (!entry) {
        rejectUpgrade(socket, 404, 'Not Found');
        return;
      }
      // A pdf/office page is read-only content, never a Yjs document — there
      // is nothing for a room to hold (bindState below no-ops for it too,
      // this just refuses the connection outright instead of opening a
      // socket that would never do anything).
      if (entry.kind === 'pdf' || entry.kind === 'office') {
        rejectUpgrade(socket, 400, 'Bad Request');
        return;
      }

      // Raw upgrade request: never passes through Fastify/@fastify/cookie, so the
      // session cookie is parsed by hand here (session.parseCookieHeader).
      //
      // Deliberately session.userForToken (cookie-hash lookup only), NOT
      // session.resolveAuth/userForRequest — round 7's PAT Bearer support is
      // intentionally NOT wired in here. DEV-PLAN round 7: "WS /collab does
      // NOT accept a PAT (cookie-only)". A PAT is meant for scripted/MCP callers making
      // discrete, auditable calls (each write attributed to the token owner,
      // MCP writes flagged source=mcp); the live collaborative editor's Y.Doc
      // session is a browser-only concept with no equivalent "scope" story for
      // an open-ended real-time stream, so it stays cookie-only.
      const cookies = session.parseCookieHeader(req.headers.cookie);
      const user = await session.userForToken(cookies[session.SESSION_COOKIE_NAME]);

      let role: Awaited<ReturnType<typeof session.effectiveRole>>;
      let guestIdentity: { name: string; email: string } | undefined;

      // Fix/share-identity: the SESSION wins whenever it grants this user any
      // real access (viewer+) to THIS page — own name/colour in presence, own
      // git commit authorship (gitSync.recordEditor below), own role, full
      // stop, regardless of any `?share=` token also sitting in the query
      // string. A share link only ever falls back into play for the other
      // two cases: no session at all, or a session that grants NOTHING on
      // this specific page (checked via sessionRole below) — previously that
      // second case fell straight through to the unconditional 403 a few
      // lines down, stranding a logged-in visitor a share link would have
      // let straight in. This does NOT let a share token upgrade a session's
      // own (lower) role — a session viewer stays a viewer even through an
      // edit link, exactly as a share link "must not silently upgrade an
      // anonymous guest" already held for the token-only case below.
      const sessionRole = user ? await session.effectivePageRole(user, entry) : undefined;

      if (user && session.roleAtLeast(sessionRole, 'viewer')) {
        role = sessionRole;
      } else {
        // No cookie session, OR a session with no access to this page at all
        // — round 8: a share-link token in the query string is the only
        // other way in, and it grants access to exactly THIS page (the one
        // it was created for), never a whole space. Wrong page, wrong/
        // unknown/revoked token, or no token at all all fail the same way
        // — no distinguishing "valid token, wrong page" from "no token" for
        // an unauthenticated caller (403 instead of 401 only when there IS a
        // session, just one this page doesn't recognize — a real, if
        // uninformative, authorization failure rather than "log in").
        //
        // R23 tail (child navigation in the public share): an includeChildren
        // token ALSO opens the rooms of the pages it collates — as VIEWER
        // only, whatever the token's mode. That is what lets a shared child
        // TABLE render live for a guest (the read-only table surface is the
        // same WS-backed component the root uses); editing stays exactly
        // where it was — the token's own page. Membership is shareGrantsPage
        // (export/shareScope.ts): the index-based subtree set, never a path
        // prefix, so `foo-bar` does not open under a share of `foo`; a
        // single-page token's set holds only its own page, so this branch
        // grants it nothing new. Revocation already killed resolveShareToken
        // above; shareGrantsPage re-resolves and dies just as instantly for
        // connections that race it.
        const shareToken = url.searchParams.get('share');
        const share = shareToken ? await shares.resolveShareToken(shareToken) : undefined;
        if (!share) {
          rejectUpgrade(socket, user ? 403 : 401, user ? 'Forbidden' : 'Unauthorized');
          return;
        }
        if (share.pageId === docName) {
          role = share.mode === 'edit' ? 'editor' : 'viewer';
        } else if (await shareGrantsPage(shareToken!, docName)) {
          role = 'viewer';
        } else {
          rejectUpgrade(socket, user ? 403 : 401, user ? 'Forbidden' : 'Unauthorized');
          return;
        }
        guestIdentity = { name: `Guest via share ${share.id.slice(0, 8)}`, email: 'guest@folio.local' };
      }

      if (!session.roleAtLeast(role, 'viewer')) {
        rejectUpgrade(socket, 403, 'Forbidden');
        return;
      }

      if (session.roleAtLeast(role, 'editor')) {
        gitSync.recordEditor(entry.space, guestIdentity ?? { name: user!.name, email: user!.email });
      }

      // Round 8 P0 fix: seed (or await another connection's already-in-flight
      // seed of) this doc BEFORE handing off to setupWSConnection — see
      // ensureDocSeeded's doc comment above for the full story. Applies
      // identically whether `user` or `guestIdentity` got us here; this was
      // never actually a cookie-vs-share divergence.
      try {
        await ensureDocSeeded(docName);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[collab] failed to seed doc ${docName} before accepting a connection:`, err);
        rejectUpgrade(socket, 500, 'Internal Server Error');
        return;
      }

      wss.handleUpgrade(req, socket, head, (conn) => {
        if (role === 'viewer') makeReadOnly(conn);
        setupWSConnection(conn, req, { docName });
        // After setupWSConnection, so our listener runs alongside its own.
        (conn as MinimalEmitter).on('message', (...args: unknown[]) => {
          const raw = args[0] as ArrayBuffer | Uint8Array;
          if (isSyncStep1Frame(raw)) replyWithOwnStateVector(conn, docName);
        });
      });
    })();
  });
}
