import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { DemoInfo } from '@shared/contracts';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { LabeledInput } from '../ui/LabeledInput';
import '../i18n/register';

export interface LoginScreenProps {
  /** Called after a successful login so the caller re-fetches auth state and swaps to the app. */
  onDone: () => void;
  /** GET /api/auth/state's `google` flag — whether GOOGLE_CLIENT_ID/SECRET are configured server-side. Only then is the "Continue with Google" button shown at all. */
  google: boolean;
  /** GET /api/auth/state's `demo` — present only on a public-demo instance (FOLIO_DEMO_MODE). The "sign in as…" block renders only when it lists accounts. */
  demo?: DemoInfo;
}

/** Codes server/auth/google.ts's callback appends as `?authError=<code>` on every refusal — see that file's own doc comment for what each means. Anything unrecognized falls back to the generic message. */
const GOOGLE_AUTH_ERROR_KEYS: Record<string, string> = {
  domain: 'auth.login.googleError.domain',
  unverified: 'auth.login.googleError.unverified',
  disabled: 'auth.login.googleError.disabled',
  state: 'auth.login.googleError.generic',
  exchange: 'auth.login.googleError.generic',
};

/** Reads `?authError=` off the current URL once, strips it from the address bar (so a reload/share never re-shows a stale error), and returns the translation key to render — or null. */
function useGoogleAuthError(): string | null {
  const [key, setKey] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('authError');
    if (!code) return;
    setKey(GOOGLE_AUTH_ERROR_KEYS[code] ?? GOOGLE_AUTH_ERROR_KEYS.exchange);
    params.delete('authError');
    const query = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (query ? `?${query}` : '') + window.location.hash);
  }, []);

  return key;
}

/** Google's four-color "G" mark, inline (no brand asset in this repo). */
function GoogleIcon() {
  return (
    <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.4 0 6.4 1.2 8.8 3.5l6.6-6.6C35.3 2.5 30 0 24 0 14.6 0 6.5 5.4 2.5 13.2l7.7 6c1.9-5.6 7.1-9.7 13.8-9.7z" />
      <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.6c-.5 3-2.2 5.5-4.7 7.2l7.4 5.7c4.3-4 6.8-9.9 6.8-17.4z" />
      <path fill="#FBBC05" d="M10.2 19.2a14.5 14.5 0 0 0 0 9.6l-7.7 6a24 24 0 0 1 0-21.6l7.7 6z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.2-8.5 2.2-6.7 0-12-4.1-13.9-9.7l-7.7 6C6.5 42.6 14.6 48 24 48z" />
      <path fill="none" d="M0 0h48v48H0z" />
    </svg>
  );
}

/** Shown whenever GET /api/auth/state reports no user (fresh visit or a session dropped mid-use). Localized from localStorage/browser language (round 10) — there's no session yet to carry a profile preference. */
export function LoginScreen({ onDone, google, demo }: LoginScreenProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const googleErrorKey = useGoogleAuthError();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const login = useMutation({
    mutationFn: (credentials: { email: string; password: string }) => api.login(credentials.email, credentials.password),
    onSuccess: onDone,
  });
  const demoAccounts = demo?.accounts ?? [];

  return (
    <div className="flex h-full overflow-y-auto bg-white p-4 dark:bg-neutral-950">
      {/* m-auto (not items-center on the parent): centers a short screen, yet lets a tall one (demo cards on a phone) scroll from its top. */}
      <div className="m-auto w-full max-w-sm">
        <h1 className="mb-1 text-xl font-semibold text-neutral-900 dark:text-neutral-100">{t('auth.login.title')}</h1>
        <p className="mb-6 text-sm text-neutral-500 dark:text-neutral-400">{t('auth.login.subtitle')}</p>
        {googleErrorKey && (
          <p role="alert" className="mb-4 text-sm text-red-600 dark:text-red-400">
            {t(googleErrorKey)}
          </p>
        )}
        {google && (
          <>
            <a
              href="/api/auth/google/start"
              className="mb-4 flex items-center justify-center gap-2 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
            >
              <GoogleIcon />
              {t('auth.login.google')}
            </a>
            <div className="mb-4 flex items-center gap-3 text-xs text-neutral-400 dark:text-neutral-600">
              <div className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
              {t('auth.login.orDivider')}
              <div className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
            </div>
          </>
        )}
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            login.mutate({ email, password });
          }}
        >
          <LabeledInput
            label="Email"
            type="email"
            required
            autoFocus
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <LabeledInput
            label={t('auth.password')}
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {login.isError && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {/* QA-3 #9: this used to be `error instanceof ApiError ?
                  error.message : t(...)` — the server's own English
                  ("invalid email or password") under a Ukrainian sign-in
                  heading. errorText() localizes what the server said and
                  keeps this key as the fallback. */}
              {errorText(login.error, 'auth.login.failed')}
            </p>
          )}
          <button
            type="submit"
            disabled={login.isPending}
            className="mt-2 rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {login.isPending ? t('auth.login.loggingIn') : t('auth.login.submit')}
          </button>
        </form>
        {demoAccounts.length > 0 && (
          <section aria-labelledby="demo-accounts-heading" className="mt-8 border-t border-neutral-200 pt-6 dark:border-neutral-800">
            <h2 id="demo-accounts-heading" className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
              {t('auth.demo.heading')}
            </h2>
            <p className="mb-3 mt-1 text-xs text-neutral-500 dark:text-neutral-400">{t('auth.demo.hint')}</p>
            <ul className="flex flex-col gap-2">
              {demoAccounts.map((account) => (
                <li key={account.email}>
                  {/* One click fills the form (so a failure is visible next to the fields) and signs in. */}
                  <button
                    type="button"
                    disabled={login.isPending}
                    aria-label={t('auth.demo.signInAs', { name: account.name })}
                    onClick={() => {
                      setEmail(account.email);
                      setPassword(account.password);
                      login.mutate({ email: account.email, password: account.password });
                    }}
                    className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-left hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">{account.name}</span>
                      {account.role && (
                        <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                          {account.role}
                        </span>
                      )}
                    </span>
                    {account.description && (
                      <span className="mt-0.5 block text-xs text-neutral-500 dark:text-neutral-400">{account.description}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
              {demo?.resetHours ? t('auth.demo.note', { count: demo.resetHours }) : t('auth.demo.noteNoInterval')}
            </p>
          </section>
        )}
      </div>
    </div>
  );
}
