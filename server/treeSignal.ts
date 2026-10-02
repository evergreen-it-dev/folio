/**
 * "The sidebar tree of a space changed" — the live signal (02.10.2026).
 *
 * THE PROBLEM. The sidebar tree is a react-query cache entry that is only
 * refetched by the tab that made a change. A page created by another user, an
 * API/MCP client, the built-in assistant, a Confluence import, a trash restore
 * or a git sync stayed invisible until a reload (the focus refetch and the 30 s
 * poll in PageTree.tsx are the fallbacks, not the mechanism).
 *
 * THE MECHANISM, end to end:
 *
 *   1. WHERE IT IS EMITTED — in the database, by triggers
 *      (db/migrations/031_tree_change_notify.sql) on the three tables the tree
 *      is read from: pages_index, page_access, page_access_grants. They run
 *      `pg_notify('folio_tree_changed', {schema, space})`. Every code path
 *      that changes the tree — REST routes, MCP tools, the assistant, imports,
 *      copy/duplicate, trash, scanSpace after a git sync, a manual psql
 *      session — ends in a write to one of those tables, so there is exactly
 *      one place and no path (today's or next year's) can forget to call it.
 *      A content-only autosave does not touch the columns the triggers watch
 *      and stays silent.
 *   2. HOW IT TRAVELS BETWEEN PROCESSES — PostgreSQL LISTEN/NOTIFY. Postgres
 *      is the one piece of shared infrastructure the app cannot run without;
 *      Redis is best-effort here (server/db/redis.ts degrades when it is down)
 *      and has no pub/sub use, so it is not the bus. Production runs ONE
 *      server process today (the collab rooms are in-memory too), but nothing
 *      below assumes it: every process LISTENs on its own connection and fans
 *      out to ITS OWN sockets, so N processes behind a load balancer work as is.
 *   3. COALESCING — notes arrive per ROW (an import of 200 pages is 200+
 *      notes) and must become few refetches WITHOUT ever making a lone change
 *      wait for them. `createCoalescer` keeps two promises:
 *        - a change is flushed one QUIET window after the last note of its
 *          burst: 0.25 s when the space has been calm, 1.2 s when it flushed
 *          less than 15 s ago (a "run"). That quiet-end flush is NEVER held back by any
 *          pacing, so a rename, a restore, a synced-in file — however busy the
 *          previous minutes were — and the last change of any burst reach the
 *          tabs ~1.2 s after the burst ends at the latest;
 *        - a burst that does NOT go quiet (a dense import, a git pull, copying
 *          a subtree, or a slow import writing a page every second) is paced
 *          by progress flushes instead: the first after at most 5 s when the
 *          space was calm, later ones with a minimum gap that doubles
 *          (2 s, 4 s, 8 s, 10 s) and starts over after 15 s without a flush.
 *          200 pages arrive as a handful of refetches, and the tab still
 *          catches up every few seconds on the way.
 *      An earlier version paced EVERY flush; after a busy stretch a lone rename
 *      then waited for the gap, up to 10 s, and the 30 s poll beat the signal.
 *      The client coalesces once more (web/src/app/sidebar/treeLive.ts).
 *   4. WHO RECEIVES IT — the existing `/events` socket (cookie session, one per
 *      user, already opened by every logged-in tab for notifications): no new
 *      channel, no new auth. At send time, in one query
 *      (store.sessionsThatCanReadSpace), only connections whose session is
 *      still valid AND whose user can read the space (a member, or anybody for
 *      an instance-visible space, never a disabled user) get the frame. A
 *      stranger, a removed member and a logged-out tab get nothing. PATs have
 *      no socket at all; share-link guests have none either — the shared page
 *      view has no sidebar tree of its own, so there is nothing for them to
 *      refresh.
 *   5. WHAT TRAVELS — `{ type: 'tree', space, v }`: the slug and a counter. Never
 *      a title, a path or a page id, also not for a restricted page: a reader
 *      who cannot see a page learns only that "something changed in a space I
 *      can read" (a timing hint about activity, not about content). The client
 *      refetches GET /api/spaces/:space/tree, which does the page-access
 *      filtering exactly as it always did, so the signal cannot widen access.
 *
 * FAILURE MODES. The LISTEN connection is separate from the pool; if it drops,
 * it is re-established with a growing pause and, once back, every space is
 * noted once (changes during the gap are not replayed by Postgres) — the
 * coalescer and the client then turn that into one refetch per watched tree.
 * While it is down the focus refetch and the 30 s poll still catch up.
 */
import type { Client, Notification } from 'pg';
import * as authStore from './auth/store.js';
import { newListenClient, query } from './db/pool.js';
import * as notificationSocket from './notifications/socket.js';

