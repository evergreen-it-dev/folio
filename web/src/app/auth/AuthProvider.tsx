import { createContext, useContext, useEffect } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { SpaceRole, User } from '@shared/contracts';
import { api, UNAUTHORIZED_EVENT } from '../api';
import { initAnalytics } from '../../analytics';
import { reconcileLanguageFromProfile } from '../../i18n';
import { resolveSpaceRole } from './roles';
import { SetupScreen } from './SetupScreen';
import { LoginScreen } from './LoginScreen';
import '../i18n/register';

const STARS_QUERY_KEY = ['stars'] as const;

export interface AuthContextValue {
  user: User;
  /** space slug -> my role; instance admins get every space as 'admin' (server-provided). */
  memberships: Record<string, SpaceRole>;
  logout: () => void;
  loggingOut: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * The authenticated user + their space memberships. Only ever called from
 * inside `<AuthProvider>`'s `children` — which AuthProvider itself only
 * renders once GET /api/auth/state confirms a logged-in user — so there is
 * no "logged out" case to handle here; that's the whole point of the gate.
 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>, and only once authenticated');
  return ctx;
}

/**
 * Same as `useAuth`, but never throws: `null` outside `<AuthProvider>`
 * (plain `useContext` default) or before auth state resolves. Exists for
 * call sites that render both inside the authed app AND on a session-free
 * surface — collab identity resolution (app/collabIdentity.ts) is the
 * motivating case: a board/document/table opened via a share link renders
 * the exact same collab hooks from OUTSIDE `<AuthProvider>` (see
 * SharedPageView's own docblock for why), and that guest has no user to
 * report — not an error, just the anonymous case.
 */
export function useAuthOptional(): AuthContextValue | null {
  return useContext(AuthContext);
}

/**
 * My role in `space`, or undefined when not a member (see roles.ts for what
 * that means for gating). Round 7 prod-bug fix: prefers `memberships`
 * (AuthProvider's own state, fetched once and only refreshed on explicit
 * invalidation) but falls back to the `['spaces']` list's own per-space
 * `myRole` when `memberships` doesn't know the space yet — see
 * roles.ts's resolveSpaceRole for the full reasoning. `['spaces']` is
 * shared cache (SpaceSwitcher/Sidebar/Breadcrumbs/MembersDialog all query
 * it too), so this adds no real extra fetch in practice.
 */
export function useSpaceRole(space: string | undefined): SpaceRole | undefined {
  const { memberships } = useAuth();
  const { data } = useQuery({ queryKey: ['spaces'], queryFn: api.listSpaces });
  return resolveSpaceRole(memberships, data?.spaces, space);
}

export interface AuthProviderProps {
  children: ReactNode;
}

/**
 * Boots the app behind an auth gate. Fetches GET /api/auth/state (public)
 * and renders exactly one of: first-run setup, login, or `children` (the
 * real app, wrapped in the user/memberships context). Also listens for the
 * "unauthorized" event api.ts's request() dispatches on any 401 — from
 * anywhere in the app, that drops straight back to the login screen by
 * simply re-fetching auth state (the server is the source of truth for
 * what "logged out" looks like; no need to hand-construct it here).
 */
export function AuthProvider({ children }: AuthProviderProps) {
  const { t } = useTranslation('app');
  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['auth', 'state'],
    queryFn: api.getAuthState,
  });

  // Round 10: brings a device that's never set localStorage in line with the
  // user's saved profile preference the first time it's seen — see
  // reconcileLanguageFromProfile's own doc comment for why this is a no-op
  // in every other case.
  // Optional analytics: the server offers a key only when the operator switched it on (server/analytics.ts).
  const analytics = data?.analytics;
  useEffect(() => {
    initAnalytics(analytics);
  }, [analytics]);

  const profileLang = data?.user?.lang;
  useEffect(() => {
    reconcileLanguageFromProfile(profileLang);
  }, [profileLang]);

  useEffect(() => {
    function handleUnauthorized() {
      void refetch();
    }
    window.addEventListener(UNAUTHORIZED_EVENT, handleUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, handleUnauthorized);
  }, [refetch]);

  // "GET /api/me/stars on boot (after auth)" — fire this once a session is
  // confirmed, in parallel with whatever the first routed screen needs,
  // rather than waiting for the first component that happens to render a
  // star toggle to discover it needs the data. Above the early returns
  // below (hooks can't be called conditionally); keyed on the user id so it
  // only actually re-fires across an actual login/logout, not every render.
  const userId = data?.user?.id;
  useEffect(() => {
    if (userId) void queryClient.prefetchQuery({ queryKey: STARS_QUERY_KEY, queryFn: api.getStars });
  }, [userId, queryClient]);

  const logoutMutation = useMutation({
    mutationFn: api.logout,
    onSettled: () => {
      // Wipe every cached page/tree/stars/etc so a different user logging
      // in on the same browser never sees a flash of the previous session's
      // data; then re-fetch auth state to drop to the login screen.
      queryClient.clear();
      void refetch();
    },
  });

  if (isLoading) {
    return <CenteredMessage>{t('auth.loading')}</CenteredMessage>;
  }

  if (isError || !data) {
    return (
      <CenteredMessage>
        {t('auth.connectionError')}{' '}
        <button type="button" onClick={() => refetch()} className="underline underline-offset-2">
          {t('auth.retry')}
        </button>
      </CenteredMessage>
    );
  }

  if (data.needsSetup) {
    return <SetupScreen onDone={() => refetch()} />;
  }

  if (!data.user) {
    return <LoginScreen onDone={() => refetch()} google={data.google} demo={data.demo} />;
  }

  const value: AuthContextValue = {
    user: data.user,
    memberships: data.memberships,
    logout: () => logoutMutation.mutate(),
    loggingOut: logoutMutation.isPending,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function CenteredMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center bg-white p-4 text-center text-sm text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
      {children}
    </div>
  );
}
