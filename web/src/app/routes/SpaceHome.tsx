import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api';
import { useApiErrorText } from '../errorText';
import { excludeTemplatesFolder, findSpaceRootPage, getTopLevelNodes } from '../sidebar/treeUtils';
import { PageContent } from './PageContent';
import { FolderListing } from './FolderView';
import { NotFound } from './NotFound';
import '../i18n/register';

/**
 * `/s/:space` — the space's front door, staying at the stable space-root URL.
 *
 * Normally that is `index.md`. QA-3 P1 #2: it isn't always. A space created
 * from an ordinary git repository has a `README.md` at its root and no
 * index.md at all, and `GET /api/resolve?path=index.md` cannot find it — the
 * server's README fallback is built as `${path}/README.md`, so for the literal
 * path `index.md` it goes looking for `index.md/README.md` and 404s. The old
 * code turned that page-level 404 into "Space "X" not found", i.e. it told
 * the user their space did not exist while the sidebar was rendering that very
 * space's tree beside the message.
 *
 * So a 404 here is now a question, not a verdict: ask the tree. If the tree
 * comes back, the space plainly exists —
 *   - it has a root page (README.md / index.md) -> render that page;
 *   - it has none -> render the root as a synthetic listing, exactly what
 *     FolderView already does for any index-less directory.
 * Only a space that the TREE endpoint also refuses gets the "no such space"
 * screen. See findSpaceRootPage in sidebar/treeUtils.ts, and the server-side
 * requirement recorded in the round report (resolve('index.md') should fall
 * back to the root README on its own).
 */
export function SpaceHome() {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const { space = '' } = useParams<{ space: string }>();

  const home = useQuery({
    queryKey: ['resolve', space, 'index.md'],
    queryFn: () => api.resolve(space, 'index.md'),
    retry: false,
  });

  const indexMissing = home.isError && home.error instanceof ApiError && home.error.status === 404;
  // A private space the user is not a member of answers 403 (it exists, they
  // can't see it). Owner's call (07.09.2026): show the same 404 screen with a
  // «maybe you lack access — ask for it» line instead of a red API error.
  const noAccess = home.isError && home.error instanceof ApiError && home.error.status === 403;

  // Same key the sidebar and FolderView use, so this is a cache read rather
  // than a second request in every case where the tree is already loaded.
  const tree = useQuery({
    queryKey: ['tree', space],
    queryFn: () => api.getTree(space),
    enabled: indexMissing,
    retry: false,
  });

  if (home.isLoading || (indexMissing && tree.isLoading)) {
    return <div className="p-8 text-sm text-neutral-400">{t('routes.spaceHome.loading')}</div>;
  }

  if (home.data) return <PageContent id={home.data.id} />;

  if (indexMissing && tree.data) {
    const rootPage = findSpaceRootPage(tree.data);
    if (rootPage) return <PageContent id={rootPage.id} />;
    return (
      <FolderListing
        space={space}
        title={space}
        entries={excludeTemplatesFolder(getTopLevelNodes(tree.data))}
      />
    );
  }

  // The space itself is gone (or was never there): the tree endpoint says so too.
  if (indexMissing || noAccess) {
    return <NotFound message={t('routes.spaceHome.notFound', { space })} hint={t('routes.notFound.maybeNoAccess')} space={space} />;
  }

  return (
    <div className="p-8 text-sm text-red-600 dark:text-red-400">
      {t('routes.spaceHome.openFailed')}
      {home.error ? `: ${errorText(home.error)}` : ''}.
    </div>
  );
}
