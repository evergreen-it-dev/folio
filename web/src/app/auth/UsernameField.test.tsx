// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import { ToastProvider } from '../ui/Toast';
// Round 28: the field moved out of the user menu into the personal-settings
// dialog (SettingsDialog.tsx) unchanged — only this import path did. Every
// assertion below is the pre-move one, deliberately: it's what guards the
// 409/Escape/normalize behavior against the move.
import { UsernameField } from './SettingsDialog';

// The whole app is Russian-language today (see pipeline.test.ts's own note)
// — pin the test's i18next instance so string assertions check real copy.
beforeEach(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderField(username: string | null | undefined, queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <UsernameField username={username} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { ...utils, queryClient };
}

function stubUpdatePreferences(response: { ok: boolean; status?: number; body?: unknown }) {
  const fn = vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    json: () => Promise.resolve(response.body ?? {}),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('UsernameField', () => {
  it('shows the current handle without the leading @', () => {
    renderField('ann');
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('ann');
  });

  it('shows an empty field when no handle is set', () => {
    renderField(null);
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('');
  });

  it('saves the trimmed, lower-cased value on blur and invalidates auth/state', async () => {
    const fetchMock = stubUpdatePreferences({ ok: true, body: { id: 'u1', username: 'annlee' } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    renderField('ann', queryClient);

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '  AnnLee  ' } });
    fireEvent.blur(input);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/me/preferences',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ username: 'annlee' }) }),
    );
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['auth', 'state'] }));
  });

  it('sends null (unset) when the field is cleared', async () => {
    const fetchMock = stubUpdatePreferences({ ok: true, body: { id: 'u1', username: null } });
    renderField('ann');

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith('/api/me/preferences', expect.objectContaining({ body: JSON.stringify({ username: null }) }));
  });

  it('does nothing on blur when the value did not actually change', async () => {
    const fetchMock = stubUpdatePreferences({ ok: true, body: {} });
    renderField('ann');
    const input = screen.getByRole('textbox');
    fireEvent.blur(input); // no change() first
    fireEvent.change(input, { target: { value: 'ANN' } }); // normalizes to the same saved value
    fireEvent.blur(input);
    // Give any accidental async call a chance to fire before asserting it didn't.
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('commits on Enter (blurs the field)', async () => {
    const fetchMock = stubUpdatePreferences({ ok: true, body: {} });
    renderField('ann');
    const input = screen.getByRole('textbox') as HTMLInputElement;
    input.focus(); // the component's Enter handler calls the real .blur() DOM method, a no-op unless actually focused
    fireEvent.change(input, { target: { value: 'bob' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it('Round 19 QA fix (F3): Escape reverts the draft to the saved value instead of committing it, and blurs', async () => {
    const fetchMock = stubUpdatePreferences({ ok: true, body: {} });
    renderField('ann');
    const input = screen.getByRole('textbox') as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: 'bob' } });
    expect(input.value).toBe('bob');

    fireEvent.keyDown(input, { key: 'Escape' });

    expect(input.value).toBe('ann'); // reverted synchronously, not just on the eventual blur/commit
    expect(document.activeElement).not.toBe(input); // the handler also blurs, same as Enter

    // The blur Escape triggers still runs through the one commit() path, but
    // the reverted value now equals `saved` — commit()'s own early return
    // (unchanged -> nothing to save) means this must NOT PATCH anything.
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Round 19 QA fix (F3): pressing Escape with the field already at the saved value is a no-op, not a save', async () => {
    const fetchMock = stubUpdatePreferences({ ok: true, body: {} });
    renderField('ann');
    const input = screen.getByRole('textbox') as HTMLInputElement;
    input.focus();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('ann');
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows a localized "taken" toast on 409 and reverts the field', async () => {
    stubUpdatePreferences({ ok: false, status: 409, body: { error: 'this username is already taken' } });
    renderField('ann');
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'bob' } });
    fireEvent.blur(input);

    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('That username is already taken'));
    await waitFor(() => expect((input as HTMLInputElement).value).toBe('ann'));
  });

  it('shows a generic error toast on any other failure', async () => {
    stubUpdatePreferences({ ok: false, status: 500 });
    renderField('ann');
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'bob' } });
    fireEvent.blur(input);

    await waitFor(() => expect(screen.getByRole('status').textContent).toBe("Couldn't save the username"));
  });
});
