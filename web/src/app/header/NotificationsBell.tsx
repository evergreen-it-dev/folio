import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Bell } from 'lucide-react';
import { spaceRoleSchema, type DecideAccessRequestBody, type NotificationItem, type SpaceRole } from '@shared/contracts';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { formatDateTime } from '../formatDate';
import { useOutsideClick } from '../hooks';
import { positionMenu, type MenuCoords } from '../ui/Menu';
import { NOTIFICATIONS_QUERY_KEY, markAllReadInCache, useNotifications } from '../notifications/useNotifications';
import '../i18n/register';

/** The roles to grant — taken from the contract, so that the list in the panel does not drift from what the server accepts. */
const ROLES: readonly SpaceRole[] = spaceRoleSchema.options;

/** Beyond a three-digit counter the badge is no longer readable, and "how many exactly" does not matter there. */
const MAX_BADGE = 99;

function describePerson(person: { name: string; username?: string | null }): string {
  return person.username ? `${person.name} (@${person.username})` : person.name;
}

/**
 * One row of the feed. Both present kinds of notification carry the same
 * request but look at it from different sides: `access_request` came to the
 * ADMINISTRATOR ("somebody asks"), `access_decision` to the requester ("it was
 * decided"). So the decision buttons are gated by the kind, not by a role from
 * memberships: the server sends `access_request` only to those who have the
 * right to decide (store.listAccessRequestRecipients), and a second,
 * client-side guess about the same right would only drift away from it.
 */
