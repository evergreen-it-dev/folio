import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

export const proposalsKey = (space: string) => ['proposals', space] as const;
export const pageProposalsKey = (pageId: string) => ['proposals', 'page', pageId] as const;

/** Open proposals of a space the caller may review. `enabled` is false for a viewer: the endpoint is editor+. */
export function useProposals(space: string, enabled: boolean) {
  return useQuery({
    queryKey: proposalsKey(space),
    queryFn: () => api.listProposals(space),
    enabled,
    // A new proposal also arrives as a bell row (NotificationsHost invalidates this key); the poll covers a missed frame.
    refetchInterval: 60_000,
    retry: false,
  });
}

export function usePageProposals(pageId: string, enabled: boolean) {
  return useQuery({
    queryKey: pageProposalsKey(pageId),
    queryFn: () => api.listPageProposals(pageId),
    enabled,
    refetchInterval: 60_000,
    retry: false,
  });
}
