import { useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, KeyRound, Loader2 } from 'lucide-react';
import type { SharedAssistantKeyInfo } from '@shared/contracts';
import { api, ApiError } from '../api';
import { useApiErrorText } from '../errorText';
import { formatDateTime } from '../formatDate';
import { useToast } from '../ui/Toast';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { LabeledInput } from '../ui/LabeledInput';
import { SharedProviderKeys } from './SharedProviderKeys';
import '../i18n/register';

export type SharedKeyPanelProps = { scope: 'instance' } | { scope: 'space'; space: string };

/**
 * Query key of the assistant settings of every space at once: invalidating this
 * prefix refreshes the chat panel and the personal-key modal wherever they are
 * open (their keys are `['assistant', 'settings', <space | null>]`).
 */
const SETTINGS_PREFIX_KEY = ['assistant', 'settings'] as const;
const MODELS_PREFIX_KEY = ['assistant', 'models'] as const;

const ALERT_CLASS =
  'rounded-lg border border-amber-300 bg-amber-50 p-2.5 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300';

/**
 * The shared Cursor key of the whole instance (instance admins, the "Shared key"
 * tab of /admin/assistant) or of one space (space admins, the dialog in the
 * sidebar's space menu). Shows who set the key and when — never the key itself —
 * and lets the admin replace or remove it; the instance variant also carries the
 * policy switch "may members use their own personal keys".
 */
