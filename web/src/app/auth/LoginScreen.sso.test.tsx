// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import type { SsoDiscoverResult, SsoProviderPublic } from '@shared/contracts';
import { LoginScreen, currentReturnTo, ssoStartUrl } from './LoginScreen';

beforeEach(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

const PROVIDERS: SsoProviderPublic[] = [
  { slug: 'google', name: 'Google' },
  { slug: 'corp', name: 'Corp SSO' },
];

/** /api/auth/sso/discover answers `discover`; /api/auth/login records its body. */
function stubFetch(discover: SsoDiscoverResult) {
  const fn = vi.fn((url: string) => {
    const body = url === '/api/auth/sso/discover' ? discover : {};
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function renderLogin() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LoginScreen onDone={() => {}} ssoProviders={PROVIDERS} />
    </QueryClientProvider>,
  );
}

describe('LoginScreen: single sign-on', () => {
  it('shows one button per provider, Google with its own label', () => {
    stubFetch({ provider: null, enforced: false });
    renderLogin();
    expect(screen.getByRole('link', { name: 'Continue with Google' }).getAttribute('href')).toBe('/api/auth/oidc/google/start');
    expect(screen.getByRole('link', { name: 'Continue with Corp SSO' }).getAttribute('href')).toBe('/api/auth/oidc/corp/start');
  });

  it('email first: an enforced domain hides the password and leads to its provider with a login hint', async () => {
    const fetchFn = stubFetch({ provider: { slug: 'corp', name: 'Corp SSO' }, enforced: true });
    renderLogin();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ann@corp.test' } });
    await waitFor(() => expect(screen.queryByLabelText('Password')).toBeNull(), { timeout: 2000 });
    expect(screen.getByText('Your organization signs in with Corp SSO.')).toBeTruthy();
    const links = screen.getAllByRole('link', { name: 'Continue with Corp SSO' });
    expect(links).toHaveLength(1); // the enforced provider's button shows once, not also in the top list
    expect(links[0].getAttribute('href')).toBe(ssoStartUrl('corp', 'ann@corp.test'));
    expect(screen.getAllByRole('link', { name: 'Continue with Google' })).toHaveLength(1); // other providers stay
    expect(fetchFn.mock.calls.some(([url]) => url === '/api/auth/login')).toBe(false);
  });

  it('a SAML provider: its button and the email routing lead to /api/auth/saml/<slug>/start (no login hint)', async () => {
    stubFetch({ provider: { slug: 'okta', name: 'Okta', kind: 'saml' }, enforced: true });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <LoginScreen onDone={() => {}} ssoProviders={[...PROVIDERS, { slug: 'okta', name: 'Okta', kind: 'saml' }]} />
      </QueryClientProvider>,
    );
    expect(screen.getByRole('link', { name: 'Continue with Okta' }).getAttribute('href')).toBe('/api/auth/saml/okta/start');
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ann@okta.test' } });
    await waitFor(() => expect(screen.queryByLabelText('Password')).toBeNull(), { timeout: 2000 });
    const links = screen.getAllByRole('link', { name: 'Continue with Okta' });
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('/api/auth/saml/okta/start');
    expect(ssoStartUrl('okta', 'ann@okta.test', 'saml')).toBe('/api/auth/saml/okta/start');
  });

  it('/login?local keeps the password form for the break-glass sign-in and sends local: true', async () => {
    window.history.replaceState({}, '', '/login?local');
    const fetchFn = stubFetch({ provider: { slug: 'corp', name: 'Corp SSO' }, enforced: true });
    renderLogin();
    expect(screen.getByText(/Emergency administrator sign-in/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Continue with Corp SSO' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'boss@corp.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expect(fetchFn.mock.calls.some(([url]) => url === '/api/auth/login')).toBe(true));
    const call = fetchFn.mock.calls.find(([url]) => url === '/api/auth/login') as unknown as [string, { body: string }];
    expect(JSON.parse(call[1].body)).toEqual({ email: 'boss@corp.test', password: 'pw', local: true });
  });

  it('shows the translated reason from ?authError=', () => {
    window.history.replaceState({}, '', '/?authError=no_account');
    stubFetch({ provider: null, enforced: false });
    renderLogin();
    expect(screen.getByRole('alert').textContent).toMatch(/Ask an administrator to invite you/);
  });
});

describe('LoginScreen: single sign-on returns to the page the person opened', () => {
  const DEEP = '/s/sk-space/p/artifact-34ac74359430e23bd9abd100';

  it('currentReturnTo is the path, query and hash; nothing for the root or /login', () => {
    window.history.replaceState({}, '', `${DEEP}?tab=history#sec`);
    expect(currentReturnTo()).toBe(`${DEEP}?tab=history#sec`);
    window.history.replaceState({}, '', '/login?local');
    expect(currentReturnTo()).toBeUndefined();
    window.history.replaceState({}, '', '/?authError=exchange');
    expect(currentReturnTo()).toBeUndefined();
  });

  it('drops a stale authError from the returnTo', () => {
    window.history.replaceState({}, '', `${DEEP}?authError=denied&tab=history`);
    expect(currentReturnTo()).toBe(`${DEEP}?tab=history`);
  });

  it('every start URL (OIDC, SAML, with a login hint) carries returnTo', () => {
    window.history.replaceState({}, '', `${DEEP}?tab=history`);
    const returnTo = `returnTo=${encodeURIComponent(`${DEEP}?tab=history`)}`;
    expect(ssoStartUrl('google')).toBe(`/api/auth/oidc/google/start?${returnTo}`);
    expect(ssoStartUrl('corp', 'ann@corp.test')).toBe(`/api/auth/oidc/corp/start?login_hint=ann%40corp.test&${returnTo}`);
    expect(ssoStartUrl('okta', undefined, 'saml')).toBe(`/api/auth/saml/okta/start?${returnTo}`);
    expect(ssoStartUrl('okta', 'ann@corp.test', 'saml')).toBe(`/api/auth/saml/okta/start?${returnTo}`);
  });

  it('the rendered buttons link with returnTo', () => {
    stubFetch({ provider: null, enforced: false });
    window.history.replaceState({}, '', DEEP);
    renderLogin();
    expect(screen.getByRole('link', { name: 'Continue with Google' }).getAttribute('href')).toBe(`/api/auth/oidc/google/start?returnTo=${encodeURIComponent(DEEP)}`);
  });
});
