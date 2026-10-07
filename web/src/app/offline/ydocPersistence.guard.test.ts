/**
 * persistYDoc's guard around y-indexeddb (06.10.2026). y-indexeddb writes each
 * update from inside the doc's 'update' event and throws there once its
 * connection is closed — another tab deleting the page's database closes it.
 * That exception escaped the editor's sync and made typed text stop reaching
 * the document. The fake below behaves like y-indexeddb in exactly that
 * respect: `_storeUpdate` is the doc listener, and it throws while "closed".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

const idb = vi.hoisted(() => ({
  instances: [] as Array<{ closed: boolean; stored: Uint8Array[]; destroyed: boolean }>,
}));

vi.mock('./db', () => ({ hasIndexedDb: () => true }));

vi.mock('y-indexeddb', () => {
  class FakeIndexeddbPersistence {
    closed = false;
    stored: Uint8Array[] = [];
    destroyed = false;
    whenSynced: Promise<this>;
    _storeUpdate: (update: Uint8Array, origin: unknown) => void;
    constructor(
      public name: string,
      public doc: Y.Doc,
    ) {
      idb.instances.push(this);
      // Like y-indexeddb: on open, the doc's whole current state is stored.
      this.stored.push(Y.encodeStateAsUpdate(doc));
      this._storeUpdate = (update: Uint8Array, origin: unknown) => {
        if (origin === this) return;
        if (this.closed) throw new Error("Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.");
        this.stored.push(update);
      };
      doc.on('update', this._storeUpdate);
      this.whenSynced = Promise.resolve(this);
    }
    async destroy() {
      this.destroyed = true;
      this.doc.off('update', this._storeUpdate);
    }
    async clearData() {
      await this.destroy();
    }
  }
  return { IndexeddbPersistence: FakeIndexeddbPersistence, clearDocument: async () => undefined };
});

const { persistYDoc, MAX_REOPENS } = await import('./ydocPersistence');

afterEach(() => {
  idb.instances.length = 0;
  vi.restoreAllMocks();
});

describe('persistYDoc guard', () => {
  it('a closed connection never throws out of a doc update, and a fresh one stores the whole state, the failed update included', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const doc = new Y.Doc();
    const persistence = persistYDoc('p1', doc);
    doc.getText('content').insert(0, 'before ');
    idb.instances[0].closed = true; // another tab deleted the database

    expect(() => doc.getText('content').insert(7, 'after')).not.toThrow();
    expect(idb.instances).toHaveLength(2);
    expect(idb.instances[0].destroyed).toBe(true);
    const reopened = new Y.Doc();
    for (const update of idb.instances[1].stored) Y.applyUpdate(reopened, update);
    expect(reopened.getText('content').toString()).toBe('before after');

    // Later updates go to the new connection only.
    doc.getText('content').insert(12, '!');
    expect(idb.instances[1].stored.length).toBeGreaterThan(1);
    persistence.destroy();
  });

  it('gives up local storage after MAX_REOPENS failures, still without throwing, and says so as an error', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const doc = new Y.Doc();
    persistYDoc('p2', doc);
    for (let i = 0; i <= MAX_REOPENS + 2; i++) {
      for (const instance of idb.instances) instance.closed = true;
      expect(() => doc.getText('content').insert(0, 'x')).not.toThrow();
    }
    expect(idb.instances).toHaveLength(MAX_REOPENS + 1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('gave up keeping a local copy'));
  });

  it('no reopening after the session cleared its own copy', async () => {
    const doc = new Y.Doc();
    const persistence = persistYDoc('p3', doc);
    await persistence.clear();
    idb.instances[0].closed = true;
    doc.getText('content').insert(0, 'x');
    expect(idb.instances).toHaveLength(1);
  });
});
