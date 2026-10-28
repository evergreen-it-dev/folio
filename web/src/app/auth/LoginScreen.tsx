import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { KeyRound } from 'lucide-react';
import type { DemoInfo, SsoDiscoverResult, SsoProviderPublic } from '@shared/contracts';
import { track } from '../../analytics';
import { api, ApiError } from '../api';
import { useApiErrorText } from '../errorText';
import { LabeledInput } from '../ui/LabeledInput';
import '../i18n/register';

export interface LoginScreenProps {
  /** Called after a successful login so the caller re-fetches auth state and swaps to the app. */
  onDone: () => void;
  /** GET /api/auth/state's `google` flag (older servers): shows the Google button when `ssoProviders` is absent. */
  google?: boolean;
  /** GET /api/auth/state's `ssoProviders` — one "Continue with …" button each (server/auth/oidc.ts). */
  ssoProviders?: SsoProviderPublic[];
  /** GET /api/auth/state's `demo` — present only on a public-demo instance (FOLIO_DEMO_MODE). The "sign in as…" block renders only when it lists accounts. */
  demo?: DemoInfo;
}

/** Codes the OIDC callback / SAML ACS append as `?authError=<code>` on every refusal (SsoErrorCode in server/auth/sso.ts). Anything unrecognized falls back to the generic message. */
const SSO_ERROR_KEYS: Record<string, string> = {
  domain: 'auth.login.ssoError.domain',
  unverified: 'auth.login.ssoError.unverified',
  disabled: 'auth.login.ssoError.disabled',
  no_account: 'auth.login.ssoError.noAccount',
  no_email: 'auth.login.ssoError.noEmail',
  link_unverified: 'auth.login.ssoError.linkUnverified',
  link_not_authoritative: 'auth.login.ssoError.linkNotAuthoritative',
  link_domain: 'auth.login.ssoError.linkDomain',
  already_linked: 'auth.login.ssoError.alreadyLinked',
  invite: 'auth.login.ssoError.invite',
  invite_email: 'auth.login.ssoError.inviteEmail',
  denied: 'auth.login.ssoError.denied',
  provider: 'auth.login.ssoError.provider',
  replay: 'auth.login.ssoError.replay',
  state: 'auth.login.ssoError.generic',
  exchange: 'auth.login.ssoError.generic',
};

/**
 * The page the person opened before signing in, as a same-origin relative path (path + query + hash) the server
 * brings them back to after single sign-on — or undefined for the root and /login (the default landing), where there
 * is nothing to return to. The `authError` of a previous failed attempt is dropped so a retry does not carry it.
 */
export function currentReturnTo(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const { pathname, search, hash } = window.location;
  if (!pathname.startsWith('/') || pathname.startsWith('//') || pathname === '/' || pathname === '/login') return undefined;
  const params = new URLSearchParams(search);
  params.delete('authError');
  const query = params.toString();
  return `${pathname}${query ? `?${query}` : ''}${hash}`;
}

/** /api/auth/oidc/<slug>/start or /api/auth/saml/<slug>/start — the server redirects to the provider. SAML takes no login hint. `returnTo` (default: the current page) is where the server lands the person after signing in. */
export function ssoStartUrl(slug: string, loginHint?: string, kind: SsoProviderPublic['kind'] = 'oidc', returnTo: string | undefined = currentReturnTo()): string {
  const params: string[] = [];
  if (kind !== 'saml' && loginHint && loginHint.includes('@')) params.push(`login_hint=${encodeURIComponent(loginHint.trim())}`);
  if (returnTo) params.push(`returnTo=${encodeURIComponent(returnTo)}`);
  return `/api/auth/${kind === 'saml' ? 'saml' : 'oidc'}/${encodeURIComponent(slug)}/start${params.length ? `?${params.join('&')}` : ''}`;
}

