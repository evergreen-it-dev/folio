// @vitest-environment jsdom
/**
 * The public site shell: what an anonymous visitor gets for a published space. The page is
 * fetched from the anonymous /api/public/** routes only (never a session route), the tree and
 * every link use the site's own URLs (path mode `/public/<slug>/p/<id>`, host mode `/p/<id>`),
 * and nothing asks the visitor to sign in. The heavy leaf renderers (markdown pipeline, table
 * grid) have their own suites; <Markdown> is replaced by a stub that exposes what it was given.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import type { PublicPagePayload, PublicSiteInfo, SearchHit, TreeNode } from '@shared/contracts';

vi.mock('../../markdown', () => ({
  Markdown: ({ markdown, publicSite }: { markdown: string; publicSite?: { space: string; pageUrl: (id: string) => string } }) => (
    <div data-testid="markdown-body" data-public-site={publicSite ? `${publicSite.space}|${publicSite.pageUrl('x1')}` : ''}>
      {markdown}
    </div>
  ),
}));

const { PublicSiteView } = await import('./PublicSiteView');
const { PublicSiteLoader } = await import('./PublicSiteRoutes');

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.title = '';
});

const SITE: PublicSiteInfo = {
  space: 'docs',
  name: 'Docs',
  allowDownload: false,
  allowAssistant: false,
  mode: 'path',
  homePageId: 'p1',
  instanceUrl: 'https://folio.example.com',
  title: null,
  tagline: null,
  lang: null,
  logoUrl: null,
  faviconUrl: null,
  cssUrl: null,
  canonicalBase: 'https://folio.example.com/public/docs',
  indexing: true,
};

function node(id: string, title: string, children: TreeNode[] = [], path = `${id}.md`): TreeNode {
  return { id, space: 'docs', path, kind: 'doc', title, order: 0, status: 'published', updatedAt: '2026-10-13T00:00:00Z', children };
}

const TREE: TreeNode[] = [node('p1', 'Guide', [node('p2', 'Install', [], 'guide/install.md')], 'guide.md'), node('p3', 'Reference')];

function pagePayload(id: string, title: string, markdown: string): PublicPagePayload {
  return {
    spaceName: 'Docs Space',
    page: { id, space: 'docs', path: `${id}.md`, kind: 'doc', title, order: 0, status: 'published', updatedAt: '2026-10-13T00:00:00Z', markdown },
  };
}

const PAGES: Record<string, PublicPagePayload> = {
  p1: pagePayload('p1', 'Guide', '# Guide\n\nWelcome to the guide.'),
  p2: pagePayload('p2', 'Install', '# Install\n\nRun the installer.'),
  p3: pagePayload('p3', 'Reference', '# Reference\n\nAll the options.'),
};

/** Routes fetch by exact URL; anything not listed is a 404, like the real server for a page it will not show. */
function stubFetch(extra: Record<string, unknown> = {}) {
  const fetchMock = vi.fn((input: unknown) => {
    const url = String(input);
    let body: unknown;
    if (url === '/api/public/spaces/docs/tree') body = { tree: TREE };
    else if (url in extra) body = extra[url];
    else {
      const match = /^\/api\/public\/spaces\/docs\/pages\/([^/?]+)$/.exec(url);
      body = match ? PAGES[match[1]] : undefined;
    }
    if (body === undefined) {
      return Promise.resolve({ ok: false, status: 404, statusText: '', json: () => Promise.resolve({ error: 'not found' }) });
    }
    return Promise.resolve({ ok: true, status: 200, statusText: '', headers: new Headers(), json: () => Promise.resolve(body) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderSite(site: PublicSiteInfo, initialPath: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const basePath = site.mode === 'host' ? '' : '/public/docs';
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path={basePath || '/'} element={<PublicSiteView site={site} />} />
          <Route path={`${basePath}/p/:id`} element={<RoutedView site={site} />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The page route: the id comes from the URL, as in PublicSiteRoutes. */
function RoutedView({ site }: { site: PublicSiteInfo }) {
  const { id } = useParams();
  return <PublicSiteView site={site} pageId={id} />;
}

/** The left column. */
function sidebar() {
  return screen.getByRole('complementary', { name: 'Docs' });
}

/** The pinned area at the bottom of the left column: the aside's last child. */
function sidebarFooter() {
  return sidebar().lastElementChild as HTMLElement;
}

/** The top bar over the page. */
function header() {
  return screen.getByRole('banner');
}

function treeLinks() {
  const nav = screen.getByRole('navigation', { name: 'Pages' });
  return Array.from(nav.querySelectorAll('a'));
}

describe('PublicSiteView', () => {
  it('shows the home page, the tree with the site\'s own URLs and the footer links, without asking anyone to sign in', async () => {
    const fetchMock = stubFetch();
    renderSite(SITE, '/public/docs');

    await waitFor(() => expect(screen.getByTestId('markdown-body').textContent).toContain('Welcome to the guide.'));
    // The page opens at the home URL: `homePageId` is fetched, no redirect to /p/<id>.
    expect(fetchMock).toHaveBeenCalledWith('/api/public/spaces/docs/pages/p1', expect.anything());
    // Markdown gets the public-site adapter, whose page URLs are the path-mode ones.
    expect(screen.getByTestId('markdown-body').getAttribute('data-public-site')).toBe('docs|/public/docs/p/x1');

    await waitFor(() => expect(treeLinks().length).toBeGreaterThan(0));
    const hrefs = treeLinks().map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/public/docs/p/p1');
    expect(hrefs).toContain('/public/docs/p/p3');
    const current = treeLinks().find((a) => a.getAttribute('aria-current') === 'page');
    expect(current?.getAttribute('href')).toBe('/public/docs/p/p1');

    // A page with children has an expander; the child appears under it with its own public URL.
    expect(screen.queryByRole('link', { name: 'Install' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand “Guide”' }));
    expect(screen.getByRole('link', { name: 'Install' }).getAttribute('href')).toBe('/public/docs/p/p2');

    // Sidebar footer: the way into the app for people who have an account (`signin=1` so the app does not bounce them back here)
    // and the product credit, which points at the product site (not this instance) and is a plain link — no nofollow.
    const footer = sidebarFooter();
    expect(within(footer).getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('https://folio.example.com/s/docs/p/p1?signin=1');
    const poweredBy = within(footer).getByRole('link', { name: 'Powered by Folio' });
    expect(poweredBy.getAttribute('href')).toBe('https://foliowiki.online');
    expect(poweredBy.getAttribute('target')).toBe('_blank');
    expect(poweredBy.getAttribute('rel')).toContain('noopener');
    expect(poweredBy.getAttribute('rel') ?? '').not.toContain('nofollow');
    // They live in the left column only: nothing is left under the main area.
    expect(screen.getAllByRole('link', { name: 'Sign in' })).toHaveLength(1);
    expect(screen.getAllByRole('link', { name: 'Powered by Folio' })).toHaveLength(1);
    expect(document.querySelector('footer')).toBeNull();

    // Nothing here is a login wall, and no request went to a session route.
    expect(screen.queryByText('Log in to Folio')).toBeNull();
    expect(screen.queryByLabelText('Email')).toBeNull();
    for (const [url] of fetchMock.mock.calls) expect(String(url).startsWith('/api/public/')).toBe(true);
  });

  it('puts "Space home" above the page tree in the left column, highlighted while the home is open', async () => {
    stubFetch();
    const { unmount } = renderSite(SITE, '/public/docs');
    await waitFor(() => expect(treeLinks().length).toBeGreaterThan(0));

    const home = within(sidebar()).getByRole('link', { name: 'Space home' });
    expect(home.getAttribute('href')).toBe('/public/docs');
    expect(home.getAttribute('aria-current')).toBe('page');
    // Above the tree, not inside it.
    const tree = screen.getByRole('navigation', { name: 'Pages' });
    expect(home.compareDocumentPosition(tree) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tree.contains(home)).toBe(false);
    unmount();

    // On another page it is a plain link again; on the home page's own /p/<id> URL it counts as open.
    const other = renderSite(SITE, '/public/docs/p/p3');
    await waitFor(() => expect(screen.getByTestId('markdown-body').textContent).toContain('All the options.'));
    expect(within(sidebar()).getByRole('link', { name: 'Space home' }).getAttribute('aria-current')).toBeNull();
    other.unmount();

    renderSite(SITE, '/public/docs/p/p1');
    await waitFor(() => expect(screen.getByTestId('markdown-body').textContent).toContain('Welcome to the guide.'));
    expect(within(sidebar()).getByRole('link', { name: 'Space home' }).getAttribute('aria-current')).toBe('page');
  });

  it('in host mode "Space home" and the tree are rooted at "/"', async () => {
    stubFetch();
    renderSite({ ...SITE, mode: 'host' }, '/');
    await waitFor(() => expect(treeLinks().length).toBeGreaterThan(0));
    expect(within(sidebar()).getByRole('link', { name: 'Space home' }).getAttribute('href')).toBe('/');
  });

  it('has search in the header (not in the left column), and Ask AI only when the space allows it', async () => {
    stubFetch();
    const { unmount } = renderSite(SITE, '/public/docs');
    await waitFor(() => expect(treeLinks().length).toBeGreaterThan(0));

    expect(within(header()).getByRole('button', { name: 'Search this site' })).toBeTruthy();
    expect(within(sidebar()).queryByRole('button', { name: 'Search this site' })).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull(); // the input appears in the dialog the button opens
    expect(within(header()).queryByRole('button', { name: 'Ask AI about this space' })).toBeNull();
    unmount();

    renderSite({ ...SITE, allowAssistant: true, allowDownload: true }, '/public/docs');
    const ask = await within(header()).findByRole('button', { name: 'Ask AI about this space' });
    // Short visible label, the full sentence as the accessible name and tooltip.
    expect(ask.textContent).toBe('Ask AI');
    expect(ask.getAttribute('title')).toBe('Ask AI about this space');
    expect(ask.getAttribute('aria-expanded')).toBe('false');
    expect(within(sidebar()).queryByRole('button', { name: 'Ask AI about this space' })).toBeNull();

    // Header order, left to right: breadcrumbs, search, Ask AI, download.
    const download = await within(header()).findByRole('button', { name: 'Download' });
    const crumbs = within(header()).getByRole('navigation', { name: 'Breadcrumbs' });
    const search = within(header()).getByRole('button', { name: 'Search this site' });
    const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(crumbs, search)).toBe(true);
    expect(follows(search, ask)).toBe(true);
    expect(follows(ask, download)).toBe(true);

    // It toggles the chat sheet, which is the same PublicAskPanel (a dialog that stays out of the way while closed).
    expect(screen.queryByRole('dialog', { name: 'Ask AI' })).toBeNull();
    fireEvent.click(ask);
    expect(await screen.findByRole('dialog', { name: 'Ask AI' })).toBeTruthy();
    expect(ask.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(ask);
    expect(screen.queryByRole('dialog', { name: 'Ask AI' })).toBeNull();
  });

  it('keeps the left column\'s footer inside it, so the phone menu carries "Sign in" and "Powered by Folio"', async () => {
    stubFetch();
    renderSite(SITE, '/public/docs');
    await waitFor(() => expect(treeLinks().length).toBeGreaterThan(0));

    // The menu button is in the header; the aside is the collapsible column that holds the footer.
    expect(within(header()).getByRole('button', { name: 'Open the page menu' })).toBeTruthy();
    expect(sidebar().contains(screen.getByRole('link', { name: 'Sign in' }))).toBe(true);
    expect(sidebar().contains(screen.getByRole('link', { name: 'Powered by Folio' }))).toBe(true);
    // The footer is the last thing in the column, after the tree.
    const footer = sidebarFooter();
    expect(footer.contains(screen.getByRole('link', { name: 'Sign in' }))).toBe(true);
    expect(screen.getByRole('navigation', { name: 'Pages' }).compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('titles the tab "<page> · <space name>" and builds breadcrumbs from the tree path', async () => {
    stubFetch();
    renderSite(SITE, '/public/docs/p/p2');

    await waitFor(() => expect(screen.getByTestId('markdown-body').textContent).toContain('Run the installer.'));
    expect(document.title).toBe('Install · Docs Space');

    await waitFor(() => {
      const crumbs = screen.getByRole('navigation', { name: 'Breadcrumbs' });
      expect(within(crumbs).getByRole('link', { name: 'Guide' }).getAttribute('href')).toBe('/public/docs/p/p1');
    });
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumbs' });
    expect(within(crumbs).getByRole('link', { name: 'Docs' }).getAttribute('href')).toBe('/public/docs');
    expect(crumbs.querySelector('[aria-current="page"]')?.textContent).toBe('Install');
    // The parent of the open page starts expanded, so the open page's row is visible and highlighted.
    expect(treeLinks().find((a) => a.getAttribute('aria-current') === 'page')?.getAttribute('href')).toBe('/public/docs/p/p2');
  });

  it('in host mode every URL is rooted at "/"', async () => {
    stubFetch();
    renderSite({ ...SITE, mode: 'host' }, '/');

    await waitFor(() => expect(screen.getByTestId('markdown-body').getAttribute('data-public-site')).toBe('docs|/p/x1'));
    await waitFor(() => expect(treeLinks().length).toBeGreaterThan(0));
    expect(treeLinks().map((a) => a.getAttribute('href'))).toEqual(expect.arrayContaining(['/p/p1', '/p/p3']));
  });

  it('lists the pages when the space has no home page', async () => {
    stubFetch();
    renderSite({ ...SITE, homePageId: null }, '/public/docs');

    const index = await screen.findByRole('navigation', { name: 'All pages' });
    // The list is fully expanded, children included.
    expect(within(index).getByRole('link', { name: 'Install' }).getAttribute('href')).toBe('/public/docs/p/p2');
    expect(screen.queryByTestId('markdown-body')).toBeNull();
  });

  it('applies the site appearance: the stylesheet link, <html lang>, the title and logo, and the stable hooks for CSS', async () => {
    stubFetch();
    const site: PublicSiteInfo = {
      ...SITE,
      title: 'Acme Docs',
      lang: 'uk',
      logoUrl: '/api/public/spaces/docs/site-assets/logo.png?v=1',
      cssUrl: '/api/public/spaces/docs/site.css?v=abc',
    };
    const { unmount } = renderSite(site, '/public/docs');
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());

    const link = document.head.querySelector('link[rel="stylesheet"][href="/api/public/spaces/docs/site.css?v=abc"]');
    expect(link).not.toBeNull();
    expect(document.documentElement.lang).toBe('uk');

    // The site title replaces the space name (left column, breadcrumbs, document title) and the logo sits next to it.
    const aside = screen.getByRole('complementary', { name: 'Acme Docs' });
    expect(within(aside).getByText('Acme Docs')).toBeTruthy();
    expect(aside.querySelector('img')?.getAttribute('src')).toBe('/api/public/spaces/docs/site-assets/logo.png?v=1');
    expect(document.title).toBe('Guide · Acme Docs');

    // Hooks a site stylesheet can rely on.
    expect(document.querySelector('.folio-site')).not.toBeNull();
    for (const part of ['header', 'sidebar', 'main', 'footer', 'page']) {
      expect(document.querySelector(`[data-folio-site-part="${part}"]`), part).not.toBeNull();
    }

    // Leaving the site takes the stylesheet and the language with it.
    unmount();
    expect(document.head.querySelector('link[href="/api/public/spaces/docs/site.css?v=abc"]')).toBeNull();
    expect(document.documentElement.lang).not.toBe('uk');
  });

  it('says so, with a way back, when the page does not exist', async () => {
    stubFetch();
    renderSite(SITE, '/public/docs/p/gone');

    expect(await screen.findByText(/This page moved or was removed/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to the home page' }).getAttribute('href')).toBe('/public/docs');
  });

  it('offers downloads only when the space allows them', async () => {
    stubFetch();
    const { unmount } = renderSite(SITE, '/public/docs');
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
    unmount();

    renderSite({ ...SITE, allowDownload: true }, '/public/docs');
    expect(await screen.findByRole('button', { name: 'Download' })).toBeTruthy();
  });

  it('searches this space only, debounced, from a dialog the header button opens, and links hits to the site', async () => {
    const hit: SearchHit = { id: 'p2', space: 'docs', path: 'guide/install.md', title: 'Install', snippet: 'Run the installer' };
    const fetchMock = stubFetch({ '/api/public/spaces/docs/search?q=inst': { hits: [hit] } });
    renderSite(SITE, '/public/docs');
    await waitFor(() => expect(treeLinks().length).toBeGreaterThan(0));

    fireEvent.click(within(header()).getByRole('button', { name: 'Search this site' }));
    const input = screen.getByRole('searchbox');
    expect(screen.getByRole('dialog', { name: 'Search this site' })).toBeTruthy();
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: 'inst' } });
    const result = await screen.findByRole('link', { name: /Install\s*Run the installer/ });
    expect(result.getAttribute('href')).toBe('/public/docs/p/p2');
    expect(fetchMock).toHaveBeenCalledWith('/api/public/spaces/docs/search?q=inst', expect.anything());
    // The tree stays where it is; the results are in the dialog, not in the left column.
    expect(screen.getByRole('navigation', { name: 'Pages' })).toBeTruthy();
    expect(sidebar().contains(result)).toBe(false);

    // Following a hit closes the dialog and forgets the query.
    fireEvent.click(result);
    await waitFor(() => expect(screen.queryByRole('searchbox')).toBeNull());
    expect(screen.queryByRole('dialog', { name: 'Search this site' })).toBeNull();
    fireEvent.click(within(header()).getByRole('button', { name: 'Search this site' }));
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('');
  });

  it('opens the search with Ctrl+K, takes Enter on the highlighted hit and closes on Escape', async () => {
    const hits: SearchHit[] = [
      { id: 'p2', space: 'docs', path: 'guide/install.md', title: 'Install', snippet: 'Run the installer' },
      { id: 'p3', space: 'docs', path: 'p3.md', title: 'Reference', snippet: 'Install options' },
    ];
    stubFetch({ '/api/public/spaces/docs/search?q=inst': { hits } });
    renderSite(SITE, '/public/docs');
    await waitFor(() => expect(treeLinks().length).toBeGreaterThan(0));

    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    const input = screen.getByRole('searchbox');
    fireEvent.change(input, { target: { value: 'inst' } });
    await screen.findByRole('link', { name: /Reference\s*Install options/ }); // the tree has a plain "Reference" row too

    // ArrowDown moves to the second hit; Enter opens it.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('markdown-body').textContent).toContain('All the options.'));
    expect(screen.queryByRole('searchbox')).toBeNull();

    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' });
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('says what happened when nothing matches', async () => {
    stubFetch({ '/api/public/spaces/docs/search?q=zzz': { hits: [] } });
    renderSite(SITE, '/public/docs');
    fireEvent.click(await within(header()).findByRole('button', { name: 'Search this site' }));
    expect(screen.getByText('Type to search the pages of this site.')).toBeTruthy();

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz' } });
    expect(await screen.findByText('Nothing found for “zzz”')).toBeTruthy();
  });
});

describe('PublicSiteLoader', () => {
  function renderLoader(mode: 'path' | 'host') {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <PublicSiteLoader mode={mode} slug="docs" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('shows "this space is not public" with a sign-in link when the server says 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: false, status: 404, statusText: '', json: () => Promise.resolve({ error: 'not a public site' }) })),
    );
    renderLoader('path');

    expect(await screen.findByRole('heading', { name: 'This space is not public' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/s/docs?signin=1');
  });

  it('asks the Host-resolved route in host mode and the slug route in path mode', async () => {
    const fetchMock = stubFetch({ '/api/public/site': SITE, '/api/public/spaces/docs': SITE });
    renderLoader('host');
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith('/api/public/site', expect.anything());
    // The route knows it is on the site's own host, whatever the payload says.
    await waitFor(() => expect(treeLinks().length).toBeGreaterThan(0));
    expect(treeLinks().map((a) => a.getAttribute('href'))).toContain('/p/p1');
  });
});
