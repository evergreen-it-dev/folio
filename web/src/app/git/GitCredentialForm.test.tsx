// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import { ToastProvider } from '../ui/Toast';
import { GitCredentialForm } from './GitCredentialForm';

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

function renderForm(onSaved = vi.fn(), onCancel?: () => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <GitCredentialForm onSaved={onSaved} onCancel={onCancel} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { onSaved };
}

describe('GitCredentialForm', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('disables "Connect" until both host and token are filled in', () => {
    renderForm();
    const submit = screen.getByRole('button', { name: 'Connect' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'github.com' } });
    expect((submit as HTMLButtonElement).disabled).toBe(true); // token still empty

    fireEvent.change(screen.getByLabelText('Access token (PAT)'), { target: { value: 'ghp_abc123' } });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
  });

  it('POSTs the trimmed host/provider/token/label and calls onSaved with the response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: () =>
        Promise.resolve({ id: 'cred1', host: 'gitlab.com', provider: 'gitlab', label: 'Work', createdAt: '2026-01-01T00:00:00Z' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { onSaved } = renderForm();
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'gitlab' } });
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: '  gitlab.com  ' } });
    fireEvent.change(screen.getByLabelText('Access token (PAT)'), { target: { value: ' glpat-xyz ' } });
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: ' Work ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 'cred1', host: 'gitlab.com' })));

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/me/git-credentials',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ host: 'gitlab.com', provider: 'gitlab', token: 'glpat-xyz', label: 'Work' }),
      }),
    );
  });

  it('calls onCancel when Cancel is clicked', () => {
    const onCancel = vi.fn();
    renderForm(vi.fn(), onCancel);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('shows an error message on a failed save instead of crashing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 400, json: () => Promise.resolve({ error: 'Invalid host' }) }),
    );
    renderForm();
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'github.com' } });
    fireEvent.change(screen.getByLabelText('Access token (PAT)'), { target: { value: 'ghp_abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    // QA-3 #9: the server's own reason still reaches the user, now inside a
    // localized frame (errorText.ts -> errors.status.badRequest) instead of
    // being pasted raw into a localized UI.
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Invalid host'));
  });
});
