import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronRight, House, LogIn, Menu as MenuIcon, X } from 'lucide-react';
import type { PublicSiteInfo } from '@shared/contracts';
import { api, ApiError } from '../api';
import { getTopLevelNodes, treeNodeDisplayTitle } from '../sidebar/treeUtils';
import { PublicAssistantSlot } from './PublicAssistantSlot';
import { PublicDownloadMenu } from './PublicDownloadMenu';
import { PublicPageBody } from './PublicPageBody';
import { PublicSearch } from './PublicSearch';
import { PublicTree } from './PublicTree';
import { pathToNode } from './treePaths';
import { FOLIO_PRODUCT_URL, PUBLIC_SITE_QUERY_KEY, appPageUrl, publicHomeUrl, publicPageUrl } from './publicSite';
import '../i18n/register';

export interface PublicSiteViewProps {
  site: PublicSiteInfo;
  /** The page in the URL; absent at the site's home, which opens `site.homePageId` (or lists the pages when the space has no home page). */
  pageId?: string;
}

/**
 * The public site's shell, laid out like the app's: a left column (the space name, "Space home", the
 * page tree, and a footer pinned to its bottom with "Sign in" and "Powered by Folio") and a main column
 * whose header carries the breadcrumbs, search, "Ask AI" and download, over the page. Rendered OUTSIDE
 * <AuthProvider> (see App.tsx), so nothing in it may touch a session: it reads the anonymous
 * /api/public/** routes only and builds every link with publicSite.ts. On a phone the left column
 * (footer included) folds behind a menu button, and the header's search and Ask AI shrink to icons.
 */
