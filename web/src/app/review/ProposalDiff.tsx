import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { collapseUnchanged, diffLines, exceedsDiffLimit } from '../settings/lineDiff';
import '../i18n/register';

/**
 * The page's text right now (`-`) against the proposed text (`+`), unchanged runs folded —
 * the same line diff the space settings conflict view uses (settings/lineDiff.ts). For a page
 * that does not exist yet there is nothing to compare: the proposed text is shown whole.
 */
export function ProposalDiff({ current, proposed }: { current: string | null; proposed: string }) {
  const { t } = useTranslation('app');
  const rows = useMemo(() => {
    if (current === null || exceedsDiffLimit(current, proposed)) return null;
    return collapseUnchanged(diffLines(current, proposed));
  }, [current, proposed]);

  if (current === null) {
    return (
      <pre aria-label={t('review.newText')} className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded border border-neutral-200 p-2 text-[11px] leading-snug dark:border-neutral-700">
        {proposed || t('review.emptyText')}
      </pre>
    );
  }
  if (rows === null) {
    return <p className="text-xs text-neutral-500">{t('review.tooLarge')}</p>;
  }
  const changed = rows.some((row) => row.kind === 'add' || row.kind === 'del');
  return (
    <pre
      aria-label={t('review.diffLabel')}
      className="max-h-[50vh] overflow-auto rounded border border-neutral-200 bg-white p-2 text-[11px] leading-snug text-neutral-800 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200"
    >
      <span className="mb-1 block text-neutral-500">{t('review.legend')}</span>
      {!changed && <span className="block text-neutral-500">{t('review.noChanges')}</span>}
      {rows.map((row, index) =>
        row.kind === 'skip' ? (
          <span key={index} className="block text-neutral-400">
            {t('review.unchanged', { count: row.count })}
          </span>
        ) : (
          <span
            key={index}
            className={`block whitespace-pre-wrap break-words ${
              row.kind === 'del' ? 'bg-red-100 text-red-900 dark:bg-red-950/60 dark:text-red-200' : row.kind === 'add' ? 'bg-green-100 text-green-900 dark:bg-green-950/60 dark:text-green-200' : ''
            }`}
          >
            {row.kind === 'del' ? '- ' : row.kind === 'add' ? '+ ' : '  '}
            {row.text}
          </span>
        ),
      )}
    </pre>
  );
}
