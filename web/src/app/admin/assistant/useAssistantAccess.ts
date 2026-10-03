import { useQuery } from '@tanstack/react-query';
import { ApiError, api } from '../../api';

export const ASSISTANT_ACCESS_QUERY_KEY = ['assistant-admin', 'access'] as const;

/**
 * Who the signed-in user is for the assistant analytics: `{ scope: 'instance' }`,
 * `{ scope: 'spaces', spaces }` for a space admin, or a 403 error (no access).
 * Shared by the user menu (to show the item) and the page (its guard) through one
 * cache entry, so it is asked once per session, not on every render. Never retried
 * on a refusal; the server enforces the same rule on every analytics endpoint.
 */
export function useAssistantAccess(enabled = true) {
  return useQuery({
    queryKey: ASSISTANT_ACCESS_QUERY_KEY,
    queryFn: () => api.getAdminAssistantAccess(),
    enabled,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: (count, err) => !(err instanceof ApiError && (err.status === 401 || err.status === 403)) && count < 1,
  });
}
