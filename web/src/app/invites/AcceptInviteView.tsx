import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { normalizeUsername, usernameSchema } from '@shared/contracts';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { roleLabel } from '../auth/roles';
import { LabeledInput } from '../ui/LabeledInput';
import { useSettings } from '../settings';
import type { ThemeMode } from '../settings';
import '../i18n/register';

const REASON_KEY: Record<string, string> = {
  expired: 'invites.accept.reasonExpired',
  revoked: 'invites.accept.reasonRevoked',
  exhausted: 'invites.accept.reasonExhausted',
  not_found: 'invites.accept.reasonNotFound',
};

/**
 * Public `/invite/:token` (round 9) — rendered OUTSIDE AuthProvider, same
 * split as /share/:token in App.tsx's AppRoutes: no session required to
 * even LOAD this screen. Still checks GET /api/auth/state itself (a plain
 * query, not the gate) to detect an existing browser session. A signed-in
 * visitor can accept the invite into that account directly; signing out stays
 * available as the secondary path when the link was meant for someone else.
 */
export function AcceptInviteView() {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { setTheme } = useSettings();

  const authState = useQuery({ queryKey: ['auth', 'state'], queryFn: api.getAuthState, retry: false });
  const invite = useQuery({
    queryKey: ['invite', token],
    queryFn: () => api.getInvite(token!),
    enabled: !!token,
    retry: false,
  });

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [selectedTheme, setSelectedTheme] = useState<ThemeMode | null>(null);

  const pinnedEmail = invite.data?.email ?? undefined;
  const effectiveEmail = pinnedEmail ?? email;

  const accept = useMutation({
    mutationFn: () => api.acceptInvite(token!, { name: name.trim(), email: effectiveEmail.trim(), password, username: normalizeUsername(username) }),
    onSuccess: (authData) => {
      queryClient.setQueryData(['auth', 'state'], authData);
      const firstSpace = Object.keys(authData.memberships)[0];
      navigate(firstSpace ? `/s/${firstSpace}` : '/', { replace: true });
    },
  });

  const acceptCurrent = useMutation({
    mutationFn: () => api.acceptInviteAsCurrentUser(token!),
    onSuccess: (authData) => {
      queryClient.setQueryData(['auth', 'state'], authData);
      const invitedSpace = invite.data?.spaces[0]?.space;
      const firstSpace = invitedSpace ?? Object.keys(authData.memberships)[0];
      navigate(firstSpace ? `/s/${firstSpace}` : '/', { replace: true });
    },
  });

  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      queryClient.clear();
      void authState.refetch();
    },
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!accept.isPending) accept.mutate();
  }

  if (authState.isLoading || invite.isLoading) {
    return <CenteredCard>{t('ui.loading')}</CenteredCard>;
  }

  if (invite.isError || !invite.data) {
    return <CenteredCard>{t('invites.accept.loadFailed')}</CenteredCard>;
  }

  if (!invite.data.valid) {
    const key = REASON_KEY[invite.data.reason ?? 'not_found'] ?? REASON_KEY.not_found!;
    return <CenteredCard>{t(key)}</CenteredCard>;
  }

  if (authState.data?.user) {
    return (
      <CenteredCard>
        <p className="mb-4 text-sm text-neutral-600 dark:text-neutral-400">
          {t('invites.accept.alreadyLoggedIn', { name: authState.data.user.name })}
        </p>
        {acceptCurrent.isError && (
          <p role="alert" className="mb-4 text-sm text-red-600 dark:text-red-400">
            {errorText(acceptCurrent.error, 'invites.accept.continueFailed')}
          </p>
        )}
        <div className="flex justify-center gap-2">
          <button
            type="button"
            disabled={acceptCurrent.isPending}
            onClick={() => acceptCurrent.mutate()}
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {acceptCurrent.isPending ? t('invites.accept.continuing') : t('invites.accept.continue')}
          </button>
          <button
            type="button"
            disabled={logout.isPending}
            onClick={() => logout.mutate()}
            className="rounded-md border border-neutral-300 bg-transparent px-4 py-2 text-sm font-medium text-neutral-700 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-200"
          >
            {logout.isPending ? t('invites.accept.signingOut') : t('auth.userMenu.signOut')}
          </button>
        </div>
      </CenteredCard>
    );
  }

  const info = invite.data;
  // 08.09.2026 (owner request): people sometimes paste "@username" here —
  // ignore a leading '@' (any number of them) rather than rejecting it, by
  // validating through the same usernameSchema the server uses (it
  // transforms via normalizeUsername before checking the format), so this
  // never re-implements the format rule on its own.
  const normalizedUsername = normalizeUsername(username);
  const validUsername = usernameSchema.safeParse(username).success;
  const canSubmit = name.trim().length > 0 && effectiveEmail.trim().length > 0 && password.length >= 8 && validUsername && selectedTheme !== null;

  return (
    <CenteredCard wide>
      <h1 className="mb-1 text-xl font-semibold text-neutral-900 dark:text-neutral-100">
        {t('invites.accept.title', { name: info.invitedBy })}
      </h1>
      {info.spaces.length > 0 && (
        <p className="mb-1 text-sm text-neutral-500 dark:text-neutral-400">
          {t('invites.accept.spacesIntro')}{' '}
          {info.spaces.map((s, i) => (
            <span key={s.space}>
              {i > 0 && ', '}
              «{s.name}» ({roleLabel(s.role)})
            </span>
          ))}
        </p>
      )}
      <p className="mb-6 text-sm text-neutral-500 dark:text-neutral-400">{t('invites.accept.subtitle')}</p>

      <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
        <LabeledInput label={t('auth.name')} required autoFocus autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
        <div className="flex flex-col gap-1">
          <LabeledInput
            label={t('settings.username.label')}
            required
            maxLength={40} // a few chars of slack over the server's 32 so a pasted "@@…" prefix isn't cut before normalizing
            placeholder={t('settings.username.placeholder')}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          {username.trim() !== '' && normalizedUsername !== username.trim() && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {t('settings.username.willBeSaved', { username: normalizedUsername })}
            </p>
          )}
        </div>
        <LabeledInput
          label="Email"
          type="email"
          required
          autoComplete="email"
          value={effectiveEmail}
          disabled={!!pinnedEmail}
          title={pinnedEmail ? t('invites.accept.emailPinnedHint') : undefined}
          onChange={(e) => setEmail(e.target.value)}
        />
        <LabeledInput
          label={t('auth.setup.passwordLabel')}
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <div>
          <div className="mb-1 text-sm font-medium text-neutral-700 dark:text-neutral-300">{t('invites.accept.chooseTheme')}</div>
          <div role="group" aria-label={t('invites.accept.chooseTheme')} className="grid grid-cols-3 gap-1 rounded-md bg-neutral-100 p-1 dark:bg-neutral-800">
            {(['light', 'dark', 'system'] as ThemeMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={selectedTheme === mode}
                onClick={() => {
                  setSelectedTheme(mode);
                  setTheme(mode);
                }}
                className={`rounded px-2 py-1.5 text-sm ${selectedTheme === mode ? 'bg-white font-medium text-neutral-900 shadow-sm dark:bg-neutral-600 dark:text-white' : 'text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200'}`}
              >
                {t(`settings.theme.${mode}`)}
              </button>
            ))}
          </div>
        </div>
        {accept.isError && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {errorText(accept.error, 'invites.accept.failed')}
          </p>
        )}
        <button
          type="submit"
          disabled={accept.isPending || !canSubmit}
          className="mt-2 rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          {accept.isPending ? t('invites.accept.accepting') : t('invites.accept.submit')}
        </button>
      </form>
    </CenteredCard>
  );
}

function CenteredCard({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="flex h-full min-h-screen items-center justify-center bg-white p-4 dark:bg-neutral-950">
      <div className={`w-full ${wide ? 'max-w-md' : 'max-w-sm text-center text-sm text-neutral-500 dark:text-neutral-400'}`}>
        {children}
      </div>
    </div>
  );
}
