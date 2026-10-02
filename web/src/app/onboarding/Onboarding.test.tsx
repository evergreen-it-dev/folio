// @vitest-environment jsdom
/**
 * The welcome wizard (the owner, 02.10.2026): "what do you want to start
 * with" -> an overview of what Folio can do, with no assistant in it -> an
 * overview of Folio AI -> the first document itself.
 *
 * What is pinned here is the flow and the two requests it ends in — a space,
 * then the chosen page in it — and the difference between a first run (no
 * space yet: one is made) and the tour opened on purpose at /welcome (the
 * page goes into a space that is already there, or nothing is created).
 */
import type { ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import i18next from 'i18next';
import { ToastProvider } from '../ui/Toast';
import { RootRedirect } from '../routes/RootRedirect';
import { Onboarding } from './Onboarding';
import '../i18n/register';

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

interface Call {
  url: string;
  method: string;
  body: unknown;
}

interface StubOptions {
  spaces?: { slug: string; name: string; pageCount: number; myRole?: string }[];
  /** Fail the first N page creations with a 500. */
  failPages?: number;
}

function stubFetch({ spaces = [], failPages = 0 }: StubOptions = {}): Call[] {
  const calls: Call[] = [];
  let pageFailures = failPages;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      const json = (payload: unknown, status = 200) =>
        Promise.resolve({ ok: status < 300, status, statusText: '', json: () => Promise.resolve(payload) });
      if (method === 'GET' && url === '/api/spaces') return json({ spaces });
      if (method === 'POST' && url === '/api/spaces') return json({ slug: 'team-wiki', name: body.name, pageCount: 0, myRole: 'admin' }, 201);
      if (method === 'POST' && url === '/api/pages') {
        if (pageFailures > 0) {
          pageFailures--;
          return json({ error: 'disk is full' }, 500);
        }
        return json({ id: 'P1', space: body.space, path: 'first.md', kind: body.kind, title: body.title }, 201);
      }
      return json({});
    }),
  );
  return calls;
}

/** Where the wizard sent the person, and with what router state. */
function Landed() {
  const location = useLocation();
  return <div data-testid="landed">{`${location.pathname}|${JSON.stringify(location.state)}`}</div>;
}

function renderAt(path: string, element: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <ToastProvider>
          <Routes>
            <Route path="/" element={path === '/' ? element : <Landed />} />
            <Route path="/welcome" element={element} />
            <Route path="/s/:space/p/:id" element={<Landed />} />
          </Routes>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const posts = (calls: Call[]) => calls.filter((call) => call.method === 'POST');
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));

