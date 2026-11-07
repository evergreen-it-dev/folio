import { useEffect, useMemo, useState } from 'react';
import { Lock, LockOpen } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { PageAccessGrant, PageAccessGrantRole } from '@shared/contracts';
import { api, ApiError } from '../api';
import { Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';
import '../i18n/register';

interface PageAccessButtonProps {
  pageId: string;
  /** The page's space — for the links to the parent pages it inherits a restriction from. */
  space: string;
}

type Mode = 'space' | 'me' | 'custom';

/** The page's access settings — one react-query cell shared by the header's lock icon, its «⋯» row and the dialog. */
export function usePageAccess(pageId: string) {
  const queryKey = useMemo(() => ['page-access', pageId] as const, [pageId]);
  const query = useQuery({ queryKey, queryFn: () => api.getPageAccess(pageId) });
  const restricted = query.data?.visibility === 'restricted';
  const inheritedFrom = query.data?.inheritedFrom ?? [];
  return { queryKey, data: query.data, restricted, locked: restricted || inheritedFrom.length > 0 };
}

/** The lock-icon header button with its dialog — standalone; the header itself opens PageAccessDialog from its «⋯» menu. */
export function PageAccessButton({ pageId, space }: PageAccessButtonProps) {
  const { t } = useTranslation('app');
  const [open, setOpen] = useState(false);
  const { restricted, locked } = usePageAccess(pageId);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={restricted ? t('pageAccess.restricted') : locked ? t('pageAccess.restrictedByParent') : t('pageAccess.spaceWide')}
        aria-label={t('pageAccess.button')}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
      >
        {locked ? <Lock size={15} /> : <LockOpen size={15} />}
      </button>
      {open && <PageAccessDialog pageId={pageId} space={space} onClose={() => setOpen(false)} />}
    </>
  );
}