/** The NOTIFY channel the triggers in migration 031 write to. */
export const TREE_SIGNAL_CHANNEL = 'folio_tree_changed';

/**
 * The production timings. Exported so the tests (and anything that wants the
 * same behaviour) take their numbers from one place.
 */
export const COALESCER_DEFAULTS = {
  /** A calm space: a change is flushed this long after the last note of its burst. */
  quietMs: 250,
  /** A space that flushed less than `calmMs` ago is "in a run": the quiet window is longer, so the next burst's notes join ONE flush. */
  busyQuietMs: 1200,
  /** A calm space's first burst never waits longer than this for its first flush, however dense it is. */
  maxWaitMs: 5000,
  /** Progress flushes of a burst that does not go quiet: at least this long after the previous flush, then double, up to `maxGapMs`. */
  minGapMs: 2000,
  maxGapMs: 10_000,
  /** No flush for this long ends a run (the space is calm again: 0.25 s quiet window, pacing starts over). Longer than `maxGapMs`, so a paced run never looks calm in between. */
  calmMs: 15_000,
} as const;

const HEARTBEAT_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10_000, 30_000];

export interface CoalescerOptions {
  /** See COALESCER_DEFAULTS for what each number means. `busyQuietMs` and below default to "off". */
  quietMs: number;
  maxWaitMs: number;
  busyQuietMs?: number;
  minGapMs?: number;
  maxGapMs?: number;
  calmMs?: number;
  onFlush: (key: string) => void;
}

export interface Coalescer {
  note(key: string): void;
  cancelAll(): void;
}

/**
 * Per-key coalescing (see the header, point 3, for the promises it keeps).
 * Every note recomputes when the key is due and replaces its timer:
 *
 *   due = min( lastNote + quiet,                 // the burst went quiet -> flush, whatever the pacing says
 *              progress )                         // a burst that does not -> flush on the paced schedule
 *   quiet    = the key flushed < calmMs ago ? busyQuietMs : quietMs
 *   progress = the key flushed < calmMs ago ? max(lastFlush + gap(run length), firstNote + quietMs)
 *                                           : firstNote + maxWaitMs
 *
 * Keys do not delay each other.
 */
export function createCoalescer(options: CoalescerOptions): Coalescer {
  const { quietMs, maxWaitMs, busyQuietMs = quietMs, minGapMs = 0, maxGapMs = 0, calmMs = 0, onFlush } = options;
  const pending = new Map<string, { firstAt: number; timer: ReturnType<typeof setTimeout> }>();
  /** The last flush per key and how many flushes in a row (each less than `calmMs` after the one before) the current run has had, that one included. */
  const history = new Map<string, { lastFlushAt: number; count: number }>();

  function gapAfter(count: number): number {
    if (minGapMs <= 0) return 0;
    return Math.min(minGapMs * 2 ** (count - 1), Math.max(maxGapMs, minGapMs));
  }

  function fire(key: string): void {
    pending.delete(key);
    const now = Date.now();
    const last = history.get(key);
    history.set(key, { lastFlushAt: now, count: last && now - last.lastFlushAt < calmMs ? last.count + 1 : 1 });
    onFlush(key);
  }

  return {
    note(key) {
      const now = Date.now();
      const existing = pending.get(key);
      if (existing) clearTimeout(existing.timer);
      const firstAt = existing?.firstAt ?? now;
      const last = history.get(key);
      const busy = last !== undefined && now - last.lastFlushAt < calmMs;
      const quietDue = now + (busy ? busyQuietMs : quietMs);
      // Never earlier than a calm quiet window after the burst's FIRST note, so a flush that is already "due" does not fire on a lone note's heels.
      const progressDue = busy ? Math.max(last.lastFlushAt + gapAfter(last.count), firstAt + quietMs) : firstAt + maxWaitMs;
      const timer = setTimeout(() => fire(key), Math.max(0, Math.min(quietDue, progressDue) - now));
      // A pending flush must not keep the process alive by itself.
      timer.unref?.();
      pending.set(key, { firstAt, timer });
    },
    cancelAll() {
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear();
      history.clear();
    },
  };
}

export type TreeSignalOptions = Partial<Omit<CoalescerOptions, 'onFlush'>>;

interface Running {
  coalescer: Coalescer;
  client: Client | null;
  schema: string;
  stopped: boolean;
  everConnected: boolean;
  attempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  versions: Map<string, number>;
}

let running: Running | null = null;

