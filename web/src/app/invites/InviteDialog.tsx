import { useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Plus, Trash2 } from 'lucide-react';
import type { InviteInfo, SpaceRole } from '@shared/contracts';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { roleLabel } from '../auth/roles';
import { useToast } from '../ui/Toast';
import { Modal } from '../ui/Modal';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { LabeledInput } from '../ui/LabeledInput';
import { AccessBlockEditor, nextAccessRowId } from '../admin/access/AccessBlockEditor';
import type { AccessBlockRow } from '../admin/access/AccessBlockEditor';
import '../i18n/register';

export interface InviteDialogProps {
  onClose: () => void;
  /**
   * MembersDialog's use (round 9): the space is fixed (shown as plain text,
   * not a picker) and the free-form multi-space membership list + the
   * instance-admin checkbox are both skipped — a space admin can only ever
   * grant roles in their own space (DEV-PLAN Round 9). The role itself is
   * still a live choice within that one preset space.
   */
  presetSpace?: { space: string; spaceName: string };
}

const ROLE_OPTIONS: SpaceRole[] = ['viewer', 'editor', 'admin'];
const INVITES_QUERY_KEY = ['invites'] as const;

/**
 * "Invite by link" (round 9). GET/POST /api/invites, DELETE
 * /api/invites/:id — instance admin sees/creates any invite, space admin
 * only their own (server-enforced; this UI just doesn't offer what a space
 * admin couldn't do anyway). Mirrors ApiTokensModal/GitCredentialsSettings'
 * shape: list + create-toggle + one-time reveal + revoke-with-confirm.
 */
export function InviteDialog({ onClose, presetSpace }: InviteDialogProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState<InviteInfo | null>(null);
  const [revoking, setRevoking] = useState<InviteInfo | null>(null);

  const invites = useQuery({ queryKey: INVITES_QUERY_KEY, queryFn: api.listInvites, retry: false });
  const relevantInvites = (invites.data?.invites ?? []).filter(
    (inv) => !presetSpace || inv.memberships.some((m) => m.space === presetSpace.space),
  );

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: INVITES_QUERY_KEY });
  }

  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeInvite(id),
    onSuccess: () => {
      setRevoking(null);
      invalidate();
    },
    onError: (err) => showToast(errorText(err, 'invites.revokeFailed')),
  });

  return (
    <Modal title={t('invites.title')} onClose={onClose} size="lg">
      {invites.isError ? (
        <p className="text-sm text-neutral-400">{t('invites.notLive')}</p>
      ) : (
        <div className="flex flex-col gap-4">
          {justCreated && <InviteRevealBox invite={justCreated} onDismiss={() => setJustCreated(null)} />}

          {invites.isLoading && <p className="text-sm text-neutral-400">{t('ui.loading')}</p>}
          {invites.data && relevantInvites.length === 0 && <p className="text-sm text-neutral-400">{t('invites.empty')}</p>}

          {relevantInvites.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {relevantInvites.map((inv) => (
                <InviteRow key={inv.id} invite={inv} onRevoke={() => setRevoking(inv)} />
              ))}
            </ul>
          )}

          {creating ? (
            <CreateInviteForm
              presetSpace={presetSpace}
              onCreated={(inv) => {
                setJustCreated(inv);
                setCreating(false);
                invalidate();
                navigator.clipboard
                  .writeText(inv.url)
                  .then(() => showToast(t('invites.linkCopied'), 'info'))
                  .catch(() => {
                    /* best-effort — the reveal box below still has its own copy button */
                  });
              }}
              onCancel={() => setCreating(false)}
            />
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="flex w-fit items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              <Plus size={14} aria-hidden="true" /> {t('invites.createLink')}
            </button>
          )}
        </div>
      )}

      {revoking && (
        <ConfirmDialog
          title={t('invites.revokeConfirmTitle')}
          destructive
          confirmLabel={t('ui.revoke')}
          busy={revoke.isPending}
          onCancel={() => setRevoking(null)}
          onConfirm={() => revoke.mutate(revoking.id)}
        >
          {t('invites.revokeConfirmBody')}
        </ConfirmDialog>
      )}
    </Modal>
  );
}

