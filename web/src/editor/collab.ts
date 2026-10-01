/**
 * Collaboration session: one Y.Doc per page, synced through the server's
 * y-websocket endpoint. The server persists the markdown from this connection —
 * the editor never writes the page through the REST API.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import { useAuthOptional } from '../app/auth/AuthProvider';
import { attachOfflineSession } from '../app/collabOffline';
import { resolveAuthedIdentity, useOptionalSessionUser } from '../app/collabIdentity';

/** How often a client re-announces its state vector, repairing any dropped frame. */
export const RESYNC_INTERVAL_MS = 10_000;

/**
 * `id`/`username` are additions (page presence) — see collabIdentity.ts's
 * CollabIdentity docblock for why they're optional and why every existing
 * reader of this shape stays unaffected. Despite the name, a SIGNED-IN
 * user's awareness `user` field is also typed `AnonUser` here (the field is
 * set from `resolveAuthedIdentity(...)` in useCollabSession below, which
 * fills both) — only anonUser() itself actually omits them.
 */
export interface AnonUser {
  id?: string;
  name: string;
  username?: string;
  color: string;
  colorLight: string;
}

export interface CollabSession {
  doc: Y.Doc;
  ytext: Y.Text;
  provider: WebsocketProvider;
  undoManager: Y.UndoManager;
  user: AnonUser;
  /**
   * The page was created offline and the server did not have it when this
   * session opened: there is no server to sync with, so `useSynced` counts it
   * as synced (see app/collabOffline.ts). Absent for every other session.
   */
  startedLocal?: boolean;
}

export type ConnectionStatus = 'connecting' | 'connected' | 'offline';

const ADJECTIVES = [
  'Amber', 'Brisk', 'Calm', 'Copper', 'Dusty', 'Eager', 'Fleet', 'Gentle',
  'Hazel', 'Ivory', 'Jolly', 'Keen', 'Lucid', 'Mellow', 'Noble', 'Olive',
  'Placid', 'Quiet', 'Rapid', 'Sable', 'Tidy', 'Umber', 'Vivid', 'Warm',
];

const ANIMALS = [
  'Otter', 'Falcon', 'Heron', 'Marten', 'Ibex', 'Lynx', 'Puffin', 'Tapir',
  'Quokka', 'Badger', 'Kestrel', 'Narwhal', 'Osprey', 'Panda', 'Raven', 'Shrew',
];

export const PALETTE = ['#d9480f', '#c2255c', '#7048e8', '#1971c2', '#0c8599', '#2f9e44', '#e8590c', '#5f3dc4'];

const IDENTITY_KEY = 'folio.editor.identity';

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

/**
 * A stable-per-browser anonymous identity, for a guest with no session (a
 * share-link visitor — see SharedPageView). A signed-in user gets their real
 * identity instead — see app/collabIdentity.ts's resolveAuthedIdentity,
 * used by useCollabSession below — so this only has to be friendly and
 * recognisable for someone auth genuinely doesn't know about.
 */
export function anonUser(): AnonUser {
  try {
    const stored = localStorage.getItem(IDENTITY_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<AnonUser>;
      if (parsed.name && parsed.color && parsed.colorLight) return parsed as AnonUser;
    }
  } catch {
    /* corrupted or unavailable storage — fall through and mint a new identity */
  }
  const color = pick(PALETTE);
  const user: AnonUser = { name: `${pick(ADJECTIVES)} ${pick(ANIMALS)}`, color, colorLight: `${color}33` };
  try {
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(user));
  } catch {
    /* private mode — an ephemeral identity is fine */
  }
  return user;
}

/**
 * Opens a collab session for `pageId` and tears it down completely when the page
 * changes or the component unmounts.
 *
 * Offline mode (app/collabOffline.ts): every session but a share-link one keeps
 * its Y.Doc on disk while it is open, and opens its socket only after that
 * copy has been loaded — so the session appears a moment later than the
 * provider is created, never before the doc holds everything it will start
 * with. A page created offline gets a session whose socket stays closed until
 * the server has the page.
 *
 * `space` is optional and never rebuilds the session: it is only what an edit
 * made while disconnected is filed under in the unsynced-pages list. Without
 * it (a share link, a caller that does not know) such edits are not listed.
 */
