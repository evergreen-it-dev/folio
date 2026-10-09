import { useRef } from 'react';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { FILE_PAGE_ACCEPT, useReplaceFilePage } from './useReplaceFilePage';
import '../i18n/register';

export interface ReplaceFileButtonProps {
  space: string;
  pageId: string;
  /** Styling of the icon button, so the header keeps one look for all its icons. */
  className: string;
}

/** Header icon button of a file page: opens the file picker and replaces the page's file with the chosen one. Editor+ only (the caller decides). */
export function ReplaceFileButton({ space, pageId, className }: ReplaceFileButtonProps) {
  const { t } = useTranslation('app');
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceFile = useReplaceFilePage(space, pageId);
  const label = t('files.replace.action');
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={FILE_PAGE_ACCEPT}
        className="hidden"
        data-testid="replace-file-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) replaceFile.mutate(file);
        }}
      />
      <button
        type="button"
        aria-label={label}
        title={label}
        disabled={replaceFile.isPending}
        onClick={() => inputRef.current?.click()}
        className={`${className} disabled:opacity-50`}
      >
        <RefreshCw size={15} aria-hidden="true" className={replaceFile.isPending ? 'animate-spin' : undefined} />
      </button>
    </>
  );
}
