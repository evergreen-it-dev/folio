import { ClipboardList } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { useToast } from '../ui/Toast';
import '../i18n/register';

export interface CreateFormButtonProps {
  /** The TABLE page's own id — this button only ever renders on a table page (Header.tsx gates it on the `table` prop being present). */
  pageId: string;
  space: string;
}

/**
 * Round FORMS — "Create a form" on a data table page: writes a paired
 * `<slug>.form.md` next to the table with fields derived from its columns
 * (server/storage.ts#createFormFromTable) and navigates straight to it, the
 * same "create, then go there" flow the sidebar's own "+ Form"/"+ Table"
 * use (Sidebar.tsx/TreeRow.tsx createRoot/createChild mutations).
 */
export function CreateFormButton({ pageId, space }: CreateFormButtonProps) {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const errorText = useApiErrorText();

  const createForm = useMutation({
    mutationFn: () => api.createFormFromTable(pageId),
    onSuccess: (meta) => {
      queryClient.invalidateQueries({ queryKey: ['tree', space] });
      navigate(`/s/${space}/p/${meta.id}`);
    },
    onError: (err) => {
      showToast(t('routes.form.createFromTableFailed', { message: errorText(err) }), 'error');
    },
  });

  return (
    <button
      type="button"
      aria-label={t('routes.form.createFromTable')}
      title={t('routes.form.createFromTable')}
      disabled={createForm.isPending}
      onClick={() => createForm.mutate()}
      className="inline-flex shrink-0 items-center justify-center rounded-md p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 max-md:min-h-10 max-md:min-w-10 disabled:opacity-50 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
    >
      <ClipboardList size={15} aria-hidden="true" />
    </button>
  );
}
