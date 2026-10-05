// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import type { AuthState, DemoInfo } from '@shared/contracts';
import { LoginScreen } from './LoginScreen';
import { DemoBanner } from '../DemoBanner';

beforeEach(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const DEMO: DemoInfo = {
  resetHours: 6,
  accounts: [
    { email: 'editor@demo.example', password: 'demo-pass-1', name: 'Dana Editor', role: 'Editor', description: 'Editor in Engineering and Product' },
    { email: 'viewer@demo.example', password: 'demo-pass-2', name: 'Vik Viewer', role: 'Viewer', description: 'Read-only access' },
  ],
};

function stubLogin() {
  const fn = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function renderLogin(props: { demo?: DemoInfo; onDone?: () => void }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LoginScreen onDone={props.onDone ?? (() => {})} google={false} demo={props.demo} />
    </QueryClientProvider>,
  );
}

describe('LoginScreen: public-demo block', () => {
  it('renders no demo block on an ordinary instance (no `demo`)', () => {
    renderLogin({});
    expect(screen.queryByText(/Public demo/)).toBeNull();
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('renders no block when demo mode lists no accounts', () => {
    renderLogin({ demo: { accounts: [], resetHours: 6 } });
    expect(screen.queryByText(/Public demo/)).toBeNull();
  });

  it('lists the accounts with role, description and the reset note', () => {
    renderLogin({ demo: DEMO });
    expect(screen.getByText('Public demo — sign in as…')).toBeTruthy();
    expect(screen.getByText('Dana Editor')).toBeTruthy();
    expect(screen.getByText('Editor in Engineering and Product')).toBeTruthy();
    expect(screen.getByText('Vik Viewer')).toBeTruthy();
    expect(screen.getByText("Data resets every 6 hours; don't store anything private.")).toBeTruthy();
  });

  it('drops the number when the reset interval is unknown', () => {
    renderLogin({ demo: { ...DEMO, resetHours: null } });
    expect(screen.getByText("Data is reset regularly; don't store anything private.")).toBeTruthy();
  });

  it('a click fills the email and password and signs in with that account', async () => {
    const fetchFn = stubLogin();
    const onDone = vi.fn();
    renderLogin({ demo: DEMO, onDone });

    fireEvent.click(screen.getByRole('button', { name: 'Sign in as Dana Editor' }));

    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('editor@demo.example');
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('demo-pass-1');
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const [url, init] = fetchFn.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('/api/auth/login');
    expect(JSON.parse(init.body)).toEqual({ email: 'editor@demo.example', password: 'demo-pass-1' });
  });
});

describe('DemoBanner', () => {
  function renderBanner(state: Partial<AuthState> | undefined) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    if (state) client.setQueryData(['auth', 'state'], { needsSetup: false, user: null, memberships: {}, google: false, ...state });
    return render(
      <QueryClientProvider client={client}>
        <DemoBanner />
      </QueryClientProvider>,
    );
  }

  it('shows nothing outside demo mode', () => {
    const fetchFn = stubLogin();
    renderBanner({});
    expect(screen.queryByRole('status')).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled(); // reads the cache only
  });

  it('shows the strip with the reset interval in demo mode', () => {
    renderBanner({ demo: { accounts: [], resetHours: 1 } });
    expect(screen.getByRole('status').textContent).toBe("Public demo · shared login · data resets every hour · don't enter personal data or API keys");
  });

  it('shows the strip without a number when the interval is unknown', () => {
    renderBanner({ demo: { accounts: [], resetHours: null } });
    expect(screen.getByRole('status').textContent).toBe("Public demo · shared login · data is reset regularly · don't enter personal data or API keys");
  });
});
