import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type {
  AssistantMessage,
  AssistantRunInfo,
  AssistantRunStep,
  SendAssistantMessageBody,
  StartAssistantRunResponse,
} from '@shared/contracts';
import { api, ApiError } from '../api';
import { subscribeAssistantRun } from './stream';
import { useToast } from '../ui/Toast';
import '../i18n/register';

/** Maps a terminal `error` event's code to a localized toast — see shared/contracts.ts's AssistantStreamEvent. */
function assistantErrorMessage(t: (key: string) => string, code: string): string {
  if (code === 'ASSISTANT_KEY_REQUIRED') return t('assistant.chat.errors.keyRequired');
  if (code === 'ASSISTANT_BUSY') return t('assistant.chat.errors.busy');
  return t('assistant.chat.errors.generic');
}

/**
 * Whether a `GET /api/assistant/chat` snapshot's `activeRun` is still the
 * SAME run we lost the subscription to, and still genuinely going server
 * side — vs. a stale/unrelated run, or none at all (finished, cancelled, or
 * evicted while unreachable). Used by `resyncAfterDisconnect` below to
 * decide "reattach" vs. "render whatever the server ended up with" after a
 * subscription failure — pulled out as a pure function so it's testable
 * without mounting the provider.
 */
export function isSameRunStillActive(trackedRunId: string, active: AssistantRunInfo | null): active is AssistantRunInfo {
  return active !== null && active.runId === trackedRunId && active.status === 'running';
}

/**
 * Terminal-state guarantee (owner report, 22.09.2026 — a SECOND "hangs
 * again" after the same day's loadTerminalFromDb seq fix: two prompts sent,
 * both user bubbles show, no answer, run "apparently alive"). The
 * subscription itself can look perfectly healthy in this failure mode — the
 * server's ~15s pings keep arriving, so `streamOnce`'s silence watchdog
 * never fires and nothing ever throws — while the run has actually already
 * finished server-side and its terminal write simply never reached this
 * client (lost by an intermediary between the two; not reproducible locally
 * without prod access — see the round's report). Nothing before this ever
 * re-checked the server's truth WHILE the connection still looked fine; the
 * heartbeat effect below does, on a timer, entirely independent of whether
 * the subscription itself has noticed anything wrong — this is what it asks
 * on each tick. Pulled out as its own pure predicate (rather than inlining
 * `!isSameRunStillActive(...)` at the call site) so the guarantee itself —
 * "the server's truth about MY run always wins, the moment it disagrees" —
 * has a name and a test independent of isSameRunStillActive's own.
 */
export function heartbeatNeedsResync(trackedRunId: string, serverActiveRun: AssistantRunInfo | null): boolean {
  return !isSameRunStillActive(trackedRunId, serverActiveRun);
}

export interface AssistantRunState {
  /** Metadata of the run currently tracked (non-null for as long as this app instance is watching it — including a stalled reconnect). */
  activeRun: AssistantRunInfo | null;
  /** Accumulated response text for the active run (replay's starting text, plus every `delta` since). */
  streamText: string;
  step: AssistantRunStep | null;
  isRunning: boolean;
  /** True while a dropped connection is backing off before retrying — see stream.ts's subscribeAssistantRun. */
  reconnecting: boolean;
  /**
   * The message a run most recently finished with, kept around after
   * activeRun clears to null so AssistantPanel can show it immediately
   * (as an optimistic entry, deduped by id once the invalidated
   * `['assistant','chat']` query actually refetches it) instead of a blank
   * gap while that refetch is in flight.
   */
  lastMessage: AssistantMessage | null;
  start: (body: SendAssistantMessageBody) => Promise<StartAssistantRunResponse>;
  stop: () => Promise<void>;
  /** AssistantPanel calls this on mount/open-close so a `complete` toast only fires while the panel is hidden. */
  setPanelOpen: (open: boolean) => void;
}

const AssistantRunContext = createContext<AssistantRunState | null>(null);

/** How often the heartbeat effect re-checks the server's truth about a tracked run — see heartbeatNeedsResync's doc comment. Short enough that a stuck run surfaces well before a person gives up and reloads, not so short it's a meaningful load on GET /api/assistant/runs/active (a single Map lookup). */
const HEARTBEAT_MS = 20_000;

/** Read the app's single assistant-run tracker — see AssistantRunProvider's doc comment for where it's mounted. */
export function useAssistantRun(): AssistantRunState {
  const ctx = useContext(AssistantRunContext);
  if (!ctx) throw new Error('useAssistantRun must be used within AssistantRunProvider');
  return ctx;
}