/** «Page access» dialog: who of the space's members can see and edit this page. Renders once the settings have loaded. */
export function PageAccessDialog({ pageId, space, onClose }: PageAccessButtonProps & { onClose: () => void }) {
  const { t } = useTranslation('app');
  const showToast = useToast();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>('space');
  const [grants, setGrants] = useState<Record<string, PageAccessGrantRole | ''>>({});
  const [groupGrants, setGroupGrants] = useState<Record<string, PageAccessGrantRole | ''>>({});
  const [saving, setSaving] = useState(false);
  const { queryKey, data } = usePageAccess(pageId);

  useEffect(() => {
    if (!data) return;
    const current = Object.fromEntries(data.members.map((member) => [member.userId, member.grant ?? ''])) as Record<string, PageAccessGrantRole | ''>;
    setGrants(current);
    const groups = data.groups ?? [];
    setGroupGrants(Object.fromEntries(groups.map((group) => [group.groupId, group.grant ?? ''])) as Record<string, PageAccessGrantRole | ''>);
    setMode(data.visibility === 'space' ? 'space' : data.members.some((member) => member.grant) || groups.some((group) => group.grant) ? 'custom' : 'me');
  }, [data]);

  async function save() {
    if (!data?.canManage) return;
    setSaving(true);
    try {
      const next = await api.updatePageAccess(pageId, {
        visibility: mode === 'space' ? 'space' : 'restricted',
        grants: mode === 'custom'
          ? [
              ...Object.entries(grants).flatMap(([userId, role]): PageAccessGrant[] => role ? [{ userId, role }] : []),
              ...Object.entries(groupGrants).flatMap(([groupId, role]): PageAccessGrant[] => role ? [{ groupId, role }] : []),
            ]
          : [],
      });
      queryClient.setQueryData(queryKey, next);
      onClose();
      showToast(t('pageAccess.saved'), 'info');
    } catch (error) {
      showToast(error instanceof ApiError ? error.message : t('pageAccess.saveFailed'), 'error');
    } finally {
      setSaving(false);
    }
  }

  if (!data) return null;
  const inheritedFrom = data.inheritedFrom ?? [];
  return (
    <Modal
      title={t('pageAccess.title')}
      onClose={onClose}
      footer={data.canManage ? (
        <>
          <button type="button" onClick={onClose} className="rounded-md border border-neutral-300 px-3 py-1.5 dark:border-neutral-700">
            {t('ui.cancel')}
          </button>
          <button type="button" disabled={saving} onClick={() => void save()} className="rounded-md bg-neutral-900 px-3 py-1.5 text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900">
            {saving ? t('pageAccess.saving') : t('pageAccess.save')}
          </button>
        </>
      ) : undefined}
    >
      <p className="mb-4 text-neutral-500 dark:text-neutral-400">{t('pageAccess.description')}</p>
      {inheritedFrom.length > 0 && (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950" data-testid="page-access-inherited">
          {inheritedFrom.map((parent) => (
            <div key={parent.pageId} className="flex items-center gap-2">
              <Lock size={13} className="shrink-0" />
              <span>
                {t('pageAccess.restrictedByParentPage')}{' '}
                <Link to={`/s/${encodeURIComponent(space)}/p/${encodeURIComponent(parent.pageId)}`} onClick={onClose} className="font-medium underline">
                  {parent.title}
                </Link>
              </span>
            </div>
          ))}
          <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">{t('pageAccess.inheritedHint')}</p>
        </div>
      )}
      <div className="space-y-2">
        <AccessChoice checked={mode === 'space'} disabled={!data.canManage} onChange={() => setMode('space')} title={t('pageAccess.everyone')} detail={t('pageAccess.everyoneHint')} />
        <AccessChoice checked={mode === 'me'} disabled={!data.canManage} onChange={() => setMode('me')} title={t('pageAccess.onlyMe')} detail={t('pageAccess.onlyMeHint')} />
        <AccessChoice checked={mode === 'custom'} disabled={!data.canManage} onChange={() => setMode('custom')} title={t('pageAccess.custom')} detail={t('pageAccess.customHint')} />
      </div>

      {mode === 'custom' && (
        <div className="mt-4 max-h-72 divide-y divide-neutral-200 overflow-y-auto rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-700">
          {data.members.map((member) => (
            <div key={member.userId} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{member.name}{member.owner ? ` · ${t('pageAccess.owner')}` : ''}</div>
                <div className="truncate text-xs text-neutral-500">{member.email}</div>
              </div>
              <select
                aria-label={t('pageAccess.roleFor', { name: member.name })}
                disabled={!data.canManage || member.owner}
                value={member.owner ? 'editor' : grants[member.userId] ?? ''}
                onChange={(event) => setGrants((current) => ({ ...current, [member.userId]: event.target.value as PageAccessGrantRole | '' }))}
                className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900"
              >
                <option value="">{t('pageAccess.noAccess')}</option>
                <option value="viewer">{t('pageAccess.viewer')}</option>
                <option value="editor">{t('pageAccess.editor')}</option>
              </select>
            </div>
          ))}
          {(data.groups ?? []).length > 0 && (
            <div className="bg-neutral-50 px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
              {t('pageAccess.groups')}
            </div>
          )}
          {(data.groups ?? []).map((group) => (
            <div key={group.groupId} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{group.name}</div>
                <div className="truncate text-xs text-neutral-500">
                  {t('pageAccess.groupMembers', { count: group.memberCount })}
                  {group.spaceRole ? '' : ` · ${t('pageAccess.groupAllMembersOnly')}`}
                </div>
              </div>
              <select
                aria-label={t('pageAccess.roleFor', { name: group.name })}
                disabled={!data.canManage}
                value={groupGrants[group.groupId] ?? ''}
                onChange={(event) => setGroupGrants((current) => ({ ...current, [group.groupId]: event.target.value as PageAccessGrantRole | '' }))}
                className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900"
              >
                <option value="">{t('pageAccess.noAccess')}</option>
                <option value="viewer">{t('pageAccess.viewer')}</option>
                <option value="editor">{t('pageAccess.editor')}</option>
              </select>
            </div>
          ))}
        </div>
      )}
      {data.audienceCount !== undefined && (
        <div className="mt-4 text-sm" data-testid="page-access-audience">
          <div className="font-medium">{t('pageAccess.audience', { count: data.audienceCount })}</div>
          {data.audience && data.audience.length > 0 && (
            <ul className="mt-1 max-h-40 overflow-y-auto text-xs text-neutral-600 dark:text-neutral-400">
              {data.audience.map((reader) => (
                <li key={reader.userId} className="flex justify-between gap-3 py-0.5">
                  <span className="truncate">{reader.name}</span>
                  <span className="shrink-0">{reader.role === 'viewer' ? t('pageAccess.viewer') : t('pageAccess.editor')}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}

function AccessChoice({ checked, disabled, onChange, title, detail }: { checked: boolean; disabled: boolean; onChange: () => void; title: string; detail: string }) {
  return (
    <label className={`flex gap-3 rounded-lg border p-3 ${checked ? 'border-neutral-900 dark:border-neutral-100' : 'border-neutral-200 dark:border-neutral-700'} ${disabled ? 'cursor-default' : 'cursor-pointer'}`}>
      <input type="radio" checked={checked} disabled={disabled} onChange={onChange} className="mt-0.5" />
      <span><span className="block font-medium">{title}</span><span className="block text-xs text-neutral-500">{detail}</span></span>
    </label>
  );
}
