/**
 * AI assistant — RunManager (05.09.2026, db/migrations/024_ai_runs.sql).
 *
 * The principle: an agent run is a server job (an `ai_runs` row + in-memory
 * RunState), NOT an action that lasts inside one HTTP request. `startRun`
 * returns `{ runId, conversationId }` at once; the run itself, through
 * `runCursorAssistant`, is fire-and-forget (`executeRun`, not awaited by the
 * caller). The HTTP level (routes.ts) only subscribes to events through
 * `subscribe`/`peek`/`loadTerminalFromDb` — a dropped connection NEVER
 * cancels a run, only an explicit `stop()` does.
 *
 * The event buffer of a run (everything except `ping`) is kept in memory with
 * a sequential `seq`, so a late or repeated subscriber (after F5, or a second
 * viewer) gets replay(seq > since) and then live events. The terminal event
 * (complete/stopped/error) sits in the buffer too — so a subscription that
 * joined AFTER the run finished (while it is still in memory, until the
 * 15-minute eviction) gets the replay with the terminal event at once and
 * waits for nothing live.
 *
 * Persistence to the database (`ai_runs.text`/`step_status`/`step_label`) is
 * throttled to once per 5 s, SO THAT after F5 or a restart the database shows
 * what the agent managed to do; the terminal fields
 * (`status`/`finished_at`/`error`/`message_id`) are written synchronously and
 * unconditionally at the moment of completion.
 *
 * `onTextDelta` calls (the Cursor SDK emits them practically per token) do
 * NOT become `delta` events one to one — they go through `deltaBatcher.ts`,
 * which coalesces them into ~DELTA_BATCH_MS windows before `emit()`
 * (22.09.2026, the "one letter at a time" complaint). `run.text` (the
 * snapshot for F5/reconnect) stays synchronous every time; only the outgoing
 * event is batched.
 */
import { randomUUID } from 'node:crypto';
import type {
  AssistantMessage,
  AssistantRunEvent,
  AssistantRunInfo,
  AssistantRunMode,
  AssistantRunStatus,
  AssistantRunStep,
  User,
} from '../../shared/contracts.js';
import { conflict } from '../errors.js';
import { query, queryOne } from '../db/pool.js';
import * as assistantStore from './store.js';
import type { AssistantConversationRow } from './store.js';
import { AssistantRunCancelledError, runCursorAssistant } from './cursorRuntime.js';
import { createDeltaBatcher, type DeltaBatcher } from './deltaBatcher.js';
import { authorizeAssistantNavigation } from './access.js';

/** After a distributive Omit — plain `Omit<Union, K>` collapses a discriminated union to its common-key intersection, silently dropping the per-variant fields (`message`, `text`, `code`, …). This distributes over each member first. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type BufferableEvent = DistributiveOmit<Exclude<AssistantRunEvent, { type: 'ping' }>, 'seq'>;
/** The subset of AssistantRunEvent that actually carries `seq` — i.e. everything but `ping` (never buffered, see PING_INTERVAL_MS's own comment). This is what `RunState.events` holds, so reading `.seq` back off it doesn't need a `ping` guard every time. */
type BufferedEvent = Extract<AssistantRunEvent, { seq: number }>;

interface RunState {
  id: string;
  conversationId: string;
  userId: string;
  runMode: AssistantRunMode;
  status: AssistantRunStatus;
  step: AssistantRunStep | null;
  text: string;
  error: string | null;
  messageId: string | null;
  startedAt: string;
  finishedAt: string | null;
  events: BufferedEvent[];
  seq: number;
  subscribers: Set<(event: AssistantRunEvent) => void>;
  abort: AbortController;
  cancel?: () => Promise<void>;
  pingTimer?: NodeJS.Timeout;
  lastPersist: number;
  donePromise: Promise<void>;
  resolveDone: () => void;
  /** Coalesces onTextDelta's per-token calls into ~DELTA_BATCH_MS frames before they become `delta` events — see deltaBatcher.ts's doc comment for the "one letter at a time" report this fixes. */
  deltaBatcher: DeltaBatcher;
}

/** Live runs — kept 15 min after a terminal state (for late subscribers/replay), then only `ai_runs` in the DB has the history. */
const runsById = new Map<string, RunState>();
/** conversationId -> runId, ONLY while that run is `running` — the "one run per conversation" gate and the `activeRun`/`activeRunId` lookups. Deleted the moment a run settles. */
const activeByConversation = new Map<string, string>();

