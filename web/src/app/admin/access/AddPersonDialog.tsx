import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Check, Copy } from 'lucide-react';
import type { InviteInfo } from '@shared/contracts';
import { api } from '../../api';
import { useApiErrorText } from '../../errorText';
import { Modal } from '../../ui/Modal';
import { LabeledInput } from '../../ui/LabeledInput';
import { useToast } from '../../ui/Toast';
import { AccessBlockEditor } from './AccessBlockEditor';
import type { AccessBlockRow } from './AccessBlockEditor';
import '../../i18n/register';

const FORM_ID = 'add-person-form';

export interface AddPersonDialogProps {
  onClose: () => void;
}

/**
 * Round 27 §6.4 — "Add a person": one atomic flow closing the owner's
 * scenario end to end. Two ways to hand the account over (password set now,
 * or an invite link) share the same name/email + instance-admin checkbox +
 * access block; the access rows are POSTed together with the user/invite in
 * one call each — POST /api/users now takes `memberships[]` (createUserBodySchema),
 * POST /api/invites already did (round 9).
 */
export function AddPersonDialog({ onClose }: AddPersonDialogProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const queryClient = useQueryClient();
  const showToast = useToast();

  const [mode, setMode] = useState<'password' | 'invite'>('password');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [rows, setRows] = useState<AccessBlockRow[]>([]);
  const [createdInvite, setCreatedInvite] = useState<InviteInfo | null>(null);

  // Degrades silently: an empty spaceOptions/copyFrom list just means the
  // access block's space picker and the "copy from" convenience are empty
  // until this resolves — nothing here blocks on it.
  const matrix = useQuery({ queryKey: ['access', 'matrix'], queryFn: api.getAccessMatrix, retry: false });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['users'] });
    queryClient.invalidateQueries({ queryKey: ['access', 'matrix'] });
    queryClient.invalidateQueries({ queryKey: ['admin', 'spaces'] });
  }

  const membershipRows = rows.filter((r) => r.space).map((r) => ({ space: r.space, role: r.role }));

  const createUser = useMutation({
    mutationFn: () => api.createUser({ name: name.trim(), email: email.trim(), password, isAdmin, memberships: membershipRows }),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });

  const createInvite = useMutation({
    mutationFn: () => api.createInvite({ memberships: membershipRows, isAdmin, expiresInDays: 7, maxUses: 1, email: email.trim() || undefined }),
    onSuccess: (invite) => {
      invalidate();
      setCreatedInvite(invite);
      navigator.clipboard
        .writeText(invite.url)
        .then(() => showToast(t('invites.linkCopied'), 'info'))
        .catch(() => {
          /* best-effort — the reveal box below still has its own copy button */
        });
    },
  });

  const pending = createUser.isPending || createInvite.isPending;
  const error = createUser.error ?? createInvite.error;
  const canSubmit = name.trim().length > 0 && email.trim().length > 0 && (mode === 'invite' || password.length >= 8);

  function handleSubmit() {
    if (!canSubmit) return;
    if (mode === 'password') createUser.mutate();
    else createInvite.mutate();
  }

  if (createdInvite) {
    return (
      <Modal title={t('access.addPerson.title')} onClose={onClose}>
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40">
          <p className="mb-2 text-xs font-medium text-amber-800 dark:text-amber-300">{t('invites.linkCreated')}</p>
          <InviteLinkRow url={createdInvite.url} />
          <button
            type="button"
            onClick={onClose}
            className="mt-3 rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white dark:bg-white dark:text-neutral-900"
          >
            {t('ui.close')}
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={t('access.addPerson.title')}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800">
            {t('ui.cancel')}
          </button>
          <button
            type="submit"
            form={FORM_ID}
            disabled={pending || !canSubmit}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {pending ? t('ui.pleaseWait') : t('access.addPerson.save')}
          </button>
        </>
      }
    >
      <form
        id={FORM_ID}
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          handleSubmit();
        }}
      >
        <LabeledInput label={t('auth.name')} required autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        <LabeledInput label="Email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />

        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-neutral-500 dark:text-neutral-400">{t('access.addPerson.methodLabel')}</span>
          <div className="flex gap-3">
            <label className="flex items-center gap-1.5 text-sm text-neutral-700 dark:text-neutral-300">
              <input type="radio" name="add-person-mode" checked={mode === 'password'} onChange={() => setMode('password')} />
              {t('access.addPerson.methodPassword')}
            </label>
            <label className="flex items-center gap-1.5 text-sm text-neutral-700 dark:text-neutral-300">
              <input type="radio" name="add-person-mode" checked={mode === 'invite'} onChange={() => setMode('invite')} />
              {t('access.addPerson.methodInvite')}
            </label>
          </div>
        </div>

        {mode === 'password' && (
          <LabeledInput
            label={t('auth.setup.passwordLabel')}
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        )}

        <div className="flex flex-col gap-1 rounded-md border border-neutral-200 p-2.5 dark:border-neutral-800">
          <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
            <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
            {t('admin.isAdmin')}
          </label>
          {isAdmin && <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('access.addPerson.adminWarning')}</p>}
        </div>

        <AccessBlockEditor
          rows={rows}
          onChange={setRows}
          spaceOptions={(matrix.data?.spaces ?? []).map((s) => ({ slug: s.slug, name: s.name }))}
          copyFrom={matrix.data ? { users: matrix.data.users, roles: matrix.data.roles } : undefined}
        />

        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {errorText(error, 'access.addPerson.failed')}
          </p>
        )}
      </form>
    </Modal>
  );
}

function InviteLinkRow({ url }: { url: string }) {
  const { t } = useTranslation('app');
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1.5 font-mono text-xs text-neutral-800 underline decoration-dotted underline-offset-2 hover:text-neutral-950 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:text-white"
      >
        {url}
      </a>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(url).then(() => {
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
  );
}
