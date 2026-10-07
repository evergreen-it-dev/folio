/**
 * Has the SERVER got what this tab typed? (06.10.2026, content-loss fix.)
 *
 * y-websocket has no acknowledgements. Its `synced` flag only says that the
 * first exchange after connecting is done — every edit typed after that is
 * fire-and-forget, and nothing on the client ever learns whether it arrived.
 * Two places treated `synced` as "the server has everything" anyway:
 * collabOffline.ts deleted the page's local copy on close, and the sync
 * engine deleted a flushed page's copy. A socket that died silently (it reads
 * as connected until its timeout) or a connection the server made read-only
 * (server/collab.ts makeReadOnly drops a viewer's updates without a word)
 * turned that into lost text.
 *
 * The real answer is in the protocol already: a sync step 1 carries the
 * sender's state vector — for every client, how much of its history the
 * sender holds. server/collab.ts answers every step 1 a client sends with its
 * own (replyWithOwnStateVector), so this module:
 *  - records the server's state vector from every step 1 the server sends;
 *  - asks for a fresh one shortly after local edits (sends a step 1 itself);
 *  - reports `confirmed` when the server's vector covers this doc's own — every
 *    operation this tab holds, typed here or loaded from disk, is on the server.
 *
 * A connection whose edits the server refuses never becomes confirmed, which
 * is what the editor shows as "not saved".
 */
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import type { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';

/** y-websocket's top-level message type for the sync protocol. */
const MESSAGE_SYNC = 0;

/** Local edits closer together than this share one confirmation checkpoint. */
const CHECKPOINT_MS = 250;

/** How long after the last local edit the tab asks the server for its state vector. */
export const ACK_PROBE_DELAY_MS = 400;

export interface ServerAck {
  /** True when the server's last known state vector covers everything this doc holds. */
  isConfirmed(): boolean;
  /**
   * Since when (ms epoch) the oldest edit the server has not confirmed has
   * been waiting; null when everything is confirmed. Unlike `isConfirmed()`,
   * this does not stay "unconfirmed" through steady typing — each confirmed
   * step moves it forward — so "waiting for N seconds" really means the
   * server is not taking what was typed N seconds ago.
   */
  pendingSince(): number | null;
  /** Called whenever `isConfirmed()` or `pendingSince()` may have changed. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Resolves `true` once confirmed (asking the server right away), `false` after `timeoutMs`. */
  whenConfirmed(timeoutMs: number): Promise<boolean>;
  /** Ask the server for its state vector now (no-op while disconnected). */
  probe(): void;
  dispose(): void;
}

type SyncHandler = (
  encoder: encoding.Encoder,
  decoder: decoding.Decoder,
  provider: WebsocketProvider,
  emitSynced: boolean,
  messageType: number,
) => void;

interface ProviderInternals {
  messageHandlers?: SyncHandler[];
  ws?: { readyState: number; send(data: Uint8Array): void } | null;
  wsconnected?: boolean;
}

/** `local` is covered by `remote` when the remote holds at least as much of every client's history. */
export function stateVectorCovered(local: Map<number, number>, remote: Map<number, number> | null): boolean {
  for (const [client, clock] of local) {
    if (clock > 0 && (remote?.get(client) ?? 0) < clock) return false;
  }
  return true;
}

export function trackServerAck(provider: WebsocketProvider, doc: Y.Doc): ServerAck {
  const internals = provider as unknown as ProviderInternals;
  const listeners = new Set<() => void>();
  let serverVector: Map<number, number> | null = null;
  let probeTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  /**
   * How far THIS tab's own updates go, per client — everything that did not
   * come from the socket: typing, undo, the copy loaded from disk. Only this is
   * compared with the server's vector; the whole doc's vector also holds the
   * other people's edits, which the server had first, and which would read as
   * "unconfirmed" until the next exchange every time a peer typed (review of
   * 54d4e76: a false beforeunload prompt, a copy kept and listed for nothing).
   */
  const mine = new Map<number, number>();
  /** `mine` after unconfirmed local updates, oldest first (coalesced to one per CHECKPOINT_MS). */
  const checkpoints: Array<{ vector: Map<number, number>; at: number }> = [];
  /**
   * A local update that only deletes adds nothing to any state vector, so the
   * server's vector cannot confirm it. It counts as confirmed once the server
   * answers a step 1 this tab sent AFTER it: frames on one socket arrive in
   * order, so by then the server has applied it. Pure deletes are numbered
   * (`deleteSeq`), each probe remembers the number it went out after, and each
   * step 1 from the server answers the oldest probe still waiting.
   * Approximate on purpose: y-websocket's own resync step 1s are answered too
   * and can take a probe's turn, confirming a delete up to one round trip
   * early; and a read-only connection answers while dropping the delete
   * (viewers no longer get an editor — PageContent.tsx).
   */
  let deleteSeq = 0;
  const deleteCheckpoints: Array<{ seq: number; at: number }> = [];
  const probesInFlight: number[] = [];
  let confirmed = true;

  // Whatever the doc already holds when tracking starts is this tab's to
  // confirm too: the sync engine attaches the tracker to a doc it has just
  // loaded from IndexedDB, and that copy may be the only one of an offline
  // edit (review of 90def95 — an empty start confirmed it at once and the copy
  // was deleted). A doc that already has deletions gets a delete checkpoint,
  // confirmed by the server's answer to the first probe.
  for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(doc))) mine.set(client, clock);
  if (mine.size > 0) checkpoints.push({ vector: new Map(mine), at: Date.now() });
  if (Y.decodeUpdate(Y.encodeStateAsUpdate(doc)).ds.clients.size > 0) {
    deleteSeq += 1;
    deleteCheckpoints.push({ seq: deleteSeq, at: Date.now() });
  }
  confirmed = checkpoints.length === 0 && deleteCheckpoints.length === 0;

  const notify = () => {
    // Runs inside the doc's own 'update' event: an exception here would escape
    // the transaction that produced it — the editor's sync plugin among them
    // (see editor/collab-sync.ts). Never let one through.
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('[collab] ack listener failed:', error);
      }
    }
  };

  const oldestPending = (): number | null => {
    const times = [checkpoints[0]?.at, deleteCheckpoints[0]?.at].filter((t): t is number => t !== undefined);
    return times.length > 0 ? Math.min(...times) : null;
  };

  const recompute = () => {
    const before = oldestPending();
    while (checkpoints.length > 0 && stateVectorCovered(checkpoints[0].vector, serverVector)) checkpoints.shift();
    const next = checkpoints.length === 0 && stateVectorCovered(mine, serverVector) && deleteCheckpoints.length === 0;
    if (next === confirmed && before === oldestPending()) return;
    confirmed = next;
    notify();
  };

  const probe = () => {
    if (disposed) return;
    const ws = internals.ws;
    if (!internals.wsconnected || !ws || ws.readyState !== 1) return;
    try {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(encoder, doc);
      ws.send(encoding.toUint8Array(encoder));
      probesInFlight.push(deleteSeq);
    } catch {
      // A socket closing under us: the next connect starts with a full exchange anyway.
    }
  };

  // Every sync message from the server passes through here first. Only a
  // step 1 is read (on a cloned decoder, so the original handler sees the
  // message untouched); everything else goes straight on.
  const handlers = internals.messageHandlers;
  const original = handlers?.[MESSAGE_SYNC];
  if (handlers && original) {
    handlers[MESSAGE_SYNC] = (encoder, decoder, prov, emitSynced, messageType) => {
      try {
        const peek = decoding.clone(decoder);
        if (decoding.readVarUint(peek) === syncProtocol.messageYjsSyncStep1) {
          serverVector = Y.decodeStateVector(decoding.readVarUint8Array(peek));
          const answered = probesInFlight.shift();
          if (answered !== undefined) while (deleteCheckpoints.length > 0 && deleteCheckpoints[0].seq <= answered) deleteCheckpoints.shift();
          // Applied after the original handler: a step 2 in the same exchange
          // may still be on its way, but the vector is what the server holds.
          queueMicrotask(recompute);
        }
      } catch {
        // Unreadable here means unreadable for y-websocket too; let it decide.
      }
      original(encoder, decoder, prov, emitSynced, messageType);
    };
  }

  const onUpdate = (update: Uint8Array, origin: unknown) => {
    // Updates the server sent us are already on the server; anything else is
    // ours to confirm.
    if (origin === provider) return;
    const now = Date.now();
    const added = Y.decodeStateVector(Y.encodeStateVectorFromUpdate(update));
    if (added.size === 0) {
      // No new structs: a pure delete (see deleteSeq).
      deleteSeq += 1;
      const last = deleteCheckpoints[deleteCheckpoints.length - 1];
      if (last && now - last.at < CHECKPOINT_MS) last.seq = deleteSeq;
      else deleteCheckpoints.push({ seq: deleteSeq, at: now });
    }
    for (const [client, clock] of added) if ((mine.get(client) ?? 0) < clock) mine.set(client, clock);
    if (added.size > 0) {
      const last = checkpoints[checkpoints.length - 1];
      if (last && now - last.at < CHECKPOINT_MS) last.vector = new Map(mine);
      else checkpoints.push({ vector: new Map(mine), at: now });
    }
    recompute();
    // Throttled, not debounced: someone typing without a pause must still get
    // a confirmation every ACK_PROBE_DELAY_MS, or the editor would call their
    // text "not saved" after a few seconds of steady typing.
    if (probeTimer) return;
    probeTimer = setTimeout(() => {
      probeTimer = undefined;
      probe();
    }, ACK_PROBE_DELAY_MS);
  };
  doc.on('update', onUpdate);

  // A fresh connection: the server's first step 1 predates what we send it in
  // reply, so ask again once the exchange is done.
  const onSync = (isSynced: boolean) => {
    if (isSynced) setTimeout(probe, ACK_PROBE_DELAY_MS);
  };
  provider.on('sync', onSync);
  // Answers to a closed socket's probes never come.
  const onStatus = ({ status }: { status: string }) => {
    if (status !== 'connected') probesInFlight.length = 0;
  };
  provider.on('status', onStatus);

  return {
    isConfirmed: () => confirmed,
    pendingSince: () => (confirmed ? null : (oldestPending() ?? Date.now())),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    whenConfirmed(timeoutMs) {
      recompute();
      if (confirmed) return Promise.resolve(true);
      probe();
      return new Promise((resolve) => {
        const listener = () => {
          if (!confirmed) return;
          clearTimeout(timer);
          listeners.delete(listener);
          resolve(true);
        };
        const timer = setTimeout(() => {
          listeners.delete(listener);
          resolve(false);
        }, timeoutMs);
        listeners.add(listener);
      });
    },
    probe,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (probeTimer) clearTimeout(probeTimer);
      doc.off('update', onUpdate);
      provider.off('sync', onSync);
      provider.off('status', onStatus);
      if (handlers && original && handlers[MESSAGE_SYNC] !== original) handlers[MESSAGE_SYNC] = original;
      listeners.clear();
    },
  };
}