const TERMINAL_STATUSES: ReadonlySet<AssistantRunStatus> = new Set(['done', 'error', 'cancelled']);
const RETAIN_MS = 15 * 60_000;
// Overridable only for runs.test.ts (real time, no fake timers there) — a
// real subscriber never needs faster than 15s to stay alive through a proxy.
const PING_INTERVAL_MS = Number(process.env.ASSISTANT_RUN_PING_INTERVAL_MS) || 15_000;
const PERSIST_THROTTLE_MS = 5_000;
// Owner report (22.09.2026, "it writes one letter at a time"): the Cursor SDK's own
// onDelta fires per-token; without this, every token became its own NDJSON
// write AND its own client re-render. 75ms sits in the 50-100ms range that
// still reads as a smooth stream to the eye but cuts event/render count by
// roughly 4-8x for a typical token cadence — see deltaBatcher.test.ts.
const DELTA_BATCH_MS = Number(process.env.ASSISTANT_DELTA_BATCH_MS) || 75;

function emit(run: RunState, event: BufferableEvent): void {
  run.seq += 1;
  const full = { ...event, seq: run.seq } as BufferedEvent;
  run.events.push(full);
  for (const sub of run.subscribers) sub(full);
}

function pingAll(run: RunState): void {
  for (const sub of run.subscribers) sub({ type: 'ping' });
}

