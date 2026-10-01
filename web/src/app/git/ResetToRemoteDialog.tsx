import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useResetSpaceToRemote } from './useResetSpaceToRemote';
import '../i18n/register';

export interface ResetToRemoteDialogProps {
  space: string;
  onClose: () => void;
}

/**
 * Confirms "Take the version from Git" before running it — local changes not yet in
 * git are about to be replaced by the git version. Shared by every entry
 * point (Sidebar's space menu, ConflictBanner, PageConflictBanner) so the
 * wording/behavior is identical regardless of where it was triggered from.
 */
export function ResetToRemoteDialog({ space, onClose }: ResetToRemoteDialogProps) {
  const { t } = useTranslation('app');
  const reset = useResetSpaceToRemote(space);

  return (
    <ConfirmDialog
      title={t('git.resetToRemote.confirmTitle')}
      confirmLabel={t('git.resetToRemote.confirmButton')}
      destructive
      busy={reset.isPending}
      onCancel={onClose}
      onConfirm={() => reset.mutate(undefined, { onSettled: onClose })}
    >
      {t('git.resetToRemote.confirmBody')}
    </ConfirmDialog>
  );
}
