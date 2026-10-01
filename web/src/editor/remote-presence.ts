/**
 * Time-limit remote selections without changing Awareness itself. Peer counts,
 * reconnects and the author's own local selection therefore stay untouched.
 */
export const REMOTE_SELECTION_VISIBLE_MS = 8_000;

interface AwarenessChange {
  added: number[];
  updated: number[];
  removed: number[];
}

export interface RemotePresenceAwareness {
  doc: { clientID: number };
  getStates(): Map<number, { cursor?: unknown }>;
  on(event: 'change', listener: (change: AwarenessChange) => void): void;
  off(event: 'change', listener: (change: AwarenessChange) => void): void;
}

export function attachRemotePresenceExpiry(
  editor: HTMLElement,
  awareness: RemotePresenceAwareness,
  visibleMs = REMOTE_SELECTION_VISIBLE_MS,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const hide = () => {
    delete editor.dataset.remotePresence;
    timer = null;
  };
  const hasRemoteCursor = () =>
    Array.from(awareness.getStates()).some(
      ([clientId, state]) => clientId !== awareness.doc.clientID && state?.cursor != null,
    );
  const show = () => {
    if (timer) clearTimeout(timer);
    if (!hasRemoteCursor()) return hide();
    editor.dataset.remotePresence = 'active';
    timer = setTimeout(hide, visibleMs);
  };
  const onChange = ({ added, updated, removed }: AwarenessChange) => {
    const local = awareness.doc.clientID;
    if (![...added, ...updated, ...removed].some((clientId) => clientId !== local)) return;
    show();
  };

  awareness.on('change', onChange);
  if (hasRemoteCursor()) show();
  return () => {
    awareness.off('change', onChange);
    if (timer) clearTimeout(timer);
    delete editor.dataset.remotePresence;
  };
}
