import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ChevronDown, ChevronRight, Download, ExternalLink, Globe, Lock, MoreHorizontal, Pencil, RefreshCw, Trash2, UserPlus } from 'lucide-react';
import type { AccessMatrixResponse, SpaceVisibility } from '@shared/contracts';
import { api } from '../../api';
import { formatDateTime } from '../../formatDate';
import { useApiErrorText } from '../../errorText';
import { useToast } from '../../ui/Toast';
import { MembersDialog } from '../../sidebar/MembersDialog';
import { VisibilityConfirmDialog } from './VisibilityConfirmDialog';
import { SyncStatusChip } from '../../git/SyncStatusChip';
import { normalizeRepoUrlForDisplay } from '../../sidebar/gitRepos';
import { Menu, MenuItem } from '../../ui/Menu';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import '../../i18n/register';

export interface SpacesTabProps {
  matrix: AccessMatrixResponse;
}

/** §6.3 — space list: visibility toggle, member/admin counts, page count, access-log feed. */
export function SpacesTab({ matrix }: SpacesTabProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [managingMembers, setManagingMembers] = useState<string | null>(null);
  const [visibilityTarget, setVisibilityTarget] = useState<{ slug: string; name: string; next: SpaceVisibility } | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ slug: string; name: string } | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{ slug: string; name: string; pageCount: number } | null>(null);

  const { data: adminSpaces, isLoading, isError, refetch } = useQuery({
    queryKey: ['admin', 'spaces'],
    queryFn: api.listAdminSpaces,
    retry: false,
  });

  const setVisibility = useMutation({
    mutationFn: (vars: { slug: string; visibility: SpaceVisibility }) => api.setSpaceVisibility(vars.slug, { visibility: vars.visibility }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'spaces'] });
      queryClient.invalidateQueries({ queryKey: ['access', 'matrix'] });
      setVisibilityTarget(null);
    },
    onError: (err) => showToast(errorText(err, 'access.spaces.visibilityFailed')),
  });

  const syncSpace = useMutation({
    mutationFn: (slug: string) => api.syncSpace(slug),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'spaces'] });
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
      if (result.git.status === 'error' || result.git.status === 'conflict') showToast(result.git.lastError ?? t('admin.spaces.syncFailed'));
      else showToast(t('admin.spaces.syncComplete'), 'info');
    },
    onError: (err) => showToast(errorText(err, 'admin.spaces.syncFailed')),
  });

  const renameSpace = useMutation({
    mutationFn: (vars: { slug: string; name: string }) => api.renameSpace(vars.slug, vars.name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'spaces'] });
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
      setRenameTarget(null);
      showToast(t('admin.spaces.renamed'), 'info');
    },
    onError: (err) => showToast(errorText(err, 'admin.spaces.renameFailed')),
  });

  const deleteSpace = useMutation({
    mutationFn: (slug: string) => api.deleteSpace(slug),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'spaces'] });
      queryClient.invalidateQueries({ queryKey: ['access', 'matrix'] });
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
      queryClient.invalidateQueries({ queryKey: ['trash'] });
      setDeleteTarget(null);
      showToast(t('admin.spaces.deleted'), 'info');
    },
    onError: (err) => showToast(errorText(err, 'admin.spaces.deleteFailed')),
  });

  function toggleExpanded(slug: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  if (isLoading) return <p className="text-sm text-neutral-400">{t('ui.loading')}</p>;
  if (isError) {
    return (
      <p className="text-sm text-neutral-400">
        {t('admin.spaces.notLive')}{' '}
        <button type="button" onClick={() => refetch()} className="underline underline-offset-2">
          {t('auth.retry')}
        </button>
      </p>
    );
  }
  if (!adminSpaces || adminSpaces.length === 0) return <p className="text-sm text-neutral-400">{t('admin.spaces.empty')}</p>;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
        <table className="min-w-[1040px] w-full text-sm">
          <thead className="sticky top-0 z-10 bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
            <tr>
              <th className="px-3 py-2 font-medium">{t('admin.spaces.name')}</th>
              <th className="px-3 py-2 font-medium">{t('access.spaces.visibility')}</th>
              <th className="px-3 py-2 font-medium">{t('access.spaces.members')}</th>
              <th className="px-3 py-2 font-medium">{t('admin.spaces.pages')}</th>
              <th className="px-3 py-2 font-medium">{t('admin.spaces.git')}</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {adminSpaces.map((space) => {
              const isOpen = expanded.has(space.slug);
              return (
                <Fragment key={space.slug}>
                  <tr className="border-t border-neutral-200 dark:border-neutral-800">
                    <td className="px-3 py-2">
                      <div className="font-medium text-neutral-900 dark:text-neutral-100">{space.name}</div>
                      <div className="font-mono text-xs text-neutral-500 dark:text-neutral-400">{space.slug}</div>
                    </td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() =>
                          setVisibilityTarget({ slug: space.slug, name: space.name, next: space.visibility === 'instance' ? 'private' : 'instance' })
                        }
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs ${
                          space.visibility === 'instance'
                            ? 'bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-950/40 dark:text-blue-300'
                            : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300'
                        }`}
                      >
                        {space.visibility === 'instance' ? t('access.spaces.visibilityInstance') : t('access.spaces.visibilityPrivate')}
                      </button>
                    </td>
                    <td className="px-3 py-2 text-neutral-600 dark:text-neutral-400">
                      <span className="inline-flex items-center gap-1">
                        {t('admin.spaces.members', { count: space.members.length })}
                        {space.adminCount <= 1 && (
                          <span title={t('access.spaces.oneAdminWarning')}>
                            <AlertTriangle size={12} className="text-amber-500" />
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-neutral-600 dark:text-neutral-400">{space.pageCount}</td>
                    <td className="max-w-[300px] px-3 py-2">
                      <GitSpaceStatus space={space} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <Menu
                          align="right"
                          triggerLabel={t('admin.spaces.actions', 'Space actions')}
                          trigger={<MoreHorizontal size={15} />}
                        >
                          {(close) => (
                            <>
                              {space.kind === 'remote' && (
                                <MenuItem
                                  icon={<RefreshCw size={14} className={syncSpace.isPending && syncSpace.variables === space.slug ? 'animate-spin' : undefined} />}
                                  disabled={syncSpace.isPending}
                                  onSelect={() => {
                                    close();
                                    syncSpace.mutate(space.slug);
                                  }}
                                >
                                  {t('admin.spaces.syncNow')}
                                </MenuItem>
                              )}
                              <MenuItem
                                icon={<Download size={14} />}
                                onSelect={() => {
                                  close();
                                  window.location.assign(`/api/admin/spaces/${encodeURIComponent(space.slug)}/export.zip`);
                                }}
                              >
                                {t('admin.spaces.exportZip')}
                              </MenuItem>
                              <MenuItem
                                icon={space.visibility === 'instance' ? <Lock size={14} /> : <Globe size={14} />}
                                onSelect={() => {
                                  close();
                                  setVisibilityTarget({ slug: space.slug, name: space.name, next: space.visibility === 'instance' ? 'private' : 'instance' });
                                }}
                              >
                                {space.visibility === 'instance' ? t('access.spaces.makePrivate') : t('access.spaces.makeInstance')}
                              </MenuItem>
                              <MenuItem
                                icon={<UserPlus size={14} />}
                                onSelect={() => {
                                  close();
                                  setManagingMembers(space.slug);
                                }}
                              >
                                {t('access.spaces.addMember')}
                              </MenuItem>
                              <MenuItem
                                icon={<Pencil size={14} />}
                                onSelect={() => {
                                  close();
                                  setRenameTarget({ slug: space.slug, name: space.name });
                                  setRenameValue(space.name);
                                }}
                              >
                                {t('admin.spaces.rename')}
                              </MenuItem>
                              <MenuItem
                                destructive
                                icon={<Trash2 size={14} />}
                                onSelect={() => {
                                  close();
                                  setDeleteTarget({ slug: space.slug, name: space.name, pageCount: space.pageCount });
                                }}
                              >
                                {t('admin.spaces.delete')}
                              </MenuItem>
                            </>
                          )}
                        </Menu>
                        <button
                          type="button"
                          onClick={() => toggleExpanded(space.slug)}
                          aria-label={t('access.spaces.toggleLog', { name: space.name })}
                          aria-expanded={isOpen}
                          className="inline-flex items-center gap-1 rounded p-1 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                        >
                          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                      </div>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="border-t border-neutral-100 bg-neutral-50/60 dark:border-neutral-800 dark:bg-neutral-900/40">
                      <td colSpan={6} className="px-3 py-3">
                        <SpaceAccessLog space={space.slug} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {managingMembers && <MembersDialog space={managingMembers} onClose={() => setManagingMembers(null)} />}

      {visibilityTarget && (
        <VisibilityConfirmDialog
          matrix={matrix}
          space={visibilityTarget.slug}
          spaceName={visibilityTarget.name}
          next={visibilityTarget.next}
          busy={setVisibility.isPending}
          onCancel={() => setVisibilityTarget(null)}
          onConfirm={() => setVisibility.mutate({ slug: visibilityTarget.slug, visibility: visibilityTarget.next })}
        />
      )}

      {renameTarget && (
        <ConfirmDialog
          title={t('admin.spaces.renameTitle', { name: renameTarget.name })}
          confirmLabel={t('admin.spaces.rename')}
          busy={renameSpace.isPending}
          onCancel={() => setRenameTarget(null)}
          onConfirm={() => renameSpace.mutate({ slug: renameTarget.slug, name: renameValue.trim() })}
        >
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-neutral-600 dark:text-neutral-300">{t('admin.spaces.renameLabel')}</span>
            <input
              autoFocus
              value={renameValue}
              maxLength={200}
              onChange={(event) => setRenameValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && renameValue.trim() && !renameSpace.isPending) {
                  renameSpace.mutate({ slug: renameTarget.slug, name: renameValue.trim() });
                }
              }}
              className="rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none focus:border-blue-500 dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
        </ConfirmDialog>
      )}

      {deleteTarget && (
        <ConfirmDialog
          destructive
          title={t('admin.spaces.deleteTitle', { name: deleteTarget.name })}
          confirmLabel={t('admin.spaces.delete')}
          busy={deleteSpace.isPending}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => deleteSpace.mutate(deleteTarget.slug)}
        >
          <p className="text-sm text-neutral-600 dark:text-neutral-300">
            {t('admin.spaces.deleteBody', { count: deleteTarget.pageCount })}
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function GitSpaceStatus({ space }: { space: NonNullable<Awaited<ReturnType<typeof api.listAdminSpaces>>>[number] }) {
  const { t, i18n } = useTranslation('app');
  const repoLink = space.git.repoUrl ? normalizeRepoUrlForDisplay(space.git.repoUrl) : null;

  if (!space.git.repoUrl) return <span className="text-xs text-neutral-400">{t('admin.spaces.local')}</span>;

  return (
    <div className="flex min-w-0 flex-col gap-1 text-xs">
      <div className="flex min-w-0 items-center gap-1.5">
        <SyncStatusChip git={space.git} />
        {repoLink ? (
          <a href={repoLink} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-1 text-blue-600 hover:underline dark:text-blue-400">
            <span className="truncate">{repoLink.replace(/^https:\/\//, '')}</span>
            <ExternalLink size={11} className="shrink-0" />
          </a>
        ) : (
          <span className="truncate text-neutral-500">{space.git.repoUrl}</span>
        )}
        <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
          {space.git.branch}
        </span>
      </div>
      <div className="truncate text-neutral-500 dark:text-neutral-400">
        {space.git.lastSyncAt
          ? t('admin.spaces.lastSync', {
              date: formatDateTime(space.git.lastSyncAt, i18n.language),
              name: space.git.lastSyncByName ?? t('admin.spaces.system'),
            })
          : t('admin.spaces.neverSynced')}
      </div>
    </div>
  );
}

function SpaceAccessLog({ space }: { space: string }) {
  const { t, i18n } = useTranslation('app');
  const { data, isLoading, isError } = useQuery({ queryKey: ['access', 'log', space], queryFn: () => api.getSpaceAccessLog(space) });

  if (isLoading) return <p className="text-xs text-neutral-400">{t('ui.loading')}</p>;
  if (isError) return <p className="text-xs text-neutral-400">{t('access.spaces.logFailed')}</p>;
  if (!data || data.entries.length === 0) return <p className="text-xs text-neutral-400">{t('access.spaces.logEmpty')}</p>;

  return (
    <div>
      <p className="mb-1 text-xs font-medium text-neutral-500 dark:text-neutral-400">{t('access.spaces.logTitle')}</p>
      <ul className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
        {data.entries.map((entry) => (
          <li key={entry.id}>
            {formatDateTime(entry.at, i18n.language)} · {entry.actorName} · {t(`access.log.${entry.action.replace('.', '_')}`)}
            {typeof entry.meta.role === 'string' && ` → ${entry.meta.role}`}
          </li>
        ))}
      </ul>
    </div>
  );
}
