import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Folder, Home, FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PageMeta, TreeNode } from '@shared/contracts';
import { api } from '../api';
import { canEditContent } from '../auth/roles';
import { useApiErrorText } from '../errorText';
import { Modal } from '../ui/Modal';
import { childDirOf, excludeTemplatesFolder, getTopLevelNodes } from './treeUtils';
import '../i18n/register';

interface Destination {
  key: string;
  title: string;
  path: string;
  depth: number;
  folder: boolean;
}

function flattenDestinations(nodes: TreeNode[]): Destination[] {
  const result: Destination[] = [];
  const seen = new Set<string>();
  const walk = (items: TreeNode[], depth: number) => {
    for (const node of items) {
      const targetPath = childDirOf(node);
      if (!seen.has(targetPath)) {
        seen.add(targetPath);
        result.push({ key: node.id, title: node.title, path: targetPath, depth, folder: node.kind === 'folder' });
      }
      walk(node.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return result;
}

export interface CopyDialogProps {
  page: PageMeta;
  onClose: () => void;
  onCopied: (page: PageMeta) => void;
  onError: (message: string) => void;
}

/** Copies a page to the root or underneath any page in any writable space. */
export function CopyDialog({ page, onClose, onCopied, onError }: CopyDialogProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const spacesQuery = useQuery({ queryKey: ['spaces'], queryFn: api.listSpaces });
  const writableSpaces = (spacesQuery.data?.spaces ?? []).filter((space) => canEditContent(space.myRole));
  const [targetSpace, setTargetSpace] = useState(page.space);
  const [targetPath, setTargetPath] = useState('');
  const [includeChildren, setIncludeChildren] = useState(true);

  const treeQuery = useQuery({
    queryKey: ['tree', targetSpace],
    queryFn: () => api.getTree(targetSpace),
    enabled: Boolean(targetSpace),
  });
  const destinations = useMemo(
    () =>
      treeQuery.data
        ? flattenDestinations(excludeTemplatesFolder(getTopLevelNodes(treeQuery.data)))
        : [],
    [treeQuery.data],
  );

  const copy = useMutation({
    mutationFn: () => api.copyPage(page.id, { toSpace: targetSpace, toParentPath: targetPath, includeChildren }),
    onSuccess: (copied) => {
      onCopied(copied);
      onClose();
    },
    onError: (err) => onError(errorText(err, 'sidebar.copy.failed')),
  });

  return (
    <Modal
      title={t('sidebar.copy.title', { title: page.title })}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            {t('ui.cancel')}
          </button>
          <button
            type="button"
            disabled={copy.isPending || !targetSpace || treeQuery.isLoading}
            onClick={() => copy.mutate()}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {copy.isPending ? t('sidebar.copy.copying') : t('sidebar.copy.action')}
          </button>
        </>
      }
    >
      <label className="mb-1 block text-sm font-medium" htmlFor="copy-space">
        {t('sidebar.copy.space')}
      </label>
      <select
        id="copy-space"
        value={targetSpace}
        onChange={(event) => {
          setTargetSpace(event.target.value);
          setTargetPath('');
        }}
        className="mb-4 h-9 w-full rounded-md border border-neutral-300 bg-white px-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
      >
        {writableSpaces.map((space) => (
          <option key={space.slug} value={space.slug}>
            {space.name}
          </option>
        ))}
      </select>

      <div className="mb-1 text-sm font-medium">{t('sidebar.copy.destination')}</div>
      <div className="max-h-72 overflow-y-auto rounded-md border border-neutral-200 dark:border-neutral-700">
        <button
          type="button"
          onClick={() => setTargetPath('')}
          className={`flex w-full items-center gap-2 border-b border-neutral-100 px-2.5 py-2 text-left text-sm hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-800 ${
            targetPath === '' ? 'bg-neutral-100 font-medium dark:bg-neutral-800' : ''
          }`}
        >
          <Home size={14} className="shrink-0 opacity-60" />
          {t('sidebar.copy.spaceRoot')}
        </button>
        {destinations.map((destination) => (
          <button
            key={`${destination.key}:${destination.path}`}
            type="button"
            onClick={() => setTargetPath(destination.path)}
            style={{ paddingLeft: `${10 + destination.depth * 16}px` }}
            className={`flex w-full items-center gap-2 border-b border-neutral-100 px-2.5 py-2 text-left text-sm last:border-b-0 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-800 ${
              targetPath === destination.path ? 'bg-neutral-100 font-medium dark:bg-neutral-800' : ''
            }`}
          >
            {destination.folder ? <Folder size={14} className="shrink-0 opacity-60" /> : <FileText size={14} className="shrink-0 opacity-60" />}
            <span className="truncate">{destination.title}</span>
          </button>
        ))}
        {treeQuery.isLoading && <div className="px-3 py-3 text-sm text-neutral-400">{t('sidebar.tree.loading')}</div>}
        {treeQuery.isError && <div className="px-3 py-3 text-sm text-red-600">{t('sidebar.tree.loadFailed')}</div>}
      </div>
      <label className="mt-2 flex cursor-pointer items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={includeChildren}
          onChange={(event) => setIncludeChildren(event.target.checked)}
        />
        {t('sidebar.copy.includeChildren')}
      </label>
      <p className="mt-2 text-xs text-neutral-500">{t('sidebar.copy.hint')}</p>
    </Modal>
  );
}
