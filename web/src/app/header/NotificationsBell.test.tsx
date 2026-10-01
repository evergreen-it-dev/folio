// @vitest-environment jsdom
/**
 * Round 31 — focused coverage of the bell: the badge, the decision buttons of
 * a pending request (and their absence on a decided one), the role in the
 * body of the approval, and a row from the socket appearing in an ALREADY
 * open panel without a repeated request for the feed.
 *
 * The network is stubbed at the level of `fetch` (the same trick as in
 * auth/UsernameField.test.tsx), the socket with a `WebSocket` stub: the owner
 * watches the real connection live with two people, here only the fact that
 * a frame reaches the list is checked.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import type { NotificationItem, NotificationListResponse } from '@shared/contracts';
import { NotificationsHost } from '../notifications/NotificationsHost';
import { NotificationsBell } from './NotificationsBell';
import '../i18n/register';

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeSocket.instances = [];
});

/** A minimal WebSocket double: the test throws the frames in itself. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  close() {
    this.closed = true;
  }
}

interface StubResponse {
  ok?: boolean;
  status?: number;
  body?: unknown;
}

function stubFetch(handler: (url: string, init?: RequestInit) => StubResponse) {
  const fn = vi.fn((url: string, init?: RequestInit) => {
    const res = handler(url, init);
    const ok = res.ok ?? true;
    return Promise.resolve({
      ok,
      status: res.status ?? (ok ? 200 : 500),
      statusText: '',
      json: () => Promise.resolve(res.body ?? {}),
    });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const REQUESTER = { id: 'u2', name: 'Alice Anderson', username: 'alice' };

function pendingItem(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: 'n1',
    kind: 'access_request',
    createdAt: '2026-09-11T10:00:00.000Z',
    readAt: null,
    accessRequest: {
      id: 'r1',
      space: 'docs',
      spaceName: 'Docs',
      requester: REQUESTER,
      status: 'pending',
      createdAt: '2026-09-11T10:00:00.000Z',
    },
    ...overrides,
  };
}

function decidedItem(): NotificationItem {
  return {
    id: 'n2',
    kind: 'access_request',
    createdAt: '2026-09-11T09:00:00.000Z',
    readAt: '2026-09-11T09:30:00.000Z',
    accessRequest: {
      id: 'r2',
      space: 'docs',
      spaceName: 'Docs',
      requester: REQUESTER,
      status: 'approved',
      createdAt: '2026-09-11T09:00:00.000Z',
      decidedAt: '2026-09-11T09:10:00.000Z',
      decidedBy: { id: 'u3', name: 'Bob Boss' },
      grantedRole: 'editor',
    },
  };
}

function renderBell(list: NotificationListResponse, withHost = false) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      {withHost && <NotificationsHost />}
      <NotificationsBell />
    </QueryClientProvider>,
  );
  return { ...utils, queryClient, list };
}

describe('NotificationsBell', () => {
  it('shows the unread count as a badge, and no badge at all when nothing is unread', async () => {
    const fetchMock = stubFetch(() => ({ body: { items: [pendingItem()], unread: 3 } satisfies NotificationListResponse }));
    const { unmount } = renderBell({ items: [], unread: 0 });

    const trigger = await screen.findByRole('button');
    await waitFor(() => expect(trigger.textContent).toBe('3'));
    expect(trigger.getAttribute('aria-label')).toBe('Notifications (3 unread)');

    unmount();
    cleanup();
    fetchMock.mockClear();

    stubFetch(() => ({ body: { items: [decidedItem()], unread: 0 } satisfies NotificationListResponse }));
    renderBell({ items: [], unread: 0 });
    const quiet = await screen.findByRole('button');
    await waitFor(() => expect(quiet.getAttribute('aria-label')).toBe('Notifications'));
    expect(quiet.textContent).toBe('');
  });

  it('offers approve/deny on a pending request and nothing but the outcome on a decided one', async () => {
    stubFetch(() => ({ body: { items: [pendingItem(), decidedItem()], unread: 0 } satisfies NotificationListResponse }));
    renderBell({ items: [], unread: 0 });

    fireEvent.click(await screen.findByRole('button'));

    // Both requests are in the feed; the buttons are on exactly one, the pending one.
    await waitFor(() => expect(screen.getAllByText(/is asking for access/).length).toBe(2));
    expect(screen.getAllByRole('button', { name: 'Grant access' }).length).toBe(1);
    expect(screen.getAllByRole('button', { name: 'Deny' }).length).toBe(1);

    // The decided one has no buttons, but shows WHO decided WHAT.
    expect(screen.getByText(/Bob Boss granted access/)).toBeTruthy();
  });

  it('sends the role picked in the row when approving', async () => {
    const fetchMock = stubFetch((url) => {
      if (url === '/api/notifications') return { body: { items: [pendingItem()], unread: 0 } };
      return { body: { request: { ...pendingItem().accessRequest, status: 'approved' } } };
    });
    renderBell({ items: [], unread: 0 });

    fireEvent.click(await screen.findByRole('button'));
    const select = await screen.findByRole('combobox', { name: 'Role' });
    fireEvent.change(select, { target: { value: 'editor' } });
    fireEvent.click(screen.getByRole('button', { name: 'Grant access' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/access-requests/r1/decision',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ decision: 'approve', role: 'editor' }) }),
      ),
    );
  });

  it('adds a socket-delivered row to the already-open panel without re-reading the feed', async () => {
    vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
    const fetchMock = stubFetch(() => ({ body: { items: [], unread: 0 } satisfies NotificationListResponse }));
    renderBell({ items: [], unread: 0 }, true);

    // An empty feed is a short line, not an empty box.
    fireEvent.click(await screen.findByRole('button'));
    await waitFor(() => expect(screen.getByText('No notifications yet.')).toBeTruthy());
    const callsBefore = fetchMock.mock.calls.length;

    const socket = FakeSocket.instances[0];
    expect(socket.url.endsWith('/events')).toBe(true);

    act(() => {
      // ping does nothing — it only keeps the connection.
      socket.onmessage?.({ data: JSON.stringify({ type: 'ping' }) });
      socket.onmessage?.({ data: JSON.stringify({ type: 'notification', item: pendingItem() }) });
    });

    await waitFor(() => expect(screen.getByText(/is asking for access/)).toBeTruthy());
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
    // The unread item from the frame shows on the badge at once.
    expect(screen.getAllByRole('button')[0].textContent).toBe('1');
  });
});
