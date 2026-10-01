/**
 * The `/events` socket (round 31) — a subscription PER USER, not per page:
 * a person has one notification feed however many tabs they open.
 *
 * It lives as a second `upgrade` listener next to collab.attachToServer:
 * both return EARLY for a path that is not theirs (`/collab` there,
 * `/events` here), so the order of registration does not matter and the
 * editor's socket stays untouched. Authorization is the same as in collab: a
 * raw upgrade never passes through Fastify/@fastify/cookie, so the cookie is
 * parsed by hand (session.parseCookieHeader + session.userForToken). A PAT
 * deliberately does not come here — as with /collab, this is a browser thing.
 */
import type { Server as HttpServer } from 'node:http';
import * as WS from 'ws';
import * as session from '../auth/session.js';
import type { NotificationSocketEvent } from '../../shared/contracts.js';

/**
 * ~25 s: proxies (nginx/Traefik) usually cut quiet connections at 60 s, and
 * the feed is silent for hours — without a ping a tab is "alive" exactly
 * until the first pause. The same approach as in the agent's stream
 * (server/assistant/routes.ts).
 */
const PING_INTERVAL_MS = 25_000;

/** user_id -> all of their open tabs. */
const connectionsByUser = new Map<string, Set<WS.WebSocket>>();

function register(userId: string, conn: WS.WebSocket): void {
  let set = connectionsByUser.get(userId);
  if (!set) {
    set = new Set();
    connectionsByUser.set(userId, set);
  }
  set.add(conn);

  const ping = setInterval(() => {
    if (conn.readyState === conn.OPEN) conn.send(JSON.stringify({ type: 'ping' } satisfies NotificationSocketEvent));
  }, PING_INTERVAL_MS);
  // unref: the ping timer must not keep the process alive by itself.
  ping.unref?.();

  const teardown = (): void => {
    clearInterval(ping);
    const current = connectionsByUser.get(userId);
    if (!current) return;
    current.delete(conn);
    // An empty Set would stay in the map forever — for an instance with a
    // thousand users that is a slow leak that never shows itself as a failure.
    if (current.size === 0) connectionsByUser.delete(userId);
  };

  conn.on('close', teardown);
  conn.on('error', teardown);
}

/**
 * Send an event to all tabs of a user. The person not being online is NOT an
 * error: the feed will catch up with the next GET /api/notifications; the
 * socket here only makes the row appear sooner.
 */
export function sendToUser(userId: string, event: NotificationSocketEvent): void {
  const set = connectionsByUser.get(userId);
  if (!set || set.size === 0) return;
  const payload = JSON.stringify(event);
  for (const conn of set) {
    if (conn.readyState !== conn.OPEN) continue;
    try {
      conn.send(payload);
    } catch {
      // A break during the write — the connection will reach 'close' by itself and be cleaned up.
    }
  }
}

/** How many tabs a user holds now — for diagnostics and tests. */
export function connectionCountForUser(userId: string): number {
  return connectionsByUser.get(userId)?.size ?? 0;
}

function rejectUpgrade(socket: { write: (chunk: string) => void; destroy: () => void }, status: number, statusText: string): void {
  socket.write(`HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function attachToServer(httpServer: HttpServer): void {
  const wss = new WS.WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://internal');
      // An early return for paths that are not ours — otherwise this
      // listener would cut /collab connections, which the neighbor serves.
      if (url.pathname !== '/events') return;

      const cookies = session.parseCookieHeader(req.headers.cookie);
      const user = await session.userForToken(cookies[session.SESSION_COOKIE_NAME]);
      if (!user || user.disabled) {
        rejectUpgrade(socket, 401, 'Unauthorized');
        return;
      }

      wss.handleUpgrade(req, socket, head, (conn) => {
        register(user.id, conn);
      });
    })().catch(() => {
      rejectUpgrade(socket, 500, 'Internal Server Error');
    });
  });
}
