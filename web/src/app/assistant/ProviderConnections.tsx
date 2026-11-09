import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Copy, ExternalLink, KeyRound, Loader2 } from 'lucide-react';
import type { AssistantCodexLoginState, AssistantCredentialProviderId, AssistantProviderId, AssistantProviderStatus } from '@shared/contracts';
import { api, ApiError } from '../api';
import { useApiErrorText } from '../errorText';
import { useToast } from '../ui/Toast';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { LabeledInput } from '../ui/LabeledInput';
import '../i18n/register';

export const SETTINGS_PREFIX_KEY = ['assistant', 'settings'] as const;
export const MODELS_PREFIX_KEY = ['assistant', 'models'] as const;

/** How often the Codex sign-in state is polled while the code is on screen. */
export const CODEX_POLL_MS = 3000;

const FORGET_BUTTON_CLASS =
  'rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-neutral-700 dark:text-red-400 dark:hover:bg-red-950/30';
const NEUTRAL_BUTTON_CLASS =
  'rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800';
const PRIMARY_BUTTON_CLASS =
  'flex items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900';

function statusOf(providers: AssistantProviderStatus[] | undefined, id: AssistantProviderId): AssistantProviderStatus | undefined {
  return providers?.find((provider) => provider.id === id);
}

function useRefreshAssistant() {
  const queryClient = useQueryClient();
  // A connection changed: the settings of every space and the model catalog are stale.
  return () => {
    void queryClient.invalidateQueries({ queryKey: SETTINGS_PREFIX_KEY });
    void queryClient.invalidateQueries({ queryKey: MODELS_PREFIX_KEY });
  };
}

interface ProviderKeyCardProps {
  provider: Exclude<AssistantCredentialProviderId, 'codex'>;
  status: AssistantProviderStatus | undefined;
  space: string | null;
  personalDisabled: boolean;
  encryptionAvailable: boolean;
}

