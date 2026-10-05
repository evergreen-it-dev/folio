import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Plus, Trash2 } from 'lucide-react';
import type { ApiTokenInfo, ApiTokenScope, CreatedApiToken, OAuthConnectionInfo } from '@shared/contracts';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { formatRelativeDate } from '../history';
import { useToast } from '../ui/Toast';
import { Modal } from '../ui/Modal';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { LabeledInput } from '../ui/LabeledInput';
import { buildMcpJson, buildMcpSnippet, scopeLabel } from './mcpSnippet';
import '../i18n/register';

export interface ApiTokensModalProps {
  onClose: () => void;
}

const TOKENS_QUERY_KEY = ['api-tokens'] as const;
const CONNECTIONS_QUERY_KEY = ['oauth-connections'] as const;

/**
 * "API tokens" (DEV-PLAN Round 7; MCP preset tabs added Round 9).
 * GET/POST/DELETE /api/me/tokens degrade on a 404 by hiding the whole
 * section behind a hint rather than a raw error — "not shipped yet" isn't a
 * failure the user needs to see as one.
 *
 * The just-created token is held in local state only (`justCreated`) —
 * never re-fetched, never logged anywhere client-side beyond this one
 * render — and both the reveal box and the MCP snippet below read from
 * that same piece of state, so dismissing the reveal also reverts the
 * snippet back to a placeholder.
 */
export function ApiTokensModal({ onClose }: ApiTokensModalProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState<CreatedApiToken | null>(null);
  const [revoking, setRevoking] = useState<ApiTokenInfo | null>(null);

  const tokens = useQuery({ queryKey: TOKENS_QUERY_KEY, queryFn: api.listApiTokens, retry: false });

  const create = useMutation({
    mutationFn: (body: { name: string; scopes: ApiTokenScope[] }) => api.createApiToken(body),
    onSuccess: (token) => {
      setJustCreated(token);
      setCreating(false);
      void queryClient.invalidateQueries({ queryKey: TOKENS_QUERY_KEY });
    },
    onError: (err) => showToast(errorText(err, 'tokens.createFailed')),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeApiToken(id),
    onSuccess: () => {
      setRevoking(null);
      void queryClient.invalidateQueries({ queryKey: TOKENS_QUERY_KEY });
    },
    onError: (err) => showToast(errorText(err, 'tokens.revokeFailed')),
  });

  return (
    <Modal title={t('tokens.title')} onClose={onClose} size="lg">
      {tokens.isError ? (
        <p className="text-sm text-neutral-400">{t('tokens.notLive')}</p>
      ) : (
        <div className="flex flex-col gap-4">
          {justCreated && <TokenRevealBox token={justCreated} onDismiss={() => setJustCreated(null)} />}

          {tokens.isLoading && <p className="text-sm text-neutral-400">{t('ui.loading')}</p>}

          {tokens.data && tokens.data.tokens.length === 0 && <p className="text-sm text-neutral-400">{t('tokens.empty')}</p>}

          {tokens.data && tokens.data.tokens.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {tokens.data.tokens.map((tok) => (
                <TokenRow key={tok.id} token={tok} onRevoke={() => setRevoking(tok)} />
              ))}
            </ul>
          )}

          {creating ? (
            <CreateTokenForm
              busy={create.isPending}
              onCreate={(name, scopes) => create.mutate({ name, scopes })}
              onCancel={() => setCreating(false)}
            />
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="flex w-fit items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              <Plus size={14} aria-hidden="true" /> {t('tokens.createToken')}
            </button>
          )}

          <ConnectedApps />

          <McpBlock token={justCreated?.token ?? null} />
        </div>
      )}

      {revoking && (
        <ConfirmDialog
          title={t('tokens.revokeConfirmTitle')}
          destructive
          confirmLabel={t('tokens.revoke')}
          busy={revoke.isPending}
          onCancel={() => setRevoking(null)}
          onConfirm={() => revoke.mutate(revoking.id)}
        >
          {t('tokens.revokeConfirmBody', { name: revoking.name })}
        </ConfirmDialog>
      )}
    </Modal>
  );
}

