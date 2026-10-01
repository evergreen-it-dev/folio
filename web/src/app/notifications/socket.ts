import type { NotificationSocketEvent } from '@shared/contracts';

/**
 * The client half of the `/events` socket (round 31) — a subscription PER
 * USER: one socket per application, not per panel and not per page (see
 * NotificationsHost, mounted next to AssistantHost).
 *
 * Authorization is the cookie: a raw WebSocket carries the same-origin
 * `Cookie` by itself, like `/collab`, so there is no separate token here. The
 * URL is built the same way as for collab in routes/PageContent.tsx: the same
 * host, ws/wss by protocol.
 *
 * Reconnection is in the style of assistant/stream.ts: a growing pause (1.5 s,
 * 3 s, 5 s, then 10 s) and no attempts to "wait for" a particular event. There
 * is one difference: the agent's stream catches up on what it missed by `seq`,
 * and here there are no numbers, so after EVERY reopening `onReopen` is called
 * — "re-read the feed", because anything could have happened in it during the
 * break. The first opening does not do this: the feed has just been loaded by
 * the GET /api/notifications request itself.
 */

const RECONNECT_DELAYS_MS = [1500, 3000, 5000, 10_000];

export interface SubscribeNotificationsOptions {
  /** A `ping` frame does not reach here — it only keeps the connection alive. */
  onEvent: (event: Exclude<NotificationSocketEvent, { type: 'ping' }>) => void;
  /** The socket opened AGAIN (after a break) — the fallback path: re-read the feed. */
  onReopen?: () => void;
  signal: AbortSignal;
}

/** ws/wss on the same host — separate, so that a test can check the address without opening a socket. */
export function notificationsSocketUrl(): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/events`;
}

/**
 * Keeps the socket open until `signal` is aborted. Returns nothing and never
 * throws: a break here is a regular state, not an application error.
 */
export function subscribeNotifications({ onEvent, onReopen, signal }: SubscribeNotificationsOptions): void {
  // An environment without WebSocket (SSR, a test without a stub) — the feed
  // simply stays on the request + refetch on focus, deliberately not a failure.
  if (typeof WebSocket === 'undefined') return;

  let attempt = 0;
  let everOpened = false;
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function scheduleReconnect(): void {
    if (signal.aborted || timer !== null) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
    attempt += 1;
    timer = setTimeout(() => {
      timer = null;
      connect();
    }, delay);
  }

  function connect(): void {
    if (signal.aborted) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(notificationsSocketUrl());
    } catch {
      // Even the constructor can throw (mixed content, for example) — that is
      // also just "did not work now", so the next attempt follows the pause.
      scheduleReconnect();
      return;
    }
    socket = ws;

    ws.onopen = () => {
      attempt = 0;
      if (everOpened) onReopen?.();
      everOpened = true;
    };

    ws.onmessage = (event: MessageEvent) => {
      let parsed: NotificationSocketEvent;
      try {
        parsed = JSON.parse(String(event.data)) as NotificationSocketEvent;
      } catch {
        return; // garbage in a frame must not break the subscription
      }
      if (parsed.type === 'ping') return;
      onEvent(parsed);
    };

    // An error is always followed by `close`, so reconnection is scheduled by
    // it — otherwise one break would produce two attempts.
    ws.onerror = () => undefined;
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      scheduleReconnect();
    };
  }

  signal.addEventListener(
    'abort',
    () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      const open = socket;
      socket = null;
      open?.close();
    },
    { once: true },
  );

  connect();
}
