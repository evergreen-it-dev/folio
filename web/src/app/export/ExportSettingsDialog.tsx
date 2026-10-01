import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../ui/Modal';

import { useApiErrorText } from '../errorText';
import { EXPORT_PLACEHOLDERS, getSpaceExportSettings, putSpaceExportSettings } from './spaceExportSettings';
import '../i18n/register';

export interface ExportSettingsDialogProps {
  space: string;
  onClose: () => void;
}

/**
 * R23 tail (headers and footers) — the space-level PDF header/footer editor, opened
 * from the sidebar's space menu (admins only; the API is gated the same way
 * server-side). Two HTML text areas + the placeholder legend; what's saved
 * lands in the `export` section of `<slug>.folio` and is rendered by
 * server/export/print.ts on every PDF of this space.
 *
 * Plain fetch + mount-effect local state, NOT react-query — deliberate house
 * style for panels since the boards "eternal Loading" incident (see
 * ShareButton.tsx / HANDOFF): this dialog must work identically on every
 * page kind, including boards.
 */
export function ExportSettingsDialog({ space, onClose }: ExportSettingsDialogProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [headerHtml, setHeaderHtml] = useState('');
  const [footerHtml, setFooterHtml] = useState('');

  useEffect(() => {
    let cancelled = false;
    getSpaceExportSettings(space)
      .then((settings) => {
        if (cancelled) return;
        setHeaderHtml(settings.headerHtml ?? '');
        setFooterHtml(settings.footerHtml ?? '');
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(errorText(err, 'export.settings.loadFailed'));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [space, t]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await putSpaceExportSettings(space, {
        // Blank = "use the default" — the server drops empty templates from
        // the file rather than storing empty strings.
        headerHtml,
        footerHtml,
      });
      onClose();
    } catch (err) {
      console.error('export settings save failed', err);
      setError(errorText(err, 'export.settings.saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  const textareaClass =
    'w-full resize-y rounded-md border border-neutral-300 bg-white px-2 py-1.5 font-mono text-xs text-neutral-800 outline-none focus:border-neutral-400 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-200';

  return (
    <Modal title={t('export.settings.title')} onClose={onClose} size="lg"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            {t('export.settings.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={loading || saving}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
          >
            {saving ? t('export.settings.saving') : t('export.settings.save')}
          </button>
        </>
      }
    >
      {loading ? (
        <p className="text-sm text-neutral-400">{t('ui.loading')}</p>
      ) : (
        <div className="space-y-4">
          <p className="text-xs leading-snug text-neutral-500 dark:text-neutral-400">{t('export.settings.intro')}</p>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
              {t('export.settings.headerLabel')}
            </span>
            {/* Hardcoded samples, NOT i18n: `{{…}}` inside a translation
                string would be eaten by i18next's own interpolation, and the
                sample is HTML — language-neutral anyway. */}
            <textarea
              value={headerHtml}
              onChange={(e) => setHeaderHtml(e.target.value)}
              rows={3}
              placeholder={'<span>{{space}}</span><span>{{title}}</span>'}
              className={textareaClass}
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
              {t('export.settings.footerLabel')}
            </span>
            <textarea
              value={footerHtml}
              onChange={(e) => setFooterHtml(e.target.value)}
              rows={3}
              placeholder={'<span>{{date}}</span><span>{{page}} / {{pages}}</span>'}
              className={textareaClass}
            />
          </label>

          <p className="text-[11px] leading-relaxed text-neutral-400 dark:text-neutral-500">
            {t('export.settings.placeholdersHint')}{' '}
            {EXPORT_PLACEHOLDERS.map((placeholder) => (
              <code
                key={placeholder}
                className="mx-0.5 rounded bg-neutral-100 px-1 py-0.5 font-mono dark:bg-neutral-800"
              >
                {placeholder}
              </code>
            ))}
          </p>

          {error && (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
