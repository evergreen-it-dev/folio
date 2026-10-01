// @vitest-environment jsdom
/**
 * Owner ask #2 ("git cannot be connected to a local space") — pins the
 * dialog's client-side gate: submit only ever enables once the
 * POST /api/git/branches probe has POSITIVELY confirmed the target
 * repository is empty (`empty: true`), and a non-empty result shows the
 * "two histories" warning instead. This mirrors — as a UX head start, not
 * the actual guard — server/storage.ts's connectSpaceToRepo, which
 * re-checks and refuses (409) regardless; see server/gitNative.test.ts and
 * server/connectGit.test.ts for that server-side behavior.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import i18next from 'i18next';
import { ToastProvider } from '../ui/Toast';
import { ConnectGitDialog } from './ConnectGitDialog';

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

function stubApi(branchesResponse: unknown) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/me/git-credentials')) return jsonResponse({ credentials: [] });
    if (url.startsWith('/api/git/branches')) return jsonResponse(branchesResponse);
    if (url.startsWith('/api/spaces/demo-space/connect-git')) {
      return jsonResponse({ slug: 'demo-space', name: 'Demo', pageCount: 1, git: { repoUrl: 'https://example.test/org/repo', branch: 'main', rootPath: '', status: 'clean', ahead: 0, behind: 0, lastSyncAt: null, lastError: null } });
    }
    return jsonResponse({ error: 'not found' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter>
          <ConnectGitDialog space="demo-space" onClose={vi.fn()} />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function repoUrlInput(): HTMLInputElement {
  return screen.getByLabelText('Repository') as HTMLInputElement;
}

function submitButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement;
}

describe('ConnectGitDialog — empty-remote-only gate', () => {
  it('submit stays disabled while the repository URL is empty', () => {
    stubApi({ branches: [], defaultBranch: null, empty: true });
    renderDialog();
    expect(submitButton().disabled).toBe(true);
  });

  it('enables submit once the branches probe confirms the remote is empty', async () => {
    stubApi({ branches: [], defaultBranch: null, empty: true });
    renderDialog();

    fireEvent.change(repoUrlInput(), { target: { value: 'https://example.test/org/empty-repo.git' } });

    await waitFor(() => expect(submitButton().disabled).toBe(false), { timeout: 3000 });
    expect(screen.queryByText(/isn't empty/)).toBeNull();
  });

  it('keeps submit disabled and shows the "two histories" warning for a non-empty remote', async () => {
    stubApi({ branches: ['main', 'develop'], defaultBranch: 'main', empty: false });
    renderDialog();

    fireEvent.change(repoUrlInput(), { target: { value: 'https://example.test/org/nonempty-repo.git' } });

    await waitFor(() => expect(screen.getByText(/isn't empty/)).toBeTruthy(), { timeout: 3000 });
    expect(submitButton().disabled).toBe(true);
  });

  it('submits repoUrl/branch/token to POST /connect-git once enabled', async () => {
    const fetchMock = stubApi({ branches: [], defaultBranch: null, empty: true });
    renderDialog();

    fireEvent.change(repoUrlInput(), { target: { value: 'https://example.test/org/empty-repo.git' } });
    await waitFor(() => expect(submitButton().disabled).toBe(false), { timeout: 3000 });

    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith('/api/spaces/demo-space/connect-git'))).toBe(true),
    );
    const call = fetchMock.mock.calls.find(([input]) => String(input).startsWith('/api/spaces/demo-space/connect-git'))!;
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body).toEqual({ repoUrl: 'https://example.test/org/empty-repo.git', branch: 'main' });
  });
});

/**
 * QA-3 P2 #5: the gate above keys on a POSITIVE `empty: true`, so any probe
 * that simply fails to answer (network blip, a provider that won't serve an
 * anonymous ls-remote, a token not pasted yet) used to leave the submit
 * button disabled forever — explained only by a small grey line under the
 * branch field. "Unknown" is not "not empty": it now says why and lets the
 * server, which re-checks and answers 409, be the one that decides.
 */
describe('ConnectGitDialog — an unanswerable probe must not be a dead end', () => {
  function stubFailingProbe() {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/me/git-credentials')) return jsonResponse({ credentials: [] });
      if (url.startsWith('/api/git/branches')) return jsonResponse({ error: 'invalid repository URL' }, 400);
      if (url.startsWith('/api/spaces/demo-space/connect-git')) return jsonResponse({ error: 'remote is not empty' }, 409);
      return jsonResponse({ error: 'not found' }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('explains the failed probe instead of silently disabling the form', async () => {
    stubFailingProbe();
    renderDialog();
    fireEvent.change(repoUrlInput(), { target: { value: 'https://example.test/org/unreachable.git' } });

    await waitFor(() => expect(screen.getByText(/Could not check whether this repository is empty/)).toBeTruthy(), { timeout: 3000 });
    // …and the reason is localized, not the raw English the server sent — and
    // it is its own element, so it reads as "reason, then what to do".
    expect(screen.getByText('Invalid repository URL.')).toBeTruthy();
  });

  it('enables submit so the server can give an honest answer', async () => {
    stubFailingProbe();
    renderDialog();
    fireEvent.change(repoUrlInput(), { target: { value: 'https://example.test/org/unreachable.git' } });

    await waitFor(() => expect(submitButton().disabled).toBe(false), { timeout: 3000 });
  });

  it('surfaces the server refusal when it comes, localized', async () => {
    const fetchMock = stubFailingProbe();
    renderDialog();
    fireEvent.change(repoUrlInput(), { target: { value: 'https://example.test/org/unreachable.git' } });
    await waitFor(() => expect(submitButton().disabled).toBe(false), { timeout: 3000 });

    fireEvent.click(submitButton());
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith('/api/spaces/demo-space/connect-git'))).toBe(true),
    );
    await waitFor(() => expect(screen.getByText(/conflicts with the current state|remote is not empty/i)).toBeTruthy());
  });

  it('still refuses when the probe positively reports a non-empty remote', async () => {
    stubApi({ branches: ['main'], defaultBranch: 'main', empty: false });
    renderDialog();
    fireEvent.change(repoUrlInput(), { target: { value: 'https://example.test/org/nonempty-repo.git' } });

    await waitFor(() => expect(screen.getByText(/isn't empty/)).toBeTruthy(), { timeout: 3000 });
    expect(submitButton().disabled).toBe(true);
  });
});
