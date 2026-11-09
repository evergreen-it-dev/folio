import { useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, KeyRound, Loader2 } from 'lucide-react';
import type { AssistantCredentialProviderId } from '@shared/contracts';
import { api, ApiError } from '../api';
import { useApiErrorText } from '../errorText';
import { formatDateTime } from '../formatDate';
import { useToast } from '../ui/Toast';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { LabeledInput } from '../ui/LabeledInput';
import { MODELS_PREFIX_KEY, SETTINGS_PREFIX_KEY } from './ProviderConnections';
import '../i18n/register';

type SharedProvider = Exclude<AssistantCredentialProviderId, 'codex'>;

const ALERT_CLASS =
  'rounded-lg border border-amber-300 bg-amber-50 p-2.5 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300';

function ProviderSharedKey({ provider, space }: { provider: SharedProvider; space: string | null }) {
  const { t, i18n } = useTranslation('app');
  const errorText = useApiErrorText();
  const showToast = useToast();
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState('');
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const name = t(`assistant.providers.${provider}.name`);

  const infoKey = ['assistant', 'shared-key', space ? 'space' : 'instance', ...(space ? [space] : []), provider] as const;
  const info = useQuery({
    queryKey: infoKey,
    queryFn: () => (space ? api.getSpaceAssistantProviderKey(space, provider) : api.getInstanceAssistantProviderKey(provider)),
  });
  const current = info.data;

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: infoKey });
    void queryClient.invalidateQueries({ queryKey: SETTINGS_PREFIX_KEY });
    void queryClient.invalidateQueries({ queryKey: MODELS_PREFIX_KEY });
  }

  const save = useMutation({
    mutationFn: (key: string) => (space ? api.saveSpaceAssistantProviderKey(space, provider, key) : api.saveInstanceAssistantProviderKey(provider, key)),
    onSuccess: () => {
      setApiKey('');
      refresh();
      showToast(t('assistant.providers.sharedSaved', { provider: name }), 'info');
    },
    onError: (err) =>
      showToast(err instanceof ApiError && err.status === 400 ? t('assistant.providers.checkFailed', { provider: name }) : errorText(err, 'assistant.settings.saveFailed')),
  });
  const remove = useMutation({
    mutationFn: () => (space ? api.deleteSpaceAssistantProviderKey(space, provider) : api.deleteInstanceAssistantProviderKey(provider)),
    onSuccess: () => {
      setConfirmingRemove(false);
      refresh();
    },
    onError: (err) => {
      setConfirmingRemove(false);
      showToast(errorText(err, 'assistant.sharedKey.removeFailed'));
    },
  });

  const busy = save.isPending || remove.isPending;
  const canStore = Boolean(current?.encryptionAvailable);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (apiKey.trim() && !busy && canStore) save.mutate(apiKey.trim());
  }

  return (
    <section aria-label={name} className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-700">
      <h4 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{name}</h4>
      {info.isLoading ? (
        <p className="text-sm text-neutral-400">{t('ui.loading')}</p>
      ) : info.isError || !current ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {errorText(info.error, 'assistant.sharedKey.loadFailed')}
        </p>
      ) : (
        <>
          {current.configured ? (
            <div className="flex flex-col gap-0.5 text-sm">
              <p className="flex items-center gap-1.5 font-medium text-green-700 dark:text-green-400">
                <CheckCircle2 size={14} />
                {current.keyName ? t('assistant.sharedKey.connected', { name: current.keyName }) : t('assistant.settings.connected')}
              </p>
              {current.updatedAt && (
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  {current.updatedBy
                    ? t('assistant.sharedKey.updatedBy', { name: current.updatedBy.name, date: formatDateTime(current.updatedAt, i18n.language) })
                    : t('assistant.sharedKey.updatedAt', { date: formatDateTime(current.updatedAt, i18n.language) })}
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('assistant.providers.sharedNotConfigured', { provider: name })}</p>
          )}
          {!current.encryptionAvailable && (
            <div role="alert" className={ALERT_CLASS}>
              {t('assistant.sharedKey.encryptionUnavailable')}
            </div>
          )}
          <form onSubmit={submit} className="flex flex-col gap-2">
            <div>
              <LabeledInput
                label={current.configured ? t('assistant.providers.sharedReplace', { provider: name }) : t(`assistant.providers.${provider}.keyLabel`)}
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={t(`assistant.providers.${provider}.keyPlaceholder`)}
                disabled={busy || !canStore}
              />
              <p className="mt-1 text-xs text-neutral-400">{t(`assistant.providers.${provider}.hint`)}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="submit"
                disabled={!apiKey.trim() || busy || !canStore}
                className="flex items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
              >
                {save.isPending ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
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
        </>
      )}
      {confirmingRemove && (
        <ConfirmDialog
          title={t('assistant.sharedKey.removeTitle')}
          destructive
          confirmLabel={t('assistant.sharedKey.remove')}
          busy={remove.isPending}
          onCancel={() => setConfirmingRemove(false)}
          onConfirm={() => remove.mutate()}
        >
          {t('assistant.sharedKey.removeConfirmBody')}
        </ConfirmDialog>
      )}
    </section>
  );
}

/** Shared keys of the instance or one space for the providers that take a key. Optional providers show only when the server lists them. */
export function SharedProviderKeys({ space }: { space: string | null }) {
  const { t } = useTranslation('app');
  const settings = useQuery({ queryKey: ['assistant', 'settings', space], queryFn: () => api.getAssistantSettings(space) });
  const minimaxListed = settings.data?.providers?.some((provider) => provider.id === 'minimax') ?? false;
  return (
    <div className="flex flex-col gap-3 border-t border-neutral-200 pt-3 dark:border-neutral-800">
      <div>
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{t('assistant.providers.sharedHeading')}</h3>
        <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">{t(space ? 'assistant.providers.sharedIntroSpace' : 'assistant.providers.sharedIntroInstance')}</p>
      </div>
      {minimaxListed && <ProviderSharedKey provider="minimax" space={space} />}
      <ProviderSharedKey provider="anthropic" space={space} />
    </div>
  );
}
