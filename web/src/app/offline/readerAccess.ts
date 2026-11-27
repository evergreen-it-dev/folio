import { api, ApiError } from '../api';
import { offlineReaderReady } from './readerReady';
import { clearOfflineReaderAccount, listOfflineDocumentIds, markOfflineDocumentVerified, removeOfflineDocument, saveOfflineDocument } from './savedDocuments';
import { sessionLifetimeMs } from './sessionLifetime';

export async function forgetDeniedDocument(account: string, id: string, error: unknown): Promise<void> {
  if (!(error instanceof ApiError)) return;
  if (error.status === 401 || error.status === 409) await clearOfflineReaderAccount(account);
  if (error.status === 403 || error.status === 404) await removeOfflineDocument(account, id);
}

/** Store a fresh, server-authorized copy. An open editor can have newer, still unsent changes. */
export async function saveDocumentForOfflineReading(account: string, id: string, space: string): Promise<void> {
  if (!(await offlineReaderReady())) throw new Error('The offline reader is unavailable.');
  try {
    const page = await api.getPage(id, account);
    if (page?.id !== id || page.space !== space || page.kind !== 'doc' || typeof page.markdown !== 'string') {
      throw new Error('This page cannot be saved for offline reading.');
    }
    const now = Date.now();
    await saveOfflineDocument(account, { id, space, title: page.title, markdown: page.markdown, savedAt: now, verifiedAt: now }, sessionLifetimeMs());
  } catch (error) {
    await forgetDeniedDocument(account, id, error);
    throw error;
  }
}

/** The role endpoint also returns a successful response with role=null when access was withdrawn. */
export async function verifyOfflineDocuments(account: string, signal: AbortSignal): Promise<void> {
  const ids = await listOfflineDocumentIds(account);
  for (const id of ids) {
    if (signal.aborted) return;
    try {
      const access = await api.getMyPageRole(id, account, signal);
      if (signal.aborted) return;
      if (access?.role === null) await removeOfflineDocument(account, id);
      else await markOfflineDocumentVerified(account, id);
    } catch (error) {
      if (signal.aborted) return;
      await forgetDeniedDocument(account, id, error);
      if (!(error instanceof ApiError) || error.status === 401 || error.status === 409 || error.status >= 500) return;
    }
  }
}
