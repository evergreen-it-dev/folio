// @vitest-environment jsdom
/**
 * Round 27 §6.4 / §11.4 acceptance criterion: "The 'Add a person' dialog
 * creates a user and three accesses with one save". Covers the password-set
 * path's atomic POST /api/users call with memberships[], and that the
 * invite path posts to /api/invites instead with the same memberships shape.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import type { AccessMatrixResponse } from '@shared/contracts';
import { ToastProvider } from '../../ui/Toast';
import { AddPersonDialog } from './AddPersonDialog';

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const MATRIX: AccessMatrixResponse = {
  users: [{ id: 'u-1', name: 'Maria', email: 'maria@t.local', isAdmin: false, disabled: false }],
  spaces: [
    { slug: 'eng', name: 'Engineering', visibility: 'private' },
    { slug: 'sales', name: 'Sales', visibility: 'private' },
  ],
  roles: { 'u-1': { eng: 'editor', sales: 'viewer' } },
};

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

function stubApi() {
  const calls: { url: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (init?.body) calls.push({ url, body: JSON.parse(init.body as string) });
    if (url === '/api/access/matrix') return jsonResponse(MATRIX);
    if (url === '/api/users' && init?.method === 'POST') return jsonResponse({ id: 'new-1', name: 'New Person', email: 'new@t.local', isAdmin: false, createdAt: '' }, 201);
    if (url === '/api/invites' && init?.method === 'POST') {
      return jsonResponse({
        id: 'inv-1',
        url: 'https://folio.example/invite/abc',
        memberships: [],
        isAdmin: false,
        email: null,
        expiresAt: new Date().toISOString(),
        maxUses: 1,
        uses: 0,
        createdBy: 'admin-1',
        createdAt: new Date().toISOString(),
        revokedAt: null,
      });
    }
    return jsonResponse({ error: 'not found' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  return { fetchMock, calls };
}

function renderDialog(onClose = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AddPersonDialog onClose={onClose} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { onClose };
}

describe('AddPersonDialog', () => {
  it('password path: one atomic POST /api/users carrying name/email/password/isAdmin/memberships', async () => {
    const { calls } = stubApi();
    const { onClose } = renderDialog();

    await screen.findByText('Copy access from'); // matrix loaded -> copy-from block rendered

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New Person' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new@t.local' } });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: 'password123' } });

    fireEvent.click(screen.getByText('Add a space'));
    fireEvent.change(screen.getByLabelText('Space'), { target: { value: 'eng' } });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'admin' } });

    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(onClose).toHaveBeenCalled());

    const createCall = calls.find((c) => c.url === '/api/users');
    expect(createCall).toBeTruthy();
    expect(createCall!.body).toMatchObject({
      name: 'New Person',
      email: 'new@t.local',
      password: 'password123',
      isAdmin: false,
      memberships: [{ space: 'eng', role: 'admin' }],
    });
  });

  it('invite path: posts to /api/invites instead, with the same memberships shape, and shows the reveal box', async () => {
    const { calls } = stubApi();
    renderDialog();

    await screen.findByText('Copy access from');

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Invitee' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'invitee@t.local' } });
    fireEvent.click(screen.getByLabelText('Create an invite link'));

    fireEvent.click(screen.getByText('Add a space'));
    fireEvent.change(screen.getByLabelText('Space'), { target: { value: 'sales' } });

    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(screen.getByText('The link was created and already copied to the clipboard.')).toBeTruthy());

    const inviteCall = calls.find((c) => c.url === '/api/invites');
    expect(inviteCall).toBeTruthy();
    expect((inviteCall!.body as { memberships: unknown[] }).memberships).toEqual([{ space: 'sales', role: 'viewer' }]);
    expect(calls.some((c) => c.url === '/api/users')).toBe(false);
  });
});
