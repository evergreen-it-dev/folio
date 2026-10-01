import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Folder } from 'lucide-react';
import type { PageMeta } from '@shared/contracts';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { Modal } from '../ui/Modal';
import { dirname } from './treeUtils';
import '../i18n/register';

export interface MoveDialogProps {
  page: PageMeta;
  /** All directories currently in use in the space (see treeUtils.collectDirectories), plus "" for the root. */
  directories: string[];
  onClose: () => void;
  onMoved: () => void;
  onError: (message: string) => void;
}

/** Parent-directory picker for POST /api/pages/:id/move. */
export function MoveDialog({ page, directories, onClose, onMoved, onError }: MoveDialogProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const currentParent = dirname(page.path);
  const [target, setTarget] = useState(currentParent);

  const move = useMutation({
    mutationFn: () => api.movePage(page.id, { toParentPath: target }),
    onSuccess: () => {
      onMoved();
      onClose();
    },
    onError: (err) => onError(errorText(err, 'sidebar.move.failed')),
  });

  return (
    <Modal
      title={t('sidebar.move.title', { title: page.title })}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            {t('ui.cancel')}
          </button>
          <button
            type="button"
            disabled={move.isPending || target === currentParent}
            onClick={() => move.mutate()}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {move.isPending ? t('sidebar.move.moving') : t('sidebar.move.action')}
          </button>
        </>
      }
    >
      <p className="mb-3 text-neutral-500">{t('sidebar.move.subtitle', { space: page.space })}</p>
      <div className="max-h-64 overflow-y-auto rounded-md border border-neutral-200 dark:border-neutral-700">
        {directories.map((dir) => (
          <button
            key={dir || '.'}
            type="button"
            onClick={() => setTarget(dir)}
            style={{ paddingLeft: `${10 + dir.split('/').filter(Boolean).length * 14}px` }}
            className={`flex w-full items-center gap-2 border-b border-neutral-100 px-2.5 py-1.5 text-left last:border-b-0 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-800 ${
              target === dir ? 'bg-neutral-100 font-medium dark:bg-neutral-800' : ''
            }`}
          >
            <Folder size={14} className="shrink-0 opacity-60" />
            <span className="truncate">{dir === '' ? t('sidebar.move.spaceRoot') : dir}</span>
            {dir === currentParent && <span className="ml-auto shrink-0 text-xs opacity-50">{t('sidebar.move.current')}</span>}
          </button>
        ))}
      </div>
    </Modal>
  );
}
