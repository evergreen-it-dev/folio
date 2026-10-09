import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { useToast } from '../ui/Toast';
import '../i18n/register';

/** File types a file page can hold — the same set the upload accepts. */
export const FILE_PAGE_ACCEPT = '.pdf,.docx,.xlsx,.pptx';

/** True when the name has one of the extensions a file page can hold. */
export function isFilePageName(name: string): boolean {
  return /\.(pdf|docx|xlsx|pptx)$/i.test(name);
}

/**
 * Everything on screen that depends on the file page's content or path: the
 * page itself (viewers key their reload on its updatedAt), the tree (the name
 * changes with the extension), and the open history list.
 */
export function useRefreshFilePage(space: string, pageId: string): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['page', pageId] });
    void queryClient.invalidateQueries({ queryKey: ['tree', space] });
    void queryClient.invalidateQueries({ queryKey: ['history', pageId] });
  };
}

/**
 * "Replace with new version…": uploads a file over an existing file page. On
 * success the page shows the new version straight away (its queries are
 * refreshed) and a toast offers «Undo», which restores the version just
 * replaced from the page history.
 */
export function useReplaceFilePage(space: string, pageId: string) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const showToast = useToast();
  const refresh = useRefreshFilePage(space, pageId);

  async function undo(sha: string): Promise<void> {
    try {
      await api.restoreVersion(pageId, sha);
      refresh();
      showToast(t('files.replace.undone'), 'info');
    } catch (err) {
      showToast(errorText(err, 'files.replace.undoFailed'));
    }
  }

  return useMutation({
    mutationFn: (file: File) => api.replacePageFile(pageId, file),
    onSuccess: (page) => {
      refresh();
      if (page.previousSha) {
        const sha = page.previousSha;
        showToast(t('files.replace.done'), 'info', { label: t('files.replace.undo'), onClick: () => void undo(sha) });
      } else {
        showToast(t('files.replace.same'), 'info');
      }
    },
    onError: (err) => showToast(errorText(err, 'files.replace.failed')),
  });
}