/** Tells the readers of `space` that its tree changed; the one and only fan-out. */
async function flush(state: Running, space: string): Promise<void> {
  try {
    const tokens = notificationSocket.openSessionTokens();
    if (tokens.length === 0) return;
    const allowed = await authStore.sessionsThatCanReadSpace(space, tokens);
    if (allowed.size === 0 || state.stopped) return;
    const v = (state.versions.get(space) ?? 0) + 1;
    state.versions.set(space, v);
    notificationSocket.sendToSessions(allowed, { type: 'tree', space, v });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[tree-signal] could not fan out a change of "${space}": ${(err as Error).message}`);
  }
}

function onNotification(state: Running, message: Notification): void {
  if (message.channel !== TREE_SIGNAL_CHANNEL || !message.payload) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(message.payload);
  } catch {
    return; // not ours, or garbage: a signal must never throw into the pg client
  }
  if (typeof parsed !== 'object' || parsed === null) return;
  const { schema, space } = parsed as { schema?: unknown; space?: unknown };
  if (typeof schema !== 'string' || typeof space !== 'string' || schema !== state.schema) return;
  state.coalescer.note(space);
}

function scheduleReconnect(state: Running): void {
  if (state.stopped || state.reconnectTimer) return;
  const delay = RECONNECT_DELAYS_MS[Math.min(state.attempt, RECONNECT_DELAYS_MS.length - 1)];
  state.attempt += 1;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    void connect(state);
  }, delay);
  state.reconnectTimer.unref?.();
}

function dropClient(state: Running, client: Client): void {
  if (state.client !== client) return;
  state.client = null;
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
  client.removeAllListeners();
  // Late errors of a half-dead socket must not become an unhandled 'error' event.
  client.on('error', () => undefined);
  void client.end().catch(() => undefined);
  scheduleReconnect(state);
}

/** After a gap nobody replays what was missed: note every space once; the coalescer and the client do the rest. */
async function resync(state: Running): Promise<void> {
  try {
    const rows = await query<{ slug: string }>('SELECT slug FROM spaces');
    for (const row of rows) state.coalescer.note(row.slug);
  } catch {
    // The database is not answering either; the next successful connect resyncs again.
  }
}

async function connect(state: Running): Promise<void> {
  if (state.stopped) return;
  const client = newListenClient();
  client.on('notification', (message) => onNotification(state, message));
  client.on('error', (err) => {
    // eslint-disable-next-line no-console
    if (state.client === client) console.warn(`[tree-signal] listen connection error: ${err.message}`);
    dropClient(state, client);
  });
  client.on('end', () => dropClient(state, client));
  try {
    await client.connect();
    const { rows } = await client.query<{ schema: string }>('SELECT current_schema() AS schema');
    state.schema = rows[0].schema;
    await client.query(`LISTEN ${TREE_SIGNAL_CHANNEL}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[tree-signal] cannot listen yet, the sidebar falls back to refetch on focus and the poll: ${(err as Error).message}`);
    state.client = client;
    dropClient(state, client);
    return;
  }
  if (state.stopped) {
    client.removeAllListeners();
    void client.end().catch(() => undefined);
    return;
  }
  state.client = client;
  state.attempt = 0;
  const reconnected = state.everConnected;
  state.everConnected = true;

  // A connection that died without a FIN (a proxy, a sleeping VM) is found by asking it something.
  state.heartbeatTimer = setInterval(() => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const dead = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('heartbeat timed out')), HEARTBEAT_TIMEOUT_MS);
    });
    Promise.race([client.query('SELECT 1'), dead])
      .catch(() => dropClient(state, client))
      .finally(() => clearTimeout(timeout));
  }, HEARTBEAT_MS);
  state.heartbeatTimer.unref?.();

  if (reconnected) await resync(state);
}

/**
 * Starts listening. Resolves once the first attempt has finished — LISTEN is
 * active if it worked; if it did not, a warning was logged and retries are
 * scheduled (never throws: the sidebar still has its fallbacks).
 */
export async function startTreeSignal(options: TreeSignalOptions = {}): Promise<void> {
  if (running) return;
  const state: Running = {
    coalescer: createCoalescer({
      ...COALESCER_DEFAULTS,
      ...options,
      onFlush: (space) => void flush(state, space),
    }),
    client: null,
    schema: 'public',
    stopped: false,
    everConnected: false,
    attempt: 0,
    reconnectTimer: null,
    heartbeatTimer: null,
    versions: new Map(),
  };
  running = state;
  await connect(state);
}

export async function stopTreeSignal(): Promise<void> {
  const state = running;
  if (!state) return;
  running = null;
  state.stopped = true;
  state.coalescer.cancelAll();
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
  const client = state.client;
  state.client = null;
  if (client) {
    client.removeAllListeners();
    client.on('error', () => undefined);
    await client.end().catch(() => undefined);
  }
}
