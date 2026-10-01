import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { useToast } from '../ui/Toast';
import '../i18n/register';

/**
 * "Take the version from Git" (POST /api/spaces/:space/git/reset-to-remote) — shared
 * by every place that offers the action (the sidebar space menu, the
 * space-level ConflictBanner, and PageConflictBanner on a page whose file
 * itself has conflict markers) so the mutation/toast/invalidation behavior
 * can't drift between them. Invalidates ['spaces'] (git status/conflicts)
 * and ['tree', space] (page titles/paths, in case the reset renamed/removed
 * pages) — the same pair syncSpace's own callers already refetch.
 */
export function useResetSpaceToRemote(space: string) {
  const { t } = useTranslation('app');
  const queryClient = useQueryClient();
  const showToast = useToast();
  const errorText = useApiErrorText();

  return useMutation({
    mutationFn: () => api.resetSpaceToRemote(space),
    onSuccess: (result) => {
      showToast(t('git.resetToRemote.success', { count: result.changedCount }), 'info');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
      queryClient.invalidateQueries({ queryKey: ['tree', space] });
    },
    onError: (err) => showToast(errorText(err, 'git.resetToRemote.failed')),
  });
}
