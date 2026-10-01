import { useTranslation } from 'react-i18next';
import type { AccessMatrixResponse, SpaceVisibility } from '@shared/contracts';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { activeUserCount, usersLosingAccessOnPrivate } from './logic';
import '../../i18n/register';

export interface VisibilityConfirmDialogProps {
  matrix: Pick<AccessMatrixResponse, 'users' | 'roles'>;
  space: string;
  spaceName: string;
  next: SpaceVisibility;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Round 27 §3's exact confirmation requirements: switching to `instance`
 * must say "all N users of the instance will see the space"; switching to
 * `private` must show WHO loses access (computed client-side from the
 * matrix, since the server doesn't precompute this list).
 */
export function VisibilityConfirmDialog({ matrix, space, spaceName, next, busy, onConfirm, onCancel }: VisibilityConfirmDialogProps) {
  const { t } = useTranslation('app');

  if (next === 'instance') {
    const count = activeUserCount(matrix.users);
    return (
      <ConfirmDialog title={t('access.visibility.toInstanceTitle', { space: spaceName })} busy={busy} onConfirm={onConfirm} onCancel={onCancel}>
        <p>{t('access.visibility.toInstanceBody', { space: spaceName, count })}</p>
      </ConfirmDialog>
    );
  }

  const losing = usersLosingAccessOnPrivate(matrix, space);
  return (
    <ConfirmDialog title={t('access.visibility.toPrivateTitle', { space: spaceName })} busy={busy} onConfirm={onConfirm} onCancel={onCancel}>
      <p className="mb-2">{t('access.visibility.toPrivateBody', { space: spaceName })}</p>
      {losing.length === 0 ? (
        <p className="text-neutral-500 dark:text-neutral-400">{t('access.visibility.toPrivateNoneLost')}</p>
      ) : (
        <ul className="max-h-40 list-disc overflow-y-auto pl-4 text-neutral-700 dark:text-neutral-300">
          {losing.map((u) => (
            <li key={u.id}>
              {u.name} ({u.email})
            </li>
          ))}
        </ul>
      )}
    </ConfirmDialog>
  );
}
