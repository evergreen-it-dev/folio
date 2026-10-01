import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { PageMeta } from '@shared/contracts';
import { api, ApiError } from '../api';
import { useApiErrorText } from '../errorText';
import { Modal } from '../ui/Modal';
import { getPageSlugInfo, isValidSlug, previewSlugPath } from './slugUtils';
import '../i18n/register';

export interface ChangeSlugDialogProps {
  page: PageMeta;
  onClose: () => void;
  /** Invalidate tree+page (mirrors TreeRow's own `invalidate()`) — the URL never changes, the page route is id-based (`/s/:space/p/:id`), not path-based. */
  onChanged: () => void;
  onError: (message: string) => void;
}

/**
 * "Change slug" (DEV-PLAN Round 22, SHELL-4) — renames the page's own
 * file/directory segment via POST /api/pages/:id/slug (SERVER building this
 * in parallel, slug-api). Distinct from the existing rename flow (which
 * edits the H1/display title, not the URL-facing path segment); `id` never
 * changes either way.
 */
export function ChangeSlugDialog({ page, onClose, onChanged, onError }: ChangeSlugDialogProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const info = getPageSlugInfo(page.path, page.kind);
  const [slug, setSlug] = useState(info.slug);

  const trimmed = slug.trim();
  const valid = isValidSlug(trimmed);
  const unchanged = trimmed === info.slug;
  const preview = previewSlugPath(page.path, page.kind, valid ? trimmed : info.slug);

  const change = useMutation({
    mutationFn: () => api.changePageSlug(page.id, trimmed),
    onSuccess: () => {
      onChanged();
      onClose();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        onError(t('sidebar.slug.conflict'));
        return;
      }
      // Endpoint not live yet (SERVER's parallel slug-api work) — same
      // "notLive" degrade-gracefully convention as tokens/ApiTokensModal.tsx,
      // just surfaced as a toast rather than hiding a whole list: this modal
      // is reached by explicitly choosing the action, not by loading data.
      if (err instanceof ApiError && err.status === 404) {
        onError(t('sidebar.slug.notLive'));
        return;
      }
      onError(errorText(err, 'sidebar.slug.failed'));
    },
  });

  function submit() {
    if (!valid || unchanged || change.isPending) return;
    change.mutate();
  }

  return (
    <Modal
      title={t('sidebar.slug.title', { title: page.title })}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            {t('ui.cancel')}
          </button>
          <button
            type="button"
            disabled={!valid || unchanged || change.isPending}
            onClick={submit}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {change.isPending ? t('sidebar.slug.changing') : t('sidebar.slug.action')}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-neutral-500 dark:text-neutral-400">{t('sidebar.slug.current', { slug: info.slug })}</p>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-600 dark:text-neutral-400">{t('sidebar.slug.label')}</span>
          <input
            autoFocus
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
            aria-invalid={!valid}
            className={`rounded-md border bg-transparent px-3 py-2 text-sm text-neutral-900 outline-none dark:text-neutral-100 ${
              valid
                ? 'border-neutral-300 focus:border-neutral-500 dark:border-neutral-700 dark:focus:border-neutral-500'
                : 'border-red-400 dark:border-red-600'
            }`}
          />
          <span className={valid ? 'text-xs text-neutral-400 dark:text-neutral-500' : 'text-xs text-red-600 dark:text-red-400'}>
            {valid ? t('sidebar.slug.hint') : t('sidebar.slug.invalid')}
          </span>
        </label>
        <p className="truncate text-xs text-neutral-500 dark:text-neutral-400" title={preview}>
          {t('sidebar.slug.preview', { path: preview })}
        </p>
        <p className="text-xs text-amber-700 dark:text-amber-400">{t('sidebar.slug.warning')}</p>
      </div>
    </Modal>
  );
}