const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Reads `?authError=` off the current URL once, strips it from the address bar (so a reload/share never re-shows a stale error), and returns the translation key to render — or null. */
function useSsoAuthError(): string | null {
  const [key, setKey] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('authError');
    if (!code) return;
    setKey(SSO_ERROR_KEYS[code] ?? SSO_ERROR_KEYS.exchange);
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

/** Single sign-on button: Google's mark for the `google` provider, a key for any other. */
function SsoButton({ provider, href, primary }: { provider: SsoProviderPublic; href: string; primary?: boolean }) {
  const { t } = useTranslation('app');
  return (
    <a
      href={href}
      className={
        primary
          ? 'flex items-center justify-center gap-2 rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200'
          : 'flex items-center justify-center gap-2 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800'
      }
    >
      {provider.slug === 'google' ? <GoogleIcon /> : <KeyRound size={16} aria-hidden="true" />}
      {provider.slug === 'google' ? t('auth.login.google') : t('auth.login.continueWith', { name: provider.name })}
    </a>
  );
}

/**
 * Shown whenever GET /api/auth/state reports no user (fresh visit or a session dropped mid-use). Localized from
 * localStorage/browser language (round 10) — there's no session yet to carry a profile preference.
 *
 * Email first (docs/AUTH.md): once the typed email's domain belongs to a single sign-on provider
 * (POST /api/auth/sso/discover), that provider's button leads; where the provider ENFORCES single sign-on the
 * password field disappears. `/login?local` keeps it for an instance admin's audited break-glass sign-in.
 */
export function LoginScreen({ onDone, google, ssoProviders, demo }: LoginScreenProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const ssoErrorKey = useSsoAuthError();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [discovered, setDiscovered] = useState<(SsoDiscoverResult & { email: string }) | null>(null);
  const local = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('local');
  const providers: SsoProviderPublic[] = ssoProviders ?? (google ? [{ slug: 'google', name: 'Google' }] : []);
  const hasProviders = providers.length > 0;

  // Debounced: the domain only, once the email looks complete; never when no provider is configured.
  useEffect(() => {
    const value = email.trim();
    if (!hasProviders || !EMAIL_LIKE.test(value)) {
      setDiscovered(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .ssoDiscover(value)
        .then((result) => {
          if (!cancelled && result && typeof result === 'object') setDiscovered({ provider: result.provider ?? null, enforced: Boolean(result.enforced), email: value });
        })
        .catch(() => {});
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [email, hasProviders]);

  const routed = discovered && discovered.email === email.trim() ? discovered : null;
  const enforced = Boolean(routed?.enforced && routed.provider) && !local;

  // Once the typed email's provider is enforced, its inline button below leads; the top list drops it so the same button never shows twice.
  const topProviders = enforced && routed?.provider ? providers.filter((p) => p.slug !== routed.provider!.slug) : providers;

  const login = useMutation({
    mutationFn: (credentials: { email: string; password: string }) => api.login(credentials.email, credentials.password, local),
    onSuccess: (_data, credentials) => {
      // Only a sign-in as one of the public demo accounts is reported, and only the account's short name.
      const account = (demo?.accounts ?? []).find((a) => a.email.toLowerCase() === credentials.email.trim().toLowerCase());
      if (account) track('demo_login', { account: account.email.split('@')[0] ?? 'demo' });
      onDone();
    },
  });
  const demoAccounts = demo?.accounts ?? [];

  return (
    <div className="flex h-full overflow-y-auto bg-white p-4 dark:bg-neutral-950">
      {/* m-auto (not items-center on the parent): centers a short screen, yet lets a tall one (demo cards on a phone) scroll from its top. */}
      <div className="m-auto w-full max-w-sm">
        <h1 className="mb-1 text-xl font-semibold text-neutral-900 dark:text-neutral-100">{t('auth.login.title')}</h1>
        <p className="mb-6 text-sm text-neutral-500 dark:text-neutral-400">{t('auth.login.subtitle')}</p>
        {ssoErrorKey && (
          <p role="alert" className="mb-4 text-sm text-red-600 dark:text-red-400">
            {t(ssoErrorKey)}
          </p>
        )}
        {local && (
          <p className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            {t('auth.login.breakGlass')}
          </p>
        )}
        {topProviders.length > 0 && !local && (
          <>
            <div className="mb-4 flex flex-col gap-2">
              {topProviders.map((p) => (
                <SsoButton key={p.slug} provider={p} href={ssoStartUrl(p.slug, routed?.provider?.slug === p.slug ? email : undefined, p.kind)} />
              ))}
            </div>
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
            if (enforced && routed?.provider) {
              window.location.assign(ssoStartUrl(routed.provider.slug, email, routed.provider.kind));
              return;
            }
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
          {enforced && routed?.provider ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-neutral-600 dark:text-neutral-400">{t('auth.login.ssoEnforced', { name: routed.provider.name })}</p>
              <SsoButton provider={routed.provider} href={ssoStartUrl(routed.provider.slug, email, routed.provider.kind)} primary />
            </div>
          ) : (
            <>
              {routed?.provider && !local && (
                <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('auth.login.ssoAvailable', { name: routed.provider.name })}</p>
              )}
              <LabeledInput
                label={t('auth.password')}
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </>
          )}
          {login.isError && !enforced && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {/* QA-3 #9: this used to be `error instanceof ApiError ?
                  error.message : t(...)` — the server's own English
                  ("invalid email or password") under a Ukrainian sign-in
                  heading. errorText() localizes what the server said and
                  keeps this key as the fallback. */}
              {errorText(login.error, 'auth.login.failed')}
            </p>
          )}
          {login.isError && login.error instanceof ApiError && (login.error.body as { code?: string } | undefined)?.code === 'sso_required' && routed?.provider && (
            <SsoButton provider={routed.provider} href={ssoStartUrl(routed.provider.slug, email, routed.provider.kind)} primary />
          )}
          {!enforced && (
            <button
              type="submit"
              disabled={login.isPending}
              className="mt-2 rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
            >
              {login.isPending ? t('auth.login.loggingIn') : t('auth.login.submit')}
            </button>
          )}
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
