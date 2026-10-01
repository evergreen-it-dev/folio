import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Pencil, Plus, ShieldCheck, UserCheck, UserX } from 'lucide-react';
import type { AccessMatrixResponse, AccessMatrixUser, SpaceRole } from '@shared/contracts';
import { api } from '../../api';
import { formatDate } from '../../formatDate';
import { useApiErrorText } from '../../errorText';
import { roleLabel } from '../../auth/roles';
import { useToast } from '../../ui/Toast';
import { EditUserDialog } from '../EditUserDialog';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { chipsForUser, hasNoExplicitAccess, matchesUserQuery } from './logic';
import '../../i18n/register';

type Filter = 'all' | 'noAccess' | 'admins' | 'disabled';

export interface PeopleTabProps {
  matrix: AccessMatrixResponse;
}

/** §6.1 — user list, search/filters, and an expandable per-user access panel. */
export function PeopleTab({ matrix }: PeopleTabProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<AccessMatrixUser | null>(null);
  const queryClient = useQueryClient();
  const showToast = useToast();

  // AccessMatrixUser omits fields EditUserDialog's User type needs (createdAt,
  // etc) — fetch the real records rather than fake-filling them.
  const users = useQuery({ queryKey: ['users'], queryFn: api.listUsers });
  const editingUser = editingId ? users.data?.users.find((u) => u.id === editingId) : undefined;

  const setDisabled = useMutation({
    mutationFn: (vars: { user: AccessMatrixUser; disabled: boolean }) => api.updateUser(vars.user.id, { disabled: vars.disabled }),
    onSuccess: (_result, vars) => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.invalidateQueries({ queryKey: ['access', 'matrix'] });
      if (vars.disabled) setDeactivateTarget(null);
    },
    onError: (err) => showToast(errorText(err, 'admin.editUser.failed')),
  });

  const filtered = matrix.users.filter((u) => {
    if (!matchesUserQuery(u, query)) return false;
    if (filter === 'noAccess') return hasNoExplicitAccess(matrix.roles[u.id]);
    if (filter === 'admins') return u.isAdmin;
    if (filter === 'disabled') return u.disabled;
    return true;
  });

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('access.people.searchPlaceholder')}
          aria-label={t('access.people.searchPlaceholder')}
          className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-transparent px-2.5 py-1.5 text-sm text-neutral-800 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:text-neutral-200"
        />
        <FilterChips matrix={matrix} filter={filter} onChange={setFilter} />
      </div>

      {filtered.length === 0 && <p className="text-sm text-neutral-400">{t('access.people.empty')}</p>}

      {filtered.length > 0 && (
        <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <div className="min-w-[780px]">
            <div className="sticky top-0 z-10 grid grid-cols-[minmax(230px,1.2fr)_minmax(260px,1.6fr)_7rem_12rem] gap-3 border-b border-neutral-200 bg-neutral-50 px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
              <span>{t('access.people.person')}</span>
              <span>{t('access.people.access')}</span>
              <span>{t('access.people.status')}</span>
              <span className="text-right">{t('access.people.actions')}</span>
            </div>
            <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {filtered.map((u) => (
                <PersonRow
                  key={u.id}
                  user={u}
                  roles={matrix.roles[u.id]}
                  spaces={matrix.spaces}
                  expanded={expandedId === u.id}
                  busy={setDisabled.isPending && setDisabled.variables?.user.id === u.id}
                  onToggle={() => setExpandedId((cur) => (cur === u.id ? null : u.id))}
                  onEdit={() => setEditingId(u.id)}
                  onSetDisabled={(disabled) => (disabled ? setDeactivateTarget(u) : setDisabled.mutate({ user: u, disabled: false }))}
                />
              ))}
            </ul>
          </div>
        </div>
      )}

      {editingUser && <EditUserDialog user={editingUser} onClose={() => setEditingId(null)} />}
      {deactivateTarget && (
        <ConfirmDialog
          title={t('access.people.deactivateTitle', { name: deactivateTarget.name })}
          confirmLabel={t('access.people.deactivate')}
          destructive
          busy={setDisabled.isPending}
          onCancel={() => setDeactivateTarget(null)}
          onConfirm={() => setDisabled.mutate({ user: deactivateTarget, disabled: true })}
        >
          <p className="text-sm text-neutral-600 dark:text-neutral-300">{t('access.people.deactivateBody')}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function FilterChips({ matrix, filter, onChange }: { matrix: AccessMatrixResponse; filter: Filter; onChange: (f: Filter) => void }) {
  const { t } = useTranslation('app');
  const options: { key: Filter; label: string; count: number }[] = [
    { key: 'all', label: t('access.people.filterAll'), count: matrix.users.length },
    { key: 'noAccess', label: t('access.people.filterNoAccess'), count: matrix.users.filter((u) => hasNoExplicitAccess(matrix.roles[u.id])).length },
    { key: 'admins', label: t('access.people.filterAdmins'), count: matrix.users.filter((u) => u.isAdmin).length },
    { key: 'disabled', label: t('access.people.filterDisabled'), count: matrix.users.filter((u) => u.disabled).length },
  ];
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          aria-pressed={filter === o.key}
          className={`rounded-full px-2.5 py-1 text-xs ${
            filter === o.key
              ? 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900'
              : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700'
          }`}
        >
          {o.label} <span className="opacity-70">{o.count}</span>
        </button>
      ))}
    </div>
  );
}

