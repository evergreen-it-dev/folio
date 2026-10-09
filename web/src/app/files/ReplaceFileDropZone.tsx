import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useToast } from '../ui/Toast';
import { isFilePageName, useReplaceFilePage } from './useReplaceFilePage';
import '../i18n/register';

export interface ReplaceFileDropZoneProps {
  space: string;
  pageId: string;
  /** Current space-relative path of the page, to tell whether the dropped file changes the extension. */
  pagePath: string;
  /** Editor+ on this page. Without it nothing is wired and the children render as they are. */
  canEdit: boolean;
  className?: string;
  children: ReactNode;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

function isFileDrag(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

/**
 * Wraps the viewer of a file page: while a file from the desktop is dragged over
 * the window, a drop target covers the viewer (an iframe would swallow the drop
 * otherwise); dropping asks «Replace with …?» and only then uploads.
 */
export function ReplaceFileDropZone({ space, pageId, pagePath, canEdit, className, children }: ReplaceFileDropZoneProps) {
  const { t } = useTranslation('app');
  const showToast = useToast();
  const replaceFile = useReplaceFilePage(space, pageId);
  const [dragging, setDragging] = useState(false);
  const [pending, setPending] = useState<File | null>(null);

  useEffect(() => {
    if (!canEdit) return;
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      depth++;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const end = () => {
      depth = 0;
      setDragging(false);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', end);
    window.addEventListener('dragend', end);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', end);
      window.removeEventListener('dragend', end);
    };
  }, [canEdit]);

  if (!canEdit) return <div className={className}>{children}</div>;

  const currentExt = extensionOf(pagePath);
  const pendingExt = pending ? extensionOf(pending.name) : '';

  return (
    <div className={`relative ${className ?? ''}`}>
      {children}
      {dragging && (
        <div
          data-testid="replace-file-drop"
          onDragOver={(e) => {
            if (isFileDrag(e.nativeEvent)) {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
            }
          }}
          onDrop={(e) => {
            if (!isFileDrag(e.nativeEvent)) return;
            e.preventDefault();
            setDragging(false);
            const files = Array.from(e.dataTransfer.files);
            if (files.length !== 1) return showToast(t('files.replace.dropOne'));
            if (!isFilePageName(files[0].name)) return showToast(t('files.replace.unsupportedType'));
            setPending(files[0]);
          }}
          className="absolute inset-0 z-20 flex items-center justify-center border-2 border-dashed border-blue-500 bg-blue-50/90 text-sm font-medium text-blue-700 dark:bg-blue-950/80 dark:text-blue-200"
        >
          {t('files.replace.dropHint')}
        </div>
      )}
      {pending && (
        <ConfirmDialog
          title={t('files.replace.dropTitle', { name: pending.name })}
          confirmLabel={t('files.replace.dropConfirm')}
          busy={replaceFile.isPending}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            replaceFile.mutate(pending, { onSettled: () => setPending(null) });
          }}
        >
          <p>{t('files.replace.dropBody')}</p>
          {pendingExt !== currentExt && <p className="mt-2">{t('files.replace.dropBodyExt', { from: currentExt, to: pendingExt })}</p>}
        </ConfirmDialog>
      )}
    </div>
  );
}
