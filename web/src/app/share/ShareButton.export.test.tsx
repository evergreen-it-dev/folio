// @vitest-environment jsdom
/**
 * Round 23 (EXPORT), SHELL half — what the share popover gained: the "MD"
 * link for an AI agent, and the "Include child pages" flag.
 *
 * Deliberately rendered WITHOUT a QueryClientProvider. That is not an
 * oversight and not laziness: ShareButton was taken off react-query entirely
 * after the Round 25 board bug (see ShareButton.boardRepro.test.tsx and
 * ShareButton.tsx's own comment — the observer stopped updating on board
 * routes and the popover hung on "Loading…" forever). Mounting it bare
 * here is a standing check that nothing in this round quietly reintroduced
 * that dependency: the day someone adds a `useQuery` back, this file throws
 * "No QueryClient set" and says so out loud.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import type { ShareLinkInfo } from '@shared/contracts';
import { ToastProvider } from '../ui/Toast';
import { ShareButton } from './ShareButton';

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (navigator as { clipboard?: unknown }).clipboard;
});

function shareLink(overrides: Partial<ShareLinkInfo> = {}): ShareLinkInfo {
  return {
    id: 's1',
    mode: 'view',
    url: 'https://folio.example/share/tok123',
    mdUrl: 'https://folio.example/share/tok123.md',
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'Test User',
    includeChildren: false,
    ...overrides,
  };
}

/**
 * jsdom ships no `navigator.clipboard` at all (the same shape a non-secure
 * http:// origin has in a real browser), so it has to be installed
 * explicitly — and `configurable` so afterEach can take it back off.
 */
function stubClipboard(behavior: 'ok' | 'denied' | 'missing' = 'ok') {
  if (behavior === 'missing') return vi.fn();
  const writeText =
    behavior === 'ok'
      ? vi.fn().mockResolvedValue(undefined)
      : vi.fn().mockRejectedValue(new DOMException('Write permission denied.', 'NotAllowedError'));
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return writeText;
}

