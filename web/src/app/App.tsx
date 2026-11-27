import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Suspense, lazy, useEffect, useMemo } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { PUBLIC_SITE_PATH_PREFIX } from '@shared/contracts';
import { ToastProvider } from './ui/Toast';
import { SettingsProvider } from './settings';
import { AuthProvider } from './auth/AuthProvider';
import { safeReturnPath } from './auth/LoginScreen';
import { AssistantHost } from './assistant/AssistantHost';
import { CompareProvider } from './compare/CompareProvider';
import { ComparePage } from './compare/ComparePage';
import { NotificationsHost } from './notifications/NotificationsHost';
import { Shell } from './Shell';
import { RootRedirect } from './routes/RootRedirect';
import { Onboarding } from './onboarding/Onboarding';
import { SpaceHome } from './routes/SpaceHome';
import { PageView } from './routes/PageView';
import { FolderView } from './routes/FolderView';
import { AccessAdmin } from './admin/access/AccessAdmin';
import { AssistantAnalytics } from './admin/assistant/AssistantAnalytics';
import { ChatIntegrationsAdmin } from './admin/integrations/ChatIntegrationsAdmin';
import { AuditLogAdmin } from './admin/audit/AuditLogAdmin';
import { AuthProvidersAdmin } from './admin/auth/AuthProvidersAdmin';
import { TrashPage } from './trash/TrashPage';
import { NotFound } from './routes/NotFound';
import { OAuthResume } from './routes/OAuthResume';
import { SharedPageView } from './share/SharedPageView';
import { AcceptInviteView } from './invites/AcceptInviteView';
import { PublicHostRoutes, PublicPathRoutes } from './public/PublicSiteRoutes';
import { readHostSiteSlug } from './public/publicSite';
import { SentryHost } from '../sentry/SentryHost';
import { ReportProblemHost } from './feedback/reportProblem';
import { NewVersionNotice } from './ui/NewVersionNotice';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { PageCrashed } from './routes/PageCrashed';
import './i18n/register';

// The settings page carries the CodeMirror CSS/HTML modes and the CSS sanitizer; only space admins ever open it, so it is a chunk of its own
// (the public sites share this bundle with the app and should not pay for it).
const SpaceSettingsPage = lazy(() => import('./settings/SpaceSettingsPage').then((m) => ({ default: m.SpaceSettingsPage })));
// Graph view (16.10.2026): its own chunk — d3-force and the canvas load only when a graph is opened.
const GraphPage = lazy(() => import('./graph/GraphPage').then((m) => ({ default: m.GraphPage })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

/**
 * App root: providers (react-query, toasts, router) + the route table.
 * `/` redirects to the first space; `/s/:space` is the space home (resolves
 * index.md); `/s/:space/p/:id` is a page by id; `/s/:space/d/*` is a
 * synthetic folder listing (round 3, git-native spaces); `/s/:space/settings`
 * is the space's "Site & PDF" settings; `/admin/access`
 * (round 27) is the instance-admin Access page — client-guarded, see
 * AccessAdmin — consolidating the old `/admin/users` and `/admin/spaces`
 * pages (round 22), which now just redirect here for any stale bookmark/link.
 * See DEV-PLAN.md.
 *
 * AuthProvider sits *inside* BrowserRouter (so the gate itself doesn't
 * disturb whatever URL the user landed on — e.g. a deep link to a page
 * survives a login round-trip for free, since AuthProvider just switches
 * from rendering the login screen to rendering the same Routes tree, still
 * matched against the same location) but wraps the whole Routes tree —
 * except `/share/:token` (round 8) and `/invite/:token` (round 9), the
 * genuinely public routes — and the published-space site (`/public/:space` on the
 * main host; `/` and `/p/:id` on a site's own subdomain / custom domain, see
 * app/public/): see AppRoutes below for why those need their own <Routes> tree
 * entirely outside AuthProvider rather than just another <Route> inside it.
 */
export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <SettingsProvider>
        <ToastProvider>
          <BrowserRouter>
            <SentryHost />
            <ReportProblemHost />
            <NewVersionNotice />
            {/* Outermost net: a lazy chunk that fails outside the Shell (a public site, a shared page, the admin
                pages) would otherwise take the whole tree down to a blank screen. */}
            <ErrorBoundary fallback={(error, reset, eventId) => <PageCrashed onRetry={reset} eventId={eventId} error={error} />}>
              <AppRoutes />
            </ErrorBoundary>
          </BrowserRouter>
        </ToastProvider>
      </SettingsProvider>
    </QueryClientProvider>
  );
}

/**
 * `/login` after the session exists: home, or the page named by `?returnTo=` (the share page's "Sign in" link).
 * A full location replace, because the target may live outside this router tree (`/share/...`).
 */
function LoginReturn() {
  const target = safeReturnPath(new URLSearchParams(window.location.search).get('returnTo'));
  useEffect(() => {
    if (target) window.location.replace(target);
  }, [target]);
  return target ? null : <Navigate to="/" replace />;
}