function InviteRevealBox({ invite, onDismiss }: { invite: InviteInfo; onDismiss: () => void }) {
  const { t } = useTranslation('app');
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40">
      <p className="mb-2 text-xs font-medium text-amber-800 dark:text-amber-300">{t('invites.linkCreated')}</p>
      <div className="flex items-center gap-2">
        {/* Round 19 QA fix (#1-client): server now sends a normalized,
            absolute https URL (PUBLIC_URL fix — see DEV-PLAN Round 19's
            SERVER section); this just displays invite.url exactly as given,
            no client-side scheme/prefix of its own, as a real <a> (was a
            plain <code>) so it actually reads and behaves as a clickable
            link rather than inert text someone has to select by hand.
            target=_blank: this is the *creator's* own already-authenticated
            tab — following the link in place would either bounce them
            through /invite/:token's own "already logged in, sign out?"
            prompt or (worse) tempt them into actually submitting someone
            else's invite from their own session. */}
        <a
          href={invite.url}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1.5 font-mono text-xs text-neutral-800 underline decoration-dotted underline-offset-2 hover:text-neutral-950 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:text-white"
        >
          {invite.url}
        </a>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(invite.url).then(() => {
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
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="mt-2 text-xs text-amber-700 underline underline-offset-2 hover:text-amber-900 dark:text-amber-400 dark:hover:text-amber-200"
      >
        {t('ui.close')}
      </button>
    </div>
  );
}

function InviteRow({ invite, onRevoke }: { invite: InviteInfo; onRevoke: () => void }) {
  const { t, i18n } = useTranslation('app');
  const membershipText =
    invite.memberships.map((m) => `${m.space} (${roleLabel(m.role)})`).join(', ') || (invite.isAdmin ? '' : '—');
  const expiresText = new Date(invite.expiresAt).toLocaleDateString(i18n.language, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

  return (
    <li className="flex items-center gap-2 rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-neutral-900 dark:text-neutral-100">
          {[membershipText, invite.isAdmin ? t('invites.instanceAdmin') : null].filter(Boolean).join(' + ')}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
          <span>{t('invites.usesOf', { uses: invite.uses, max: invite.maxUses === 0 ? '∞' : invite.maxUses })}</span>
          {invite.email && <span>· {invite.email}</span>}
          <span>· {t('invites.expiresAt', { date: expiresText })}</span>
        </div>
      </div>
      <button
        type="button"
        onClick={onRevoke}
        aria-label={t('ui.revoke')}
        title={t('ui.revoke')}
        className="shrink-0 rounded p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-red-600 dark:hover:bg-neutral-800"
      >
        <Trash2 size={14} />
      </button>
    </li>
  );
}

function CreateInviteForm({
  presetSpace,
  onCreated,
  onCancel,
}: {
  presetSpace?: { space: string; spaceName: string };
  onCreated: (invite: InviteInfo) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const showToast = useToast();
  const spaces = useQuery({ queryKey: ['spaces'], queryFn: api.listSpaces, enabled: !presetSpace });
  const [rows, setRows] = useState<AccessBlockRow[]>(
    presetSpace ? [{ id: nextAccessRowId(), space: presetSpace.space, role: 'viewer' }] : [],
  );
  const [isAdmin, setIsAdmin] = useState(false);
  const [expiresInDays, setExpiresInDays] = useState(7);
  const [unlimited, setUnlimited] = useState(false);
  const [maxUses, setMaxUses] = useState(1);
  const [email, setEmail] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api.createInvite({
        memberships: rows.filter((r) => r.space).map((r) => ({ space: r.space, role: r.role })),
        isAdmin,
        expiresInDays,
        maxUses: unlimited ? 0 : maxUses,
        email: email.trim() || undefined,
      }),
    onSuccess: onCreated,
    onError: (err) => showToast(errorText(err, 'invites.createFailed')),
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (canSubmit) create.mutate();
  }

  const canSubmit = presetSpace ? rows.length > 0 && rows[0]!.space.length > 0 : rows.some((r) => r.space) || isAdmin;

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 rounded-md border border-neutral-200 p-3 dark:border-neutral-800"
    >
      {presetSpace ? (
        <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
          {t('invites.presetSpace', { space: presetSpace.spaceName })}
          <select
            value={rows[0]?.role ?? 'viewer'}
            onChange={(e) =>
              setRows([{ id: rows[0]?.id ?? nextAccessRowId(), space: presetSpace.space, role: e.target.value as SpaceRole }])
            }
            className="rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-xs text-neutral-800 dark:border-neutral-700 dark:text-neutral-200"
          >
            {ROLE_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <>
          {/* Round 27 §6.4: the same repeatable "space + role" block as
              admin/access/AddPersonDialog.tsx's own access rows — spec's
              explicit "the same access block is reused in the invitation
              dialog" (this is the standalone, non-presetSpace invite flow;
              MembersDialog's own presetSpace invite keeps its single fixed-space
              row above, which is a different shape entirely). */}
          <AccessBlockEditor rows={rows} onChange={setRows} spaceOptions={(spaces.data?.spaces ?? []).map((s) => ({ slug: s.slug, name: s.name }))} />
          <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
            <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} /> {t('invites.grantInstanceAdmin')}
          </label>
        </>
      )}

      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
          {t('invites.expiresInDays')}
          <input
            type="number"
            min={1}
            max={90}
            value={expiresInDays}
            onChange={(e) => setExpiresInDays(Number(e.target.value))}
            className="w-20 rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm text-neutral-800 dark:border-neutral-700 dark:text-neutral-200"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
          {t('invites.maxUses')}
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              min={1}
              disabled={unlimited}
              value={maxUses}
              onChange={(e) => setMaxUses(Number(e.target.value))}
              className="w-16 rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm text-neutral-800 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-200"
            />
            <label className="flex items-center gap-1 text-xs text-neutral-600 dark:text-neutral-400">
              <input type="checkbox" checked={unlimited} onChange={(e) => setUnlimited(e.target.checked)} /> {t('invites.unlimited')}
            </label>
          </div>
        </label>
      </div>
      <LabeledInput
        label={t('invites.emailOptional')}
        type="email"
        placeholder="user@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />

      {create.isError && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {errorText(create.error, 'invites.createFailed')}
        </p>
      )}

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
          disabled={!canSubmit || create.isPending}
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          {create.isPending ? t('invites.creating') : t('invites.createLink')}
        </button>
      </div>
    </form>
  );
}