/** Routes by URL + method: GET the list, POST a creation. */
function stubFetch(shares: ShareLinkInfo[], created?: ShareLinkInfo) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(created ?? shareLink()) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ shares }) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function openPopover(pageId = 'p1') {
  render(
    <ToastProvider>
      <ShareButton pageId={pageId} />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Share' }));
}

/**
 * "For an agent" is the "Markdown for an agent" CHECKBOX next to "Include
 * child pages" (the owner's feedback: a separate mini MD button in the row
 * of the link read badly). The checkbox is a DISPLAY mode: the link row and
 * copying switch to mdUrl, the token is the same.
 */
function tickMarkdownMode() {
  fireEvent.click(screen.getByRole('checkbox', { name: /Markdown for an agent/ }));
}

describe('ShareButton — the MD link for an agent', () => {
  it('copies the link\'s own mdUrl, not the human URL', async () => {
    stubFetch([shareLink()]);
    const writeText = stubClipboard();
    openPopover();

    await screen.findByRole('checkbox', { name: /Markdown for an agent/ });
    tickMarkdownMode();
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://folio.example/share/tok123.md'));
    expect(writeText).not.toHaveBeenCalledWith('https://folio.example/share/tok123');
    expect(await screen.findByText('MD link copied')).toBeTruthy();
  });

  it("takes mdUrl from the server's record rather than deriving it from url", async () => {
    // A deliberately non-derivable mdUrl: anything that builds `${url}.md`
    // client-side passes only by accident, and fails here.
    stubFetch([shareLink({ url: 'https://folio.example/share/tok123', mdUrl: 'https://cdn.example/raw/other-token.md' })]);
    const writeText = stubClipboard();
    openPopover();

    await screen.findByRole('checkbox', { name: /Markdown for an agent/ });
    tickMarkdownMode();
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://cdn.example/raw/other-token.md'));
  });

  it('explains what the mode is for, in the checkbox caption', async () => {
    stubFetch([shareLink()]);
    stubClipboard();
    openPopover();

    const box = await screen.findByRole('checkbox', { name: /Markdown for an agent/ });
    const caption = box.closest('label')?.textContent ?? '';
    expect(caption).toContain('AI agent');
    expect(caption).toContain('markdown');
  });

  it('shows the md URL in the link row itself once the mode is on', async () => {
    stubFetch([shareLink()]);
    stubClipboard();
    openPopover();

    await screen.findByRole('checkbox', { name: /Markdown for an agent/ });
    expect(screen.getByRole('link')).toHaveProperty('href', 'https://folio.example/share/tok123');
    tickMarkdownMode();
    expect(screen.getByRole('link')).toHaveProperty('href', 'https://folio.example/share/tok123.md');
  });

  it('survives a denied clipboard permission and says so, instead of failing silently', async () => {
    stubFetch([shareLink()]);
    const writeText = stubClipboard('denied');
    openPopover();

    await screen.findByRole('checkbox', { name: /Markdown for an agent/ });
    tickMarkdownMode();
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(await screen.findByText(/Could not copy the MD link/)).toBeTruthy();
  });

  it('survives an origin with no navigator.clipboard at all (plain http://) without throwing', async () => {
    stubFetch([shareLink()]);
    stubClipboard('missing'); // nothing installed — the property stays undefined
    openPopover();

    await screen.findByRole('checkbox', { name: /Markdown for an agent/ });
    tickMarkdownMode();
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));

    // The old `navigator.clipboard.writeText(...)` form threw a TypeError here.
    expect(await screen.findByText(/Could not copy the MD link/)).toBeTruthy();
  });

  it('copying the human link is unregressed and still reachable', async () => {
    stubFetch([shareLink()]);
    const writeText = stubClipboard();
    openPopover();

    fireEvent.click(await screen.findByRole('button', { name: 'Copy link' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://folio.example/share/tok123'));
  });
});

describe('ShareButton — "Include child pages"', () => {
  it('sends includeChildren: true on create once the box is ticked', async () => {
    const fetchMock = stubFetch([], shareLink({ includeChildren: true }));
    stubClipboard();
    openPopover();

    await screen.findAllByText('Create link');
    fireEvent.click(screen.getByRole('checkbox', { name: /Include child pages/ }));
    fireEvent.click(screen.getAllByText('Create link')[0]);

    await waitFor(() => {
      const post = fetchMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === 'POST');
      expect(post).toBeTruthy();
      expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({ mode: 'view', includeChildren: true });
    });
  });

  it('defaults to false — an unticked box must not silently widen the link', async () => {
    const fetchMock = stubFetch([], shareLink());
    stubClipboard();
    openPopover();

    await screen.findAllByText('Create link');
    fireEvent.click(screen.getAllByText('Create link')[0]);

    await waitFor(() => {
      const post = fetchMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === 'POST');
      expect(post).toBeTruthy();
      expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({ mode: 'view', includeChildren: false });
    });
  });

  it('captions the checkbox with BOTH meanings of the one flag', async () => {
    stubFetch([]);
    openPopover();

    await screen.findAllByText('Create link');
    const label = screen.getByRole('checkbox', { name: /Include child pages/ }).closest('label');
    const text = label?.textContent ?? '';
    // For a human following the link:
    expect(text).toContain('child pages');
    expect(text).toContain('also shows');
    // For an export / the agent link:
    expect(text).toContain('collated into a single document');
  });

  // The owner, 01.10.2026: an unticked box captioned "This page only"
  // read as "not only this page" — a board was shared that way and its child
  // page was missing from the link. The label says what the box does; the
  // tick alone says whether it is on.
  it("shows an existing link's stored flag as a ticked 'include children' box", async () => {
    stubFetch([shareLink({ includeChildren: true })]);
    openPopover();

    const box = (await screen.findByRole('checkbox', { name: 'Include child pages' })) as HTMLInputElement;
    expect(box.checked).toBe(true);
  });

  it('a link created without the flag shows the same box unticked — never a caption that reads the other way', async () => {
    stubFetch([shareLink({ includeChildren: false })]);
    openPopover();

    const box = (await screen.findByRole('checkbox', { name: 'Include child pages' })) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.queryByText('This page only')).toBeNull();
  });

  it('ticking the box on an existing link widens that very link', async () => {
    const fetchMock = stubFetch([shareLink({ mode: 'edit', includeChildren: false })]);
    openPopover();

    // One box only: the creation-time one is gone as soon as a link exists.
    const liveScope = await screen.findByRole('checkbox', { name: 'Include child pages' });
    expect(screen.getAllByRole('checkbox', { name: /Include child pages/ })).toHaveLength(1);
    fireEvent.click(liveScope);

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === 'PATCH');
      expect(patch).toBeTruthy();
      expect(JSON.parse((patch![1] as RequestInit).body as string)).toEqual({ includeChildren: true });
    });
  });

  it('keeps per-link scope controls when both links exist, with no creation-only checkbox', async () => {
    stubFetch([shareLink({ id: 's1', mode: 'view' }), shareLink({ id: 's2', mode: 'edit' })]);
    openPopover();

    await screen.findAllByRole('button', { name: 'Copy link' });
    // One box per link, and no third, creation-time one.
    expect(screen.getAllByRole('checkbox', { name: 'Include child pages' })).toHaveLength(2);
    expect(screen.getByRole('checkbox', { name: /Markdown for an agent/ })).toBeTruthy();
  });
});
