import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Stars } from '@shared/contracts';
import { api } from './api';

export type StarKind = 'space' | 'page';

export const EMPTY_STARS: Stars = { spaces: [], pages: [] };

/**
 * Pure reducer: applies one star/unstar toggle to a Stars snapshot,
 * returning a new object (or the same `stars` reference, unchanged, if it's
 * already in the requested state — keeps this idempotent under retries).
 * The one piece of this feature worth unit testing in isolation; the actual
 * optimistic-update wiring (useToggleStar below) is just react-query
 * plumbing around it.
 */
export function applyStarToggle(stars: Stars, kind: StarKind, id: string, starred: boolean): Stars {
  const listKey = kind === 'space' ? 'spaces' : 'pages';
  const list = stars[listKey];
  const has = list.includes(id);
  if (has === starred) return stars;
  const nextList = starred ? [...list, id] : list.filter((existing) => existing !== id);
  return { ...stars, [listKey]: nextList };
}

export function isStarred(stars: Stars | undefined, kind: StarKind, id: string): boolean {
  if (!stars) return false;
  return (kind === 'space' ? stars.spaces : stars.pages).includes(id);
}

const STARS_KEY = ['stars'] as const;

export function useStars() {
  return useQuery({ queryKey: STARS_KEY, queryFn: api.getStars });
}

interface ToggleStarVars {
  kind: StarKind;
  id: string;
  starred: boolean;
}

/** Optimistic star/unstar: flips the local cache immediately via applyStarToggle, reverts to the pre-mutation snapshot on error, reconciles with the server on settle. */
export function useToggleStar() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ kind, id, starred }: ToggleStarVars) =>
      kind === 'space' ? api.setSpaceStar(id, starred) : api.setPageStar(id, starred),

    onMutate: async ({ kind, id, starred }: ToggleStarVars) => {
      await queryClient.cancelQueries({ queryKey: STARS_KEY });
      const previous = queryClient.getQueryData<Stars>(STARS_KEY);
      queryClient.setQueryData<Stars>(STARS_KEY, (current) => applyStarToggle(current ?? EMPTY_STARS, kind, id, starred));
      return { previous };
    },

    onError: (_err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(STARS_KEY, context.previous);
    },

    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: STARS_KEY });
    },
  });
}
