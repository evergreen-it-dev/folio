// @vitest-environment jsdom
/**
 * The 403 screen and the 404 screen used to be one view ("404" + a rights
 * hint + Request access). They are now two:
 *  - NotFound: the thing is not there. No hint about rights, no button.
 *  - NoAccess: it exists, the caller may not see it. A request-access button
 *    only when the caller has no role in the space; for a restricted page in
 *    a space they belong to it would only be answered with "you already have
 *    access", so the screen says who to ask instead.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import i18next from 'i18next';
import type { SpaceRole } from '@shared/contracts';
import { api } from '../api';
import { NoAccess } from './NoAccess';
import { NotFound } from './NotFound';
import '../i18n/register';

// NoAccess only asks "what is my role in this space"; AuthProvider's real
// answer needs the whole auth bootstrap.
const role = vi.hoisted(() => ({ current: undefined as SpaceRole | undefined, admin: false }));
vi.mock('../auth/AuthProvider', () => ({
  useSpaceRole: () => role.current,
  useAuthOptional: () => ({ user: { isAdmin: role.admin } }),
}));

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

beforeEach(() => {
  role.current = undefined;
  role.admin = false;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderView(view: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{view}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('NoAccess', () => {
  it('offers to request access when the space exists and the caller has no role in it', () => {
    renderView(<NoAccess space="secret" />);
    expect(screen.getByRole('heading', { name: 'No access' })).toBeTruthy();
    expect(screen.getByText(/You don't have access to the space “secret”/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Request access' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go home' })).toBeTruthy();
    expect(screen.queryByText('404')).toBeNull();
  });

  it('for a restricted page inside a space the caller belongs to, offers a PAGE request (not a space request)', async () => {
    role.current = 'viewer';
    const state = vi.spyOn(api, 'getPageAccessRequestState').mockResolvedValue({ pending: false });
    const create = vi.spyOn(api, 'createAccessRequest').mockResolvedValue({ request: {} } as never);
    renderView(<NoAccess space="docs" page pageId="p1" />);
    expect(screen.getByText(/open only to specific people/)).toBeTruthy();
    const button = await screen.findByRole('button', { name: 'Request access' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(create).toHaveBeenCalledWith('docs', 'p1'));
    await screen.findByText(/the page owner will see it/);
    expect(state).toHaveBeenCalledWith('p1');
    expect(screen.getByRole('link', { name: 'Go home' })).toBeTruthy();
  });

  it('a live page request shows "request sent" instead of the button', async () => {
    role.current = 'viewer';
    vi.spyOn(api, 'getPageAccessRequestState').mockResolvedValue({ pending: true });
    renderView(<NoAccess space="docs" page pageId="p1" />);
    await screen.findByText(/the page owner will see it/);
    expect(screen.queryByRole('button', { name: 'Request access' })).toBeNull();
  });

  it('an instance admin on a restricted page gets "Give myself access", which posts the self-grant', async () => {
    role.admin = true;
    const grant = vi.spyOn(api, 'selfGrantPageAccess').mockResolvedValue({ space: 'docs', pageId: 'p1' });
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    renderView(<NoAccess space="docs" page pageId="p1" />);
    expect(screen.getByText(/As a Folio admin you can give yourself access/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Request access' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Give myself access' }));
    await waitFor(() => expect(grant).toHaveBeenCalledWith('p1'));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('falls back to a plain line, without a button, when there is no space to ask about', () => {
    renderView(<NoAccess page />);
    expect(screen.getByText("You don't have access to this page.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Request access' })).toBeNull();
  });
});

describe('NotFound', () => {
  it('is a plain 404: no rights hint, no request button', () => {
    renderView(<NotFound message="This page wasn't found — it may have been deleted or moved." />);
    expect(screen.getByText('404')).toBeTruthy();
    expect(screen.getByText(/wasn't found/)).toBeTruthy();
    expect(screen.queryByText(/access/i)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('link', { name: 'Go home' })).toBeTruthy();
  });
});
