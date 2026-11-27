// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import { LoginScreen } from './LoginScreen';
import { SetupScreen } from './SetupScreen';
import { LANG_STORAGE_KEY } from '../../i18n';

beforeEach(async () => {
  localStorage.clear();
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function withClient(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

describe('language switcher on signed-out screens', () => {
  it('switches the login page language, remembers it, and sends no profile PATCH', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    withClient(<LoginScreen onDone={() => {}} google={false} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Log in to Folio');

    fireEvent.click(screen.getByRole('button', { name: '\u0423\u043a\u0440\u0430\u0457\u043d\u0441\u044c\u043a\u0430' }));
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('\u0412\u0445\u0456\u0434 \u0443 Folio'));
    expect(localStorage.getItem(LANG_STORAGE_KEY)).toBe('uk');
    expect(screen.getByRole('button', { name: '\u0423\u043a\u0440\u0430\u0457\u043d\u0441\u044c\u043a\u0430' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Log in to Folio'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is also on the first-run setup screen', () => {
    withClient(<SetupScreen onDone={() => {}} />);
    expect(screen.getByRole('button', { name: '\u0423\u043a\u0440\u0430\u0457\u043d\u0441\u044c\u043a\u0430' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'English' })).toBeTruthy();
  });
});
