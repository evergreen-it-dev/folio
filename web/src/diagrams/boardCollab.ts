/**
 * DEV-PLAN Round 29 (DIAGRAMS) — the React binding for a board's collab room.
 *
 * Shape mirrors web/src/editor/collab.ts and web/src/tables/collab/useTableCollab.ts
 * (one Y.Doc per page, one WebsocketProvider at the SAME `/collab` endpoint,
 * the SAME room name — pageId — and the SAME stored anonymous identity), so
 * a person is the same name/colour whether they meet a collaborator in a
 * document, a table or a board.
 *
 * `web/src/editor/**` cannot be imported from here (DEV-PLAN: editor already
 * imports diagrams/, and the reverse edge would be a cycle) — `anonUser()`
 * below is therefore a deliberate duplicate of editor/collab.ts's function,
 * reading the SAME `folio.editor.identity` localStorage key so the name
 * still matches across zones despite the two copies. app/collabIdentity.ts
 * (the signed-in-user identity resolver, fix/collab-identity) is fine to
 * import though: app/auth/AuthProvider.tsx's own import chain never reaches
 * editor/ or diagrams/, so pulling from app/ doesn't reintroduce the cycle
 * this docblock warns about — only editor/** itself is off-limits.
 *
 * Hooks here take primitives (a session, an Awareness) rather than hiding
 * everything behind one opaque object, so the pure reconciliation logic in
 * ./boardYdoc stays trivially testable and BoardCanvas.tsx only has to reach
 * into exactly the pieces it needs.
 */
import { useEffect, useRef, useState } from 'react';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import { useAuthOptional } from '../app/auth/AuthProvider';
import { attachOfflineSession } from '../app/collabOffline';
import { resolveAuthedIdentity, useOptionalSessionUser } from '../app/collabIdentity';

/** How often a client re-announces its state vector, repairing any dropped frame. */
export const RESYNC_INTERVAL_MS = 10_000;
import type { Awareness } from 'y-protocols/awareness';
import { boardRoots, type BoardRoots } from './boardYdoc';

/** `id`/`username` are additions (page presence) — see editor/collab.ts's AnonUser docblock, mirrored here. */
export interface BoardAnonUser {
  id?: string;
  name: string;
  username?: string;
  color: string;
  colorLight: string;
}

const ADJECTIVES = [
  'Amber', 'Brisk', 'Calm', 'Copper', 'Dusty', 'Eager', 'Fleet', 'Gentle',
  'Hazel', 'Ivory', 'Jolly', 'Keen', 'Lucid', 'Mellow', 'Noble', 'Olive',
  'Placid', 'Quiet', 'Rapid', 'Sable', 'Tidy', 'Umber', 'Vivid', 'Warm',
];

const ANIMALS = [
  'Otter', 'Falcon', 'Heron', 'Marten', 'Ibex', 'Lynx', 'Puffin', 'Tapir',
  'Quokka', 'Badger', 'Kestrel', 'Narwhal', 'Osprey', 'Panda', 'Raven', 'Shrew',
];

const PALETTE = ['#d9480f', '#c2255c', '#7048e8', '#1971c2', '#0c8599', '#2f9e44', '#e8590c', '#5f3dc4'];

/** Byte-for-byte the same key editor/collab.ts reads/writes — see this module's docblock. */
const IDENTITY_KEY = 'folio.editor.identity';

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

/**
 * Duplicate of editor/collab.ts's anonUser() — see the module docblock for
 * why this can't just be imported. Only for the anonymous case (a
 * share-link guest — see SharedPageView); a signed-in user gets their real
 * identity from app/collabIdentity.ts's resolveAuthedIdentity instead, used
 * by useBoardCollabSession below.
 */
export function anonUser(): BoardAnonUser {
  try {
    const stored = localStorage.getItem(IDENTITY_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<BoardAnonUser>;
      if (parsed.name && parsed.color && parsed.colorLight) return parsed as BoardAnonUser;
    }
  } catch {
    /* corrupted or unavailable storage — fall through and mint a new identity */
  }
  const color = pick(PALETTE);
  const user: BoardAnonUser = { name: `${pick(ADJECTIVES)} ${pick(ANIMALS)}`, color, colorLight: `${color}33` };
  try {
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(user));
  } catch {
    /* private mode — an ephemeral identity is fine */
  }
  return user;
}

