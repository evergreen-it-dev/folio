import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';
import { Waypoints } from 'lucide-react';
import { RowIconBox, kindIconProps } from './PageGlyph';
import '../i18n/register';

/** Graph view (16.10.2026): the sidebar row under Tags that opens the space's graph. */
export function GraphLink({ space, onNavigate }: { space: string; onNavigate?: () => void }) {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const location = useLocation();
  const href = `/s/${encodeURIComponent(space)}/graph`;
  const active = location.pathname === href || location.pathname === `/s/${space}/graph`;
  return (
    <button
      type="button"
      onClick={() => {
        navigate(href);
        onNavigate?.();
      }}
      aria-current={active ? 'page' : undefined}
      // Like `.agent`: the bare word tells a newcomer little (owner, 16.10) — the hover hint says what the graph is.
      title={t('sidebar.graphHint')}
      aria-label={`${t('graph.title')} — ${t('sidebar.graphHint')}`}
      className={`flex w-full items-center gap-2 rounded-md py-2 pl-1 pr-2 text-left text-[13px] leading-5 md:py-[3px] ${
        active
          ? 'bg-white font-medium text-neutral-950 shadow-[0_1px_2px_rgb(0_0_0/0.06)] ring-1 ring-neutral-200/90 dark:bg-white/[0.08] dark:text-white dark:shadow-none dark:ring-white/10'
          : 'text-neutral-800 hover:bg-neutral-200/60 dark:text-neutral-200 dark:hover:bg-white/[0.06]'
      }`}
    >
      <RowIconBox>
        <Waypoints {...kindIconProps} />
      </RowIconBox>
      <span className="min-w-0 flex-1 truncate">{t('graph.title')}</span>
    </button>
  );
}