/**
 * Branches *before* mounting AuthProvider at all, rather than adding
 * `/share/:token` as one more <Route> inside AuthProvider's tree. AuthProvider
 * unconditionally renders a login/setup screen in place of its children until
 * a session exists — there is no "let this one route through" escape hatch,
 * so a share visitor with no cookie would hit the login wall before ever
 * reaching the route. Two sibling <Routes> trees (one gated, one not) would
 * have the opposite problem: both try to match the current location, so a
 * visit to /share/:token would ALSO hit the gated tree's own catch-all `*`
 * route and render two things stacked in the DOM at once. Checking the path
 * with useLocation and mounting exactly one tree sidesteps both.
 */
function AppRoutes() {
  const { t } = useTranslation('app');
  const location = useLocation();
  // Set by the server in index.html when this host is a published space's own subdomain / custom domain.
  const hostSiteSlug = useMemo(() => readHostSiteSlug(), []);

  if (location.pathname.startsWith('/share/')) {
    return (
      <Routes>
        <Route path="/share/:token" element={<SharedPageView />} />
        {/* R23 tail: a CHILD page inside an includeChildren share — same
            component, same public tree; the extra segment only selects which
            page of the token's subtree to fetch. */}
        <Route path="/share/:token/p/:pageId" element={<SharedPageView />} />
      </Routes>
    );
  }

  if (location.pathname.startsWith('/invite/')) {
    return (
      <Routes>
        <Route path="/invite/:token" element={<AcceptInviteView />} />
      </Routes>
    );
  }

  // Published spaces: anonymous visitors, no AuthProvider (it would answer with a login screen).
  // On a site's own host the site owns every other path too; on the main host only /public/….
  if (hostSiteSlug) return <PublicHostRoutes slug={hostSiteSlug} />;
  if (location.pathname === PUBLIC_SITE_PATH_PREFIX || location.pathname.startsWith(`${PUBLIC_SITE_PATH_PREFIX}/`)) {
    return <PublicPathRoutes />;
  }

  return (
    <AuthProvider>
      <AssistantHost>
      {/* Round 31: the `/events` socket and the notification feed are also
          "once, above the route tree", for the same reason as AssistantHost:
          moving between pages must not reopen the connection. Draws nothing. */}
      <NotificationsHost />
      {/* Compare mode: the reader's compare list (sidebar row, header, history panel) and its floating tray — once, above the routes. */}
      <CompareProvider>
      <Routes>
        <Route path="/" element={<RootRedirect />} />
        {/* The welcome wizard on purpose, as a tour (the account menu links
            here). On a first run RootRedirect shows the same component. */}
        <Route path="/welcome" element={<Onboarding />} />
        {/* Compare mode: pages and versions from any spaces side by side; the columns are in the query (compare/compareList.ts). */}
        <Route path="/compare" element={<ComparePage />} />
        <Route path="/s/:space" element={<Shell />}>
          <Route index element={<SpaceHome />} />
          <Route path="p/:id" element={<PageView />} />
          <Route path="d/*" element={<FolderView />} />
          <Route
            path="graph"
            element={
              <Suspense fallback={<div className="p-8 text-sm text-neutral-400">{t('ui.loading')}</div>}>
                <GraphPage />
              </Suspense>
            }
          />
          {/* 14.10.2026: "Site & PDF" — SEO, the public site's CSS and the PDF header/footer, kept in .folio/ in the repository (space admins). */}
          <Route
            path="settings"
            element={
              <Suspense fallback={<div className="p-8 text-sm text-neutral-400">{t('ui.loading')}</div>}>
                <SpaceSettingsPage />
              </Suspense>
            }
          />
        </Route>
        <Route path="/admin/access" element={<AccessAdmin />} />
        <Route path="/admin/assistant" element={<AssistantAnalytics />} />
        <Route path="/admin/integrations" element={<ChatIntegrationsAdmin />} />
        <Route path="/admin/audit" element={<AuditLogAdmin />} />
        {/* Single sign-on providers (OpenID Connect), docs/AUTH.md. */}
        <Route path="/admin/auth" element={<AuthProvidersAdmin />} />
        {/* Trash round: the trash list — server-scoped (space admins see their spaces, instance admin everything), so no client role guard here. */}
        <Route path="/trash" element={<TrashPage />} />
        {/* QA-3: `/login` is not a route — AuthProvider swaps the login screen in
            for whatever URL you are on, so the address bar keeps saying /login and,
            once the session exists, the tree matched it against the catch-all and
            rendered a 404 to a user who had just logged in successfully. Anyone who
            bookmarks the login URL hits that. Send it home instead. */}
        <Route path="/login" element={<LoginReturn />} />
        {/* OAuth for MCP: after logging in at the consent URL, ask the server for it again. */}
        <Route path="/oauth/authorize" element={<OAuthResume />} />
        {/* Round 27: consolidated into /admin/access (spec-access.md §6) — redirect stale links/bookmarks rather than 404 them. */}
        <Route path="/admin/users" element={<Navigate to="/admin/access?tab=people" replace />} />
        <Route path="/admin/spaces" element={<Navigate to="/admin/access?tab=spaces" replace />} />
        <Route path="*" element={<NotFound message={t('routes.notFound.generic')} />} />
      </Routes>
      </CompareProvider>
      </AssistantHost>
    </AuthProvider>
  );
}
