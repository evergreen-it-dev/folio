/** A read-only snapshot explicitly saved on this device, separate from pending edits. */
export interface SavedDocument {
  id: string;
  space: string;
  title: string;
  markdown: string;
  savedAt: number;
}

export type SavedDocumentSummary = Pick<SavedDocument, 'id' | 'space' | 'title'>;

const DATABASE = 'folio-offline-reader';
const CHANNEL = 'folio-saved-documents-changed';
const listeners = new Set<() => void>();
let channel: BroadcastChannel | undefined;

function notifyReaders(): void {
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent): void {
  if (event.key === CHANNEL && event.newValue !== null) notifyReaders();
}

/** The message carries no account or document data. Readers reopen the store after a commit. */
export function subscribeOfflineDocuments(listener: () => void): () => void {
  listeners.add(listener);
  if (!channel && typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = notifyReaders;
  } else if (typeof BroadcastChannel === 'undefined') {
    window.addEventListener('storage', onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      channel?.close();
      channel = undefined;
      window.removeEventListener('storage', onStorage);
    }
  };
}

function changed(): void {
  if (typeof BroadcastChannel !== 'undefined') {
    const sender = channel ?? new BroadcastChannel(CHANNEL);
    sender.postMessage(null);
    if (!channel) sender.close();
  } else {
    // Older browsers deliver storage events to the other windows on the origin.
    try {
      localStorage.setItem(CHANNEL, 'changed');
      localStorage.removeItem(CHANNEL);
    } catch { /* Storage may be disabled. */ }
  }
  notifyReaders();
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 2);
    request.onupgradeneeded = (event) => {
      if (event.oldVersion < 1) {
        request.result.createObjectStore('account');
        request.result.createObjectStore('documents', { keyPath: 'id' });
      }
      // IndexedDB populates the index for existing snapshots during the upgrade.
      request.transaction!.objectStore('documents').createIndex('library', ['id', 'space', 'title']);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Check the owner and access the documents in the same IndexedDB transaction.
// This serializes changes with other tabs, including a save racing with sign-out.
async function withAccount<T>(
  mode: IDBTransactionMode,
  apply: (owner: string | null, account: IDBObjectStore, docs: IDBObjectStore) => IDBRequest<T> | T,
): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(['account', 'documents'], mode);
      const account = tx.objectStore('account');
      const docs = tx.objectStore('documents');
      const owner = account.get('current');
      let result: IDBRequest<T> | T;
      tx.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
      tx.onabort = () => reject(tx.error ?? new Error('Offline document transaction aborted'));
      owner.onsuccess = () => {
        try {
          result = apply(owner.result ?? null, account, docs);
        } catch (error) {
          tx.abort();
          reject(error);
        }
      };
    });
  } finally {
    db.close();
  }
}

async function changeAccount(next: string | null, expected?: string): Promise<void> {
  const modified = await withAccount('readwrite', (owner, account, docs) => {
    if (owner === next || (expected !== undefined && owner !== expected)) return false;
    docs.clear();
    if (next === null) account.delete('current');
    else account.put(next, 'current');
    return true;
  });
  if (modified) changed();
}

export function setOfflineReaderAccount(accountId: string | null): Promise<void> {
  return changeAccount(accountId);
}

export function clearOfflineDocuments(): Promise<void> {
  return changeAccount(null);
}

/** A delayed response about a previous session must not clear a new account's copies. */
export function clearOfflineReaderAccount(accountId: string): Promise<void> {
  return changeAccount(null, accountId);
}

export async function saveOfflineDocument(accountId: string, doc: SavedDocument): Promise<void> {
  await withAccount('readwrite', (owner, _account, docs) => {
    if (owner !== accountId || !owner) throw new Error('The offline reader account has changed');
    return docs.put(doc);
  });
  changed();
}

export async function removeOfflineDocument(accountId: string, id: string): Promise<void> {
  const removed = await withAccount('readwrite', (owner, _account, docs) => {
    if (!owner || owner !== accountId) return false;
    docs.delete(id);
    return true;
  });
  if (removed) changed();
}

/** The key cursor supplies the entire library listing without cloning any Markdown bodies. */
export function listOfflineDocuments(accountId?: string): Promise<SavedDocumentSummary[]> {
  return withAccount<SavedDocumentSummary[]>('readonly', (owner, _account, docs) => {
    const entries: SavedDocumentSummary[] = [];
    if (!owner || (accountId !== undefined && owner !== accountId)) return entries;
    const request = docs.index('library').openKeyCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const [id, space, title] = cursor.key as [string, string, string];
      entries.push({ id, space, title });
      cursor.continue();
    };
    // withAccount resolves once the transaction (including all cursor reads) completes.
    return entries;
  });
}

export async function getOfflineDocument(space: string, id: string): Promise<SavedDocument | undefined> {
  const doc = await withAccount<SavedDocument | undefined>('readonly', (owner, _account, docs) =>
    owner ? docs.get(id) : undefined);
  return doc?.space === space ? doc : undefined;
}

export async function hasOfflineDocument(accountId: string, id: string): Promise<boolean> {
  const key = await withAccount<IDBValidKey | undefined>('readonly', (owner, _account, docs) =>
    owner && owner === accountId ? docs.getKey(id) : undefined);
  return key !== undefined;
}

export async function listOfflineDocumentIds(accountId: string): Promise<string[]> {
  const keys = await withAccount<IDBValidKey[]>('readonly', (owner, _account, docs) =>
    owner && owner === accountId ? docs.getAllKeys() : []);
  return keys.map(String);
}
