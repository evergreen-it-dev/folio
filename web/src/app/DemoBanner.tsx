import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from './api';
import './i18n/register';

/**
 * A thin strip above the app, only on a public-demo instance (GET
 * /api/auth/state carries `demo` only when FOLIO_DEMO_MODE is on). It reads the
 * query AuthProvider already fills (`enabled: false` = cache only, never an
 * extra request), so on an ordinary instance it renders nothing.
 */
export function DemoBanner() {
  const { t } = useTranslation('app');
  const { data } = useQuery({ queryKey: ['auth', 'state'], queryFn: api.getAuthState, enabled: false });
  const demo = data?.demo;
  if (!demo) return null;
  return (
    <div
      role="status"
      className="shrink-0 bg-amber-100 px-3 py-1 text-center text-xs leading-snug text-amber-900 dark:bg-amber-950 dark:text-amber-200"
    >
      {demo.resetHours ? t('auth.demo.banner', { count: demo.resetHours }) : t('auth.demo.bannerNoInterval')}
    </div>
  );
}
