import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, KeyRound, Loader2 } from 'lucide-react';
import { api, ApiError } from '../api';
import { useApiErrorText } from '../errorText';
import { useToast } from '../ui/Toast';
import { Modal } from '../ui/Modal';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { LabeledInput } from '../ui/LabeledInput';
import '../i18n/register';

export interface AssistantSettingsModalProps {
  onClose: () => void;
}

const SETTINGS_QUERY_KEY = ['assistant', 'settings'] as const;

/**
 * «Folio AI (Cursor)» — personal-key connection + model choice, opened both
 * from UserMenu's tools section and from AssistantPanel's own "not
 * configured" plate. Ported from a sibling project's account/cursor-page.tsx,
 * trimmed to Folio's slimmer contract: no system-access matrix,
 * personalization or explain-mode toggle — those aren't in this round's
 * AssistantSettings shape (shared/contracts.ts).
 */
export function AssistantSettingsModal({ onClose }: AssistantSettingsModalProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const showToast = useToast();
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState('');
  const [confirmingForget, setConfirmingForget] = useState(false);

  const settings = useQuery({ queryKey: SETTINGS_QUERY_KEY, queryFn: api.getAssistantSettings });
  const models = useQuery({ queryKey: ['assistant', 'models'], queryFn: api.getAssistantModels });
  const current = settings.data;

  const saveKey = useMutation({
    mutationFn: (key: string) => api.saveAssistantKey(key),
    onSuccess: (result) => {
      setApiKey('');
      void queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
      showToast(t('assistant.settings.savedAs', { name: result.apiKeyName ?? '' }), 'info');
    },
    onError: (err) => {
      showToast(err instanceof ApiError && err.status === 400 ? t('assistant.settings.checkFailed') : errorText(err, 'assistant.settings.saveFailed'));
    },
  });

  const checkKey = useMutation({
    mutationFn: () => api.checkAssistantKey(),
    onSuccess: (result) => {
      showToast(result.ok ? t('assistant.settings.checkOk', { name: result.apiKeyName ?? '' }) : t('assistant.settings.checkFailed'), result.ok ? 'info' : 'error');
    },
    onError: (err) => showToast(errorText(err, 'assistant.settings.checkFailed')),
  });

  const forgetKey = useMutation({
    mutationFn: () => api.deleteAssistantKey(),
    onSuccess: () => {
      setConfirmingForget(false);
      void queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
    },
    onError: (err) => {
      setConfirmingForget(false);
      showToast(errorText(err, 'assistant.settings.forgetFailed'));
    },
  });

  const updateModel = useMutation({
    mutationFn: (model: string) => api.setAssistantModel(model),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY }),
    onError: (err) => showToast(errorText(err, 'assistant.settings.modelSaveFailed')),
  });

  const busy = saveKey.isPending || checkKey.isPending || forgetKey.isPending || updateModel.isPending;

  return (
    <Modal title={t('assistant.settings.title')} onClose={onClose}>
      {settings.isLoading ? (
        <p className="text-sm text-neutral-400">{t('ui.loading')}</p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <span className="text-neutral-500 dark:text-neutral-400">{t('assistant.settings.source')}</span>
              <p className="font-medium text-neutral-900 dark:text-neutral-100">{t(`assistant.settings.sources.${current?.apiKeySource ?? 'none'}`)}</p>
            </div>
            {current?.apiKeyName && (
              <div>
                <span className="text-neutral-500 dark:text-neutral-400">{t('assistant.settings.keyName')}</span>
                <p className="font-medium text-neutral-900 dark:text-neutral-100">{current.apiKeyName}</p>
              </div>
            )}
          </div>

          {current?.apiKeyConfigured && (
            <p className="flex items-center gap-1.5 text-sm text-green-700 dark:text-green-400">
              <CheckCircle2 size={14} />
              {t('assistant.settings.connected')}
            </p>
          )}

          {current && !current.runtimeAvailable && (
            <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-2.5 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              {t('assistant.settings.runtimeUnavailable')}
            </div>
          )}
          {current && !current.encryptionAvailable && (
            <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-2.5 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              {t('assistant.settings.encryptionUnavailable')}
            </div>
          )}

          <div>
            <LabeledInput
              label={t('assistant.settings.keyLabel')}
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={t('assistant.settings.keyPlaceholder')}
              disabled={busy || !current?.runtimeAvailable || !current?.encryptionAvailable}
            />
            <p className="mt-1 text-xs text-neutral-400">{t('assistant.settings.keyHint')}</p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => saveKey.mutate(apiKey.trim())}
              disabled={!apiKey.trim() || busy || !current?.runtimeAvailable || !current?.encryptionAvailable}
              className="flex items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
            >
              {saveKey.isPending ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
              {t('assistant.settings.save')}
            </button>
            {current?.apiKeyConfigured && (
              <button
                type="button"
                onClick={() => checkKey.mutate()}
                disabled={busy || !current.runtimeAvailable}
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
              >
                {checkKey.isPending ? <Loader2 size={14} className="animate-spin" /> : t('assistant.settings.check')}
              </button>
            )}
            {current?.apiKeySource === 'personal' && (
              <button
                type="button"
                onClick={() => setConfirmingForget(true)}
                disabled={busy}
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-neutral-700 dark:text-red-400 dark:hover:bg-red-950/30"
              >
                {t('assistant.settings.disconnect')}
              </button>
            )}
          </div>

          <div>
            <span className="text-sm text-neutral-500 dark:text-neutral-400">{t('assistant.settings.model')}</span>
            <select
              aria-label={t('assistant.settings.model')}
              value={current?.model ?? 'auto'}
              disabled={busy || models.isLoading || !current?.apiKeyConfigured}
              onChange={(event) => updateModel.mutate(event.target.value)}
              className="mt-1 block w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm text-neutral-900 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
            >
              {(models.data?.items ?? [{ id: 'auto', label: t('assistant.settings.autoModel'), description: null }]).map((model) => (
                <option key={model.id} value={model.id}>
                  {model.id === 'auto' ? t('assistant.settings.autoModel') : model.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-neutral-400">{t('assistant.settings.modelHint')}</p>
            {models.data?.error && (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">{t('assistant.settings.modelsFailed')}: {models.data.error}</p>
            )}
          </div>
        </div>
      )}

      {confirmingForget && (
        <ConfirmDialog
          title={t('assistant.settings.disconnect')}
          destructive
          confirmLabel={t('assistant.settings.disconnect')}
          busy={forgetKey.isPending}
          onCancel={() => setConfirmingForget(false)}
          onConfirm={() => forgetKey.mutate()}
        >
          {t('assistant.settings.forgetConfirmBody')}
        </ConfirmDialog>
      )}
    </Modal>
  );
}
