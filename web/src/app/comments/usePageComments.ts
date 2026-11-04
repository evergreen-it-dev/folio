/**
 * Data side of the inline comments: the thread list as a query, the mutations,
 * and the poor man's realtime.
 *
 * The server pushes nothing. A client that changed a thread bumps `commentsRev`
 * in its own Yjs awareness state, and every other client in the page's room
 * sees that field change and refetches (docs: shared/comments.ts). The list is
 * also refetched when the window regains focus, which covers a peer that was
 * not in the room at the time.
 */
import { useCallback, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CommentThreadStatus, CreateCommentThreadBody, PageCommentsResponse } from '@shared/comments';
import { api } from '../api';
import type { CollabSession } from '../../editor/collab';

export const pageCommentsKey = (pageId: string) => ['page-comments', pageId] as const;

/** The awareness field a client bumps after changing comments. */
export const COMMENTS_REV_FIELD = 'commentsRev';

export function usePageCommentsQuery(pageId: string, enabled: boolean) {
  return useQuery<PageCommentsResponse>({
    queryKey: pageCommentsKey(pageId),
    queryFn: () => api.listPageComments(pageId),
    enabled,
    refetchOnWindowFocus: true,
    staleTime: 10_000,
    // A server that does not answer (or has no comments yet) just means no
    // comments UI — it must not turn into repeated failing requests.
    retry: false,
  });
}

/** Tell the peers in the room that the comments changed. */
export function announceCommentsChange(session: CollabSession | null): void {
  session?.provider.awareness.setLocalStateField(COMMENTS_REV_FIELD, Date.now());
}

/** Refetch when any REMOTE client's `commentsRev` changes. */
export function useCommentsRealtime(session: CollabSession | null, pageId: string, enabled: boolean): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!session || !enabled) return;
    const { awareness } = session.provider;
    const seen = new Map<number, unknown>();
    for (const [clientId, state] of awareness.getStates()) seen.set(clientId, (state as Record<string, unknown>)[COMMENTS_REV_FIELD]);
    const onChange = () => {
      let changed = false;
      const alive = new Set<number>();
      for (const [clientId, state] of awareness.getStates()) {
        alive.add(clientId);
        if (clientId === awareness.clientID) continue;
        const rev = (state as Record<string, unknown>)[COMMENTS_REV_FIELD];
        // A peer that just arrived has nothing to tell yet: what it did before
        // we looked is in the list we fetched when the page opened.
        if (seen.has(clientId) && seen.get(clientId) !== rev) changed = true;
        seen.set(clientId, rev);
      }
      for (const clientId of seen.keys()) if (!alive.has(clientId)) seen.delete(clientId);
      if (changed) void queryClient.invalidateQueries({ queryKey: pageCommentsKey(pageId) });
    };
    awareness.on('change', onChange);
    return () => awareness.off('change', onChange);
  }, [session, pageId, enabled, queryClient]);
}

export interface CommentActions {
  createThread(body: CreateCommentThreadBody): Promise<void>;
  reply(threadId: string, body: string): Promise<void>;
  edit(commentId: string, body: string): Promise<void>;
  remove(commentId: string): Promise<void>;
  setStatus(threadId: string, status: CommentThreadStatus): Promise<void>;
}

/** Every mutation: call the API, refresh the list, tell the peers. A failure is thrown to the caller, which shows it where the user typed. */
export function useCommentActions(pageId: string, session: CollabSession | null): CommentActions {
  const queryClient = useQueryClient();
  const done = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: pageCommentsKey(pageId) });
    announceCommentsChange(session);
  }, [queryClient, pageId, session]);
  return useMemo<CommentActions>(
    () => ({
      createThread: async (body) => {
        await api.createCommentThread(pageId, body);
        await done();
      },
      reply: async (threadId, body) => {
        await api.replyToCommentThread(threadId, body);
        await done();
      },
      edit: async (commentId, body) => {
        await api.editComment(commentId, body);
        await done();
      },
      remove: async (commentId) => {
        await api.deleteComment(commentId);
        await done();
      },
      setStatus: async (threadId, status) => {
        await api.setCommentThreadStatus(threadId, status);
        await done();
      },
    }),
    [pageId, done],
  );
}
