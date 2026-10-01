import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from './Modal';
import '../i18n/register';

export interface ConfirmDialogProps {
  title: string;
  children: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Confirm/cancel dialog, e.g. for page deletion. */
export function ConfirmDialog({ title, children, confirmLabel, destructive, busy, onConfirm, onCancel }: ConfirmDialogProps) {
  const { t } = useTranslation('app');
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            {t('ui.cancel')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={
              destructive
                ? 'rounded-md bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700 disabled:opacity-50'
                : 'rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-neutral-900'
            }
          >
            {busy ? t('ui.pleaseWait') : (confirmLabel ?? t('ui.confirm'))}
          </button>
        </>
      }
    >
      {children}
    </Modal>
  );
}
