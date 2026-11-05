// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import type { ArtifactPayload } from '@shared/contracts';
import { ArtifactView } from './ArtifactView';
import './i18n/register';

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const payload = (over: Partial<ArtifactPayload> = {}): ArtifactPayload => ({
  type: 'html',
  entry: 'index.html',
  src: 'https://example.test/art/tok1/index.html',
  capabilities: ['storage'],
  files: [],
  warnings: [],
  stateServer: false,
  ...over,
});

describe('ArtifactView', () => {
  it('puts the action buttons into toolbarHost, and takes them back into the view in fullscreen without reloading the frame', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const { container } = render(<ArtifactView payload={payload()} pageId="p1" title="Dash" toolbarHost={host} />);
    const frame = screen.getByTitle('Dash (artifact)');
    const fullscreenButton = () => screen.getByRole('button', { name: /^Fullscreen/ });
    expect(host.contains(fullscreenButton())).toBe(true);
    expect(container.contains(fullscreenButton())).toBe(false);
    fireEvent.click(fullscreenButton());
    expect(container.contains(screen.getByRole('button', { name: /^Exit fullscreen/ }))).toBe(true);
    expect(screen.getByTitle('Dash (artifact)')).toBe(frame);
    host.remove();
  });

  it('shows the page in a frame that never gets allow-same-origin', () => {
    render(<ArtifactView payload={payload()} pageId="p1" title="Dash" />);
    const frame = screen.getByTitle('Dash (artifact)');
    expect(frame.getAttribute('src')).toBe('https://example.test/art/tok1/index.html');
    expect(frame.getAttribute('sandbox')).toContain('allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('warns when the artifact expects more than storage, and offers only the actions it was given', () => {
    render(<ArtifactView payload={payload({ capabilities: ['storage', 'claude', 'network'] })} pageId="p1" title="Dash" />);
    expect(screen.getByRole('status').textContent).toBe('Works partially: calls to Claude, network requests are not available in Folio.');
    expect(screen.queryByText('Replace…')).toBeNull();
    expect(screen.queryByText('Download .zip')).toBeNull();
  });

  it('keeps the frame address when only the minted token changes', () => {
    const { rerender } = render(<ArtifactView payload={payload()} pageId="p1" title="Dash" version="v1" />);
    rerender(<ArtifactView payload={payload({ src: 'https://example.test/art/tok2/index.html' })} pageId="p1" title="Dash" version="v1" />);
    expect(screen.getByTitle('Dash (artifact)').getAttribute('src')).toContain('/tok1/');
    rerender(<ArtifactView payload={payload({ src: 'https://example.test/art/tok3/index.html' })} pageId="p1" title="Dash" version="v2" />);
    expect(screen.getByTitle('Dash (artifact)').getAttribute('src')).toContain('/tok3/');
  });

  it('shows an empty state without a page, and an embed through its own url', () => {
    const { unmount } = render(<ArtifactView payload={payload({ src: undefined })} pageId="p1" title="Dash" />);
    expect(screen.getByText('This artifact has no page to show.')).toBeTruthy();
    unmount();
    render(<ArtifactView payload={payload({ type: 'embed', src: undefined, embedUrl: 'https://claudeusercontent.test/e/1', embedHeight: 500 })} pageId="p1" title="Dash" />);
    const frame = screen.getByTitle('Dash (artifact)') as HTMLIFrameElement;
    expect(frame.getAttribute('src')).toBe('https://claudeusercontent.test/e/1');
    expect(frame.style.height).toBe('500px');
  });

  it('shows no source badge for pasted HTML, but keeps it for a real origin or a link', () => {
    const { container, unmount } = render(<ArtifactView payload={payload({ source: { origin: 'other' } })} pageId="p1" title="Dash" />);
    expect(container.querySelector('a[title], .truncate')).toBeNull();
    unmount();
    const bare = render(<ArtifactView payload={payload({ source: undefined })} pageId="p1" title="Dash" />);
    expect(bare.container.querySelector('.truncate')).toBeNull();
    bare.unmount();
    render(<ArtifactView payload={payload({ source: { origin: 'other', url: 'https://example.com/a' } })} pageId="p1" title="Dash" />);
    expect(screen.getByText('Source').closest('a')).toBeTruthy();
  });

  it('links the original only for an http(s) address', () => {
    render(<ArtifactView payload={payload({ source: { origin: 'claude', url: 'javascript:alert(1)' } })} pageId="p1" title="Dash" />);
    expect(screen.getByText('From Claude').closest('a')).toBeNull();
    cleanup();
    render(<ArtifactView payload={payload({ source: { origin: 'claude', url: 'https://claude.ai/public/artifacts/x' } })} pageId="p1" title="Dash" />);
    const link = screen.getByText('From Claude').closest('a');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer nofollow');
  });

  it('answers the frame through the bridge, keeping a guest’s state in localStorage', async () => {
    render(<ArtifactView payload={payload()} pageId="p9" title="Dash" />);
    const frame = screen.getByTitle('Dash (artifact)') as HTMLIFrameElement;
    const win = frame.contentWindow as Window;
    const post = vi.spyOn(win, 'postMessage').mockImplementation(() => undefined);
    const send = async (data: unknown, source: Window | null = win) => {
      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', { data, source }));
        await Promise.resolve();
        await Promise.resolve();
      });
    };
    await send({ folio: 'artifact', id: 1, op: 'set', key: 'k', value: 'v', shared: false });
    expect(post).toHaveBeenLastCalledWith({ folio: 'artifact', id: 1, ok: true, value: 'v' }, '*');
    expect(JSON.parse(window.localStorage.getItem('folio:artifact:p9') ?? '{}')).toEqual({ k: 'v' });
    await send({ folio: 'artifact', id: 2, op: 'get', key: 'k', shared: false });
    expect(post).toHaveBeenLastCalledWith({ folio: 'artifact', id: 2, ok: true, value: 'v' }, '*');
    await send({ folio: 'artifact', id: 3, op: 'set', key: 'k', value: 'v', shared: true });
    expect(post).toHaveBeenLastCalledWith({ folio: 'artifact', id: 3, ok: false, error: 'Shared state needs sign-in' }, '*');
    post.mockClear();
    await send({ folio: 'artifact', id: 4, op: 'init' }, window);
    expect(post).not.toHaveBeenCalled();
  });
});
