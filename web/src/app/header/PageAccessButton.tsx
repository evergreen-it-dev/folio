import { useEffect, useMemo, useState } from 'react';
import { Lock, LockOpen } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { PageAccessGrantRole } from '@shared/contracts';
import { api, ApiError } from '../api';
import { Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';
import '../i18n/register';

interface PageAccessButtonProps {
  pageId: string;
}

type Mode = 'space' | 'me' | 'custom';

export function PageAccessButton({ pageId }: PageAccessButtonProps) {
  const { t } = useTranslation('app');
  const showToast = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('space');
  const [grants, setGrants] = useState<Record<string, PageAccessGrantRole | ''>>({});
  const [saving, setSaving] = useState(false);
  const queryKey = useMemo(() => ['page-access', pageId] as const, [pageId]);
  const { data } = useQuery({ queryKey, queryFn: () => api.getPageAccess(pageId) });

  useEffect(() => {
    if (!data || !open) return;
    const current = Object.fromEntries(data.members.map((member) => [member.userId, member.grant ?? ''])) as Record<string, PageAccessGrantRole | ''>;
    setGrants(current);
    setMode(data.visibility === 'space' ? 'space' : data.members.some((member) => member.grant) ? 'custom' : 'me');
  }, [data, open]);

  async function save() {
    if (!data?.canManage) return;
    setSaving(true);
    try {
      const next = await api.updatePageAccess(pageId, {
        visibility: mode === 'space' ? 'space' : 'restricted',
        grants: mode === 'custom'
          ? Object.entries(grants).flatMap(([userId, role]) => role ? [{ userId, role }] : [])
          : [],
      });
      queryClient.setQueryData(queryKey, next);
      setOpen(false);
      showToast(t('pageAccess.saved'), 'info');
    } catch (error) {
      showToast(error instanceof ApiError ? error.message : t('pageAccess.saveFailed'), 'error');
    } finally {
      setSaving(false);
    }
  }

  const restricted = data?.visibility === 'restricted';
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={restricted ? t('pageAccess.restricted') : t('pageAccess.spaceWide')}
        aria-label={t('pageAccess.button')}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
      >
        {restricted ? <Lock size={15} /> : <LockOpen size={15} />}
      </button>

      {open && data && (
        <Modal
          title={t('pageAccess.title')}
          onClose={() => setOpen(false)}
          footer={data.canManage ? (
            <>
              <button type="button" onClick={() => setOpen(false)} className="rounded-md border border-neutral-300 px-3 py-1.5 dark:border-neutral-700">
                {t('ui.cancel')}
              </button>
              <button type="button" disabled={saving} onClick={() => void save()} className="rounded-md bg-neutral-900 px-3 py-1.5 text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900">
                {saving ? t('pageAccess.saving') : t('pageAccess.save')}
              </button>
            </>
          ) : undefined}
        >
          <p className="mb-4 text-neutral-500 dark:text-neutral-400">{t('pageAccess.description')}</p>
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
            </div>
          )}
        </Modal>
      )}
    </>
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
