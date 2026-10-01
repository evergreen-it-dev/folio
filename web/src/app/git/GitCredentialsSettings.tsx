import { useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import type { GitCredentialInfo } from '@shared/contracts';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { useToast } from '../ui/Toast';
import { Modal } from '../ui/Modal';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { GitCredentialForm } from './GitCredentialForm';
import { ConfluenceCredentialsSection } from './ConfluenceCredentialsSection';
import '../i18n/register';

export interface GitCredentialsSettingsProps {
  onClose: () => void;
}

const CREDENTIALS_QUERY_KEY = ['git-credentials'] as const;

// Brand names — not translated in any language.
const PROVIDER_LABEL: Record<GitCredentialInfo['provider'], string> = { github: 'GitHub', gitlab: 'GitLab' };

type Tab = 'git' | 'confluence';

/**
 * "Git access" (round 11) — user-menu section: saved git PATs, list/add/
 * delete. Never shows a token value — only metadata, same one-time-reveal-
 * elsewhere convention as ApiTokensModal.tsx (there it's shown once on
 * create; a git credential's token is never echoed back at all, not even
 * once).
 *
 * Round 22b adds a "Confluence" tab alongside the original (now-tabbed) Git
 * list — same two saved-credentials concept, different provider — rather
 * than renaming this dialog: the menu entry that opens it keeps meaning
 * exactly what it always has, same "specific label, broader tabbed content"
 * shape as tokens/ApiTokensModal.tsx's own MCP tabs.
 */
export function GitCredentialsSettings({ onClose }: GitCredentialsSettingsProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const [tab, setTab] = useState<Tab>('git');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<GitCredentialInfo | null>(null);

  const credentials = useQuery({ queryKey: CREDENTIALS_QUERY_KEY, queryFn: api.getGitCredentials, retry: false });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: CREDENTIALS_QUERY_KEY });
  }

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteGitCredential(id),
    onSuccess: () => {
      setRemoving(null);
      invalidate();
    },
    onError: (err) => showToast(errorText(err, 'git.credentials.deleteFailed')),
  });

  return (
    <Modal title={t('git.credentials.title')} onClose={onClose}>
      <div role="tablist" className="mb-3 flex gap-1 rounded-md bg-neutral-100 p-1 dark:bg-neutral-800">
        <TabButton active={tab === 'git'} onClick={() => setTab('git')}>
          Git
        </TabButton>
        <TabButton active={tab === 'confluence'} onClick={() => setTab('confluence')}>
          Confluence
        </TabButton>
      </div>

      {tab === 'confluence' && <ConfluenceCredentialsSection />}

      {tab === 'git' && (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('git.credentials.intro')}</p>

          {credentials.isLoading && <p className="text-sm text-neutral-400">{t('ui.loading')}</p>}
          {credentials.isError && (
            <p className="text-sm text-red-600 dark:text-red-400">{t('git.credentials.loadFailed')}</p>
          )}
          {credentials.data && credentials.data.credentials.length === 0 && !adding && (
            <p className="text-sm text-neutral-400">{t('git.credentials.empty')}</p>
          )}

          {credentials.data && credentials.data.credentials.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {credentials.data.credentials.map((cred) => (
                <li
                  key={cred.id}
                  className="flex items-center justify-between gap-2 rounded-md border border-neutral-200 px-2.5 py-1.5 dark:border-neutral-700"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm text-neutral-900 dark:text-neutral-100">
                      {cred.label || PROVIDER_LABEL[cred.provider]}
                    </div>
                    <div className="truncate text-xs text-neutral-500 dark:text-neutral-400">
                      {PROVIDER_LABEL[cred.provider]} · {cred.host}
                    </div>
                  </div>
                  <button
                    type="button"
                    title={t('ui.delete')}
                    aria-label={t('git.credentials.deleteNamed', { name: cred.label || cred.host })}
                    onClick={() => setRemoving(cred)}
                    className="shrink-0 rounded p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-red-600 dark:hover:bg-neutral-800"
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {adding ? (
            <GitCredentialForm
              onSaved={() => {
                setAdding(false);
                invalidate();
                showToast(t('git.credentials.saved'), 'info');
              }}
              onCancel={() => setAdding(false)}
            />
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="flex items-center justify-center gap-1.5 rounded-md border border-dashed border-neutral-300 px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-900"
            >
              <Plus size={14} />
              {t('git.credentials.connectPrompt')}
            </button>
          )}
        </div>
      )}

      {removing && (
        <ConfirmDialog
          title={t('git.credentials.deleteConfirmTitle')}
          destructive
          confirmLabel={t('ui.delete')}
          busy={remove.isPending}
          onCancel={() => setRemoving(null)}
          onConfirm={() => remove.mutate(removing.id)}
        >
          {t('git.credentials.deleteConfirmBody')}
        </ConfirmDialog>
      )}
    </Modal>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex-1 rounded px-2.5 py-1 text-xs font-medium transition-colors ${
        active
          ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-neutral-100'
          : 'text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200'
      }`}
    >
      {children}
    </button>
  );
}