export interface BoardCollabSession extends BoardRoots {
  pageId: string;
  doc: Y.Doc;
  provider: WebsocketProvider;
  awareness: Awareness;
  user: BoardAnonUser;
  /**
   * The board was created offline and the server did not have it when this
   * session opened: there is no server to sync with, so `useBoardSynced`
   * counts it as synced (see app/collabOffline.ts). Absent for every other session.
   */
  startedLocal?: boolean;
}

/**
 * Opens a collab session for `pageId` and tears it down completely when the
 * page changes or the component unmounts. `pageId === ''` (the share-link
 * shape BoardCanvasProps documents) deliberately never opens a session —
 * boards reached via a share token stay on the pre-existing GET/PUT path
 * this round (see BoardCanvas.tsx), so there is nothing to connect to.
 *
 * Offline mode (app/collabOffline.ts): a signed-in session keeps its Y.Doc on
 * disk while it is open and opens its socket only after that copy has been
 * loaded, so the session is handed out a moment after the provider is created
 * — never before the doc holds everything it will start with (BoardCanvas
 * builds its one initial scene from it). A board created offline gets a
 * session whose socket stays closed until the server has the board.
 */
export function useBoardCollabSession(
  pageId: string,
  collabUrl: string,
  /**
   * Query params for the socket — `{ share: token }` for a public share link.
   * server/collab.ts already admits a share token on `/collab` (editor for an
   * edit link, viewer otherwise); documents and tables have used it for a
   * while, boards didn't pass one and so never joined the room at all.
   */
  params?: Record<string, string>,
  /**
   * The board's space — only what an edit made while disconnected is filed
   * under in the unsynced-pages list. It typically arrives AFTER the session
   * opens (BoardCanvas learns it from the page metadata), so it is read
   * lazily and never rebuilds the session; without it such edits are not listed.
   */
  space?: string,
): BoardCollabSession | null {
  const [session, setSession] = useState<BoardCollabSession | null>(null);
  // useAuthOptional() reads null on a public /share/* route — <AuthProvider>
  // never mounts there (see AuthProvider.tsx's docblock), whether or not the
  // visitor actually has a session cookie. Fix/share-identity: fall back to
  // useOptionalSessionUser(), which asks GET /api/auth/state directly, so a
  // share-link visitor who's ALSO logged in still gets their real name/colour
  // in presence instead of a random anonymous identity (and, downstream, a
  // git commit authored as "Guest via share …" for edits that really are
  // theirs — see server/collab.ts's attachToServer, which already resolves
  // the session cookie the same way regardless of any ?share= token).
  const authUser = useAuthOptional()?.user ?? useOptionalSessionUser();
  const spaceRef = useRef(space);
  useEffect(() => {
    spaceRef.current = space;
  }, [space]);

  useEffect(() => {
    if (!pageId) {
      setSession(null);
      return;
    }
    const doc = new Y.Doc();
    // A guest keeps today's behaviour exactly: the socket opens at once and
    // nothing is kept on disk — a share-link visitor's browser is not the
    // place for a copy of the board.
    const shared = Boolean(params?.share);
    // resyncInterval: y-websocket assumes a reliable transport and never
    // retransmits a frame the socket swallowed (the vite dev proxy does exactly
    // that under load: `ws proxy error: write EPIPE`). A periodic sync step 1
    // costs one state-vector frame and repairs any such gap in both directions
    // — the server answers step 1 with its own step 1 (see server/collab.ts).
    const provider = new WebsocketProvider(collabUrl, pageId, doc, {
      // Not a signed-in session's to open yet: attachOfflineSession connects
      // once the on-disk copy is in the doc (or, for a board that exists only
      // in this browser, once the server has created it).
      connect: shared,
      resyncInterval: RESYNC_INTERVAL_MS,
      params,
    });
    const user = authUser ? resolveAuthedIdentity(authUser, PALETTE) : anonUser();
    provider.awareness.setLocalStateField('user', user);

    const offline = shared ? null : attachOfflineSession({ pageId, kind: 'board', doc, provider, getSpace: () => spaceRef.current });
    let cancelled = false;
    const open = () =>
      setSession({
        pageId,
        doc,
        provider,
        awareness: provider.awareness,
        user,
        ...(offline?.startedLocal ? { startedLocal: true } : {}),
        ...boardRoots(doc),
      });
    if (offline) {
      void offline.ready.then(() => {
        if (!cancelled) open();
      });
    } else {
      open();
    }

    return () => {
      cancelled = true;
      setSession(null);
      // Before the provider goes: it decides from the provider's state
      // whether the on-disk copy is still needed.
      offline?.dispose();
      provider.awareness.setLocalStateField('cursor', null);
      provider.destroy();
      doc.destroy();
    };
    // authUser?.id (not the object itself): on a share-link visit,
    // useOptionalSessionUser()'s GET /api/auth/state settles ASYNCHRONOUSLY,
    // after this effect has already run once with authUser undefined — an id
    // dependency re-opens the session (reconnect, not a big deal for a fresh
    // room) the moment a real identity becomes known, instead of latching
    // onto "anonymous" for the rest of the tab's life. `undefined` covers
    // both "still loading" and "confirmed anonymous" — both correctly fall
    // to anonUser() above, so neither transition needs its own case here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId, collabUrl, params?.share, authUser?.id]);

  return session;
}

export type BoardConnectionStatus = 'connecting' | 'connected' | 'offline';

/**
 * Connection state for the indicator, driven by the provider's own events —
 * same three states/events as editor/collab.ts's useConnectionStatus. A board
 * created offline needs no special case: its provider is deliberately left
 * disconnected, which reads as 'offline' until the server has the board.
 */
export function useBoardConnectionStatus(session: BoardCollabSession | null): BoardConnectionStatus {
  const [status, setStatus] = useState<BoardConnectionStatus>('connecting');

  useEffect(() => {
    if (!session) {
      setStatus('connecting');
      return;
    }
    const provider = session.provider;
    const apply = (value: 'connected' | 'disconnected' | 'connecting') =>
      setStatus(value === 'disconnected' ? 'offline' : value);
    apply(provider.wsconnected ? 'connected' : provider.wsconnecting ? 'connecting' : 'disconnected');
    const onStatus = ({ status: next }: { status: 'connected' | 'disconnected' | 'connecting' }) => apply(next);
    provider.on('status', onStatus);
    return () => provider.off('status', onStatus);
  }, [session]);

  return status;
}

/**
 * Whether the first sync with the server has completed. BoardCanvas.tsx gates
 * building `initialData` on this — reading the elements/board/files maps
 * before this fires would either show a stale empty room or, worse, treat a
 * genuinely-not-yet-arrived scene as "this board is new".
 *
 * A board created offline counts as synced from the moment its session opens
 * — the session is only handed out once the board's content has been loaded
 * from disk, and there is no server to wait for — and stays so after the
 * socket connects.
 */
export function useBoardSynced(session: BoardCollabSession | null): boolean {
  const [synced, setSynced] = useState(false);

  useEffect(() => {
    if (!session) {
      setSynced(false);
      return;
    }
    const local = session.startedLocal === true;
    setSynced(local || session.provider.synced);
    const onSync = (value: boolean) => setSynced(local || value);
    session.provider.on('sync', onSync);
    return () => session.provider.off('sync', onSync);
  }, [session]);

  return synced;
}

/**
 * What a board publishes about its pointer. `tool` and `button` are what
 * Excalidraw needs to draw a peer's LASER trail rather than a plain cursor —
 * the owner's report (15.09: "this thing works without sockets", pointing at the laser
 * tool) came from publishing only x/y and hardcoding every peer to `tool:
 * 'pointer'` on the receiving side, so the trail never left the tab. Kept in
 * the same `cursor` awareness field: a peer on an older build still finds its
 * x/y there and simply ignores the rest.
 */
export interface BoardPointer {
  x: number;
  y: number;
  tool: 'pointer' | 'laser';
  button: 'up' | 'down';
}

export interface BoardPeer {
  clientId: number;
  user: BoardAnonUser;
  cursor: BoardPointer | null;
}

interface BoardAwarenessRecord {
  user?: Partial<BoardAnonUser>;
  cursor?: Partial<BoardPointer> | null;
}

const FALLBACK_USER: BoardAnonUser = { name: 'Someone', color: '#868e96', colorLight: '#868e9633' };

/**
 * Everyone else currently in the room, with their last-known pointer
 * position. Defensive on malformed/partial awareness records for the same
 * reason tables/collab/awareness.ts's peersByCell is — a peer on an older
 * build or mid-reconnect can legitimately publish a half-written state.
 */
export function useBoardPeers(session: BoardCollabSession | null): BoardPeer[] {
  const [peers, setPeers] = useState<BoardPeer[]>([]);

  useEffect(() => {
    if (!session) {
      setPeers([]);
      return;
    }
    const { awareness } = session;
    const update = () => {
      const out: BoardPeer[] = [];
      for (const [clientId, raw] of awareness.getStates()) {
        if (clientId === awareness.clientID) continue;
        if (!raw || typeof raw !== 'object') continue;
        const record = raw as BoardAwarenessRecord;
        const u = record.user;
        const user: BoardAnonUser =
          u && typeof u.name === 'string' && typeof u.color === 'string'
            ? { name: u.name, color: u.color, colorLight: typeof u.colorLight === 'string' ? u.colorLight : `${u.color}33` }
            : FALLBACK_USER;
        const cursor: BoardPointer | null =
          record.cursor && typeof record.cursor.x === 'number' && typeof record.cursor.y === 'number'
            ? {
                x: record.cursor.x,
                y: record.cursor.y,
                // Defensive defaults: an older peer publishes x/y only.
                tool: record.cursor.tool === 'laser' ? 'laser' : 'pointer',
                button: record.cursor.button === 'down' ? 'down' : 'up',
              }
            : null;
        out.push({ clientId, user, cursor });
      }
      out.sort((a, b) => a.clientId - b.clientId);
      setPeers(out);
    };
    update();
    awareness.on('change', update);
    return () => awareness.off('change', update);
  }, [session]);

  return peers;
}

/** Publishes this tab's current pointer position — call from Excalidraw's onPointerUpdate. Pass `null` to clear (e.g. the pointer leaving the canvas). */
export function publishBoardPointer(session: BoardCollabSession, cursor: BoardPointer | null): void {
  session.awareness.setLocalStateField('cursor', cursor);
}

/** Same interval the official multiplayer client throttles cursor broadcasts to (CURSOR_SYNC_TIMEOUT). */
export const CURSOR_SYNC_TIMEOUT_MS = 33;

/**
 * Wraps publishBoardPointer in a trailing-edge throttle: Excalidraw's own
 * onPointerUpdate fires on every raw pointermove, and broadcasting each of
 * those as its own awareness update turns "see a peer's cursor" into a
 * firehose competing with real scene traffic for the same socket — one of
 * the contributors to the "everything jumps" symptom this round fixes. At most one
 * publish per `intervalMs`, but the LAST position within a throttled window
 * always lands eventually (never silently dropped) — call `cancel()` on
 * teardown (session change/unmount) so a stale trailing call can't fire after
 * the session it closes over is gone.
 */
export function throttledPointerPublisher(
  session: BoardCollabSession,
  intervalMs: number = CURSOR_SYNC_TIMEOUT_MS,
): { publish: (cursor: BoardPointer | null) => void; cancel: () => void } {
  let lastSent = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: BoardPointer | null = null;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    publish(cursor) {
      pending = cursor;
      const now = Date.now();
      const elapsed = now - lastSent;
      if (elapsed >= intervalMs) {
        clearTimer();
        lastSent = now;
        publishBoardPointer(session, cursor);
        return;
      }
      if (timer === null) {
        timer = setTimeout(() => {
          timer = null;
          lastSent = Date.now();
          publishBoardPointer(session, pending);
        }, intervalMs - elapsed);
      }
    },
    cancel: clearTimer,
  };
}