interface PersonRowProps {
  user: AccessMatrixUser;
  roles: Record<string, SpaceRole> | undefined;
  spaces: AccessMatrixResponse['spaces'];
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  busy: boolean;
  onSetDisabled: (disabled: boolean) => void;
}

function PersonRow({ user, roles, spaces, expanded, busy, onToggle, onEdit, onSetDisabled }: PersonRowProps) {
  const { t } = useTranslation('app');
  const { shown, overflowCount } = chipsForUser(roles);

  return (
    <li className={user.disabled ? 'bg-neutral-50/80 dark:bg-neutral-900/50' : undefined}>
      <div className="grid grid-cols-[minmax(230px,1.2fr)_minmax(260px,1.6fr)_7rem_12rem] items-center gap-3 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={t('access.people.toggleNamed', { name: user.name })}
          className="shrink-0 rounded p-1 text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          <button type="button" onClick={onToggle} className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-1.5 truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
            {user.name}
            {user.isAdmin && (
              <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] font-normal text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                <ShieldCheck size={10} /> {t('admin.isAdmin')}
              </span>
            )}
          </div>
          <div className="truncate text-xs text-neutral-500 dark:text-neutral-400">{user.email}</div>
          </button>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {shown.map((c) => (
            <span key={c.space} className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
              {c.space}: {roleLabel(c.role)}
            </span>
          ))}
          {overflowCount > 0 && (
            <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
              +{overflowCount}
            </span>
          )}
        </div>
        <span className={`w-fit rounded-full px-2 py-0.5 text-xs ${user.disabled ? 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300' : 'bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-300'}`}>
          {user.disabled ? t('access.people.disabled') : t('access.people.active')}
        </span>
        <div className="flex items-center justify-end gap-1.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => onSetDisabled(!user.disabled)}
            className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs disabled:opacity-50 ${user.disabled ? 'border-green-200 text-green-700 hover:bg-green-50 dark:border-green-900 dark:text-green-300 dark:hover:bg-green-950/40' : 'border-red-200 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/40'}`}
          >
            {user.disabled ? <UserCheck size={12} /> : <UserX size={12} />}
            {user.disabled ? t('access.people.activate') : t('access.people.deactivate')}
          </button>
          <button
            type="button"
            onClick={onEdit}
            aria-label={t('access.people.editAccount')}
            title={t('access.people.editAccount')}
            className="inline-flex shrink-0 items-center justify-center rounded-md border border-neutral-300 p-1.5 text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            <Pencil size={12} />
          </button>
        </div>
      </div>
      {expanded && <PersonPanel userId={user.id} spaces={spaces} />}
    </li>
  );
}

function PersonPanel({ userId, spaces }: { userId: string; spaces: AccessMatrixResponse['spaces'] }) {
  const { t, i18n } = useTranslation('app');
  const errorText = useApiErrorText();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const [addingSpace, setAddingSpace] = useState('');
  const [addingRole, setAddingRole] = useState<SpaceRole>('viewer');

  const access = useQuery({ queryKey: ['access', 'user', userId], queryFn: () => api.getUserAccess(userId) });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['access', 'user', userId] });
    queryClient.invalidateQueries({ queryKey: ['access', 'matrix'] });
  }

  const change = useMutation({
    mutationFn: (vars: { space: string; role: SpaceRole | null }) =>
      api.applyAccessBulk({ changes: [{ userId, space: vars.space, role: vars.role }] }),
    onSuccess: (result, vars) => {
      invalidate();
      const failed = result.errors[0];
      if (failed) showToast(errorText(failed.error));
      else if (vars.role === null) setAddingSpace('');
    },
    onError: (err) => showToast(errorText(err, 'access.people.changeFailed')),
  });

  const memberships = access.data?.memberships ?? {};
  const availableSpaces = spaces.filter((s) => !(s.slug in memberships));

  return (
    <div className="border-t border-neutral-100 bg-neutral-50/60 px-3 py-3 dark:border-neutral-800 dark:bg-neutral-900/40">
      {access.isLoading && <p className="text-xs text-neutral-400">{t('ui.loading')}</p>}

      {access.data && (
        <>
          {Object.keys(memberships).length === 0 ? (
            <p className="text-xs text-neutral-400">{t('access.people.noMemberships')}</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {Object.entries(memberships).map(([space, role]) => (
                <li key={space} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm text-neutral-800 dark:text-neutral-200">{space}</span>
                  <select
                    value={role}
                    disabled={change.isPending}
                    onChange={(e) => change.mutate({ space, role: e.target.value as SpaceRole })}
                    className="rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-xs text-neutral-800 dark:border-neutral-700 dark:text-neutral-200"
                  >
                    {(['viewer', 'editor', 'admin'] as SpaceRole[]).map((r) => (
                      <option key={r} value={r}>
                        {roleLabel(r)}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={change.isPending}
                    onClick={() => change.mutate({ space, role: null })}
                    className="text-xs text-neutral-400 underline-offset-2 hover:text-red-600 hover:underline disabled:opacity-50"
                  >
                    {t('ui.remove')}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {availableSpaces.length > 0 && (
            <div className="mt-2 flex items-center gap-1.5 border-t border-neutral-200 pt-2 dark:border-neutral-800">
              <select
                value={addingSpace}
                onChange={(e) => setAddingSpace(e.target.value)}
                className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-xs text-neutral-800 dark:border-neutral-700 dark:text-neutral-200"
              >
                <option value="">{t('access.block.selectSpace')}</option>
                {availableSpaces.map((s) => (
                  <option key={s.slug} value={s.slug}>
                    {s.name}
                  </option>
                ))}
              </select>
              <select
                value={addingRole}
                onChange={(e) => setAddingRole(e.target.value as SpaceRole)}
                className="rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-xs text-neutral-800 dark:border-neutral-700 dark:text-neutral-200"
              >
                {(['viewer', 'editor', 'admin'] as SpaceRole[]).map((r) => (
                  <option key={r} value={r}>
                    {roleLabel(r)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={!addingSpace || change.isPending}
                onClick={() => change.mutate({ space: addingSpace, role: addingRole })}
                className="flex shrink-0 items-center gap-1 rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
              >
                <Plus size={12} /> {t('access.people.addSpace')}
              </button>
            </div>
          )}

          {access.data.log.length > 0 && (
            <div className="mt-3 border-t border-neutral-200 pt-2 dark:border-neutral-800">
              <p className="mb-1 text-xs font-medium text-neutral-500 dark:text-neutral-400">{t('access.people.recentChanges')}</p>
              <ul className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                {access.data.log.slice(0, 5).map((entry) => (
                  <li key={entry.id}>
                    {formatDate(entry.at, i18n.language)} · {entry.actorName} · {t(`access.log.${entry.action.replace('.', '_')}`)} ·{' '}
                    {entry.target}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
