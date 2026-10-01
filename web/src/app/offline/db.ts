/**
 * The small key-value stores offline mode keeps in the browser, behind one
 * interface with two implementations: IndexedDB where there is one, plain
 * memory where there is not (jsdom, a private window that refuses storage).
 * Memory means "this tab only" — offline work then survives everything
 * except closing the tab, which is still strictly better than refusing to
 * work at all.
 *
 * Not localStorage: a board's Yjs state alone can outgrow its ~5 MB, and its
 * API is synchronous. The Yjs documents themselves are NOT in here — they
 * live in their own per-page databases, written by y-indexeddb (see
 * ydocPersistence.ts); this database holds the bookkeeping around them.
 */
const DB_NAME = 'folio-offline';
const DB_VERSION = 1;

/** `pages`: pages created offline, not on the server yet. `dirty`: server pages with local edits the server has not seen. */
export type StoreName = 'pages' | 'dirty';

const KEY_PATH: Record<StoreName, string> = { pages: 'id', dirty: 'pageId' };

export interface KeyValueStore<T> {
  getAll(): Promise<T[]>;
  put(value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

let opening: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of Object.keys(KEY_PATH) as StoreName[]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: KEY_PATH[name] });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'));
    request.onblocked = () => reject(new Error('indexedDB open blocked'));
  }).catch((error) => {
    opening = null;
    throw error;
  });
  return opening;
}

function run<R>(name: StoreName, mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<R>): Promise<R> {
  return openDb().then(
    (db) =>
      new Promise<R>((resolve, reject) => {
        const tx = db.transaction(name, mode);
        const request = work(tx.objectStore(name));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = () => reject(tx.error ?? request.error ?? new Error('indexedDB transaction failed'));
        tx.onabort = () => reject(tx.error ?? new Error('indexedDB transaction aborted'));
      }),
  );
}

export function memoryStore<T>(keyOf: (value: T) => string): KeyValueStore<T> {
  const items = new Map<string, T>();
  return {
    getAll: async () => [...items.values()],
    put: async (value) => void items.set(keyOf(value), value),
    delete: async (key) => void items.delete(key),
  };
}

export function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

/**
 * IndexedDB when it works, memory when it does not — decided per call, so a
 * store that failed once (quota, a browser that revokes storage mid-session)
 * keeps answering from memory instead of rejecting every write after it.
 */
export function openStore<T>(name: StoreName, keyOf: (value: T) => string): KeyValueStore<T> {
  const memory = memoryStore<T>(keyOf);
  if (!hasIndexedDb()) return memory;
  let broken = false;
  const guard = async <R>(idb: () => Promise<R>, fallback: () => Promise<R>): Promise<R> => {
    if (broken) return fallback();
    try {
      return await idb();
    } catch (error) {
      broken = true;
      // eslint-disable-next-line no-console
      console.warn(`[offline] IndexedDB store "${name}" unavailable, keeping this tab's data in memory:`, error);
      return fallback();
    }
  };
  return {
    getAll: () => guard(() => run<T[]>(name, 'readonly', (store) => store.getAll() as IDBRequest<T[]>), memory.getAll),
    put: async (value) => {
      // Memory always gets the write too: it is what a later fallback reads.
      await memory.put(value);
      await guard(() => run(name, 'readwrite', (store) => store.put(value)).then(() => undefined), async () => undefined);
    },
    delete: async (key) => {
      await memory.delete(key);
      await guard(() => run(name, 'readwrite', (store) => store.delete(key)).then(() => undefined), async () => undefined);
    },
  };
}
