import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { GitCredentialInfo } from '@shared/contracts';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { useToast } from '../ui/Toast';
import { LabeledInput } from '../ui/LabeledInput';
import '../i18n/register';

export interface GitCredentialFormProps {
  onSaved: (credential: GitCredentialInfo) => void;
  onCancel?: () => void;
}

/**
 * "Connect GitLab/GitHub" (round 11): host + provider + token + label ->
 * POST /api/me/git-credentials. Shared by CreateSpaceDialog's inline
 * "connect" affordance and the user-menu "Git access" section, so the one
 * form only needs building/maintaining once.
 */
export function GitCredentialForm({ onSaved, onCancel }: GitCredentialFormProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const showToast = useToast();
  const [host, setHost] = useState('');
  const [provider, setProvider] = useState<'github' | 'gitlab'>('github');
  const [token, setToken] = useState('');
  const [label, setLabel] = useState('');

  const save = useMutation({
    mutationFn: () =>
      api.saveGitCredential({ host: host.trim(), provider, token: token.trim(), label: label.trim() || undefined }),
    onSuccess: (credential) => onSaved(credential),
    onError: (err) => showToast(errorText(err, 'git.credentials.saveFailed')),
  });

  const canSave = host.trim().length > 0 && token.trim().length > 0;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-neutral-200 p-3 dark:border-neutral-700">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-neutral-600 dark:text-neutral-400">{t('git.credentials.provider')}</span>
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value as 'github' | 'gitlab')}
          className="rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 text-sm text-neutral-800 dark:border-neutral-700 dark:text-neutral-200"
        >
          <option value="github">GitHub</option>
          <option value="gitlab">GitLab</option>
        </select>
      </label>
      <LabeledInput label={t('git.credentials.host')} placeholder="github.com" value={host} onChange={(e) => setHost(e.target.value)} />
      <LabeledInput
        label={t('git.credentials.token')}
        type="password"
        placeholder="ghp_… / glpat-…"
        value={token}
        onChange={(e) => setToken(e.target.value)}
      />
      <LabeledInput
        label={t('git.credentials.label')}
        placeholder={t('git.credentials.labelPlaceholder')}
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />
      {save.isError && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {errorText(save.error, 'git.credentials.saveFailed')}
        </p>
      )}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            {t('ui.cancel')}
          </button>
        )}
        <button
          type="button"
          disabled={!canSave || save.isPending}
          onClick={() => save.mutate()}
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          {save.isPending ? t('git.credentials.connecting') : t('git.credentials.connect')}
        </button>
      </div>
    </div>
  );
}
