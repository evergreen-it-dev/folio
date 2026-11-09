import { createContext, useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

/**
 * The usernames the comment box offers after "@" (GET /api/spaces/:space/mentionable,
 * the same list the table's user column uses). A context rather than a prop so
 * the three composers (new thread, reply, edit) get it without plumbing; the
 * default is "no suggestions", which is also what a failed request degrades to.
 */
export interface MentionCandidate {
  username: string;
  name: string;
}

export const MentionCandidatesContext = createContext<readonly MentionCandidate[]>([]);

export function useMentionCandidatesValue(space: string | undefined, enabled: boolean): readonly MentionCandidate[] {
  const { data } = useQuery({
    queryKey: ['mentionable', space],
    queryFn: () => api.listMentionable(space!),
    enabled: enabled && Boolean(space),
    staleTime: 5 * 60_000,
    retry: false,
  });
  return (data?.users ?? []).map((user) => ({ username: user.username, name: user.name }));
}

export function useMentionCandidates(): readonly MentionCandidate[] {
  return useContext(MentionCandidatesContext);
}

/** The `@partial` that ends right at the caret, if any: where it starts and what has been typed. */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const match = /(?:^|[\s(])@([A-Za-z0-9._-]*)$/.exec(text.slice(0, caret));
  if (!match) return null;
  return { start: caret - match[1].length - 1, query: match[1].toLowerCase() };
}