/** One API-key provider (Claude; others only when the server lists them): key form, check, forget and where the key in use comes from. */
function ProviderKeyCard({ provider, status, space, personalDisabled, encryptionAvailable }: ProviderKeyCardProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const showToast = useToast();
  const refresh = useRefreshAssistant();
  const [apiKey, setApiKey] = useState('');
  const [confirmingForget, setConfirmingForget] = useState(false);
  const name = t(`assistant.providers.${provider}.name`);
  const connected = status?.connected ?? false;
  const source = status?.source ?? 'none';

  const save = useMutation({
    mutationFn: (key: string) => api.saveAssistantProviderKey(provider, key),
    onSuccess: () => {
      setApiKey('');
      refresh();
      showToast(t('assistant.providers.saved', { provider: name }), 'info');
    },
    onError: (err) => showToast(err instanceof ApiError && err.status === 400 ? t('assistant.providers.checkFailed', { provider: name }) : errorText(err, 'assistant.settings.saveFailed')),
  });
  const check = useMutation({
    mutationFn: () => api.checkAssistantProviderKey(provider, undefined, space),
    onSuccess: (result) =>
      showToast(result.ok ? t('assistant.providers.checkOk', { provider: name }) : t('assistant.providers.checkFailed', { provider: name }), result.ok ? 'info' : 'error'),
    onError: (err) => showToast(errorText(err, 'assistant.providers.checkError')),
  });
  const forget = useMutation({
    mutationFn: () => api.deleteAssistantProviderKey(provider),
    onSuccess: () => {
      setConfirmingForget(false);
      refresh();
    },
    onError: (err) => {
      setConfirmingForget(false);
      showToast(errorText(err, 'assistant.settings.forgetFailed'));
    },
  });
  const busy = save.isPending || check.isPending || forget.isPending;
  const sharedInUse = source === 'space' || source === 'instance';

  return (
    <section aria-label={name} className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-700">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{name}</h4>
        {connected ? (
          <span className="flex items-center gap-1.5 text-sm text-green-700 dark:text-green-400">
            <CheckCircle2 size={14} />
            {t('assistant.settings.connected')}
          </span>
        ) : (
          <span className="text-sm text-neutral-500 dark:text-neutral-400">{t('assistant.providers.notConnected')}</span>
        )}
      </div>
      {connected && (
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
          {t(`assistant.settings.sources.${source}`)}
          {status?.keyName ? ` · ${status.keyName}` : ''}
        </p>
      )}

      {personalDisabled ? (
        <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">{t('assistant.providers.personalDisabled')}</p>
      ) : (
        <div className="mt-2 flex flex-col gap-2">
          <div>
            <LabeledInput
              label={t(`assistant.providers.${provider}.keyLabel`)}
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={t(`assistant.providers.${provider}.keyPlaceholder`)}
              disabled={busy || !encryptionAvailable}
            />
            <p className="mt-1 text-xs text-neutral-400">{t(`assistant.providers.${provider}.hint`)}</p>
            {sharedInUse && <p className="mt-1 text-xs text-neutral-400">{t('assistant.settings.sharedInUse')}</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => save.mutate(apiKey.trim())} disabled={!apiKey.trim() || busy || !encryptionAvailable} className={PRIMARY_BUTTON_CLASS}>
              {save.isPending ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
              {t('assistant.settings.save')}
            </button>
            {connected && (
              <button type="button" onClick={() => check.mutate()} disabled={busy} className={NEUTRAL_BUTTON_CLASS}>
                {check.isPending ? <Loader2 size={14} className="animate-spin" /> : t('assistant.settings.check')}
              </button>
            )}
            {source === 'personal' && (
              <button type="button" onClick={() => setConfirmingForget(true)} disabled={busy} className={FORGET_BUTTON_CLASS}>
                {t('assistant.settings.disconnect')}
              </button>
            )}
          </div>
        </div>
      )}

      {confirmingForget && (
        <ConfirmDialog
          title={t('assistant.settings.disconnect')}
          destructive
          confirmLabel={t('assistant.settings.disconnect')}
          busy={forget.isPending}
          onCancel={() => setConfirmingForget(false)}
          onConfirm={() => forget.mutate()}
        >
          {t('assistant.settings.forgetConfirmBody')}
        </ConfirmDialog>
      )}
    </section>
  );
}

interface CodexCardProps {
  status: AssistantProviderStatus | undefined;
  personalDisabled: boolean;
}

/**
 * Codex: sign in with a personal ChatGPT plan by device code. The code stays on screen
 * and the state is polled every few seconds until it is connected, failed or expired;
 * polling stops on those and when the modal closes (the card unmounts). Never shared.
 */
function CodexCard({ status, personalDisabled }: CodexCardProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const showToast = useToast();
  const refresh = useRefreshAssistant();
  const [login, setLogin] = useState<AssistantCodexLoginState | null>(null);
  const [expired, setExpired] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const connected = status?.connected ?? false;
  const pending = login?.status === 'pending' && !expired;

  const start = useMutation({
    mutationFn: () => api.startCodexLogin(),
    onSuccess: (state) => {
      setExpired(false);
      setLogin(state);
      if (state.status === 'connected') refresh();
    },
    onError: (err) => showToast(errorText(err, 'assistant.providers.codex.startFailed')),
  });
  const cancel = useMutation({
    mutationFn: () => api.cancelCodexLogin(),
    onSettled: () => setLogin(null),
  });
  const disconnect = useMutation({
    mutationFn: () => api.deleteAssistantProviderKey('codex'),
    onSuccess: () => {
      setConfirmingDisconnect(false);
      setLogin(null);
      refresh();
    },
    onError: (err) => {
      setConfirmingDisconnect(false);
      showToast(errorText(err, 'assistant.providers.codex.disconnectFailed'));
    },
  });

  const expiresAt = login?.expiresAt;
  useEffect(() => {
    if (!pending) return undefined;
    let stopped = false;
    const timer = setInterval(() => {
      if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
        setExpired(true);
        return;
      }
      api
        .getCodexLogin()
        .then((state) => {
          if (stopped) return;
          setLogin((prev) => ({ ...prev, ...state }));
          if (state.status === 'connected') refresh();
        })
        .catch(() => {
          // A failed poll is retried on the next tick; the code stays valid.
        });
    }, CODEX_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // `refresh` only wraps the query client and is stable enough for this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, expiresAt]);

  async function copyCode() {
    if (!login?.userCode) return;
    try {
      await navigator.clipboard.writeText(login.userCode);
      showToast(t('assistant.providers.codex.copied'), 'info');
    } catch {
      // Clipboard blocked: the code is selectable on screen.
    }
  }

  const busy = start.isPending || cancel.isPending || disconnect.isPending;
  const name = t('assistant.providers.codex.name');

  return (
    <section aria-label={name} className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-700">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{name}</h4>
        {connected ? (
          <span className="flex items-center gap-1.5 text-sm text-green-700 dark:text-green-400">
            <CheckCircle2 size={14} />
            {t('assistant.providers.codex.signedIn')}
          </span>
        ) : (
          <span className="text-sm text-neutral-500 dark:text-neutral-400">{t('assistant.providers.notConnected')}</span>
        )}
      </div>
      <p className="mt-1 text-xs text-neutral-400">{t('assistant.providers.codex.hint')}</p>
      <p role="note" className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
        {t('assistant.providers.codex.warning')}
      </p>

      {personalDisabled ? (
        <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">{t('assistant.providers.personalDisabled')}</p>
      ) : connected ? (
        <div className="mt-2">
          <button type="button" onClick={() => setConfirmingDisconnect(true)} disabled={busy} className={FORGET_BUTTON_CLASS}>
            {t('assistant.providers.codex.disconnect')}
          </button>
        </div>
      ) : pending && login ? (
        <div className="mt-2 flex flex-col gap-2 rounded-md bg-neutral-50 p-3 dark:bg-neutral-800/60">
          <p className="text-sm text-neutral-700 dark:text-neutral-200">{t('assistant.providers.codex.enterCode')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <code data-testid="codex-user-code" className="select-all rounded-md bg-white px-3 py-1.5 font-mono text-2xl font-semibold tracking-widest text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
              {login.userCode}
            </code>
            <button type="button" onClick={() => void copyCode()} className={`${NEUTRAL_BUTTON_CLASS} flex items-center gap-1.5`}>
              <Copy size={14} />
              {t('assistant.providers.codex.copy')}
            </button>
          </div>
          {login.verificationUrl && (
            <a
              href={login.verificationUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex w-fit items-center gap-1.5 text-sm text-blue-600 hover:underline dark:text-blue-400"
            >
              <ExternalLink size={14} />
              {t('assistant.providers.codex.openPage')}
            </a>
          )}
          <p className="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
            <Loader2 size={12} className="animate-spin" />
            {t('assistant.providers.codex.waiting')}
          </p>
          <div>
            <button type="button" onClick={() => cancel.mutate()} disabled={cancel.isPending} className={NEUTRAL_BUTTON_CLASS}>
              {t('assistant.providers.codex.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex flex-col items-start gap-2">
          {expired && <p className="text-sm text-amber-800 dark:text-amber-300">{t('assistant.providers.codex.expired')}</p>}
          {login?.status === 'failed' && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {login.error ? t('assistant.providers.codex.failedWith', { error: login.error }) : t('assistant.providers.codex.failed')}
            </p>
          )}
          <button type="button" onClick={() => start.mutate()} disabled={busy} className={PRIMARY_BUTTON_CLASS}>
            {start.isPending && <Loader2 size={14} className="animate-spin" />}
            {t('assistant.providers.codex.signIn')}
          </button>
        </div>
      )}

      {confirmingDisconnect && (
        <ConfirmDialog
          title={t('assistant.providers.codex.disconnect')}
          destructive
          confirmLabel={t('assistant.providers.codex.disconnect')}
          busy={disconnect.isPending}
          onCancel={() => setConfirmingDisconnect(false)}
          onConfirm={() => disconnect.mutate()}
        >
          {t('assistant.providers.codex.disconnectBody')}
        </ConfirmDialog>
      )}
    </section>
  );
}

export interface ProviderConnectionsProps {
  providers: AssistantProviderStatus[] | undefined;
  space: string | null;
  personalDisabled: boolean;
  encryptionAvailable: boolean;
}

/**
 * The "Models and connections" section. Claude is always there; the optional providers (MiniMax, Codex) have a card
 * only when the server lists them, which it does only when the operator switched them on. Cursor keeps its own block above.
 */
export function ProviderConnections({ providers, space, personalDisabled, encryptionAvailable }: ProviderConnectionsProps) {
  const { t } = useTranslation('app');
  return (
    <div className="flex flex-col gap-3 border-t border-neutral-200 pt-4 dark:border-neutral-800">
      <div>
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{t('assistant.providers.heading')}</h3>
        <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">{t('assistant.providers.intro')}</p>
      </div>
      {statusOf(providers, 'minimax') && <ProviderKeyCard provider="minimax" status={statusOf(providers, 'minimax')} space={space} personalDisabled={personalDisabled} encryptionAvailable={encryptionAvailable} />}
      <ProviderKeyCard provider="anthropic" status={statusOf(providers, 'anthropic')} space={space} personalDisabled={personalDisabled} encryptionAvailable={encryptionAvailable} />
      {statusOf(providers, 'codex') && <CodexCard status={statusOf(providers, 'codex')} personalDisabled={personalDisabled} />}
    </div>
  );
}