/**
 * Owns the assistant's run state for the app: one provider, mounted in
 * Sidebar right alongside AssistantPanel (Sidebar is always present inside a
 * space — if it unmounts on a space switch, the next mount's effect below
 * re-discovers any run in flight via `GET /api/assistant/runs/active` and
 * resubscribes from the snapshot's `seq`, seeded with its accumulated text).
 *
 * The point of pulling this out of AssistantPanel (05.09.2026 round): a run
 * is a SERVER-side task now, not an HTTP request tied to the panel's
 * lifetime — closing the panel, navigating, or an F5 must not make it look
 * abandoned. This hook keeps exactly one live NDJSON subscription for the
 * user's one active run, independent of whether the panel is currently
 * mounted-and-open, so the Sidebar button's spinner and a "finished" toast
 * both work while the panel is closed.
 */
export function AssistantRunProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation('app');
  const showToast = useToast();
  const queryClient = useQueryClient();

  const [activeRun, setActiveRun] = useState<AssistantRunInfo | null>(null);
  const [streamText, setStreamText] = useState('');
  const [step, setStep] = useState<AssistantRunStep | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [lastMessage, setLastMessage] = useState<AssistantMessage | null>(null);

  // Refs, not state: read inside subscribeAssistantRun's callbacks, which
  // close over whichever render happened to start the subscription — a ref
  // stays current without re-subscribing every time the panel toggles.
  const abortRef = useRef<AbortController | null>(null);
  const panelOpenRef = useRef(false);
  const trackedRunIdRef = useRef<string | null>(null);
  const lastSeqRef = useRef(0);
  // Batches `delta` text into at most one setStreamText per animation frame
  // (owner report, 22.09.2026: "it writes one letter at a time") — on top of the
  // server's own ~75ms coalescing (runs.ts's DELTA_BATCH_MS), this catches
  // the case where several already-batched events still land in the same
  // frame (e.g. a reconnect's replay burst), so that doesn't cost one React
  // render per event either.
  const pendingDeltaRef = useRef('');
  const deltaFrameRef = useRef<number | null>(null);
  /** conversationId of the run currently tracked — kept in a ref (not state) so resyncAfterDisconnect, a stable useCallback, always reads the current one instead of whatever was in scope when it was memoized. */
  const conversationIdRef = useRef<string | null>(null);
  /** Sidesteps a circular useCallback dependency: resyncAfterDisconnect needs to call attachSubscription, which is declared after it and itself calls resyncAfterDisconnect on failure. Kept current by the effect right after attachSubscription's declaration. */
  const attachSubscriptionRef = useRef<(runId: string, since: number) => void>(() => {});

  const setPanelOpen = useCallback((open: boolean) => {
    panelOpenRef.current = open;
  }, []);

  /** Appends to the pending delta buffer and schedules (at most one) rAF to flush it into state — see pendingDeltaRef's own comment. */
  const scheduleDeltaFlush = useCallback((text: string) => {
    pendingDeltaRef.current += text;
    if (deltaFrameRef.current !== null) return;
    deltaFrameRef.current = requestAnimationFrame(() => {
      deltaFrameRef.current = null;
      if (!pendingDeltaRef.current) return;
      const chunk = pendingDeltaRef.current;
      pendingDeltaRef.current = '';
      setStreamText((current) => current + chunk);
    });
  }, []);

  /** Drops any not-yet-flushed delta text and cancels its pending frame — called whenever a run's streamText is about to be reset/replaced from elsewhere, so a stale frame can't append leftover text from a previous/different run onto it. */
  const cancelDeltaFlush = useCallback(() => {
    if (deltaFrameRef.current !== null) {
      cancelAnimationFrame(deltaFrameRef.current);
      deltaFrameRef.current = null;
    }
    pendingDeltaRef.current = '';
  }, []);

  const refreshAfterRun = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['assistant', 'chat'] });
    void queryClient.invalidateQueries({ queryKey: ['assistant', 'conversations'] });
  }, [queryClient]);

  const clearRun = useCallback(() => {
    trackedRunIdRef.current = null;
    conversationIdRef.current = null;
    abortRef.current = null;
    cancelDeltaFlush();
    setActiveRun(null);
    setStreamText('');
    setStep(null);
    setReconnecting(false);
  }, [cancelDeltaFlush]);

  /**
   * Called when `subscribeAssistantRun` itself gives up (reconnect budget
   * exhausted, or any other non-abort/401 failure) — the exact "hung on
   * Reconnecting… forever" bug: previously this just flipped `reconnecting`
   * back to false and left `trackedRunIdRef` pointing at a dead subscription,
   * relying entirely on a `visibilitychange` event (which never fires for a
   * tab that stayed focused the whole time) to ever try again.
   *
   * Re-fetches the conversation (same snapshot `GET /api/assistant/chat`
   * uses for `activeRun`) instead: if the run is still genuinely going
   * server-side, reattach with a fresh reconnect budget; either way,
   * `attachSubscription`'s normal `.then` already knows how to turn
   * whatever `/runs/:runId/events` resolves to (live replay, or the DB's
   * terminal fallback for a run no longer in memory) into a finished state.
   * Only a failure to even reach the server at all ends in a hard stop —
   * a toast plus clearRun(), never an indefinite silent spinner.
   */
  const resyncAfterDisconnect = useCallback(
    async (runId: string) => {
      try {
        const conversation = await api.getAssistantConversation(conversationIdRef.current ?? undefined);
        if (trackedRunIdRef.current !== runId) return; // superseded meanwhile (stop()/start()/unmount)
        const active = conversation.activeRun ?? null;
        if (isSameRunStillActive(runId, active)) {
          setActiveRun(active);
          setStreamText(active.text);
          setStep(active.step);
        }
        attachSubscriptionRef.current(runId, lastSeqRef.current);
      } catch {
        if (trackedRunIdRef.current !== runId) return;
        showToast(assistantErrorMessage(t, 'ASSISTANT_PROVIDER_FAILED'));
        clearRun();
      }
    },
    [clearRun, showToast, t],
  );

  /** (Re)opens the NDJSON subscription for `runId`, starting from `since`. Does not touch activeRun/streamText/step — callers set those first so partial text shows immediately. */
  const attachSubscription = useCallback(
    (runId: string, since: number) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      trackedRunIdRef.current = runId;
      lastSeqRef.current = since;

      subscribeAssistantRun({
        runId,
        since,
        signal: controller.signal,
        onReconnecting: (value) => {
          if (trackedRunIdRef.current === runId) setReconnecting(value);
        },
        onEvent: (event) => {
          if (trackedRunIdRef.current !== runId) return;
          lastSeqRef.current = event.seq;
          if (event.type === 'status') setStep({ status: event.status, label: event.label });
          else if (event.type === 'delta') scheduleDeltaFlush(event.text);
          // complete/stopped/error are terminal — handled below once the promise resolves.
        },
      })
        .then((terminal) => {
          if (trackedRunIdRef.current !== runId) return;
          if (terminal.type === 'complete') {
            setLastMessage(terminal.message);
            refreshAfterRun();
            if (!panelOpenRef.current) showToast(t('assistant.chat.finished'), 'info');
          } else if (terminal.type === 'error') {
            showToast(assistantErrorMessage(t, terminal.code));
          }
          // 'stopped' is silent — the panel already shows the partial text it captured before calling stop().
          clearRun();
        })
        .catch((error: unknown) => {
          if (trackedRunIdRef.current !== runId) return;
          abortRef.current = null;
          if (error instanceof DOMException && error.name === 'AbortError') return; // deliberate stop()/unmount — state already cleared there
          if (error instanceof ApiError && error.status === 401) {
            clearRun();
            return;
          }
          // Reconnect budget exhausted (or another unrecoverable network error): don't just sit
          // there — resync against the server's own record of the run instead of waiting on a
          // visibilitychange that may never come (see resyncAfterDisconnect's doc comment).
          setReconnecting(false);
          void resyncAfterDisconnect(runId);
        });
    },
    [clearRun, refreshAfterRun, showToast, t, resyncAfterDisconnect, scheduleDeltaFlush],
  );

  // Keep a ref mirror of attachSubscription for resyncAfterDisconnect to call — see
  // attachSubscriptionRef's own comment for why this isn't a plain closure reference.
  useEffect(() => {
    attachSubscriptionRef.current = attachSubscription;
  }, [attachSubscription]);

  // Mount: discover any run already in flight (fresh page load / space
  // switch that remounted Sidebar) and resume watching it from its start —
  // the snapshot carries the accumulated text; the subscription continues from its seq.
  useEffect(() => {
    let cancelled = false;
    const adopt = () => {
      // Skip while this instance already tracks a live subscription.
      if (trackedRunIdRef.current) return;
      void api
        .getActiveAssistantRun()
        .then((res) => {
          if (cancelled || !res.run || res.run.status !== 'running' || trackedRunIdRef.current) return;
          conversationIdRef.current = res.run.conversationId;
          setActiveRun(res.run);
          setStreamText(res.run.text);
          setStep(res.run.step);
          // `text` already covers every delta up to `seq` (both taken from the same
          // server snapshot), so subscribe from there — replaying from 0 on top of the
          // seeded text doubled the streamed answer after F5.
          attachSubscription(res.run.runId, res.run.seq);
        })
        .catch(() => undefined);
    };
    adopt();
    // Runs can start outside this tab (another tab, the API, MCP): poll while idle
    // so the button spinner and the panel pick them up without a reload.
    const poll = setInterval(adopt, 15_000);
    return () => {
      cancelled = true;
      clearInterval(poll);
      abortRef.current?.abort();
      abortRef.current = null;
      trackedRunIdRef.current = null;
      if (deltaFrameRef.current !== null) {
        cancelAnimationFrame(deltaFrameRef.current);
        deltaFrameRef.current = null;
      }
    };
    // Intentionally mount-only: attachSubscription is stable via useCallback's own deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A backgrounded tab's fetch stream can die silently (throttled/suspended)
  // without ever rejecting; when the tab comes back and we still think a run
  // is active but nothing is currently subscribed, resume from the last seq
  // this app instance actually saw.
  useEffect(() => {
    function onVisibility() {
      if (document.visibilityState !== 'visible') return;
      if (activeRun && !abortRef.current && trackedRunIdRef.current) {
        attachSubscription(trackedRunIdRef.current, lastSeqRef.current);
      }
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [activeRun, attachSubscription]);

  // Terminal-state guarantee (owner report, 22.09.2026 — see
  // heartbeatNeedsResync's own doc comment for the failure mode this closes):
  // while a run is tracked as active, periodically ask the server what IT
  // thinks is going on for it — independent of whether the live subscription
  // itself has noticed anything wrong. The moment the server disagrees
  // (finished, errored, cancelled, or gone), resyncAfterDisconnect reconciles
  // immediately instead of the panel sitting on "Stop" indefinitely. Bounds
  // the worst case of THIS failure mode to ~HEARTBEAT_MS, not "forever".
  useEffect(() => {
    if (!activeRun) return;
    const runId = activeRun.runId;
    const timer = setInterval(() => {
      if (trackedRunIdRef.current !== runId) return;
      void api
        .getActiveAssistantRun()
        .then((res) => {
          if (trackedRunIdRef.current !== runId) return;
          if (heartbeatNeedsResync(runId, res.run)) void resyncAfterDisconnect(runId);
        })
        .catch(() => undefined); // a failed heartbeat check just tries again next tick — the subscription's own reconnect/silence-timeout logic still covers a genuinely dead connection meanwhile
    }, HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [activeRun, resyncAfterDisconnect]);

  const start = useCallback(
    async (body: SendAssistantMessageBody): Promise<StartAssistantRunResponse> => {
      const res = await api.startAssistantRun(body);
      const run: AssistantRunInfo = {
        runId: res.runId,
        conversationId: res.conversationId,
        runMode: body.runMode,
        status: 'running',
        step: null,
        text: '',
        seq: 0,
        error: null,
        messageId: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      };
      conversationIdRef.current = run.conversationId;
      cancelDeltaFlush(); // drop any not-yet-flushed frame from whatever run preceded this one
      setActiveRun(run);
      setStreamText('');
      setStep(null);
      attachSubscription(run.runId, 0);
      return res;
    },
    [attachSubscription, cancelDeltaFlush],
  );

  const stop = useCallback(async () => {
    const runId = trackedRunIdRef.current;
    abortRef.current?.abort();
    clearRun();
    if (runId) {
      try {
        await api.stopAssistantRun(runId);
      } catch {
        // Best-effort: the events subscription is already torn down locally either way.
      }
    }
    refreshAfterRun();
  }, [clearRun, refreshAfterRun]);

  const value: AssistantRunState = {
    activeRun,
    streamText,
    step,
    isRunning: activeRun !== null,
    reconnecting,
    lastMessage,
    start,
    stop,
    setPanelOpen,
  };

  return <AssistantRunContext.Provider value={value}>{children}</AssistantRunContext.Provider>;
}
