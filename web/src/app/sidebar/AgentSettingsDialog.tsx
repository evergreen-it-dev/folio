import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { AgentWriteMode } from '@shared/proposals';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { Modal } from '../ui/Modal';
import '../i18n/register';

/**
 * Space menu "AI agents…" (space admins; the API checks the role too): do agents write straight
 * into pages (direct, the default) or hand their Markdown edits over for an editor to accept
 * (review)? Pattern: ScanSettingsDialog. The note under the switch says what review does NOT cover.
 */
export function AgentSettingsDialog({ space, onClose }: { space: string; onClose: () => void }) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['spaces'], queryFn: api.listSpaces });
  const current: AgentWriteMode = data?.spaces.find((s) => s.slug === space)?.agentWriteMode ?? 'direct';
  const [draft, setDraft] = useState<AgentWriteMode | null>(null);
  const mode = draft ?? current;

  const save = useMutation({
    mutationFn: () => api.updateAgentSettings(space, mode),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['spaces'] });
      void queryClient.invalidateQueries({ queryKey: ['proposals'] });
      onClose();
    },
  });

  const option = (value: AgentWriteMode) => (
    <label className="flex cursor-pointer items-start gap-3">
      <input type="radio" name="agent-write-mode" checked={mode === value} onChange={() => setDraft(value)} className="mt-1 h-4 w-4 shrink-0" />
      <span className="flex flex-col gap-1">
        <span className="text-sm font-medium">{t(`agentSettings.${value}.label`)}</span>
        <span className="text-xs leading-snug text-neutral-500 dark:text-neutral-400">{t(`agentSettings.${value}.hint`)}</span>
      </span>
    </label>
  );

  return (
    <Modal
      title={t('agentSettings.title')}
      onClose={save.isPending ? () => {} : onClose}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={save.isPending} className="rounded-md px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800">
            {t('ui.cancel')}
          </button>
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={save.isPending || mode === current}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {save.isPending ? t('agentSettings.saving') : t('agentSettings.save')}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-xs leading-snug text-neutral-500 dark:text-neutral-400">{t('agentSettings.intro')}</p>
        <fieldset className="flex flex-col gap-3">
          <legend className="sr-only">{t('agentSettings.title')}</legend>
          {option('direct')}
          {option('review')}
        </fieldset>
        <p className="text-xs leading-snug text-neutral-500 dark:text-neutral-400">{t('agentSettings.scopeNote')}</p>
        <p className="text-xs leading-snug text-neutral-500 dark:text-neutral-400">{t('agentSettings.gitNote')}</p>
        {save.isError && (
          <p role="alert" className="text-xs text-red-600 dark:text-red-400">
            {errorText(save.error, 'agentSettings.saveFailed')}
          </p>
        )}
      </div>
    </Modal>
  );
}