/** "Connected apps": OAuth connections (Claude, ChatGPT, …) the user approved. Hidden when the endpoint is not there (older server). */
function ConnectedApps() {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const [disconnecting, setDisconnecting] = useState<OAuthConnectionInfo | null>(null);
  const connections = useQuery({ queryKey: CONNECTIONS_QUERY_KEY, queryFn: api.listOAuthConnections, retry: false });
  const disconnect = useMutation({
    mutationFn: (id: string) => api.revokeOAuthConnection(id),
    onSuccess: () => {
      setDisconnecting(null);
      void queryClient.invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY });
    },
    onError: (err) => showToast(errorText(err, 'tokens.connected.failed')),
  });

  if (connections.isError || !connections.data) return null;
  return (
    <div className="border-t border-neutral-200 pt-3 dark:border-neutral-800">
      <div className="mb-1.5 text-sm font-medium text-neutral-700 dark:text-neutral-300">{t('tokens.connected.title')}</div>
      {connections.data.connections.length === 0 ? (
        <p className="text-sm text-neutral-400">{t('tokens.connected.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {connections.data.connections.map((c) => (
            <li key={c.id} className="flex items-center gap-2 rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">{c.clientName}</div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
                  {c.scopes.map((s) => (
                    <span key={s} className="rounded-full bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800">
                      {scopeLabel(s)}
                    </span>
                  ))}
                  <span>{t('tokens.connected.from', { host: c.redirectHost })}</span>
                  <span>· {t('tokens.createdAt', { date: formatRelativeDate(c.createdAt) })}</span>
                  <span>· {c.lastUsedAt ? t('tokens.lastUsedAt', { date: formatRelativeDate(c.lastUsedAt) }) : t('tokens.neverUsed')}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setDisconnecting(c)}
                aria-label={t('tokens.connected.disconnectNamed', { name: c.clientName })}
                title={t('tokens.connected.disconnect')}
                className="shrink-0 rounded p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-red-600 dark:hover:bg-neutral-800"
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {disconnecting && (
        <ConfirmDialog
          title={t('tokens.connected.confirmTitle')}
          destructive
          confirmLabel={t('tokens.connected.disconnect')}
          busy={disconnect.isPending}
          onCancel={() => setDisconnecting(null)}
          onConfirm={() => disconnect.mutate(disconnecting.id)}
        >
          {t('tokens.connected.confirmBody', { name: disconnecting.clientName })}
        </ConfirmDialog>
      )}
    </div>
  );
}

function TokenRevealBox({ token, onDismiss }: { token: CreatedApiToken; onDismiss: () => void }) {
  const { t } = useTranslation('app');
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40">
      <p className="mb-2 text-xs font-medium text-amber-800 dark:text-amber-300">{t('tokens.revealOnce')}</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1.5 text-xs text-neutral-800 dark:bg-neutral-900 dark:text-neutral-200">
          {token.token}
        </code>
        <CopyButton text={token.token} />
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="mt-2 text-xs text-amber-700 underline underline-offset-2 hover:text-amber-900 dark:text-amber-400 dark:hover:text-amber-200"
      >
        {t('tokens.copiedDismiss')}
      </button>
    </div>
  );
}

function TokenRow({ token, onRevoke }: { token: ApiTokenInfo; onRevoke: () => void }) {
  const { t } = useTranslation('app');
  return (
    <li className="flex items-center gap-2 rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">{token.name}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
          {token.scopes.map((s) => (
            <span key={s} className="rounded-full bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800">
              {scopeLabel(s)}
            </span>
          ))}
          <span>{t('tokens.createdAt', { date: formatRelativeDate(token.createdAt) })}</span>
          <span>
            · {token.lastUsedAt ? t('tokens.lastUsedAt', { date: formatRelativeDate(token.lastUsedAt) }) : t('tokens.neverUsed')}
          </span>
        </div>
      </div>
      <button
        type="button"
        onClick={onRevoke}
        aria-label={t('tokens.revokeNamed', { name: token.name })}
        title={t('tokens.revoke')}
        className="shrink-0 rounded p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-red-600 dark:hover:bg-neutral-800"
      >
        <Trash2 size={14} />
      </button>
    </li>
  );
}

function CreateTokenForm({
  busy,
  onCreate,
  onCancel,
}: {
  busy: boolean;
  onCreate: (name: string, scopes: ApiTokenScope[]) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation('app');
  const [name, setName] = useState('');
  const [read, setRead] = useState(true);
  const [write, setWrite] = useState(false);
  const canSubmit = name.trim().length > 0 && (read || write);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    const scopes: ApiTokenScope[] = [...(read ? (['read'] as const) : []), ...(write ? (['write'] as const) : [])];
    onCreate(name.trim(), scopes);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 rounded-md border border-neutral-200 p-3 dark:border-neutral-800"
    >
      <LabeledInput
        label={t('tokens.name')}
        autoFocus
        required
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t('tokens.namePlaceholder')}
      />
      <div className="flex gap-4 text-sm text-neutral-700 dark:text-neutral-300">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={read} onChange={(e) => setRead(e.target.checked)} /> {scopeLabel('read')}
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} /> {scopeLabel('write')}
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          {t('ui.cancel')}
        </button>
        <button
          type="submit"
          disabled={busy || !canSubmit}
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          {busy ? t('tokens.creating') : t('ui.create')}
        </button>
      </div>
    </form>
  );
}

