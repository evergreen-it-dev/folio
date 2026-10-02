import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ToastProvider } from './ui/Toast';
import { SettingsProvider } from './settings';
import { AuthProvider } from './auth/AuthProvider';
import { AssistantHost } from './assistant/AssistantHost';
import { NotificationsHost } from './notifications/NotificationsHost';
import { Shell } from './Shell';
import { RootRedirect } from './routes/RootRedirect';
import { Onboarding } from './onboarding/Onboarding';
import { SpaceHome } from './routes/SpaceHome';
import { PageView } from './routes/PageView';
import { FolderView } from './routes/FolderView';
import { AccessAdmin } from './admin/access/AccessAdmin';
import { TrashPage } from './trash/TrashPage';
import { NotFound } from './routes/NotFound';
import { SharedPageView } from './share/SharedPageView';
import { AcceptInviteView } from './invites/AcceptInviteView';
import './i18n/register';

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
 * synthetic folder listing (round 3, git-native spaces); `/admin/access`
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
 * genuinely public routes: see AppRoutes below for why those need their own
 * <Routes> tree entirely outside AuthProvider rather than just another
 * <Route> inside it.
 */
export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <SettingsProvider>
        <ToastProvider>
          <BrowserRouter>
            <AppRoutes />
          </BrowserRouter>
        </ToastProvider>
      </SettingsProvider>
    </QueryClientProvider>
  );
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

  return (
    <AuthProvider>
      <AssistantHost>
      {/* Round 31: the `/events` socket and the notification feed are also
          "once, above the route tree", for the same reason as AssistantHost:
          moving between pages must not reopen the connection. Draws nothing. */}
      <NotificationsHost />
      <Routes>
        <Route path="/" element={<RootRedirect />} />
        {/* The welcome wizard on purpose, as a tour (the account menu links
            here). On a first run RootRedirect shows the same component. */}
        <Route path="/welcome" element={<Onboarding />} />
        <Route path="/s/:space" element={<Shell />}>
          <Route index element={<SpaceHome />} />
          <Route path="p/:id" element={<PageView />} />
          <Route path="d/*" element={<FolderView />} />
        </Route>
        <Route path="/admin/access" element={<AccessAdmin />} />
        {/* Trash round: the trash list — server-scoped (space admins see their spaces, instance admin everything), so no client role guard here. */}
        <Route path="/trash" element={<TrashPage />} />
        {/* QA-3: `/login` is not a route — AuthProvider swaps the login screen in
            for whatever URL you are on, so the address bar keeps saying /login and,
            once the session exists, the tree matched it against the catch-all and
            rendered a 404 to a user who had just logged in successfully. Anyone who
            bookmarks the login URL hits that. Send it home instead. */}
        <Route path="/login" element={<Navigate to="/" replace />} />
        {/* Round 27: consolidated into /admin/access (spec-access.md §6) — redirect stale links/bookmarks rather than 404 them. */}
        <Route path="/admin/users" element={<Navigate to="/admin/access?tab=people" replace />} />
        <Route path="/admin/spaces" element={<Navigate to="/admin/access?tab=spaces" replace />} />
        <Route path="*" element={<NotFound message={t('routes.notFound.generic')} />} />
      </Routes>
      </AssistantHost>
    </AuthProvider>
  );
}
