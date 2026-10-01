import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import type { ConfluenceCredentialInfo } from '@shared/contracts';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { useToast } from '../ui/Toast';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { formatRelativeDate } from '../history';
import '../i18n/register';

/** Shared with import/ConfluenceImportDialog.tsx by content (both key off the literal 'confluence-credentials' string) — react-query matches query keys structurally, so a separately-declared array here still hits the same cache entry. */
const CREDENTIALS_QUERY_KEY = ['confluence-credentials'] as const;

/**
 * Round 22b — the "Confluence" tab inside GitCredentialsSettings' own
 * dialog: list + delete for saved Confluence credentials (PAT for on-prem,
 * email + API-token for Cloud). No add-form here — the primary way to save
 * one is the "Save for the next imports" checkbox in
 * ConfluenceImportDialog; this section only manages what's already there.
 * Never fetches or displays a token value — same convention as
 * GitCredentialsSettings' own Git list.
 *
 * GET /api/me/confluence-credentials degrades on a 404/any error to a quiet
 * "not live yet" hint rather than a raw error banner — same convention as
 * tokens/ApiTokensModal.tsx ("not shipped yet" isn't a failure the user
 * needs to see as one).
 */
export function ConfluenceCredentialsSection() {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const [removing, setRemoving] = useState<ConfluenceCredentialInfo | null>(null);

  const credentials = useQuery({ queryKey: CREDENTIALS_QUERY_KEY, queryFn: api.getConfluenceCredentials, retry: false });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteConfluenceCredential(id),
    onSuccess: () => {
      setRemoving(null);
      void queryClient.invalidateQueries({ queryKey: CREDENTIALS_QUERY_KEY });
    },
    onError: (err) => showToast(errorText(err, 'git.confluenceCredentials.deleteFailed')),
  });

  if (credentials.isError) {
    return <p className="text-sm text-neutral-400">{t('git.confluenceCredentials.notLive')}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('git.confluenceCredentials.intro')}</p>

      {credentials.isLoading && <p className="text-sm text-neutral-400">{t('ui.loading')}</p>}

      {credentials.data && credentials.data.credentials.length === 0 && (
        <p className="text-sm text-neutral-400">{t('git.confluenceCredentials.empty')}</p>
      )}

      {credentials.data && credentials.data.credentials.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {credentials.data.credentials.map((cred) => (
            <li
              key={cred.id}
              className="flex items-center justify-between gap-2 rounded-md border border-neutral-200 px-2.5 py-1.5 dark:border-neutral-700"
            >
              <div className="min-w-0">
                <div className="truncate text-sm text-neutral-900 dark:text-neutral-100">{cred.label}</div>
                <div className="truncate text-xs text-neutral-500 dark:text-neutral-400">
                  {t(`git.confluenceCredentials.kind.${cred.kind}`)} · {cred.host}
                  {cred.email ? ` · ${cred.email}` : ''} · {formatRelativeDate(cred.createdAt)}
                </div>
              </div>
              <button
                type="button"
                title={t('ui.delete')}
                aria-label={t('git.confluenceCredentials.deleteNamed', { name: cred.label })}
                onClick={() => setRemoving(cred)}
                className="shrink-0 rounded p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-red-600 dark:hover:bg-neutral-800"
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {removing && (
        <ConfirmDialog
          title={t('git.confluenceCredentials.deleteConfirmTitle')}
          destructive
          confirmLabel={t('ui.delete')}
          busy={remove.isPending}
          onCancel={() => setRemoving(null)}
          onConfirm={() => remove.mutate(removing.id)}
        >
          {t('git.confluenceCredentials.deleteConfirmBody')}
        </ConfirmDialog>
      )}
    </div>
  );
}
