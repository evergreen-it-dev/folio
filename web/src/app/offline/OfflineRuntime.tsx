import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useToast } from '../ui/Toast';
import { startConnectivity, useConnectivity, type Connectivity } from './connectivity';
import { startSyncEngine, useSyncStatus } from './syncEngine';
import { warmUpBoardEditor } from './warmUp';
import '../i18n/register';

/**
 * Mounted once, inside the signed-in shell: starts the connectivity probe
 * and the sync engine, and says out loud what the header pill shows
 * quietly — but only at the moment something CHANGES. Going offline, coming
 * back, and "your offline work is on the server now" are each worth one
 * toast; a connection that flaps between slow and fine is not, so
 * `degraded` is announced only when arriving from `online`, and never
 * un-announced.
 */
const WARM_UP_DELAY_MS = 4_000;

export function OfflineRuntime() {
  const { t } = useTranslation('app');
  const queryClient = useQueryClient();
  const showToast = useToast();
  const connectivity = useConnectivity();
  const sync = useSyncStatus();
  const previous = useRef<Connectivity>(connectivity);
  const announcedSync = useRef<number | null>(sync.lastSyncedAt);
  const warmedUp = useRef(false);

  useEffect(() => {
    const stopConnectivity = startConnectivity();
    const stopEngine = startSyncEngine(queryClient);
    return () => {
      stopEngine();
      stopConnectivity();
    };
  }, [queryClient]);

  // A board can be created offline only if the board editor is already on
  // the device — see warmUp.ts. Once, a few seconds after the app has
  // settled, and only while the connection is good.
  useEffect(() => {
    if (connectivity !== 'online' || warmedUp.current) return;
    const timer = setTimeout(() => {
      warmedUp.current = true;
      void warmUpBoardEditor().then((done) => {
        // Not this time (a file did not arrive, the connection dropped):
        // the next change of state to `online` tries again.
        if (!done) warmedUp.current = false;
      });
    }, WARM_UP_DELAY_MS);
    return () => clearTimeout(timer);
  }, [connectivity]);

  useEffect(() => {
    const before = previous.current;
    previous.current = connectivity;
    if (before === connectivity) return;
    if (connectivity === 'offline') showToast(t('offline.toast.offline'), 'info');
    else if (before === 'offline') showToast(t('offline.toast.online'), 'info');
    else if (connectivity === 'degraded' && before === 'online') showToast(t('offline.toast.degraded'), 'info');
  }, [connectivity, showToast, t]);

  useEffect(() => {
    if (sync.lastSyncedAt === null || sync.lastSyncedAt === announcedSync.current) return;
    announcedSync.current = sync.lastSyncedAt;
    showToast(t('offline.toast.synced', { count: sync.lastSynced }), 'info');
  }, [sync.lastSyncedAt, sync.lastSynced, showToast, t]);

  return null;
}
