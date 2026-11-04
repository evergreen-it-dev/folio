import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { GitConflictChoice } from '@shared/contracts';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { useToast } from '../ui/Toast';
import '../i18n/register';

/** Explicit choice for one deletion / binary git conflict (POST …/git/resolve-conflict); the next Sync pushes. */
export function useResolveGitConflict(space: string) {
  const { t } = useTranslation('app');
  const queryClient = useQueryClient();
  const showToast = useToast();
  const errorText = useApiErrorText();

  return useMutation({
    mutationFn: (v: { path: string; choice: GitConflictChoice }) => api.resolveGitConflict(space, v.path, v.choice),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
      queryClient.invalidateQueries({ queryKey: ['tree', space] });
    },
    onError: (err) => showToast(errorText(err, 'git.conflictBanner.resolveFailed')),
    onSuccess: () => showToast(t('git.conflictBanner.resolved'), 'info'),
  });
}
