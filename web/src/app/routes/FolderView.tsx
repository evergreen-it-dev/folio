import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ClipboardList, FileText, FileType2, Folder, LayoutDashboard, Presentation, Sheet, Table2 } from 'lucide-react';
import { officeFormat, type TreeNode } from '@shared/contracts';
import { api } from '../api';
import { useDocumentTitle } from '../hooks';
import { useSetHeaderInfo } from '../Shell';
import { findNodeByPath, treeNodeDisplayTitle } from '../sidebar/treeUtils';
import { NotFound } from './NotFound';
import '../i18n/register';

function humanize(segment: string): string {
  return segment.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * The listing itself, split out of FolderView so SpaceHome can render the
 * SPACE ROOT with it (QA-3 P1 #2: a space whose root has neither index.md nor
 * a README the server will resolve still has a perfectly good tree — showing
 * it beats a 404 that claims the space doesn't exist).
 */
export function FolderListing({ space, title, entries }: { space: string; title: string; entries: TreeNode[] }) {
  const { t } = useTranslation('app');
  const navigate = useNavigate();

  return (
    <div className="mx-auto max-w-2xl p-8">
      <div className="mb-6 flex items-center gap-2.5">
        <Folder size={22} className="shrink-0 text-neutral-400" aria-hidden="true" />
        <div>
          <h1 className="text-xl font-bold text-neutral-900 dark:text-neutral-100">{title}</h1>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('routes.folder.syntheticHint')}</p>
        </div>
      </div>

      {entries.length === 0 ? (
        <p className="text-sm text-neutral-400">{t('routes.folder.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {entries.map((child) => {
            const displayTitle = treeNodeDisplayTitle(child, entries);
            // Round 26: a data table is a page kind of its own, so it gets
            // its own glyph here — the href is the ordinary page route (a
            // table has a real page id, unlike a synthetic folder node).
            // Round OFFICE: a docx/xlsx/pptx page also gets a glyph per its
            // actual format (officeFormat), not a single generic one.
            const officeFmt = child.kind === 'office' ? officeFormat(child.path) : undefined;
            const ChildIcon =
              child.kind === 'board'
                ? LayoutDashboard
                : child.kind === 'table'
                  ? Table2
                  : child.kind === 'form'
                    ? ClipboardList
                    : child.kind === 'folder'
                      ? Folder
                      : child.kind === 'pdf'
                        ? FileType2
                        : officeFmt === 'xlsx'
                          ? Sheet
                          : officeFmt === 'pptx'
                            ? Presentation
                            : FileText;
            const to = child.kind === 'folder' ? `/s/${space}/d/${child.path}` : `/s/${space}/p/${child.id}`;
            return (
              <li key={child.id}>
                <button
                  type="button"
                  onClick={() => navigate(to)}
                  className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  <ChildIcon size={16} className="shrink-0 opacity-60" aria-hidden="true" />
                  <span className="truncate text-neutral-800 dark:text-neutral-200" title={displayTitle === child.title ? child.title : `${child.title} · ${child.path}`}>
                    {displayTitle}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * `/s/:space/d/*` — a synthetic listing page for a repo folder that has
 * neither index.md nor README.md (those get a normal doc node from the
 * server instead — "nothing special needed" there, per DEV-PLAN). Read-only
 * by construction: there is no file backing this page, so no editor.
 */
export function FolderView() {
  const { t } = useTranslation('app');
  const { space = '' } = useParams<{ space: string }>();
  const params = useParams();
  const path = params['*'] ?? '';

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['tree', space],
    queryFn: () => api.getTree(space),
  });

  const node = useMemo(() => (data ? findNodeByPath(data.tree, path) : undefined), [data, path]);
  const fallbackTitle = humanize(path.split('/').filter(Boolean).pop() ?? space);
  const title = node?.title ?? fallbackTitle;

  useDocumentTitle(title);
  useSetHeaderInfo(node ? { pagePath: node.path, title } : null);

  if (isLoading) {
    return <div className="p-8 text-sm text-neutral-400">{t('ui.loading')}</div>;
  }

  if (isError || !data) {
    return (
      <div className="p-8 text-sm text-red-600 dark:text-red-400">
        {t('routes.folder.loadFailed')}{' '}
        <button type="button" onClick={() => refetch()} className="underline underline-offset-2">
          {t('auth.retry')}
        </button>
      </div>
    );
  }

  if (!node || node.kind !== 'folder') {
    return <NotFound message={t('routes.folder.notFound')} hint={t('routes.notFound.maybeNoAccess')} space={space} />;
  }

  return <FolderListing space={space} title={title} entries={node.children} />;
}
