// @vitest-environment jsdom
/**
 * Round 22b: saved-credential auto-match in the Confluence import dialog —
 * a typed page URL's host is compared against GET /api/me/confluence-
 * credentials (confluenceHost.test.ts covers the pure host-extraction logic
 * in isolation; this covers the wiring: collapse-by-default, "Enter
 * another" back to manual entry, and the two request-body shapes
 * (credentialId vs auth+save) POSTed to /api/import/confluence).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import i18next from 'i18next';
import { ConfluenceImportDialog } from './ConfluenceImportDialog';

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

/**
 * `extra.spaces` backs the "existing space" select/preselect test; `extra.tree`
 * backs GET /api/spaces/:space/tree for the parent-page picker test (checked
 * BEFORE the generic /api/spaces prefix below, since that GET URL also starts
 * with /api/spaces); `extra.job` overrides the canned "done" GET /api/import/
 * jobs/:id response for the error-rendering test.
 */
function stubApi(credentials: unknown[] = [], credentialsStatus = 200, extra: { spaces?: unknown[]; tree?: unknown; job?: unknown } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    if (/^\/api\/spaces\/[^/]+\/tree$/.test(url) && method === 'GET') return jsonResponse(extra.tree ?? { tree: [] });
    if (url.startsWith('/api/spaces') && method === 'GET') return jsonResponse({ spaces: extra.spaces ?? [] });
    if (url === '/api/me/confluence-credentials' && method === 'GET') {
      return credentialsStatus === 200 ? jsonResponse({ credentials }) : jsonResponse({ error: 'not found' }, credentialsStatus);
    }
    if (url === '/api/import/confluence' && method === 'POST') {
      return jsonResponse({ id: 'job1', status: 'done', total: 1, done: 1, currentTitle: null, error: null, targetSpace: 'test' });
    }
    if (url.startsWith('/api/import/jobs/') && method === 'GET') {
      return jsonResponse(extra.job ?? { id: 'job1', status: 'done', total: 1, done: 1, currentTitle: null, error: null, targetSpace: 'test' });
    }
    return jsonResponse({ error: 'not found' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderDialog(currentSpace?: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ConfluenceImportDialog currentSpace={currentSpace} onClose={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function postBody(fetchMock: ReturnType<typeof stubApi>): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(([input, init]) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    return url === '/api/import/confluence' && (init as RequestInit | undefined)?.method === 'POST';
  });
  if (!call) throw new Error('POST /api/import/confluence was never called');
  return JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>;
}

describe('ConfluenceImportDialog — saved credentials (round 22b)', () => {
  it('shows manual auth fields with "save for next time" checked by default when nothing matches the typed host', async () => {
    stubApi([]);
    renderDialog();

    fireEvent.change(screen.getByLabelText('Confluence page URL'), {
      target: { value: 'https://tracker.example.com/wiki/pages/123' },
    });

    await waitFor(() => expect(screen.getByLabelText('Personal Access Token')).toBeTruthy());
    expect(screen.queryByText(/Use the saved token/)).toBeNull();
    const saveCheckbox = screen.getByLabelText('Save for future imports') as HTMLInputElement;
    expect(saveCheckbox.checked).toBe(true);
  });

  it('auto-matches a saved credential by host and collapses auth into a summary line (ignores a credential saved for a different host)', async () => {
    stubApi([
      { id: 'cred-other', host: 'other.example.com', kind: 'pat', label: 'Another host', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'cred1', host: 'tracker.example.com', kind: 'pat', label: 'Work', createdAt: '2026-01-02T00:00:00Z' },
    ]);
    renderDialog();

    fireEvent.change(screen.getByLabelText('Confluence page URL'), {
      target: { value: 'https://tracker.example.com/wiki/pages/123' },
    });

    await screen.findByText('Use the saved token (Work)');
    expect(screen.queryByText(/Another host/)).toBeNull();
    expect(screen.queryByLabelText('Personal Access Token')).toBeNull();
  });

  it('"Enter another" switches back to manual entry even though a saved credential matches', async () => {
    stubApi([{ id: 'cred1', host: 'tracker.example.com', kind: 'pat', label: 'Work', createdAt: '2026-01-02T00:00:00Z' }]);
    renderDialog();

    fireEvent.change(screen.getByLabelText('Confluence page URL'), {
      target: { value: 'https://tracker.example.com/wiki/pages/123' },
    });
    await screen.findByText('Use the saved token (Work)');

    fireEvent.click(screen.getByRole('button', { name: 'Enter another' }));

    await waitFor(() => expect(screen.getByLabelText('Personal Access Token')).toBeTruthy());
    expect(screen.queryByText(/Use the saved token/)).toBeNull();
  });

  it('submits credentialId only (no auth/save) when using the matched saved credential', async () => {
    const fetchMock = stubApi([
      { id: 'cred1', host: 'tracker.example.com', kind: 'pat', label: 'Work', createdAt: '2026-01-02T00:00:00Z' },
    ]);
    renderDialog();

    fireEvent.change(screen.getByLabelText('Confluence page URL'), {
      target: { value: 'https://tracker.example.com/wiki/pages/123' },
    });
    await screen.findByText('Use the saved token (Work)');

    fireEvent.change(screen.getByLabelText('New space name'), { target: { value: 'Test Space' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start import' }));

    await waitFor(() => expect(postBody(fetchMock)).toBeTruthy());
    expect(postBody(fetchMock)).toEqual({
      pageUrl: 'https://tracker.example.com/wiki/pages/123',
      targetSpace: 'Test Space',
      targetPath: '',
      includeChildren: true,
      credentialId: 'cred1',
    });
  });

  it('submits auth (cloud + email) and save:false when entering credentials manually with the checkbox unchecked', async () => {
    const fetchMock = stubApi([]);
    renderDialog();

    fireEvent.change(screen.getByLabelText('Confluence page URL'), {
      target: { value: 'https://acme.atlassian.net/wiki/pages/5' },
    });
    await waitFor(() => expect(screen.getByLabelText('Personal Access Token')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Cloud (email + token)' }));
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'me@acme.com' } });
    fireEvent.change(screen.getByLabelText('API token'), { target: { value: 'secret-token' } });
    fireEvent.click(screen.getByLabelText('Save for future imports')); // uncheck (default is checked)
    fireEvent.change(screen.getByLabelText('New space name'), { target: { value: 'Test Space' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start import' }));

    await waitFor(() => expect(postBody(fetchMock)).toBeTruthy());
    expect(postBody(fetchMock)).toEqual({
      pageUrl: 'https://acme.atlassian.net/wiki/pages/5',
      targetSpace: 'Test Space',
      targetPath: '',
      includeChildren: true,
      auth: { kind: 'basic', token: 'secret-token', email: 'me@acme.com' },
      save: false,
    });
  });

  it('shows a validation error instead of submitting when the page URL is empty', async () => {
    const fetchMock = stubApi([]);
    renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Start import' }));

    await waitFor(() => expect(screen.getByText('Enter a Confluence page link')).toBeTruthy());
    expect(fetchMock.mock.calls.some(([input]) => (typeof input === 'string' ? input : (input as URL).toString()) === '/api/import/confluence')).toBe(false);
  });

  it('still offers (and can submit) manual entry when the saved-credentials endpoint 404s', async () => {
    const fetchMock = stubApi([], 404);
    renderDialog();

    fireEvent.change(screen.getByLabelText('Confluence page URL'), {
      target: { value: 'https://tracker.example.com/wiki/pages/123' },
    });
    await waitFor(() => expect(screen.getByLabelText('Personal Access Token')).toBeTruthy());
    expect(screen.queryByText(/Use the saved token/)).toBeNull();

    fireEvent.change(screen.getByLabelText('Personal Access Token'), { target: { value: 'pat-secret' } });
    fireEvent.change(screen.getByLabelText('New space name'), { target: { value: 'Test Space' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start import' }));

    await waitFor(() => expect(postBody(fetchMock)).toBeTruthy());
    expect(postBody(fetchMock)).toEqual({
      pageUrl: 'https://tracker.example.com/wiki/pages/123',
      targetSpace: 'Test Space',
      targetPath: '',
      includeChildren: true,
      auth: { kind: 'pat', token: 'pat-secret' },
      save: true,
    });
  });
});

/**
 * Owner report 22.09.2026 — "import from Confluence does not work", three
 * complaints, one focused assertion each: the current space used to never
 * be preselected, the target path was a free-text field nobody could fill
 * in without already knowing it, and a raw HTTP status ("Confluence API 401
 * Unauthorized for ...") reached the UI verbatim on an auth failure.
 */
describe('ConfluenceImportDialog — current-space default, parent-page picker, humanized errors (owner report 22.09.2026)', () => {
  it('preselects the space the dialog was opened from', async () => {
    stubApi([], 200, { spaces: [{ slug: 'my-space', name: 'My space' }] });
    renderDialog('my-space');

    const select = (await screen.findByLabelText('Space')) as HTMLSelectElement;
    // The select itself is found as soon as the dialog mounts (targetSpace's
    // initial state is already 'my-space'); its DOM `.value` only reflects
    // that once a matching <option> exists, which needs the ['spaces'] fetch
    // to resolve first.
    await waitFor(() => expect(select.value).toBe('my-space'));
  });

  it('"New space" starts with an empty name, not the slug of the space the dialog was opened from (02.10.2026)', async () => {
    const fetchMock = stubApi([], 200, { spaces: [{ slug: 'product', name: 'Product' }] });
    renderDialog('product');

    // Opened from a space: "Existing space" is preselected...
    const select = (await screen.findByLabelText('Space')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('product'));

    // ...and switching to "New space" must not carry that slug into the name field, where typing appended to it ("productAcme Handbook").
    fireEvent.click(screen.getByRole('button', { name: 'New space' }));
    const nameField = screen.getByLabelText('New space name') as HTMLInputElement;
    expect(nameField.value).toBe('');
    fireEvent.change(nameField, { target: { value: 'Acme Handbook' } });

    // Going back and forth keeps each mode's own value: the existing-space choice survives, the typed name survives.
    fireEvent.click(screen.getByRole('button', { name: 'Existing space' }));
    await waitFor(() => expect((screen.getByLabelText('Space') as HTMLSelectElement).value).toBe('product'));
    fireEvent.click(screen.getByRole('button', { name: 'New space' }));
    expect((screen.getByLabelText('New space name') as HTMLInputElement).value).toBe('Acme Handbook');

    fireEvent.change(screen.getByLabelText('Confluence page URL'), { target: { value: 'https://tracker.example.com/wiki/pages/123' } });
    fireEvent.change(await screen.findByLabelText('Personal Access Token'), { target: { value: 'secret-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start import' }));

    await waitFor(() => expect(postBody(fetchMock)).toBeTruthy());
    expect(postBody(fetchMock).targetSpace).toBe('Acme Handbook');
  });

  it('defaults the import target to the space root, and picking a page sends its own directory as targetPath', async () => {
    const fetchMock = stubApi([], 200, {
      spaces: [{ slug: 'my-space', name: 'My space' }],
      tree: {
        tree: [
          {
            id: 'p1',
            space: 'my-space',
            path: 'guide.md',
            kind: 'doc',
            title: 'Guide',
            order: 10,
            status: 'published',
            updatedAt: '2026-01-01T00:00:00Z',
            children: [],
          },
        ],
      },
    });
    renderDialog('my-space');

    // Root is selected by default, before anything is picked.
    const rootRow = (await screen.findByText('Space root')).closest('button');
    expect(rootRow?.className).toContain('bg-neutral-100');

    fireEvent.click((await screen.findByText('Guide')).closest('button')!);
    fireEvent.change(screen.getByLabelText('Confluence page URL'), {
      target: { value: 'https://tracker.example.com/wiki/pages/123' },
    });
    fireEvent.change(screen.getByLabelText('Personal Access Token'), { target: { value: 'pat-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start import' }));

    await waitFor(() => expect(postBody(fetchMock)).toBeTruthy());
    expect(postBody(fetchMock)).toMatchObject({ targetSpace: 'my-space', targetPath: 'guide' });
  });

  it('renders a human explanation instead of the raw HTTP status when the job fails with 401', async () => {
    stubApi([], 200, {
      spaces: [{ slug: 'my-space', name: 'My space' }],
      job: {
        id: 'job1',
        status: 'error',
        total: 0,
        done: 0,
        currentTitle: null,
        error: 'Confluence API 401 Unauthorized for /rest/api/content/123',
        errorCode: 'unauthorized',
        targetSpace: null,
      },
    });
    renderDialog('my-space');

    fireEvent.change(screen.getByLabelText('Confluence page URL'), {
      target: { value: 'https://tracker.example.com/wiki/pages/123' },
    });
    fireEvent.change(screen.getByLabelText('Personal Access Token'), { target: { value: 'pat-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start import' }));

    await screen.findByText('The token is invalid or has expired');
  });
});
