/**
 * `api.createPage` that does not give up when the network does.
 *
 * Online it is exactly the old call. When the server cannot be reached —
 * known up front (`offline`) or found out the hard way (the request itself
 * fails at the network level) — a document or a board is created on this
 * device instead (localPages.ts), opens like any other page, and reaches
 * the server through the sync engine later. The caller gets a `PageMeta`
 * either way; `local` says which it was, for the wording of the toast.
 *
 * Only a NETWORK failure falls back. A server that answered — 403, 400,
 * 409 — said something the author has to hear; creating the page locally
 * would only postpone the same refusal.
 */
import type { QueryClient } from '@tanstack/react-query';
import type { CreatePageBody, PageMeta } from '@shared/contracts';
import { ApiError, api, type TreeResponse } from '../api';
import { getConnectivity } from './connectivity';
import { createLocalPage, localPageDoc, localPageMeta, offlineCreatableKind } from './localPages';
import { requestSync } from './syncEngine';
import { seedLocalPage } from './ydocPersistence';

export interface CreatedPage {
  page: PageMeta;
  local: boolean;
}

/** Thrown for a kind that needs the server (table, form, upload) when there is none. */
export class OfflineUnsupportedError extends Error {
  constructor(readonly kind: string) {
    super(`"${kind}" cannot be created offline`);
    this.name = 'OfflineUnsupportedError';
  }
}

/**
 * The request did not reach the application: the network refused it, or the
 * proxy in front of the app answered for it (502/503 — the container is
 * restarting or gone). NOT 504: a gateway timeout means the app may well
 * have received the request and created the page, and a local twin of it
 * would then be a duplicate.
 */
function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof ApiError && (error.status === 502 || error.status === 503));
}

function pathsOf(tree: TreeResponse | undefined): string[] {
  const out: string[] = [];
  const walk = (nodes: TreeResponse['tree']) => {
    for (const node of nodes) {
      out.push(node.path);
      walk(node.children);
    }
  };
  if (tree) walk(tree.tree);
  return out;
}

export async function createPageOfflineAware(queryClient: QueryClient, body: CreatePageBody): Promise<CreatedPage> {
  const kind = body.kind ?? 'doc';
  if (getConnectivity() !== 'offline') {
    try {
      return { page: await api.createPage(body), local: false };
    } catch (error) {
      if (!isNetworkError(error)) throw error;
      // The request never reached the server (api.ts does not retry a POST):
      // nothing was created there, so creating it here cannot duplicate it.
    }
  }
  if (!offlineCreatableKind(kind)) throw new OfflineUnsupportedError(kind);

  const cached = queryClient.getQueryData<TreeResponse>(['tree', body.space]);
  const local = await createLocalPage({ space: body.space, parentPath: body.parentPath, title: body.title, kind }, pathsOf(cached));
  await seedLocalPage(local);
  queryClient.setQueryData(['page', local.id], localPageDoc(local));
  // In case the failure was a blip rather than an outage: the engine
  // declines by itself while the connection is `offline`.
  void requestSync();
  return { page: localPageMeta(local), local: true };
}

/** The tree as of now — from the server when it answers, from the cache when it cannot. */
export async function treeOfflineAware(queryClient: QueryClient, space: string): Promise<TreeResponse> {
  const cached = queryClient.getQueryData<TreeResponse>(['tree', space]);
  if (getConnectivity() === 'offline' && cached) return cached;
  try {
    return await api.getTree(space);
  } catch (error) {
    if (cached && isNetworkError(error)) return cached;
    throw error;
  }
}
