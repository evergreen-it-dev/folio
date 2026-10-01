import { useState } from 'react';
import { History } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { HistoryPanel } from './HistoryPanel';
import '../i18n/register';

export interface HistoryButtonProps {
  pageId: string;
  space: string;
  pagePath: string;
  /** editor+ in this space — viewers see history and can preview versions, but not restore (DEV-PLAN: "restore — editor+"). */
  canRestore: boolean;
}

/** Header icon button opening the page-history panel (list of commits touching this file + read-only version preview). */
export function HistoryButton({ pageId, space, pagePath, canRestore }: HistoryButtonProps) {
  const { t } = useTranslation('app');
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        aria-label={t('header.history')}
        title={t('header.history')}
        onClick={() => setOpen(true)}
        // max-md:min-h/w-10: touch-target floor (round 14), no-op at md+.
        className="inline-flex shrink-0 items-center justify-center rounded-md p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 max-md:min-h-10 max-md:min-w-10 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
      >
        <History size={15} aria-hidden="true" />
      </button>
      {open && (
        <HistoryPanel pageId={pageId} space={space} pagePath={pagePath} canRestore={canRestore} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
