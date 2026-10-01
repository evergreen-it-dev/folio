import { useTranslation } from 'react-i18next';
import '../i18n/register';

export interface StaticBoardViewProps {
  svg: string | undefined;
  title: string;
}

/**
 * Read-only board view for viewers (BoardEditor is never mounted for them —
 * DEV-PLAN Round 2 is explicit that viewers only ever see the fetched SVG).
 * Renders the raw SVG through an <img data: URL> rather than
 * dangerouslySetInnerHTML: images render SVG in an "image context" that
 * never executes embedded scripts/event handlers, which matters here since
 * the string came from disk, not from something already sanitized.
 */
export function StaticBoardView({ svg, title }: StaticBoardViewProps) {
  const { t } = useTranslation('app');
  if (!svg) {
    return <div className="p-8 text-sm text-neutral-400">{t('routes.board.empty')}</div>;
  }

  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-neutral-200 bg-neutral-50 px-4 py-2 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        {t('routes.board.readOnly')}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <img src={src} alt={title} className="mx-auto max-w-full" />
      </div>
    </div>
  );
}