describe('Onboarding — a first run (no space yet)', () => {
  it('is what the root route shows when there is no space at all', async () => {
    stubFetch();
    renderAt('/', <RootRedirect />);
    expect(await screen.findByRole('heading', { name: /What do you want to create first/ })).toBeTruthy();
  });

  it('walks choice -> features -> Folio AI, then creates the space and the chosen page and opens it', async () => {
    const calls = stubFetch();
    renderAt('/', <Onboarding />);

    // 1. What to start with: three options, a document preselected.
    await screen.findByRole('heading', { name: /What do you want to create first/ });
    const options = screen.getAllByRole('radio');
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining('Document'),
      expect.stringContaining('Whiteboard'),
      expect.stringContaining('Data table'),
    ]);
    expect(options[0].getAttribute('aria-checked')).toBe('true');
    fireEvent.click(options[1]);
    expect(options[1].getAttribute('aria-checked')).toBe('true');
    fireEvent.change(screen.getByLabelText('Name of your first space'), { target: { value: 'Acme handbook' } });
    click('Continue');

    // 2. What Folio can do — and not a word about the assistant here.
    await screen.findByRole('heading', { name: 'What you can do in Folio' });
    expect(screen.getAllByRole('listitem')).toHaveLength(6);
    expect(document.body.textContent).not.toMatch(/Folio AI|assistant|agent/i);
    expect(posts(calls)).toHaveLength(0);
    click('Continue');

    // 3. Folio AI, on a screen of its own.
    await screen.findByRole('heading', { name: 'Meet Folio AI' });
    expect(screen.getByText('Ask')).toBeTruthy();
    expect(screen.getByText('Agent')).toBeTruthy();
    expect(posts(calls)).toHaveLength(0);

    // 4. …and the thing itself.
    click('Create my first whiteboard');
    await waitFor(() => expect(screen.getByTestId('landed').textContent).toContain('/s/team-wiki/p/P1'));
    expect(posts(calls)).toEqual([
      { url: '/api/spaces', method: 'POST', body: { name: 'Acme handbook' } },
      { url: '/api/pages', method: 'POST', body: { space: 'team-wiki', parentPath: '', title: 'First whiteboard', kind: 'board' } },
    ]);
  });

  it('opens a first DOCUMENT ready to type in — through router state, never the URL', async () => {
    stubFetch();
    renderAt('/', <Onboarding />);
    await screen.findByRole('heading', { name: /What do you want to create first/ });
    click('Continue');
    click('Continue');
    click('Create my first document');
    await waitFor(() => expect(screen.getByTestId('landed').textContent).toBe('/s/team-wiki/p/P1|{"startEditing":true}'));
  });

  it('names the space by default when the field is left empty', async () => {
    const calls = stubFetch();
    renderAt('/', <Onboarding />);
    await screen.findByRole('heading', { name: /What do you want to create first/ });
    click('Skip');
    await waitFor(() => expect(posts(calls)).toHaveLength(2));
    // "Skip" skips the tour, not the outcome: there is nowhere to land until a space exists.
    expect(posts(calls)[0].body).toEqual({ name: 'Team wiki' });
    expect(posts(calls)[1].body).toMatchObject({ kind: 'doc', title: 'Getting started' });
  });

  it('goes back a step without losing the choice', async () => {
    stubFetch();
    renderAt('/', <Onboarding />);
    await screen.findByRole('heading', { name: /What do you want to create first/ });
    fireEvent.click(screen.getAllByRole('radio')[2]);
    click('Continue');
    click('Back');
    expect(screen.getAllByRole('radio')[2].getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1');
  });

  it('a retry after the page failed reuses the space that was already made', async () => {
    const calls = stubFetch({ failPages: 1 });
    renderAt('/', <Onboarding />);
    await screen.findByRole('heading', { name: /What do you want to create first/ });
    click('Continue');
    click('Continue');
    click('Create my first document');
    expect(await screen.findByRole('alert')).toBeTruthy();

    click('Create my first document');
    await waitFor(() => expect(screen.getByTestId('landed')).toBeTruthy());
    expect(posts(calls).filter((call) => call.url === '/api/spaces')).toHaveLength(1);
    expect(posts(calls).filter((call) => call.url === '/api/pages')).toHaveLength(2);
  });

  it('offers to connect an existing Git repository instead', async () => {
    stubFetch();
    renderAt('/', <Onboarding />);
    await screen.findByRole('heading', { name: /What do you want to create first/ });
    expect(screen.getByRole('button', { name: 'Connect it instead' })).toBeTruthy();
  });
});

describe('Onboarding — the tour at /welcome, with spaces already there', () => {
  const SPACES = [
    { slug: 'read-only', name: 'Read only', pageCount: 3, myRole: 'viewer' },
    { slug: 'eng', name: 'Engineering', pageCount: 9, myRole: 'editor' },
    { slug: 'ops', name: 'Operations', pageCount: 4, myRole: 'admin' },
  ];

  it('makes no space: the page goes into the one the person was last in', async () => {
    window.localStorage.setItem('folio:last-space', 'ops');
    const calls = stubFetch({ spaces: SPACES });
    renderAt('/welcome', <Onboarding />);

    await screen.findByRole('heading', { name: /What do you want to create first/ });
    // No first space to name, no repository to connect.
    expect(screen.queryByLabelText('Name of your first space')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Connect it instead' })).toBeNull();
    fireEvent.click(screen.getAllByRole('radio')[2]);
    click('Continue');
    click('Continue');
    click('Create my first table');

    await waitFor(() => expect(screen.getByTestId('landed').textContent).toContain('/p/P1'));
    const sent = posts(calls);
    expect(sent.map((call) => call.url)).toEqual(['/api/pages']);
    expect((sent[0].body as { space: string }).space).toBe('ops');
    expect(sent[0].body).toMatchObject({ kind: 'table', title: 'First table' });
  });

  it('"Skip" just leaves, creating nothing', async () => {
    const calls = stubFetch({ spaces: SPACES });
    renderAt('/welcome', <Onboarding />);
    await screen.findByRole('heading', { name: /What do you want to create first/ });
    click('Skip');
    await waitFor(() => expect(screen.getByTestId('landed').textContent).toContain('/|'));
    expect(posts(calls)).toHaveLength(0);
  });

  it('someone who can only read sees the tour and ends with "Go to Folio"', async () => {
    const calls = stubFetch({ spaces: [SPACES[0]] });
    renderAt('/welcome', <Onboarding />);
    await screen.findByRole('heading', { name: /What do you want to create first/ });
    click('Continue');
    click('Continue');
    click('Go to Folio');
    await waitFor(() => expect(screen.getByTestId('landed').textContent).toContain('/|'));
    expect(posts(calls)).toHaveLength(0);
  });
});