export function SharedKeyPanel(props: SharedKeyPanelProps) {
  const { t, i18n } = useTranslation('app');
  const errorText = useApiErrorText();
  const showToast = useToast();
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState('');
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const space = props.scope === 'space' ? props.space : null;
  // `'space'` before the slug keeps a space that happens to be named "instance" apart from the instance key.
  const infoKey = space ? (['assistant', 'shared-key', 'space', space] as const) : (['assistant', 'shared-key', 'instance'] as const);

  const info = useQuery({
    queryKey: infoKey,
    queryFn: () => (space ? api.getSpaceAssistantKey(space) : api.getInstanceAssistantKey()),
  });
  const current = info.data;

  // The key (or the policy) changed: the info card, every cached assistant settings
  // (the source and the "connected" flag in the chat) and the model catalog (it was
  // empty while there was no key) are stale.
  function refresh() {
    void queryClient.invalidateQueries({ queryKey: infoKey });
    void queryClient.invalidateQueries({ queryKey: SETTINGS_PREFIX_KEY });
    void queryClient.invalidateQueries({ queryKey: MODELS_PREFIX_KEY });
  }

  const saveKey = useMutation({
    mutationFn: (key: string) => (space ? api.saveSpaceAssistantKey(space, key) : api.saveInstanceAssistantKey(key)),
    onSuccess: (result) => {
      setApiKey('');
      refresh();
      showToast(t('assistant.sharedKey.saved', { name: result.apiKeyName ?? '' }), 'info');
    },
    onError: (err) => {
      showToast(err instanceof ApiError && err.status === 400 ? t('assistant.settings.checkFailed') : errorText(err, 'assistant.settings.saveFailed'));
    },
  });

  const removeKey = useMutation({
    mutationFn: () => (space ? api.deleteSpaceAssistantKey(space) : api.deleteInstanceAssistantKey()),
    onSuccess: () => {
      setConfirmingRemove(false);
      refresh();
    },
    onError: (err) => {
      setConfirmingRemove(false);
      showToast(errorText(err, 'assistant.sharedKey.removeFailed'));
    },
  });

  const updatePolicy = useMutation({
    mutationFn: (personalKeysAllowed: boolean) => api.setAssistantKeyPolicy(personalKeysAllowed),
    onSuccess: (result) => {
      queryClient.setQueryData<SharedAssistantKeyInfo>(infoKey, result);
      refresh();
    },
    onError: (err) => showToast(errorText(err, 'assistant.sharedKey.policyFailed')),
  });

  const busy = saveKey.isPending || removeKey.isPending || updatePolicy.isPending;
  const canStore = Boolean(current?.runtimeAvailable && current.encryptionAvailable);
  const personalKeysAllowed = current?.personalKeysAllowed !== false;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (apiKey.trim() && !busy && canStore) saveKey.mutate(apiKey.trim());
  }

  if (info.isLoading) return <p className="text-sm text-neutral-400">{t('ui.loading')}</p>;
  if (info.isError || !current) {
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {errorText(info.error, 'assistant.sharedKey.loadFailed')}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-neutral-600 dark:text-neutral-300">
        {t(props.scope === 'instance' ? 'assistant.sharedKey.introInstance' : 'assistant.sharedKey.introSpace')}
      </p>

      {current.configured ? (
        <div className="flex flex-col gap-0.5 text-sm">
          <p className="flex items-center gap-1.5 font-medium text-green-700 dark:text-green-400">
            <CheckCircle2 size={14} />
            {t('assistant.sharedKey.connected', { name: current.apiKeyName ?? '' })}
          </p>
          {current.email && <p className="text-neutral-600 dark:text-neutral-300">{t('assistant.sharedKey.account', { email: current.email })}</p>}
          {current.updatedAt && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {current.updatedBy
                ? t('assistant.sharedKey.updatedBy', { name: current.updatedBy.name, date: formatDateTime(current.updatedAt, i18n.language) })
                : t('assistant.sharedKey.updatedAt', { date: formatDateTime(current.updatedAt, i18n.language) })}
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('assistant.sharedKey.notConfigured')}</p>
      )}

      {!current.runtimeAvailable && (
        <div role="alert" className={ALERT_CLASS}>
          {t('assistant.settings.runtimeUnavailable')}
        </div>
      )}
      {!current.encryptionAvailable && (
        <div role="alert" className={ALERT_CLASS}>
          {t('assistant.sharedKey.encryptionUnavailable')}
        </div>
      )}

      <form onSubmit={submit} className="flex flex-col gap-3">
        <div>
          <LabeledInput
            label={t(current.configured ? 'assistant.sharedKey.replaceLabel' : 'assistant.settings.keyLabel')}
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={t('assistant.settings.keyPlaceholder')}
            disabled={busy || !canStore}
          />
          <p className="mt-1 text-xs text-neutral-400">{t('assistant.settings.keyHint')}</p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={!apiKey.trim() || busy || !canStore}
            className="flex items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {saveKey.isPending ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
            {t('assistant.settings.save')}
          </button>
          {current.configured && (
            <button
              type="button"
              onClick={() => setConfirmingRemove(true)}
              disabled={busy}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-neutral-700 dark:text-red-400 dark:hover:bg-red-950/30"
            >
              {t('assistant.sharedKey.remove')}
            </button>
          )}
        </div>
      </form>

      {props.scope === 'instance' && (
        <div className="border-t border-neutral-200 pt-3 dark:border-neutral-800">
          <label className="flex items-start gap-2 text-sm text-neutral-800 dark:text-neutral-100">
            <input
              type="checkbox"
              checked={personalKeysAllowed}
              disabled={busy}
              onChange={(event) => updatePolicy.mutate(event.target.checked)}
              className="mt-0.5"
            />
            <span>{t('assistant.sharedKey.policyLabel')}</span>
          </label>
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{t('assistant.sharedKey.policyHint')}</p>
          {!personalKeysAllowed && !current.configured && (
            <div role="alert" className={`mt-2 ${ALERT_CLASS}`}>
              {t('assistant.sharedKey.policyNoKey')}
            </div>
          )}
        </div>
      )}

      <SharedProviderKeys space={space} />

      {confirmingRemove && (
        <ConfirmDialog
          title={t('assistant.sharedKey.removeTitle')}
          destructive
          confirmLabel={t('assistant.sharedKey.remove')}
          busy={removeKey.isPending}
          onCancel={() => setConfirmingRemove(false)}
          onConfirm={() => removeKey.mutate()}
        >
          {t('assistant.sharedKey.removeConfirmBody')}
        </ConfirmDialog>
      )}
    </div>
  );
}
