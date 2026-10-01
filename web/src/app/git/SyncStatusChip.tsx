import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SpaceGitInfo } from '@shared/contracts';
import '../i18n/register';

export interface SyncStatusChipProps {
  /** Undefined when the space has no git info yet (server hasn't landed the field, or this SpaceInfo predates round 3) — renders nothing, never guesses. */
  git: SpaceGitInfo | undefined;
}

/** Small status indicator next to the space name, driven by SpaceGitInfo.status. */
export function SyncStatusChip({ git }: SyncStatusChipProps) {
  const { t } = useTranslation('app');
  if (!git) return null;

  switch (git.status) {
    case 'local':
      return (
        <span className="shrink-0 rounded-full bg-neutral-200 px-1.5 py-0.5 text-[10px] font-medium text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300">
          {t('git.status.local')}
        </span>
      );
    case 'clean':
      return (
        <span
          title={t('git.status.synced')}
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-green-500"
          aria-label={t('git.status.synced')}
        />
      );
    case 'syncing':
      return <Loader2 size={12} className="shrink-0 animate-spin text-neutral-400" aria-label={t('git.status.syncing')} />;
    case 'ahead':
    case 'behind': {
      const parts: string[] = [];
      if (git.ahead > 0) parts.push(`${git.ahead}↑`);
      if (git.behind > 0) parts.push(`${git.behind}↓`);
      if (parts.length === 0) return null;
      return (
        <span
          title={t('git.status.pendingChanges')}
          className="shrink-0 rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-950 dark:text-blue-300"
        >
          {parts.join(' / ')}
        </span>
      );
    }
    case 'conflict':
      return (
        <span title={t('git.status.conflict')} className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" aria-label={t('git.status.conflict')} />
      );
    case 'error':
      return (
        <span
          title={git.lastError ?? t('git.status.syncError')}
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500"
          aria-label={git.lastError ?? t('git.status.syncError')}
        />
      );
    default:
      return null;
  }
}