type McpTab = 'claude-code' | 'cursor' | 'other';

/** Round 9: three ready-to-use MCP connection presets, one snippet each — the CLI form for Claude Code, and the same raw ~/.cursor/mcp.json-shaped JSON for Cursor/"Other" (Claude Desktop, Windsurf, anything that reads that config shape). */
function McpBlock({ token }: { token: string | null }) {
  const { t } = useTranslation('app');
  const [tab, setTab] = useState<McpTab>('claude-code');
  const snippet =
    tab === 'claude-code' ? buildMcpSnippet(window.location.origin, token) : buildMcpJson(window.location.origin, token);

  return (
    <div className="border-t border-neutral-200 pt-3 dark:border-neutral-800">
      <div className="mb-1.5 text-sm font-medium text-neutral-700 dark:text-neutral-300">{t('tokens.mcp.title')}</div>
      <div role="tablist" className="mb-2 flex gap-1 rounded-md bg-neutral-100 p-1 dark:bg-neutral-800">
        <McpTabButton active={tab === 'claude-code'} onClick={() => setTab('claude-code')}>
          Claude Code
        </McpTabButton>
        <McpTabButton active={tab === 'cursor'} onClick={() => setTab('cursor')}>
          Cursor
        </McpTabButton>
        <McpTabButton active={tab === 'other'} onClick={() => setTab('other')}>
          {t('tokens.mcp.tabOther')}
        </McpTabButton>
      </div>
      <div className="flex items-start gap-2">
        <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-neutral-100 p-2 font-mono text-xs text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200">
          {snippet}
        </pre>
        <CopyButton text={snippet} />
      </div>
      {tab === 'cursor' && <p className="mt-1 text-xs text-neutral-400">{t('tokens.mcp.cursorHint')}</p>}
      {!token && <p className="mt-1 text-xs text-neutral-400">{t('tokens.mcp.replaceHint')}</p>}
    </div>
  );
}

function McpTabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
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

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation('app');
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      aria-label={t('ui.copy')}
      title={t('ui.copy')}
      className="shrink-0 rounded-md border border-neutral-300 p-1.5 text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
    >
      {copied ? <Check size={14} className="text-green-600 dark:text-green-400" /> : <Copy size={14} />}
    </button>
  );
}