function toRunInfo(run: RunState): AssistantRunInfo {
  return {
    runId: run.id,
    conversationId: run.conversationId,
    runMode: run.runMode,
    status: run.status,
    step: run.step,
    text: run.text,
    seq: run.seq,
    error: run.error,
    messageId: run.messageId,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

// ---------------------------------------------------------------------------
// DB (ai_runs) — raw here rather than store.ts: tightly coupled to RunState's
// own shape and only ever called from this module.
// ---------------------------------------------------------------------------

interface RawRunRow {
  id: string;
  conversation_id: string;
  user_id: string;
  run_mode: AssistantRunMode;
  status: AssistantRunStatus;
  step_status: string | null;
  step_label: string | null;
  text: string;
  error: string | null;
  message_id: string | null;
  started_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

async function dbInsertRun(row: {
  id: string;
  conversationId: string;
  userId: string;
  runMode: AssistantRunMode;
  space: string | null;
  pageId: string | null;
  userMessageId: string;
}): Promise<void> {
  await query(
    `INSERT INTO ai_runs (id, conversation_id, user_id, run_mode, status, space, page_id, user_message_id)
     VALUES ($1, $2, $3, $4, 'running', $5, $6, $7)`,
    [row.id, row.conversationId, row.userId, row.runMode, row.space, row.pageId, row.userMessageId],
  );
}

async function dbPersistProgress(runId: string, progress: { text: string; stepStatus: string | null; stepLabel: string | null }): Promise<void> {
  await query(
    `UPDATE ai_runs SET text = $2, step_status = $3, step_label = $4, updated_at = now() WHERE id = $1`,
    [runId, progress.text, progress.stepStatus, progress.stepLabel],
  );
}

async function dbFinishRun(
  runId: string,
  final: { status: 'done' | 'error' | 'cancelled'; text: string; messageId: string | null; error: string | null },
): Promise<void> {
  await query(
    `UPDATE ai_runs SET status = $2, text = $3, message_id = $4, error = $5, finished_at = now(), updated_at = now() WHERE id = $1`,
    [runId, final.status, final.text, final.messageId, final.error],
  );
}

async function dbGetRun(runId: string): Promise<RawRunRow | undefined> {
  return queryOne<RawRunRow>('SELECT * FROM ai_runs WHERE id = $1', [runId]);
}

/** Boot recovery (server/index.ts, after runMigrations): a `running` row means the process died mid-run — there is no in-memory RunState to resume it into, so it is lost. Marked `error` so the conversation doesn't look stuck forever. */
export async function recoverAfterRestart(): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE ai_runs SET status = 'error', error = 'server restarted', finished_at = now(), updated_at = now() WHERE status = 'running' RETURNING id`,
  );
  if (rows.length > 0) {
    console.warn(`assistant runs: marked ${rows.length} orphaned running run(s) as error after restart: ${rows.map((r) => r.id).join(', ')}`);
  }
  return rows.length;
}

/**
 * seq stamped on a DB-reconstructed terminal event (loadTerminalFromDb below)
 * — deliberately NOT part of the run's own buffer numbering, because there
 * is no buffer left by the time this is used. It must beat any `since` a
 * reconnecting client could legitimately send, or GET /runs/:runId/events's
 * own `event.seq > since` gate silently drops it and the client (seeing a
 * clean-but-empty response, not an error) just reconnects again forever.
 *
 * This used to be hardcoded to `1`, on the reasoning that "since is at most
 * the run's own last live seq" — backwards: `since` is exactly the count of
 * real events the client already received live BEFORE the run left memory
 * (eviction after RETAIN_MS, or a server restart mid-run), which is often
 * well past 1 for anything but a one-liner reply. Any run with real seq
 * history reconnecting after eviction got `1 > since` = false, an empty
 * body, and `streamOnce` read that as "closed cleanly, no terminal event" —
 * exactly the prod symptom (narration visible, then stuck on
 * "Reconnecting…" with a Stop button, no error, no answer, forever): each
 * reconnect "succeeded" (200, empty body) so subscribeAssistantRun's own
 * give-up budget kept resetting to 0 on every cycle instead of ever
 * expiring into a surfaced error.
 */
const HISTORICAL_EVENT_SEQ = Number.MAX_SAFE_INTEGER;

/** Rebuilds a terminal AssistantRunEvent for a run that is no longer in memory (evicted after RETAIN_MS, or lost across a restart) — used by GET /runs/:runId/events as the one-shot fallback. See HISTORICAL_EVENT_SEQ for why its seq is what it is. */
export async function loadTerminalFromDb(runId: string): Promise<{ userId: string; conversationId: string; event: AssistantRunEvent } | null> {
  const row = await dbGetRun(runId);
  if (!row) return null;
  let event: AssistantRunEvent;
  if (row.status === 'done' && row.message_id) {
    const message = await assistantStore.findMessageById(row.message_id);
    event = message
      ? { type: 'complete', conversationId: row.conversation_id, seq: HISTORICAL_EVENT_SEQ, message: serializeMessage(message) }
      : { type: 'error', code: 'ASSISTANT_PROVIDER_FAILED', seq: HISTORICAL_EVENT_SEQ };
  } else if (row.status === 'cancelled') {
    event = { type: 'stopped', conversationId: row.conversation_id, seq: HISTORICAL_EVENT_SEQ };
  } else {
    // 'error', or a stale 'running' this call raced with recoverAfterRestart on — both surface as an error to the client.
    event = { type: 'error', code: 'ASSISTANT_PROVIDER_FAILED', seq: HISTORICAL_EVENT_SEQ };
  }
  return { userId: row.user_id, conversationId: row.conversation_id, event };
}

function serializeMessage(row: { id: string; role: 'user' | 'assistant'; content: string; createdAt: Date }): AssistantMessage {
  return { id: row.id, role: row.role, content: row.content, createdAt: row.createdAt.toISOString() };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface StartRunInput {
  user: User;
  conversation: AssistantConversationRow;
  message: string;
  runMode: AssistantRunMode;
  currentPath: string | null;
  space: string | null;
  pageId: string | null;
  apiKey: string;
}

/**
 * One run per conversation at a time — a second start while one is `running` is a 409, same as the pre-runs.ts `activeConversations` guard.
 *
 * The `space`/`pageId` come from the client, so they are authorized here
 * first (security review F-05): a run for a space the user cannot read is
 * refused before it leaves a message, a run row or a workspace behind. The
 * routes already did this before touching the conversation; this keeps the
 * guarantee for any other caller of the RunManager.
 */
export async function startRun(input: StartRunInput): Promise<{ runId: string; conversationId: string }> {
  await authorizeAssistantNavigation(input.user, input);
  const conversationId = input.conversation.id;
  if (activeByConversation.has(conversationId)) throw conflict('This assistant conversation is already processing a message');

  const runId = randomUUID();
  // Reserve the slot synchronously (before the first await) so two concurrent
  // POSTs for the same conversation can't both pass the check above.
  activeByConversation.set(conversationId, runId);
  try {
    const userMessage = await assistantStore.insertMessage(conversationId, 'user', input.message);
    await dbInsertRun({
      id: runId,
      conversationId,
      userId: input.user.id,
      runMode: input.runMode,
      space: input.space ?? null,
      pageId: input.pageId ?? null,
      userMessageId: userMessage.id,
    });
  } catch (err) {
    activeByConversation.delete(conversationId);
    throw err;
  }

  let resolveDone!: () => void;
  const donePromise = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  // deltaBatcher's onFlush closes over `run`, which doesn't exist yet at
  // object-literal time — declared with `let` and assigned right after.
  let run!: RunState;
  const deltaBatcher = createDeltaBatcher({
    intervalMs: DELTA_BATCH_MS,
    onFlush: (text) => emit(run, { type: 'delta', text }),
  });
  run = {
    id: runId,
    conversationId,
    userId: input.user.id,
    runMode: input.runMode,
    status: 'running',
    step: { status: 'starting' },
    text: '',
    error: null,
    messageId: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    events: [],
    seq: 0,
    subscribers: new Set(),
    abort: new AbortController(),
    lastPersist: 0,
    donePromise,
    resolveDone,
    deltaBatcher,
  };
  runsById.set(runId, run);
  run.pingTimer = setInterval(() => pingAll(run), PING_INTERVAL_MS);
  run.pingTimer.unref?.();
  emit(run, { type: 'status', status: 'starting' });
  console.log(`assistant run ${runId}: started (conversation ${conversationId}, mode ${input.runMode})`);

  void executeRun(run, input);

  return { runId, conversationId };
}

function setStep(run: RunState, step: AssistantRunStep): void {
  if (run.step && run.step.status === step.status && run.step.label === step.label) return;
  // Flush any buffered delta text FIRST — otherwise a status change (tool
  // call, thinking) could reach subscribers before the text that preceded it
  // once that text's own batch timer finally fires, scrambling the visible
  // order (text after "calling tool X" when it was actually written before).
  run.deltaBatcher.flush();
  run.step = step;
  emit(run, { type: 'status', status: step.status, label: step.label });
}

function maybePersist(run: RunState): void {
  const now = Date.now();
  if (now - run.lastPersist < PERSIST_THROTTLE_MS) return;
  run.lastPersist = now;
  void dbPersistProgress(run.id, { text: run.text, stepStatus: run.step?.status ?? null, stepLabel: run.step?.label ?? null }).catch((err) => {
    console.warn(`assistant run ${run.id}: progress persist failed:`, err instanceof Error ? err.message : err);
  });
}

async function executeRun(run: RunState, input: StartRunInput): Promise<void> {
  try {
    let replyText: string;
    try {
      replyText = await runCursorAssistant({
        runId: run.id,
        apiKey: input.apiKey,
        user: input.user,
        conversation: input.conversation,
        message: input.message,
        currentPath: input.currentPath,
        space: input.space,
        pageId: input.pageId,
        runMode: input.runMode,
        signal: run.abort.signal,
        onRun: (cursorRun) => {
          run.cancel = () => cursorRun.cancel();
        },
        onTextDelta: (text) => {
          // run.text (the snapshot a reconnecting/F5'd client sees via
          // GET /api/assistant/chat's activeRun, and what maybePersist
          // writes to ai_runs) stays updated on EVERY call, synchronously —
          // only the live `delta` EVENT to subscribers is batched below.
          run.text += text;
          setStep(run, { status: 'writing' }); // no-op after the first delta (see setStep's dedup guard) — flushes only the true first token, not the whole stream
          run.deltaBatcher.push(text);
          maybePersist(run);
        },
        onTool: (name) => {
          setStep(run, { status: 'tool', label: name });
          maybePersist(run);
        },
        onEvent: (event) => {
          if (event.type === 'thinking') setStep(run, { status: 'thinking' });
          else if (event.type === 'tool_call') setStep(run, { status: 'tool', label: event.name });
          else if (event.type === 'task' && event.text) setStep(run, { status: 'thinking', label: event.text });
          else return;
          maybePersist(run);
        },
      });
    } catch (err) {
      if (err instanceof AssistantRunCancelledError || run.abort.signal.aborted) {
        await finishCancelled(run);
        return;
      }
      throw err;
    }
    await finishDone(run, replyText);
  } catch (err) {
    await finishError(run, err);
  }
}

async function finishDone(run: RunState, replyText: string): Promise<void> {
  // Any text still sitting in the batcher's buffer becomes its own `delta`
  // event now, ahead of `complete` — a live subscriber's streamText should
  // already equal the final text by the time `complete` arrives, not jump.
  run.deltaBatcher.flush();
  const saved = await assistantStore.insertMessage(run.conversationId, 'assistant', replyText);
  run.status = 'done';
  run.text = replyText;
  run.messageId = saved.id;
  run.finishedAt = new Date().toISOString();
  await dbFinishRun(run.id, { status: 'done', text: replyText, messageId: saved.id, error: null });
  console.log(`assistant run ${run.id}: done (conversation ${run.conversationId})`);
  emit(run, { type: 'complete', conversationId: run.conversationId, message: serializeMessage(saved) });
  settle(run);
}

async function finishCancelled(run: RunState): Promise<void> {
  run.deltaBatcher.flush();
  if (run.text.trim()) {
    const saved = await assistantStore.insertMessage(run.conversationId, 'assistant', run.text);
    run.messageId = saved.id;
  }
  run.status = 'cancelled';
  run.finishedAt = new Date().toISOString();
  await dbFinishRun(run.id, { status: 'cancelled', text: run.text, messageId: run.messageId, error: null });
  console.log(`assistant run ${run.id}: cancelled (conversation ${run.conversationId})`);
  emit(run, { type: 'stopped', conversationId: run.conversationId });
  settle(run);
}

async function finishError(run: RunState, err: unknown): Promise<void> {
  run.deltaBatcher.flush();
  const message = err instanceof Error ? err.message : String(err);
  run.status = 'error';
  run.error = message;
  run.finishedAt = new Date().toISOString();
  await dbFinishRun(run.id, { status: 'error', text: run.text, messageId: null, error: message }).catch((dbErr) => {
    console.warn(`assistant run ${run.id}: failed to persist terminal error:`, dbErr instanceof Error ? dbErr.message : dbErr);
  });
  console.warn(`assistant run ${run.id}: provider failed (conversation ${run.conversationId}): ${message}`);
  emit(run, { type: 'error', code: 'ASSISTANT_PROVIDER_FAILED' });
  settle(run);
}

function settle(run: RunState): void {
  if (run.pingTimer) clearInterval(run.pingTimer);
  run.deltaBatcher.dispose(); // each finish* already flushed; this only guards a path that somehow didn't
  if (activeByConversation.get(run.conversationId) === run.id) activeByConversation.delete(run.conversationId);
  run.resolveDone();
  const evictTimer = setTimeout(() => runsById.delete(run.id), RETAIN_MS);
  evictTimer.unref?.();
}

/** `runId` ownership + status, without the replay side effects of `subscribe` — routes.ts uses this to decide between the live path and the DB fallback, and to 404 a run that belongs to someone else before hijacking the response. */
export function peek(runId: string): { userId: string; conversationId: string; status: AssistantRunStatus } | null {
  const run = runsById.get(runId);
  return run ? { userId: run.userId, conversationId: run.conversationId, status: run.status } : null;
}

/**
 * Replays buffered events with `seq > since`, then (unless the run is
 * already terminal — the replay above already included its terminal event)
 * registers `onEvent` for live events. Returns an unsubscribe function, or
 * `null` if the run isn't in memory (evicted or never existed — the caller
 * should fall back to `loadTerminalFromDb`).
 */
export function subscribe(runId: string, since: number, onEvent: (event: AssistantRunEvent) => void): (() => void) | null {
  const run = runsById.get(runId);
  if (!run) return null;
  for (const event of run.events) {
    if (event.seq > since) onEvent(event);
  }
  if (TERMINAL_STATUSES.has(run.status)) return () => {};
  run.subscribers.add(onEvent);
  return () => run.subscribers.delete(onEvent);
}

/** `stop(runId, userId)` — the only way a run is cancelled. Returns `false` for a 404 (unknown run, or one that belongs to another user); `true` once the run has settled to `cancelled` (idempotent: a already-terminal run is a no-op success). */
export async function stop(runId: string, userId: string): Promise<boolean> {
  const run = runsById.get(runId);
  if (!run || run.userId !== userId) return false;
  if (run.status === 'running') {
    console.log(`assistant run ${runId}: stop requested`);
    run.abort.abort();
    await run.cancel?.().catch(() => undefined);
    await run.donePromise;
  }
  return true;
}

export function getActiveRunForUser(userId: string): AssistantRunInfo | null {
  for (const run of runsById.values()) {
    if (run.userId === userId && run.status === 'running') return toRunInfo(run);
  }
  return null;
}

export function getActiveRunForConversation(conversationId: string): AssistantRunInfo | null {
  const runId = activeByConversation.get(conversationId);
  if (!runId) return null;
  const run = runsById.get(runId);
  return run && run.status === 'running' ? toRunInfo(run) : null;
}