export function PublicSiteView({ site, pageId }: PublicSiteViewProps) {
  const { t } = useTranslation('app');
  const [menuOpen, setMenuOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const effectiveId = pageId ?? site.homePageId ?? undefined;
  // The home is open at its own URL, and on the home page's `/p/<id>` URL too (the breadcrumbs treat it as the root as well).
  const atHome = !effectiveId || effectiveId === site.homePageId;

  const treeQuery = useQuery({
    queryKey: [PUBLIC_SITE_QUERY_KEY, site.space, 'tree'],
    queryFn: () => api.getPublicTree(site.space),
    staleTime: 60_000,
    retry: false,
  });
  const pageQuery = useQuery({
    queryKey: [PUBLIC_SITE_QUERY_KEY, site.space, 'page', effectiveId],
    queryFn: () => api.getPublicPage(site.space, effectiveId!),
    enabled: Boolean(effectiveId),
    retry: false,
  });

  const nodes = useMemo(() => (treeQuery.data ? getTopLevelNodes({ tree: treeQuery.data.tree }) : []), [treeQuery.data]);
  const page = pageQuery.data?.page;
  // The server answered an id that no longer exists with the page it used to mean (server/storage.ts findMovedPage):
  // move the address bar to the page's current address, so the link that is shared from here is the stable one.
  const navigate = useNavigate();
  const movedTo = page && effectiveId && page.id !== effectiveId ? page.id : undefined;
  useEffect(() => {
    if (movedTo) navigate(publicPageUrl(site, movedTo), { replace: true });
  }, [movedTo, navigate, site]);
  // The site's own title (.folio/site.json) wins over the space's name.
  const spaceName = site.title ?? pageQuery.data?.spaceName ?? site.name;
  const siteName = site.title ?? site.name;

  // `<page> · <space>`; restored on the way out, like useDocumentTitle does for the app.
  useEffect(() => {
    const original = document.title;
    document.title = page ? `${page.title} · ${spaceName}` : spaceName;
    return () => {
      document.title = original;
    };
  }, [page, spaceName]);

  // The site's stylesheet (.folio/site.css, sanitized by the server): linked while the site is on screen. A server-rendered
  // <link> to the same URL is reused, not duplicated, and stays when the site unmounts.
  useEffect(() => {
    const href = site.cssUrl;
    if (!href) return;
    const present = Array.from(document.head.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')).some((link) => link.getAttribute('href') === href);
    if (present) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
    return () => link.remove();
  }, [site.cssUrl]);

  // <html lang> from site.json, put back on the way out.
  useEffect(() => {
    const lang = site.lang;
    if (!lang) return;
    const original = document.documentElement.lang;
    document.documentElement.lang = lang;
    return () => {
      document.documentElement.lang = original;
    };
  }, [site.lang]);

  // The page area is its own scroll container, so moving to another page must not keep the previous page's scroll offset.
  useEffect(() => {
    mainRef.current?.scrollTo?.(0, 0);
  }, [effectiveId]);

  // Closing the drawer on Escape is the one keyboard affordance a modal-ish panel needs.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  // Ancestors of the page on screen, for the breadcrumbs. The home page is the site's root: no trail below the space name.
  const crumbs = useMemo(() => {
    if (!page || page.id === site.homePageId) return [];
    const chain = pathToNode(nodes, page.id);
    if (!chain) return [{ key: page.id, title: page.title, to: undefined as string | undefined, current: true }];
    return chain.map((node, index) => ({
      key: node.id,
      title: treeNodeDisplayTitle(node, index === 0 ? nodes : chain[index - 1].children),
      to: node.kind === 'folder' || node.id === page.id ? undefined : publicPageUrl(site, node.id),
      current: node.id === page.id,
    }));
  }, [page, nodes, site]);

  const pageNotFound = pageQuery.isError && pageQuery.error instanceof ApiError && pageQuery.error.status === 404;

  return (
    <div className="folio-site flex h-full min-h-0 bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      {menuOpen && <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => setMenuOpen(false)} aria-hidden="true" />}

      <aside
        aria-label={siteName}
        data-folio-site-part="sidebar"
        className={`${
          menuOpen ? 'fixed inset-y-0 left-0 z-40 flex shadow-xl' : 'hidden'
        } w-72 max-w-[85vw] shrink-0 flex-col border-r border-neutral-200 bg-neutral-50 md:static md:z-auto md:flex md:max-w-none md:shadow-none dark:border-neutral-800 dark:bg-neutral-900`}
      >
        {/* Same row as the app sidebar's top (h-14, hairline below), so the two columns line up with the header. */}
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-neutral-200 px-4 dark:border-neutral-800">
          <Link
            to={publicHomeUrl(site)}
            onClick={() => setMenuOpen(false)}
            className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold tracking-tight text-neutral-900 dark:text-neutral-100"
          >
            {site.logoUrl && <img src={site.logoUrl} alt="" className="h-6 w-auto max-w-[8rem] shrink-0 object-contain" />}
            <span className="min-w-0 truncate">{siteName}</span>
          </Link>
          <button
            type="button"
            aria-label={t('publicSite.closeMenu')}
            onClick={() => setMenuOpen(false)}
            className="rounded p-1 text-neutral-500 hover:bg-neutral-200/70 md:hidden dark:hover:bg-neutral-800"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        {/* The app sidebar's "Space home" row: highlighted while the home is open (the home page, or the page list of a space without one). */}
        <Link
          to={publicHomeUrl(site)}
          onClick={() => setMenuOpen(false)}
          aria-current={atHome ? 'page' : undefined}
          className={`mx-2 mt-2 flex shrink-0 items-center gap-2 rounded-md px-2 py-2 text-left text-sm md:py-1.5 ${
            atHome
              ? 'bg-neutral-200/70 font-medium text-neutral-900 dark:bg-neutral-700/60 dark:text-neutral-50'
              : 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800/70'
          }`}
        >
          <House size={14} className="opacity-60" aria-hidden="true" />
          {t('publicSite.nav.home')}
        </Link>

        <div className="mt-2 min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {treeQuery.isLoading && <p className="px-1.5 py-2 text-xs text-neutral-400">{t('ui.loading')}</p>}
          {treeQuery.isError && <p className="px-1.5 py-2 text-xs text-red-600 dark:text-red-400">{t('publicSite.treeFailed')}</p>}
          {treeQuery.data && (
            <PublicTree
              site={site}
              nodes={nodes}
              currentId={effectiveId}
              onNavigate={() => setMenuOpen(false)}
              ariaLabel={t('publicSite.tree.label')}
            />
          )}
        </div>

        {/* Pinned to the bottom like the app sidebar's user menu: the way into the app, and the product credit. */}
        <div data-folio-site-part="footer" className="shrink-0 border-t border-neutral-200 p-2 dark:border-neutral-800">
          <a
            href={appPageUrl(site, effectiveId)}
            className="flex items-center gap-2 rounded-md px-2 py-2 text-sm text-neutral-700 hover:bg-neutral-100 md:py-1.5 dark:text-neutral-300 dark:hover:bg-neutral-800/70"
          >
            <LogIn size={14} className="opacity-60" aria-hidden="true" />
            {t('publicSite.signIn')}
          </a>
          {/* The product site, for promotion: a plain link (no nofollow) that opens in a new tab. */}
          <a
            href={FOLIO_PRODUCT_URL}
            target="_blank"
            rel="noopener"
            className="block px-2 py-1 text-xs text-neutral-400 hover:text-neutral-700 dark:text-neutral-500 dark:hover:text-neutral-300"
          >
            {t('publicSite.poweredBy')}
          </a>
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Heights and padding as the app's header (header/Header.tsx). No backdrop-blur and no z-index on purpose: the Ask AI sheet and the search dialog are `fixed` inside it, and a backdrop-filter would make the header their containing block. */}
        <header
          data-folio-site-part="header"
          className="flex h-14 shrink-0 items-center gap-2 border-b border-neutral-200 bg-white px-3 dark:border-neutral-800 dark:bg-neutral-950"
        >
          <button
            type="button"
            aria-label={t('publicSite.openMenu')}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(true)}
            className="inline-flex shrink-0 items-center justify-center rounded-md p-1.5 text-neutral-500 hover:bg-neutral-100 max-md:min-h-10 max-md:min-w-10 md:hidden dark:hover:bg-neutral-800"
          >
            <MenuIcon size={18} aria-hidden="true" />
          </button>
          <nav aria-label={t('publicSite.breadcrumbs')} className="min-w-0 flex-1">
            <ol className="flex min-w-0 items-center gap-1 text-sm text-neutral-500 dark:text-neutral-400">
              <li className="min-w-0 shrink-0 truncate">
                <Link to={publicHomeUrl(site)} className="hover:text-neutral-900 dark:hover:text-neutral-100">
                  {siteName}
                </Link>
              </li>
              {crumbs.map((crumb) => (
                <Fragment key={crumb.key}>
                  <li aria-hidden="true" className="shrink-0">
                    <ChevronRight size={13} />
                  </li>
                  <li className="min-w-0 truncate">
                    {crumb.to ? (
                      <Link to={crumb.to} className="hover:text-neutral-900 dark:hover:text-neutral-100">
                        {crumb.title}
                      </Link>
                    ) : (
                      <span aria-current={crumb.current ? 'page' : undefined} className={crumb.current ? 'font-medium text-neutral-900 dark:text-neutral-100' : undefined}>
                        {crumb.title}
                      </span>
                    )}
                  </li>
                </Fragment>
              ))}
            </ol>
          </nav>
          <PublicSearch site={site} />
          {site.allowAssistant && <PublicAssistantSlot site={site} pageId={effectiveId} />}
          {site.allowDownload && page && page.kind !== 'folder' && (
            <div className="shrink-0">
              <PublicDownloadMenu space={site.space} pageId={page.id} pagePath={page.path} title={page.title} />
            </div>
          )}
        </header>

        <main ref={mainRef} data-folio-site-part="main" className="min-h-0 flex-1 overflow-auto">
          {pageQuery.isLoading && <div className="p-8 text-sm text-neutral-400">{t('ui.loading')}</div>}
          {pageNotFound && (
            <div className="p-8 text-sm text-neutral-500 dark:text-neutral-400">
              <p>{t('publicSite.pageNotFound')}</p>
              <Link to={publicHomeUrl(site)} className="mt-2 inline-block text-blue-600 underline underline-offset-2 dark:text-blue-400">
                {t('publicSite.backHome')}
              </Link>
            </div>
          )}
          {pageQuery.isError && !pageNotFound && (
            <div className="p-8 text-sm text-red-600 dark:text-red-400">{t('publicSite.loadFailed')}</div>
          )}
          {page && (
            <div data-folio-site-part="page" className="h-full">
              <PublicPageBody site={site} page={page} />
            </div>
          )}
          {!effectiveId && (
            <div className="mx-auto max-w-2xl px-6 py-10">
              <h1 className="mb-4 text-2xl font-semibold tracking-tight">{siteName}</h1>
              {treeQuery.isLoading && <p className="text-sm text-neutral-400">{t('ui.loading')}</p>}
              {treeQuery.data && nodes.length === 0 && <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('publicSite.empty')}</p>}
              {treeQuery.data && nodes.length > 0 && (
                <PublicTree site={site} nodes={nodes} defaultOpen="all" ariaLabel={t('publicSite.index.label')} />
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
