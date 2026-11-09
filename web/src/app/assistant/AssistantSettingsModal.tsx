import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, KeyRound, Loader2 } from 'lucide-react';
import type { AssistantModelOption } from '@shared/contracts';
import { api, ApiError } from '../api';
import { useApiErrorText } from '../errorText';
import { useToast } from '../ui/Toast';
import { Modal } from '../ui/Modal';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { LabeledInput } from '../ui/LabeledInput';
import { ProviderConnections } from './ProviderConnections';
import '../i18n/register';

export interface AssistantSettingsModalProps {
  onClose: () => void;
  /** The space the chat is opened in (null/omitted outside a space), so a shared space key is reported as the source. */
  space?: string | null;
}

const SETTINGS_PREFIX_KEY = ['assistant', 'settings'] as const;

/**
 * «Folio AI» settings — Cursor key, the other providers (Claude API key and the optional ones the server lists), model choice. Personal-key connection + model choice, opened both
 * from UserMenu's tools section and from AssistantPanel's own "not
 * configured" plate. Ported from a sibling project's account/cursor-page.tsx,
 * trimmed to Folio's slimmer contract: no system-access matrix,
 * personalization or explain-mode toggle — those aren't in this round's
 * AssistantSettings shape (shared/contracts.ts).
 *
 * Besides the personal key it reports where the key in use really comes from
 * (own / space / instance / server), and when the instance admin turned personal
 * keys off (`personalKeysAllowed: false`) it hides the key form and says that the
 * shared key is used for everyone — only the model choice stays.
 */
