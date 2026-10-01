import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Globe, Link2, Lock, ShieldCheck, Trash2 } from 'lucide-react';
import type { SpaceRole, SpaceVisibility, User } from '@shared/contracts';
import { api } from '../api';
import { formatDate, formatDateTime } from '../formatDate';
import { useApiErrorText } from '../errorText';
import { useAuth } from '../auth/AuthProvider';
import { roleLabel } from '../auth/roles';
import { InviteDialog } from '../invites/InviteDialog';
import { Modal } from '../ui/Modal';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useToast } from '../ui/Toast';
import '../i18n/register';

export interface MembersDialogProps {
  space: string;
  onClose: () => void;
}

const ROLE_OPTIONS: SpaceRole[] = ['viewer', 'editor', 'admin'];

/** GET/PUT/DELETE /api/spaces/:space/members — space admin+. */
export function MembersDialog({ space, onClose }: MembersDialogProps) {
  const { t, i18n } = useTranslation('app');
  const errorText = useApiErrorText();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const [removingUserId, setRemovingUserId] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);

  const { data: spacesData } = useQuery({ queryKey: ['spaces'], queryFn: api.listSpaces });
  const spaceInfo = spacesData?.spaces.find((s) => s.slug === space);
  const spaceName = spaceInfo?.name ?? space;
  // Round 27 visibility, surfaced here too (owner, 08.09.2026: "the space
  // settings must say that it is instance-wide"). Same PATCH the access page
  // uses; a space's own admin may flip it (server: canAdministerSpace).
  const visibility: SpaceVisibility = spaceInfo?.visibility ?? 'private';
  const [visibilityTarget, setVisibilityTarget] = useState<SpaceVisibility | null>(null);
  const setVisibility = useMutation({
    mutationFn: (next: SpaceVisibility) => api.setSpaceVisibility(space, { visibility: next }),
    onSuccess: () => {
      setVisibilityTarget(null);
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
      queryClient.invalidateQueries({ queryKey: ['access'] });
      showToast(t('members.visibility.changed'), 'info');
    },
    onError: (err) => {
      setVisibilityTarget(null);
      showToast(errorText(err, 'access.spaces.visibilityFailed'));
    },
  });

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['members', space],
    queryFn: () => api.listMembers(space),
  });

  // Only instance admins can see GET /api/users (per the endpoint table), so
  // only they get the pick-a-user dropdown (searching across ALL instance
  // users, round 27 §6.5 — everyone but the space's own current members);
  // everyone else gets a plain email input and the server resolves it (see
  // api.ts's setMember doc).
  const { data: usersData } = useQuery({ queryKey: ['users'], queryFn: api.listUsers, enabled: user.isAdmin });
  const existingMemberIds = useMemo(() => new Set((data?.members ?? []).map((m) => m.user.id)), [data]);
  const candidateUsers = useMemo(
    () => (usersData?.users ?? []).filter((u) => !existingMemberIds.has(u.id)),
    [usersData, existingMemberIds],
  );

  // Round 27 §2.3/§6.5: "instance administrator's access" badge — degrades
  // silently on a 403 (a plain editor opening this dialog can't call
  // canAdministerSpace's gate on this endpoint; not every MembersDialog
  // caller is a space admin) or on any other failure, same pattern as every
  // other "not live yet / not allowed" query elsewhere in this file's app/.
  const accessLog = useQuery({ queryKey: ['access', 'log', space], queryFn: () => api.getSpaceAccessLog(space), retry: false });
  const selfGrantEntry = useMemo(
    () => new Map((accessLog.data?.entries ?? []).filter((e) => e.action === 'access.self_grant').map((e) => [e.meta.targetUserId as string, e])),
    [accessLog.data],
  );

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['members', space] });
    // Round 7 prod-bug fix: any add/change/remove here can affect the
    // *current* user's own role in this space (an admin editing their own
    // row, or another admin changing it concurrently) — refresh the actual
    // membership source of truth rather than relying solely on
    // useSpaceRole's spaces-list fallback to paper over it.
    queryClient.invalidateQueries({ queryKey: ['auth', 'state'] });
  }

  const setMember = useMutation({
    mutationFn: ({ identifier, role }: { identifier: string; role: SpaceRole }) => api.setMember(space, identifier, role),
    onSuccess: invalidate,
    onError: (err) => showToast(errorText(err, 'members.setRoleFailed')),
  });

  const removeMember = useMutation({
    mutationFn: (userId: string) => api.removeMember(space, userId),
    onSuccess: () => {
      invalidate();
      setRemovingUserId(null);
    },
    onError: (err) => showToast(errorText(err, 'members.removeFailed')),
  });

  const removingMember = data?.members.find((m) => m.user.id === removingUserId);

  return (
    <Modal title={t('members.title', { space: spaceName })} onClose={onClose}>
      <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-neutral-200 px-3 py-2 text-sm dark:border-neutral-800">
          <span className="inline-flex items-center gap-1.5 text-neutral-700 dark:text-neutral-300">
            {visibility === 'instance' ? <Globe size={14} className="opacity-70" /> : <Lock size={14} className="opacity-70" />}
            {t('members.visibility.label')}:{' '}
            <strong>{visibility === 'instance' ? t('access.spaces.visibilityInstance') : t('access.spaces.visibilityPrivate')}</strong>
          </span>
          <button
            type="button"
            onClick={() => setVisibilityTarget(visibility === 'instance' ? 'private' : 'instance')}
            className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            {visibility === 'instance' ? t('access.spaces.makePrivate') : t('access.spaces.makeInstance')}
          </button>
        </div>
        {isLoading && <p className="text-neutral-400">{t('ui.loading')}</p>}

        {isError && (
          <p className="text-red-600 dark:text-red-400">
            {t('members.loadFailed')}{' '}
            <button type="button" onClick={() => refetch()} className="underline underline-offset-2">
              {t('auth.retry')}
            </button>
          </p>
        )}

        {data && data.members.length === 0 && <p className="text-neutral-400">{t('members.empty')}</p>}

        {data && data.members.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {data.members.map((m) => {
              // Round 27 §2.3: badge on any membership that's an instance-admin's
              // own access — whether granted through the new UI (has an
              // access.self_grant log entry, with a date) or materialized by the
              // migration on rollout (db/migrations/016_*, no log entry to date it).
              const selfGrant = m.role === 'admin' && m.user.isAdmin ? selfGrantEntry.get(m.user.id) : undefined;
              const showBadge = m.role === 'admin' && m.user.isAdmin;
              return (
                <li key={m.user.id} className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
                      {m.user.name}
                      {showBadge && (
                        <span
                          title={selfGrant ? formatDateTime(selfGrant.at, i18n.language) : undefined}
                          className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] font-normal text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                        >
                          <ShieldCheck size={10} /> {t('members.instanceAdminAccess')}
                          {selfGrant && ` · ${formatDate(selfGrant.at, i18n.language)}`}
                        </span>
                      )}
                    </div>
                    <div className="truncate text-xs text-neutral-500 dark:text-neutral-400">{m.user.email}</div>
                  </div>
                  <select
                    value={m.role}
                    disabled={setMember.isPending}
                    onChange={(e) => setMember.mutate({ identifier: m.user.id, role: e.target.value as SpaceRole })}
                    className="shrink-0 rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-xs text-neutral-800 dark:border-neutral-700 dark:text-neutral-200"
                  >
                    {ROLE_OPTIONS.map((r) => (
                      <option key={r} value={r}>
                        {roleLabel(r)}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    aria-label={t('members.removeNamed', { name: m.user.name })}
                    onClick={() => setRemovingUserId(m.user.id)}
                    className="shrink-0 rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-red-600 dark:hover:bg-neutral-800"
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <AddMemberForm
          isInstanceAdmin={user.isAdmin}
          candidates={candidateUsers}
          pending={setMember.isPending}
          onAdd={(identifier, role) => setMember.mutate({ identifier, role })}
        />

        <div className="flex flex-wrap items-center gap-3 border-t border-neutral-200 pt-3 dark:border-neutral-800">
          <button
            type="button"
            onClick={() => setInviting(true)}
            className="flex w-fit items-center gap-1.5 rounded-md border border-dashed border-neutral-300 px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-900"
          >
            <Link2 size={14} /> {t('invites.createLink')}
          </button>
          {/* Round 27 §6.5 — deep-links to the Spaces tab of the new "Access"
              page, which has this space's own access-change log (SpacesTab.tsx). */}
          <Link
            to="/admin/access?tab=spaces"
            className="text-sm text-neutral-500 underline underline-offset-2 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200"
          >
            {t('members.accessLogLink')}
          </Link>
        </div>
      </div>

      {visibilityTarget && (
        <ConfirmDialog
          title={visibilityTarget === 'instance' ? t('members.visibility.confirmInstanceTitle', { space: spaceName }) : t('members.visibility.confirmPrivateTitle', { space: spaceName })}
          confirmLabel={visibilityTarget === 'instance' ? t('access.spaces.makeInstance') : t('access.spaces.makePrivate')}
          busy={setVisibility.isPending}
          onCancel={() => setVisibilityTarget(null)}
          onConfirm={() => setVisibility.mutate(visibilityTarget)}
        >
          {visibilityTarget === 'instance' ? t('members.visibility.confirmInstanceBody') : t('members.visibility.confirmPrivateBody')}
        </ConfirmDialog>
      )}

      {removingMember && (
        <ConfirmDialog
          title={t('members.removeConfirmTitle')}
          destructive
          confirmLabel={t('ui.delete')}
          busy={removeMember.isPending}
          onCancel={() => setRemovingUserId(null)}
          onConfirm={() => removeMember.mutate(removingMember.user.id)}
        >
          {t('members.removeConfirmBody', { name: removingMember.user.name, space: spaceName })}
        </ConfirmDialog>
      )}

      {inviting && <InviteDialog onClose={() => setInviting(false)} presetSpace={{ space, spaceName }} />}
    </Modal>
  );
}

interface AddMemberFormProps {
  isInstanceAdmin: boolean;
  candidates: User[];
  pending: boolean;
  onAdd: (identifier: string, role: SpaceRole) => void;
}

function AddMemberForm({ isInstanceAdmin, candidates, pending, onAdd }: AddMemberFormProps) {
  const { t } = useTranslation('app');
  const [selectedUserId, setSelectedUserId] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<SpaceRole>('viewer');

  const identifier = isInstanceAdmin ? selectedUserId : email.trim();

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!identifier) return;
    onAdd(identifier, role);
    setSelectedUserId('');
    setEmail('');
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-wrap items-end gap-2 border-t border-neutral-200 pt-3 dark:border-neutral-800"
    >
      {isInstanceAdmin ? (
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
          {t('members.user')}
          <select
            value={selectedUserId}
            onChange={(e) => setSelectedUserId(e.target.value)}
            className="rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 text-sm text-neutral-800 dark:border-neutral-700 dark:text-neutral-200"
          >
            <option value="">{candidates.length === 0 ? t('members.noCandidates') : t('members.selectUser')}</option>
            {candidates.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.email})
              </option>
            ))}
          </select>
        </label>
      ) : (
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="user@example.com"
            className="rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 text-sm text-neutral-800 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:text-neutral-200"
          />
        </label>
      )}
      <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
        {t('admin.role')}
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as SpaceRole)}
          className="rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 text-sm text-neutral-800 dark:border-neutral-700 dark:text-neutral-200"
        >
          {ROLE_OPTIONS.map((r) => (
            <option key={r} value={r}>
              {roleLabel(r)}
            </option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        disabled={pending || !identifier}
        className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
      >
        {t('members.add')}
      </button>
    </form>
  );
}
