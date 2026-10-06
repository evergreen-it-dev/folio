import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from './api';
import './i18n/register';

/**
 * Public demo only: `.agent` is edited under a shared login, so what one visitor
 * writes there is what the next visitor's connected agents (MCP) read. Says so
 * where the rules are. Cache only (as DemoBanner), so an ordinary instance
 * renders nothing and makes no request.
 */
export function AgentDemoNote({ className = '' }: { className?: string }) {
  const { t } = useTranslation('app');
  const { data } = useQuery({ queryKey: ['auth', 'state'], queryFn: api.getAuthState, enabled: false });
  if (!data?.demo) return null;
  return (
    <p role="note" className={`text-[11px] leading-snug text-amber-700 dark:text-amber-300 ${className}`}>
      {t('sidebar.agent.demoNote')}
    </p>
  );
}
