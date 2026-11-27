/** A read-only snapshot explicitly saved on this device, separate from pending edits. */
export interface SavedDocument {
  id: string;
  space: string;
  title: string;
  markdown: string;
  savedAt: number;
  /**
   * Last time the server confirmed online that this account still has access. Copies saved before
   * this field existed have none: their `savedAt` stands in for it.
   */
  verifiedAt?: number;
}

export type SavedDocumentSummary = Pick<SavedDocument, 'id' | 'space' | 'title'>;

const DATABASE = 'folio-offline-reader';
const SESSION_TTL_KEY = 'sessionTtlMs';
/**
 * Used when no lifetime was stored with the copies. Same as the server's default session
 * lifetime (server/auth/sessionTtl.ts, FOLIO_SESSION_TTL_DAYS).
 */
export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
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

/**
 * `sessionTtlMs` is the server's session lifetime. The offline reader cannot ask the server, so it
 * is kept next to the copies and pruneExpiredOfflineDocuments reads it back.
 */
export async function saveOfflineDocument(accountId: string, doc: SavedDocument, sessionTtlMs?: number): Promise<void> {
  await withAccount('readwrite', (owner, account, docs) => {
    if (owner !== accountId || !owner) throw new Error('The offline reader account has changed');
    if (sessionTtlMs) account.put(sessionTtlMs, SESSION_TTL_KEY);
    return docs.put(doc);
  });
  changed();
}

/** The server just confirmed this account's access to the document: restart its expiry clock. */
export async function markOfflineDocumentVerified(accountId: string, id: string, now = Date.now()): Promise<void> {
  await withAccount('readwrite', (owner, _account, docs) => {
    if (!owner || owner !== accountId) return;
    const request = docs.get(id);
    request.onsuccess = () => {
      if (request.result) docs.put({ ...request.result, verifiedAt: now });
    };
  });
}

/**
 * Deletes the copies the server has not confirmed within the session lifetime: the session may
 * have ended or the access been withdrawn while the device stayed offline, and nothing else
 * would ever remove them. Returns how many were deleted.
 */
export async function pruneExpiredOfflineDocuments(now = Date.now()): Promise<number> {
  const result = { removed: 0 };
  await withAccount('readwrite', (owner, account, docs) => {
    if (!owner) return result;
    const ttl = account.get(SESSION_TTL_KEY);
    ttl.onsuccess = () => {
      const lifetime = typeof ttl.result === 'number' && ttl.result > 0 ? ttl.result : DEFAULT_SESSION_TTL_MS;
      const cursorRequest = docs.openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        const doc = cursor.value as SavedDocument;
        const stamp = Number.isFinite(doc.verifiedAt) ? doc.verifiedAt! : Number.isFinite(doc.savedAt) ? doc.savedAt : 0;
        if (now - stamp >= lifetime) {
          cursor.delete();
          result.removed++;
        }
        cursor.continue();
      };
    };
    return result;
  });
  if (result.removed) changed();
  return result.removed;
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
