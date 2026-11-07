import { Columns2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useCompare } from '../compare/compareContext';
import '../i18n/register';

export interface CompareButtonProps {
  pageId: string;
  space: string;
  title: string;
}

/** Header icon button: puts the page in (or takes it out of) the compare list — the sidebar row's "Add to comparison", for the page that is open. */
export function CompareButton({ pageId, space, title }: CompareButtonProps) {
  const { t } = useTranslation('app');
  const compare = useCompare();
  const inList = compare.has({ pageId });
  const label = t(inList ? 'compare.remove' : 'compare.add');
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={inList}
      title={label}
      onClick={() => (inList ? compare.remove({ pageId }) : compare.add({ pageId, space, title }))}
      // max-md:min-h/w-10: touch-target floor (round 14), no-op at md+.
      className={`inline-flex shrink-0 items-center justify-center rounded-md p-1.5 hover:bg-neutral-100 max-md:min-h-10 max-md:min-w-10 dark:hover:bg-neutral-800 ${
        inList ? 'text-blue-600 dark:text-blue-400' : 'text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100'
      }`}
    >
      <Columns2 size={15} aria-hidden="true" />
    </button>
  );
}