export function useCollabSession(
  pageId: string,
  collabUrl: string,
  collabParams?: Record<string, string>,
  space?: string,
): CollabSession | null {
  const [session, setSession] = useState<CollabSession | null>(null);
  // useAuthOptional() reads null on a public /share/* route — <AuthProvider>
  // never mounts there (see AuthProvider.tsx's docblock), whether or not the
  // visitor actually has a session cookie. Fix/doc-share-role: fall back to
  // useOptionalSessionUser(), which asks GET /api/auth/state directly, so a
  // share-link visitor who's ALSO logged in still gets their real name/colour
  // in presence instead of a random anonymous identity — same fix boards
  // already got (diagrams/boardCollab.ts's useBoardCollabSession).
  const authUser = useAuthOptional()?.user ?? useOptionalSessionUser();
  // Read lazily by the session (see the `space` note above), so it must not
  // be an effect dependency.
  const spaceRef = useRef(space);
  useEffect(() => {
    spaceRef.current = space;
  }, [space]);

  useEffect(() => {
    const doc = new Y.Doc();
    const ytext = doc.getText('content');
    // A guest keeps today's behaviour exactly: the socket opens at once and
    // nothing is kept on disk — a share-link visitor's browser is not the
    // place for a copy of the page.
    const shared = Boolean(collabParams?.share);
    // Same reliability net as boards (see diagrams/boardCollab.ts): a periodic
    // sync step 1 repairs a frame the transport dropped, in both directions.
    const provider = new WebsocketProvider(collabUrl, pageId, doc, {
      // Not a signed-in session's to open yet: attachOfflineSession connects
      // once the on-disk copy is in the doc (or, for a page that exists only
      // in this browser, once the server has created it).
      connect: shared,
      resyncInterval: RESYNC_INTERVAL_MS,
      ...(collabParams ? { params: collabParams } : {}),
    });
    const user = authUser ? resolveAuthedIdentity(authUser, PALETTE) : anonUser();
    provider.awareness.setLocalStateField('user', user);
    // Tracked origins are wired by y-codemirror.next's undo plugin.
    const undoManager = new Y.UndoManager(ytext, { captureTimeout: 400 });

    const offline = shared ? null : attachOfflineSession({ pageId, kind: 'doc', doc, provider, getSpace: () => spaceRef.current });
    let cancelled = false;
    const open = () => setSession({ doc, ytext, provider, undoManager, user, ...(offline?.startedLocal ? { startedLocal: true } : {}) });
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
      undoManager.destroy();
      provider.destroy();
      doc.destroy();
    };
    // authUser?.id (not the object itself): on a share-link visit,
    // useOptionalSessionUser()'s GET /api/auth/state settles ASYNCHRONOUSLY,
    // after this effect has already run once with authUser undefined — an id
    // dependency re-opens the session (reconnect, cheap for a fresh room) the
    // moment a real identity becomes known, instead of latching onto
    // "anonymous" for the rest of the tab's life. `undefined` covers both
    // "still loading" and "confirmed anonymous" — both correctly fall to
    // anonUser() above, so neither transition needs its own case here.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- params are serialized into the key below
  }, [pageId, collabUrl, JSON.stringify(collabParams ?? null), authUser?.id]);

  return session;
}

/**
 * Connection state for the indicator, driven by the provider's own events.
 * A page created offline needs no special case: its provider is deliberately
 * left disconnected, which reads as 'offline' here until the server has the
 * page and the session connects it ('connecting' → 'connected').
 */
export function useConnectionStatus(session: CollabSession | null): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');

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
 * Whether the first sync with the server has completed. A page created
 * offline counts as synced from the moment its session opens (its content is
 * loaded from disk and there is no server to wait for) and stays so after the
 * socket connects — the page's real content is what the user is typing in.
 */
export function useSynced(session: CollabSession | null): boolean {
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

/** Number of other people currently in the room. */
export function usePeerCount(session: CollabSession | null): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!session) {
      setCount(0);
      return;
    }
    const { awareness } = session.provider;
    const update = () => setCount(Math.max(0, awareness.getStates().size - 1));
    update();
    awareness.on('change', update);
    return () => awareness.off('change', update);
  }, [session]);

  return count;
}

/**
 * Current markdown of the shared document. Only subscribes while `enabled`, so
 * typing in the editor does not re-render React on every keystroke.
 */
export function useDocumentText(session: CollabSession | null, enabled: boolean): string {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!session || !enabled) return () => {};
      session.ytext.observe(onChange);
      return () => session.ytext.unobserve(onChange);
    },
    [session, enabled],
  );
  const snapshot = useCallback(
    () => (session && enabled ? session.ytext.toString() : ''),
    [session, enabled],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