function NotificationRow({ item }: { item: NotificationItem }) {
  const { t, i18n } = useTranslation('app');
  const queryClient = useQueryClient();
  const errorText = useApiErrorText();
  const [role, setRole] = useState<SpaceRole>('viewer');
  const [error, setError] = useState<string | null>(null);
  const request = item.accessRequest;

  const decide = useMutation({
    mutationFn: (body: DecideAccessRequestBody) => api.decideAccessRequest(request.id, body),
    onMutate: () => setError(null),
    // A decision changes the state of the request for ALL administrators, so
    // re-reading the feed is cheaper than guessing the new row locally.
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_KEY }),
    onError: (err) => setError(errorText(err, 'notifications.decideFailed')),
  });

  const pending = item.kind === 'access_request' && request.status === 'pending';
  const spaceName = request.spaceName || request.space;

  let headline: string;
  if (item.kind === 'access_request') {
    headline = t('notifications.request.asks', { name: describePerson(request.requester), space: spaceName });
  } else if (request.status === 'approved') {
    headline = t('notifications.decision.approved', {
      space: spaceName,
      role: t(`roles.${request.grantedRole ?? 'viewer'}`),
    });
  } else {
    headline = t('notifications.decision.denied', { space: spaceName });
  }

  // A decided request stays visible in the ADMIN row, but without buttons —
  // instead it shows who did what: otherwise two administrators would argue
  // with buttons that no longer do anything.
  let outcome: string | null = null;
  if (item.kind === 'access_request' && request.status !== 'pending') {
    const by = request.decidedBy ? describePerson(request.decidedBy) : t('notifications.request.someone');
    outcome =
      request.status === 'approved'
        ? t('notifications.request.approvedBy', { name: by, role: t(`roles.${request.grantedRole ?? 'viewer'}`) })
        : t('notifications.request.deniedBy', { name: by });
  }

  return (
    <li className="flex flex-col gap-1 rounded-md px-2.5 py-2 text-sm text-neutral-700 dark:text-neutral-200">
      <div className="flex items-start gap-2">
        {!item.readAt && <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500" aria-hidden="true" />}
        <span className={item.readAt ? 'ml-3.5' : ''}>{headline}</span>
      </div>
      <span className="ml-3.5 text-xs text-neutral-400">{formatDateTime(item.createdAt, i18n.language)}</span>
      {outcome && <span className="ml-3.5 text-xs text-neutral-500 dark:text-neutral-400">{outcome}</span>}

      {pending && (
        <div className="ml-3.5 mt-1 flex flex-wrap items-center gap-1.5">
          <label className="sr-only" htmlFor={`notif-role-${item.id}`}>
            {t('notifications.request.roleLabel')}
          </label>
          <select
            id={`notif-role-${item.id}`}
            aria-label={t('notifications.request.roleLabel')}
            value={role}
            onChange={(event) => setRole(event.target.value as SpaceRole)}
            className="rounded-md border border-neutral-300 bg-white px-1.5 py-1 text-xs dark:border-neutral-600 dark:bg-neutral-800"
          >
            {ROLES.map((option) => (
              <option key={option} value={option}>
                {t(`roles.${option}`)}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={decide.isPending}
            onClick={() => decide.mutate({ decision: 'approve', role })}
            className="rounded-md bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {t('notifications.request.approve')}
          </button>
          <button
            type="button"
            disabled={decide.isPending}
            onClick={() => decide.mutate({ decision: 'deny' })}
            className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            {t('notifications.request.deny')}
          </button>
        </div>
      )}

      {error && <span className="ml-3.5 text-xs text-red-600 dark:text-red-400">{error}</span>}
    </li>
  );
}

/**
 * The bell in the header: the unread counter as a badge, the panel with the
 * feed on click (unlike the neighboring presence indicator, which opens on
 * hover: there the list is a reference, here there are live buttons inside,
 * and a panel that runs away from the mouse would cost a press of the wrong
 * button).
 *
 * The panel MUST go through a portal and `position: fixed` — the same lesson
 * as recorded in ui/Menu.tsx and header/PagePresence.tsx: the root of Shell is
 * `flex h-full overflow-hidden`, and an overflow ancestor clips absolute
 * descendants whatever their z-index. positionMenu additionally flips the
 * panel upwards when it does not fit below.
 *
 * The data comes from the same cache key that NotificationsHost fills, so a
 * socket row appears in the open panel without any refetch.
 */
export function NotificationsBell() {
  const { t } = useTranslation('app');
  const queryClient = useQueryClient();
  const { data } = useNotifications();
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<MenuCoords | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const items = data?.items ?? [];
  const unread = data?.unread ?? 0;

  const markRead = useMutation({
    mutationFn: () => api.markNotificationsRead(),
    // The badge has to disappear the moment the person saw the feed, not after
    // the next GET; the error is deliberately swallowed here — unread items are
    // not lost, the next opening will try again.
    onSuccess: () => markAllReadInCache(queryClient, new Date().toISOString()),
    onError: () => undefined,
  });

  // Measure, then position, as in Menu.tsx: the height of the panel is known
  // only after it is really in the DOM, and a layout effect runs before paint —
  // so there is no flicker at (0, 0).
  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    const triggerEl = triggerRef.current;
    const panelEl = panelRef.current;
    if (triggerEl && panelEl) {
      setCoords(positionMenu(triggerEl.getBoundingClientRect(), panelEl.getBoundingClientRect(), 'right'));
    }
  }, [open, items.length]);

  useOutsideClick([triggerRef, panelRef], () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const dismiss = () => setOpen(false);
    document.addEventListener('keydown', onKey);
    // Fixed coordinates go stale on the very first scroll; closing is enough
    // (Menu.tsx does the same). Capture — because scroll does not bubble.
    window.addEventListener('scroll', dismiss, { capture: true });
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', dismiss, { capture: true });
      window.removeEventListener('resize', dismiss);
    };
  }, [open]);

  const label = unread > 0 ? t('notifications.bellUnread', { count: unread }) : t('notifications.bell');

  return (
    <div className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next && unread > 0 && !markRead.isPending) markRead.mutate();
        }}
        // max-md:min-h/w-10 — the same touch threshold as the rest of the header buttons.
        className="relative inline-flex items-center justify-center rounded-md p-1.5 text-neutral-500 hover:bg-neutral-100 max-md:min-h-10 max-md:min-w-10 dark:hover:bg-neutral-800"
      >
        <Bell size={17} aria-hidden="true" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium leading-none text-white">
            {unread > MAX_BADGE ? `${MAX_BADGE}+` : unread}
          </span>
        )}
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            style={{
              position: 'fixed',
              top: coords?.top ?? 0,
              left: coords?.left ?? 0,
              visibility: coords ? 'visible' : 'hidden',
            }}
            // z-[80] — as in Menu.tsx: above all floating surfaces, including the Folio AI panel.
            className="z-[80] w-[min(22rem,calc(100vw-1rem))] rounded-lg border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
          >
            {items.length === 0 ? (
              // An empty feed is a normal state, not a failure: a short line is
              // better than an empty box that does not tell whether it is alive.
              <p className="px-2.5 py-3 text-sm text-neutral-400">{t('notifications.empty')}</p>
            ) : (
              <ul className="flex max-h-[min(70vh,26rem)] flex-col gap-0.5 overflow-y-auto">
                {items.map((item) => (
                  <NotificationRow key={item.id} item={item} />
                ))}
              </ul>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
