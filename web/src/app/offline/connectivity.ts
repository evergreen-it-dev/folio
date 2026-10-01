/**
 * What the app knows about its own connection, in three states the owner
 * asked to SEE (29.09.2026: "an indicator of a bad connection and of offline mode"):
 *
 *  - `online`   — requests go through and come back promptly;
 *  - `degraded` — the server is reachable but slow or dropping requests:
 *                 things work, saving may lag, nothing is lost;
 *  - `offline`  — the server cannot be reached: new pages and edits stay on
 *                 this device until it can.
 *
 * `navigator.onLine` alone is not the answer: it says "there is a network
 * interface", which is true on a train in a tunnel and on hotel wifi behind
 * a login page. So the state is driven by what actually happens to
 * requests — a cheap probe of `GET /api/health` on a timer, plus the outcome
 * of every real API call (`reportRequest`, called by api.ts) — with the
 * browser's own `offline` event as the one signal trusted on the spot.
 *
 * The decision itself is a pure reducer (`reduceConnectivity`), so its
 * thresholds are tested without timers or fetch.
 */
import { useSyncExternalStore } from 'react';

export type Connectivity = 'online' | 'degraded' | 'offline';

export interface ConnectivityModel {
  state: Connectivity;
  /** Consecutive failed probes/requests. */
  failures: number;
  /** Consecutive slow probes. */
  slow: number;
  /** Latency of the last successful probe, ms. */
  latencyMs: number | null;
  browserOnline: boolean;
}

export type ConnectivityEvent =
  | { type: 'browser'; online: boolean }
  /** `latencyMs` only from the health probe — a real request may be legitimately long (an export, an import). */
  | { type: 'success'; latencyMs?: number }
  | { type: 'failure' };

/** A probe slower than this counts as slow; two in a row make the connection `degraded`. */
export const SLOW_PROBE_MS = 1500;
/** One failure is a hiccup (`degraded`); this many in a row is `offline`. */
export const OFFLINE_AFTER_FAILURES = 2;
const SLOW_STREAK = 2;

export const PROBE_INTERVAL_MS: Record<Connectivity, number> = {
  online: 30_000,
  degraded: 10_000,
  offline: 5_000,
};
const PROBE_TIMEOUT_MS = 5_000;

export const INITIAL_CONNECTIVITY: ConnectivityModel = {
  state: 'online',
  failures: 0,
  slow: 0,
  latencyMs: null,
  browserOnline: true,
};

export function reduceConnectivity(model: ConnectivityModel, event: ConnectivityEvent): ConnectivityModel {
  switch (event.type) {
    case 'browser':
      // Going offline is believed at once. Coming back is not: the interface
      // being up says nothing about the server — the next success decides.
      return event.online
        ? { ...model, browserOnline: true }
        : { ...model, browserOnline: false, state: 'offline', failures: Math.max(model.failures, OFFLINE_AFTER_FAILURES) };
    case 'failure': {
      const failures = model.failures + 1;
      return { ...model, failures, state: failures >= OFFLINE_AFTER_FAILURES ? 'offline' : 'degraded' };
    }
    case 'success': {
      const measured = event.latencyMs !== undefined;
      const slow = measured ? (event.latencyMs! > SLOW_PROBE_MS ? model.slow + 1 : 0) : model.slow;
      return {
        ...model,
        failures: 0,
        slow,
        latencyMs: measured ? event.latencyMs! : model.latencyMs,
        browserOnline: true,
        state: slow >= SLOW_STREAK ? 'degraded' : 'online',
      };
    }
  }
}

let model: ConnectivityModel = INITIAL_CONNECTIVITY;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let probing = false;

function apply(event: ConnectivityEvent): void {
  const next = reduceConnectivity(model, event);
  const changed = next.state !== model.state;
  model = next;
  if (changed) {
    for (const listener of [...listeners]) listener();
    // The cadence depends on the state; a change re-arms the timer at once.
    if (running) schedule();
  }
}

export function getConnectivity(): Connectivity {
  return model.state;
}

export function getConnectivityModel(): ConnectivityModel {
  return model;
}

export function subscribeConnectivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useConnectivity(): Connectivity {
  return useSyncExternalStore(subscribeConnectivity, getConnectivity, () => 'online' as Connectivity);
}

/** Called by api.ts for every request: a network-level failure, or any response at all (even a 4xx proves the server is there). */
export function reportRequest(ok: boolean): void {
  apply(ok ? { type: 'success' } : { type: 'failure' });
}

/** One probe now. Resolves with the state after it. */
export async function probeConnectivity(): Promise<Connectivity> {
  if (probing || typeof fetch === 'undefined') return model.state;
  probing = true;
  const started = performance.now();
  try {
    const controller = new AbortController();
    const abort = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch('/api/health', { cache: 'no-store', signal: controller.signal });
      // A proxy answering 502/503 while the container restarts is not "the
      // server is there" as far as saving goes.
      if (res.status >= 500) apply({ type: 'failure' });
      else apply({ type: 'success', latencyMs: performance.now() - started });
    } finally {
      clearTimeout(abort);
    }
  } catch {
    apply({ type: 'failure' });
  } finally {
    probing = false;
  }
  return model.state;
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    // A hidden tab keeps its last answer: nobody is looking, and a probe
    // every few seconds from twenty background tabs is just load.
    if (typeof document === 'undefined' || document.visibilityState === 'visible') await probeConnectivity();
    if (running) schedule();
  }, PROBE_INTERVAL_MS[model.state]);
}

/** Starts the probe timer and the browser listeners. Idempotent; returns the stop function. */
export function startConnectivity(): () => void {
  if (running || typeof window === 'undefined') return () => undefined;
  running = true;
  const onOnline = () => {
    apply({ type: 'browser', online: true });
    void probeConnectivity();
  };
  const onOffline = () => apply({ type: 'browser', online: false });
  const onVisible = () => {
    if (document.visibilityState === 'visible') void probeConnectivity();
  };
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  document.addEventListener('visibilitychange', onVisible);
  if (typeof navigator !== 'undefined' && navigator.onLine === false) onOffline();
  void probeConnectivity();
  schedule();
  return () => {
    running = false;
    if (timer) clearTimeout(timer);
    timer = null;
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

/** Tests only. */
export function resetConnectivityForTests(next: Partial<ConnectivityModel> = {}): void {
  // `offline` is only ever reached with the failure count that makes it so;
  // a test that asks for the state gets the model that goes with it.
  const failures = next.failures ?? (next.state === 'offline' ? OFFLINE_AFTER_FAILURES : 0);
  model = { ...INITIAL_CONNECTIVITY, ...next, failures };
  for (const listener of [...listeners]) listener();
}
