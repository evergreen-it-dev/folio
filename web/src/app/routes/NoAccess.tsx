import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Lock } from 'lucide-react';
import { useDocumentTitle } from '../hooks';
import { useAuthOptional, useSpaceRole } from '../auth/AuthProvider';
import { RequestAccessButton } from '../notifications/RequestAccessButton';
import { GiveMyselfAccessButton, RequestPageAccessButton } from '../notifications/PageAccessActions';
import '../i18n/register';

export interface NoAccessProps {
  /**
   * The space the screen is about, when the route knows it. Optional on
   * purpose: with no space there is nothing access could be requested for,
   * and the screen falls back to a plain "no access" line without a button.
   */
  space?: string;
  /**
   * True when the screen answers a 403 on one PAGE (as opposed to the space
   * itself). It only matters for a caller who already has a role in the
   * space: then the page must be restricted to specific people, and a
   * space-level "request access" would only be answered with "you already
   * have access".
   */
  page?: boolean;
  /** The page that answered 403, when the route knows it: lets the screen offer the page-level actions. */
  pageId?: string;
}

/**
 * The server answered 403: the thing exists, the caller may not see it.
 * Deliberately a different screen from NotFound (a real 404) — the two used
 * to share one «404 + Request access» view, which told people who had
 * nothing to ask for that they lacked rights, and people who lacked rights
 * that the page did not exist.
 *
 * Only ever rendered inside the authenticated app (AuthProvider's GuestGate
 * keeps anonymous visitors out), so a "request access" button is always
 * addressed to a signed-in user. The public site has its own views.
 */
export function NoAccess({ space, page = false, pageId }: NoAccessProps) {
  const { t } = useTranslation('app');
  const role = useSpaceRole(space);
  const isInstanceAdmin = useAuthOptional()?.user.isAdmin === true;
  useDocumentTitle(t('routes.noAccess.title'));

  // An instance admin on a page that answered 403 can let themselves in (a recorded grant — there is no admin bypass).
  const canSelfGrant = isInstanceAdmin && page && Boolean(pageId);
  // No role in the space: access to the whole space can be requested.
  const canRequest = !canSelfGrant && Boolean(space) && role === undefined;
  // A role in the space, yet a page answered 403: the page itself is restricted.
  const restrictedPage = !canSelfGrant && Boolean(space) && role !== undefined && page;

  const message = canSelfGrant
    ? t('routes.noAccess.restrictedPageAdmin')
    : canRequest
      ? t('routes.noAccess.space', { space })
      : restrictedPage
        ? t('routes.noAccess.restrictedPage')
        : t('routes.noAccess.generic');

  return (
    <div className="flex h-full min-h-[60vh] flex-col items-center justify-center gap-3 p-8 text-center">
      <Lock size={44} className="text-neutral-300 dark:text-neutral-700" aria-hidden="true" />
      <h1 className="text-xl font-semibold text-neutral-700 dark:text-neutral-300">{t('routes.noAccess.title')}</h1>
      <p className="max-w-sm text-sm text-neutral-500 dark:text-neutral-400">{message}</p>
      {canRequest && space && <RequestAccessButton space={space} />}
      {canSelfGrant && pageId && <GiveMyselfAccessButton pageId={pageId} />}
      {restrictedPage && space && pageId && <RequestPageAccessButton space={space} pageId={pageId} />}
      <Link to="/" className="text-sm text-blue-600 underline underline-offset-2 dark:text-blue-400">
        {t('admin.backHome')}
      </Link>
    </div>
  );
}