export function AssistantSettingsModal({ onClose, space = null }: AssistantSettingsModalProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const showToast = useToast();
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState('');
  const [confirmingForget, setConfirmingForget] = useState(false);

  const settingsKey = [...SETTINGS_PREFIX_KEY, space] as const;
  const settings = useQuery({ queryKey: settingsKey, queryFn: () => api.getAssistantSettings(space) });
  const models = useQuery({ queryKey: ['assistant', 'models', space], queryFn: () => api.getAssistantModels(space) });
  const current = settings.data;
  // The instance admin turned personal keys off: the shared key serves everyone, a personal key is not used.
  const personalDisabled = current?.personalKeysAllowed === false;
  const cursorProviderSource = current?.providers?.find((provider) => provider.id === 'cursor')?.source ?? current?.apiKeySource;
  const sharedInUse = cursorProviderSource === 'space' || cursorProviderSource === 'instance';

  const saveKey = useMutation({
    mutationFn: (key: string) => api.saveAssistantKey(key),
    onSuccess: (result) => {
      setApiKey('');
      void queryClient.invalidateQueries({ queryKey: SETTINGS_PREFIX_KEY });
      void queryClient.invalidateQueries({ queryKey: ['assistant', 'models'] });
      showToast(t('assistant.settings.savedAs', { name: result.apiKeyName ?? '' }), 'info');
    },
    onError: (err) => {
      showToast(err instanceof ApiError && err.status === 400 ? t('assistant.settings.checkFailed') : errorText(err, 'assistant.settings.saveFailed'));
    },
  });

  const checkKey = useMutation({
    mutationFn: () => api.checkAssistantKey(undefined, space),
    onSuccess: (result) => {
      showToast(result.ok ? t('assistant.settings.checkOk', { name: result.apiKeyName ?? '' }) : t('assistant.settings.checkFailed'), result.ok ? 'info' : 'error');
    },
    onError: (err) => showToast(errorText(err, 'assistant.settings.checkFailed')),
  });

  const forgetKey = useMutation({
    mutationFn: () => api.deleteAssistantKey(),
    onSuccess: () => {
      setConfirmingForget(false);
      void queryClient.invalidateQueries({ queryKey: SETTINGS_PREFIX_KEY });
      void queryClient.invalidateQueries({ queryKey: ['assistant', 'models'] });
    },
    onError: (err) => {
      setConfirmingForget(false);
      showToast(errorText(err, 'assistant.settings.forgetFailed'));
    },
  });

  const updateModel = useMutation({
    mutationFn: (model: string) => api.setAssistantModel(model, space),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: SETTINGS_PREFIX_KEY }),
    onError: (err) => showToast(errorText(err, 'assistant.settings.modelSaveFailed')),
  });

  // The Cursor form and its warnings follow the Cursor runtime; the route-wide `runtimeAvailable` also covers the other providers.
  const cursorRuntime = current ? (current.cursorRuntimeAvailable ?? current.runtimeAvailable) : false;
  const anyConnected = Boolean(current?.apiKeyConfigured || current?.providers?.some((provider) => provider.connected));
  const modelItems = models.data?.items ?? [{ id: 'auto', label: t('assistant.settings.autoModel'), description: null }];
  const savedModel = current?.model ?? 'auto';
  // The saved model belongs to a provider that is no longer connected: keep it selectable (so the select shows the truth), with a note.
  const staleModel = Boolean(models.data && current && savedModel !== 'auto' && !modelItems.some((item) => item.id === savedModel));
  // The Cursor block describes Cursor's own credential; `current.apiKey*` follow the route a run would take, which may be another provider's.
  const cursorStatus = current?.providers?.find((provider) => provider.id === 'cursor');
  const cursorSource = cursorStatus ? cursorStatus.source : (current?.apiKeySource ?? 'none');
  const cursorKeyName = cursorStatus ? cursorStatus.keyName : (current?.apiKeyName ?? null);
  const cursorConnected = cursorStatus ? cursorStatus.connected : Boolean(current?.apiKeyConfigured);
  const groups = groupModels(modelItems, current?.providers, t);

  const busy = saveKey.isPending || checkKey.isPending || forgetKey.isPending || updateModel.isPending;

  return (
    <Modal title={t('assistant.settings.title')} onClose={onClose}>
      {settings.isLoading ? (
        <p className="text-sm text-neutral-400">{t('ui.loading')}</p>
      ) : (
        <div className="flex flex-col gap-4">
          <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{t('assistant.providers.cursorHeading')}</h3>
          <div className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <span className="text-neutral-500 dark:text-neutral-400">{t('assistant.settings.source')}</span>
              <p className="font-medium text-neutral-900 dark:text-neutral-100">{t(`assistant.settings.sources.${cursorSource}`)}</p>
            </div>
            {cursorKeyName && (
              <div>
                <span className="text-neutral-500 dark:text-neutral-400">{t('assistant.settings.keyName')}</span>
                <p className="font-medium text-neutral-900 dark:text-neutral-100">{cursorKeyName}</p>
              </div>
            )}
          </div>

          {cursorConnected && (
            <p className="flex items-center gap-1.5 text-sm text-green-700 dark:text-green-400">
              <CheckCircle2 size={14} />
              {t('assistant.settings.connected')}
            </p>
          )}

          {current && !cursorRuntime && (
            <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-2.5 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              {t('assistant.settings.runtimeUnavailable')}
            </div>
          )}
          {current && !current.encryptionAvailable && !personalDisabled && (
            <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-2.5 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              {t('assistant.settings.encryptionUnavailable')}
            </div>
          )}

          {personalDisabled ? (
            <>
              <p className="rounded-lg border border-neutral-200 bg-neutral-50 p-2.5 text-sm text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-200">
                {t('assistant.settings.personalDisabled')}
              </p>
              {/* Not reachable with the current server (a personal key is skipped under this policy and never reported as the source), kept so a stale personal key can still be forgotten. */}
              {cursorSource === 'personal' && (
                <div className="flex flex-col items-start gap-2">
                  <p className="text-sm text-amber-800 dark:text-amber-300">{t('assistant.settings.personalIgnored')}</p>
                  <button
                    type="button"
                    onClick={() => setConfirmingForget(true)}
                    disabled={busy}
                    className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-neutral-700 dark:text-red-400 dark:hover:bg-red-950/30"
                  >
                    {t('assistant.settings.disconnect')}
                  </button>
                </div>
              )}
            </>
          ) : (
            <>
              <div>
                <LabeledInput
                  label={t('assistant.settings.keyLabel')}
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={t('assistant.settings.keyPlaceholder')}
                  disabled={busy || !cursorRuntime || !current?.encryptionAvailable}
                />
                <p className="mt-1 text-xs text-neutral-400">{t('assistant.settings.keyHint')}</p>
                {sharedInUse && <p className="mt-1 text-xs text-neutral-400">{t('assistant.settings.sharedInUse')}</p>}
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => saveKey.mutate(apiKey.trim())}
                  disabled={!apiKey.trim() || busy || !cursorRuntime || !current?.encryptionAvailable}
                  className="flex items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
                >
                  {saveKey.isPending ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
                  {t('assistant.settings.save')}
                </button>
                {cursorConnected && (
                  <button
                    type="button"
                    onClick={() => checkKey.mutate()}
                    disabled={busy || !cursorRuntime}
                    className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
                  >
                    {checkKey.isPending ? <Loader2 size={14} className="animate-spin" /> : t('assistant.settings.check')}
                  </button>
                )}
                {cursorSource === 'personal' && (
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
            </>
          )}

          <ProviderConnections
            providers={current?.providers}
            space={space}
            personalDisabled={personalDisabled}
            encryptionAvailable={current?.encryptionAvailable ?? false}
          />

          <div className="border-t border-neutral-200 pt-4 dark:border-neutral-800">
            <span className="text-sm text-neutral-500 dark:text-neutral-400">{t('assistant.settings.model')}</span>
            <select
              aria-label={t('assistant.settings.model')}
              value={savedModel}
              disabled={busy || models.isLoading || !anyConnected}
              onChange={(event) => updateModel.mutate(event.target.value)}
              className="mt-1 block w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm text-neutral-900 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
            >
              {groups.top.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.id === 'auto' ? t('assistant.settings.autoModel') : model.label}
                </option>
              ))}
              {groups.groups.map((group) => (
                <optgroup key={group.id} label={group.label}>
                  {group.items.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                    </option>
                  ))}
                </optgroup>
              ))}
              {staleModel && (
                <optgroup label={t('assistant.settings.modelUnavailableGroup')}>
                  <option value={savedModel}>{t('assistant.settings.modelUnavailableOption', { model: savedModel })}</option>
                </optgroup>
              )}
            </select>
            <p className="mt-1 text-xs text-neutral-400">{t('assistant.settings.modelHint')}</p>
            {staleModel && (
              <p role="status" className="mt-1 text-xs text-amber-800 dark:text-amber-300">
                {t('assistant.settings.modelUnavailable')}
              </p>
            )}
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

type Translate = (key: string, values?: Record<string, unknown>) => string;

/** `auto` first (ungrouped), then one group per provider in the server's order; Cursor models carry no provider prefix. */
function groupModels(items: AssistantModelOption[], providers: { id: string; label: string }[] | undefined, t: Translate) {
  const top: AssistantModelOption[] = [];
  const order: string[] = [];
  const byProvider = new Map<string, AssistantModelOption[]>();
  for (const item of items) {
    if (item.id === 'auto') {
      top.push(item);
      continue;
    }
    const provider = item.provider ?? 'cursor';
    if (!byProvider.has(provider)) {
      byProvider.set(provider, []);
      order.push(provider);
    }
    byProvider.get(provider)!.push(item);
  }
  const groups = order.map((id) => ({
    id,
    label: providers?.find((provider) => provider.id === id)?.label || t(`assistant.providers.names.${id}`),
    items: byProvider.get(id)!,
  }));
  return { top, groups };
}
