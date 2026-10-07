/**
 * Server acknowledgement from state vectors (collabAck.ts). The provider is a
 * small fake with the two internals the tracker uses — the per-instance
 * `messageHandlers` table and the socket — driven with real sync-protocol
 * frames, exactly what server/collab.ts sends.
 */
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebsocketProvider } from 'y-websocket';
import { ACK_PROBE_DELAY_MS, stateVectorCovered, trackServerAck } from './collabAck';

type Handler = (encoder: encoding.Encoder, decoder: decoding.Decoder, provider: unknown, emitSynced: boolean, messageType: number) => void;

function fakeProvider() {
  const sent: Uint8Array[] = [];
  const original = vi.fn<Handler>();
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const provider = {
    messageHandlers: [original] as Handler[],
    wsconnected: true,
    ws: { readyState: 1, send: (data: Uint8Array) => sent.push(data) },
    on(event: string, fn: (...args: unknown[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
    },
    off(event: string, fn: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(fn);
    },
    emit(event: string, ...args: unknown[]) {
      for (const fn of listeners.get(event) ?? []) fn(...args);
    },
  };
  /** Delivers a sync step 1 carrying `server`'s state vector, the way y-websocket's message loop does. */
  const serverStep1 = (server: Y.Doc) => {
    const frame = encoding.createEncoder();
    syncProtocol.writeSyncStep1(frame, server);
    const decoder = decoding.createDecoder(encoding.toUint8Array(frame));
    provider.messageHandlers[0](encoding.createEncoder(), decoder, provider, true, 0);
  };
  return { provider, sent, original, serverStep1, asProvider: provider as unknown as WebsocketProvider };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe('stateVectorCovered', () => {
  it('needs every client of the local vector at least as far on the remote', () => {
    expect(stateVectorCovered(new Map([[1, 5]]), new Map([[1, 5], [2, 3]]))).toBe(true);
    expect(stateVectorCovered(new Map([[1, 6]]), new Map([[1, 5]]))).toBe(false);
    expect(stateVectorCovered(new Map([[1, 1]]), null)).toBe(false);
    expect(stateVectorCovered(new Map(), null)).toBe(true);
  });
});

describe('trackServerAck', () => {
  it('a local edit is unconfirmed until the server state vector covers it; the original handler still sees every message', async () => {
    const { asProvider, serverStep1, original } = fakeProvider();
    const doc = new Y.Doc();
    const server = new Y.Doc();
    const ack = trackServerAck(asProvider, doc);
    expect(ack.isConfirmed()).toBe(true); // nothing typed

    doc.getText('content').insert(0, 'typed');
    expect(ack.isConfirmed()).toBe(false);

    // The server answers with a vector that does NOT have the edit (a read-only
    // connection, or the update was lost): still unconfirmed.
    serverStep1(server);
    await flush();
    expect(ack.isConfirmed()).toBe(false);
    expect(original).toHaveBeenCalledTimes(1);

    // The edit reaches the server.
    Y.applyUpdate(server, Y.encodeStateAsUpdate(doc));
    serverStep1(server);
    await flush();
    expect(ack.isConfirmed()).toBe(true);
    expect(original).toHaveBeenCalledTimes(2);
    // The message reached the original handler unread: its decoder starts at the sync type.
    const decoder = original.mock.calls[1][1];
    expect(decoding.readVarUint(decoder)).toBe(syncProtocol.messageYjsSyncStep1);
    ack.dispose();
  });

  it('asks the server for its vector shortly after a local edit, never for one that came from the server', () => {
    vi.useFakeTimers();
    const { asProvider, sent } = fakeProvider();
    const doc = new Y.Doc();
    const ack = trackServerAck(asProvider, doc);
    Y.applyUpdate(doc, (() => {
      const other = new Y.Doc();
      other.getText('content').insert(0, 'from server');
      return Y.encodeStateAsUpdate(other);
    })(), asProvider);
    vi.advanceTimersByTime(ACK_PROBE_DELAY_MS + 10);
    expect(sent).toHaveLength(0);

    doc.getText('content').insert(0, 'mine ');
    vi.advanceTimersByTime(ACK_PROBE_DELAY_MS + 10);
    expect(sent).toHaveLength(1);
    // Steady typing still gets probed on schedule (throttle, not debounce).
    for (let i = 0; i < 10; i++) {
      doc.getText('content').insert(0, 'k');
      vi.advanceTimersByTime(ACK_PROBE_DELAY_MS / 4);
    }
    expect(sent.length).toBeGreaterThanOrEqual(3);
    const decoder = decoding.createDecoder(sent[0]);
    expect(decoding.readVarUint(decoder)).toBe(0); // messageSync
    expect(decoding.readVarUint(decoder)).toBe(syncProtocol.messageYjsSyncStep1);
    ack.dispose();
  });

  it('whenConfirmed resolves on confirmation, or false on timeout', async () => {
    const { asProvider, serverStep1 } = fakeProvider();
    const doc = new Y.Doc();
    const server = new Y.Doc();
    const ack = trackServerAck(asProvider, doc);
    doc.getText('content').insert(0, 'x');
    expect(await ack.whenConfirmed(20)).toBe(false);
    const pending = ack.whenConfirmed(1_000);
    Y.applyUpdate(server, Y.encodeStateAsUpdate(doc));
    serverStep1(server);
    expect(await pending).toBe(true);
    ack.dispose();
  });

  it('pendingSince moves forward as the server confirms older edits, even while newer ones keep coming', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(1_000_000);
    const { asProvider, serverStep1 } = fakeProvider();
    const doc = new Y.Doc();
    const server = new Y.Doc();
    const ack = trackServerAck(asProvider, doc);
    expect(ack.pendingSince()).toBeNull();
    doc.getText('content').insert(0, 'a');
    expect(ack.pendingSince()).toBe(1_000_000);
    // The server gets the first edit; a second one was typed meanwhile.
    Y.applyUpdate(server, Y.encodeStateAsUpdate(doc));
    vi.setSystemTime(1_001_000);
    doc.getText('content').insert(1, 'b');
    serverStep1(server);
    await Promise.resolve();
    await Promise.resolve();
    expect(ack.isConfirmed()).toBe(false);
    expect(ack.pendingSince()).toBe(1_001_000);
    ack.dispose();
  });

  it('a peer typing does not make this tab unconfirmed (only its own updates count)', async () => {
    const { asProvider, serverStep1 } = fakeProvider();
    const doc = new Y.Doc();
    const server = new Y.Doc();
    const ack = trackServerAck(asProvider, doc);
    doc.getText('content').insert(0, 'mine');
    Y.applyUpdate(server, Y.encodeStateAsUpdate(doc));
    serverStep1(server);
    await flush();
    expect(ack.isConfirmed()).toBe(true);

    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(server));
    peer.getText('content').insert(0, 'peer typed ');
    // Relayed by the server, with the provider as origin — before any new step 1 from the server.
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc)), asProvider);
    expect(ack.isConfirmed()).toBe(true);
    expect(ack.pendingSince()).toBeNull();
    ack.dispose();
  });

  it('copy loaded from disk (another origin) counts as this tab\'s own until the server has it', async () => {
    const { asProvider, serverStep1 } = fakeProvider();
    const doc = new Y.Doc();
    const ack = trackServerAck(asProvider, doc);
    const old = new Y.Doc();
    old.getText('content').insert(0, 'typed offline last week');
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(old), 'indexeddb');
    expect(ack.isConfirmed()).toBe(false);
    const server = new Y.Doc();
    Y.applyUpdate(server, Y.encodeStateAsUpdate(doc));
    serverStep1(server);
    await flush();
    expect(ack.isConfirmed()).toBe(true);
    ack.dispose();
  });

  it('a pure delete is unconfirmed until the server answers a step 1 sent after it', async () => {
    const { asProvider, serverStep1, sent } = fakeProvider();
    const doc = new Y.Doc();
    const server = new Y.Doc();
    const ack = trackServerAck(asProvider, doc);
    doc.getText('content').insert(0, 'abc');
    Y.applyUpdate(server, Y.encodeStateAsUpdate(doc));
    serverStep1(server);
    await flush();
    expect(ack.isConfirmed()).toBe(true);

    doc.getText('content').delete(0, 1);
    expect(ack.isConfirmed()).toBe(false);
    // A step 1 that answers nothing this tab sent after the delete (unsolicited): still unconfirmed.
    serverStep1(server);
    await flush();
    expect(ack.isConfirmed()).toBe(false);
    ack.probe();
    expect(sent.length).toBeGreaterThan(0);
    serverStep1(server);
    await flush();
    expect(ack.isConfirmed()).toBe(true);
    ack.dispose();
  });

  it('what the doc already holds when tracking starts must be confirmed too (sync engine order: load, then track)', async () => {
    const { asProvider, serverStep1 } = fakeProvider();
    const server = new Y.Doc();
    server.getText('content').insert(0, 'on the server');
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(server));
    doc.getText('content').insert(0, 'offline edit ');
    doc.getText('content').delete(0, 1); // and a deletion
    const ack = trackServerAck(asProvider, doc);
    expect(ack.isConfirmed()).toBe(false);
    serverStep1(server); // the server never took it
    await flush();
    expect(ack.isConfirmed()).toBe(false);
    expect(await ack.whenConfirmed(20)).toBe(false);
    Y.applyUpdate(server, Y.encodeStateAsUpdate(doc));
    ack.probe();
    serverStep1(server);
    await flush();
    expect(ack.isConfirmed()).toBe(true);
    ack.dispose();
  });

  it('a throwing listener never escapes into the doc update', () => {
    const { asProvider } = fakeProvider();
    const doc = new Y.Doc();
    const ack = trackServerAck(asProvider, doc);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ack.subscribe(() => {
      throw new Error('listener bug');
    });
    expect(() => doc.getText('content').insert(0, 'x')).not.toThrow();
    ack.dispose();
    vi.restoreAllMocks();
  });

  it('dispose restores the original handler', () => {
    const { provider, asProvider, original } = fakeProvider();
    const ack = trackServerAck(asProvider, new Y.Doc());
    expect(provider.messageHandlers[0]).not.toBe(original);
    ack.dispose();
    expect(provider.messageHandlers[0]).toBe(original);
  });
});
