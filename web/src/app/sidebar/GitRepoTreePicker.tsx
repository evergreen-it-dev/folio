import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Folder, Loader2 } from 'lucide-react';
import { api } from '../api';
import '../i18n/register';

export interface GitRepoTreePickerProps {
  repoUrl: string;
  branch: string;
  /** Best-effort — see this file's own docblock; omitted falls back to SERVER's host-based auto-token match. */
  credentialId?: string;
  selectedPath: string;
  onSelect: (path: string) => void;
}

/**
 * Round 19 (#6-ux): lazy, visual directory-tree picker for rootPath, backed
 * by GET /api/git/tree (SERVER's temporary shallow-clone-per-(repoUrl,
 * branch), cached ~10min server-side — see server/gitTree.ts). Expanding a
 * node fetches its own next level on demand (one useQuery per node, keyed
 * on its own path, enabled only once expanded); clicking a directory's name
 * calls onSelect with that path. The text field this augments
 * (CreateSpaceDialog's rootPath) stays independently editable throughout —
 * this is an ADD-ON way to fill it, never a replacement, and it never
 * disables or hides that field.
 *
 * Silent degrade on ANY root-level failure (server/gitTree.ts's endpoint
 * 404ing while still being built, a network error, or a repo/branch/
 * credential combination that just isn't browsable) — renders nothing at
 * all in that case, per DEV-PLAN's own instruction ("on an error or when the
 * endpoint is unavailable we silently stay with manual entry, as now").
 * A NESTED node's own expand failure is more local and handled separately
 * (react-query's isError on that one node — collapsing and re-expanding
 * retries; the rest of an already-rendered tree stays usable).
 */
export function GitRepoTreePicker({ repoUrl, branch, credentialId, selectedPath, onSelect }: GitRepoTreePickerProps) {
  const { t } = useTranslation('app');
  const root = useQuery({
    queryKey: ['git-tree', repoUrl, branch, credentialId, ''],
    queryFn: () => api.getGitTree({ repoUrl, branch, path: '', credentialId }),
    retry: false,
  });

  if (root.isLoading) {
    return (
      <p className="flex items-center gap-1.5 px-1 py-1 text-xs text-neutral-400 dark:text-neutral-500">
        <Loader2 size={12} className="animate-spin" aria-hidden="true" />
        {t('ui.loading')}
      </p>
    );
  }

  // Silent degrade — see this component's own docblock. The caller's plain
  // rootPath text input is the only rootPath UI in this case, same as
  // before this feature existed.
  if (root.isError || !root.data) return null;

  return (
    <div>
      <p className="mb-1 text-xs text-neutral-500 dark:text-neutral-400">{t('sidebar.createSpace.rootPathTreeLabel')}</p>
      <div className="max-h-40 overflow-y-auto rounded-md border border-neutral-200 p-1 text-sm dark:border-neutral-700">
        {/* The repo root itself (rootPath="") is always selectable — it never
            needs its own expand toggle since its children are exactly the
            dirs list already fetched above. */}
        <div className="flex items-center gap-0.5">
          <span className="w-[18px] shrink-0" aria-hidden="true" />
          <button
            type="button"
            onClick={() => onSelect('')}
            className={`flex min-w-0 flex-1 items-center gap-1 truncate rounded px-1 py-0.5 text-left ${
              selectedPath === ''
                ? 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900'
                : 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800'
            }`}
          >
            <Folder size={12} className="shrink-0" aria-hidden="true" />
            <span className="truncate">{t('sidebar.createSpace.rootPathTreeRoot')}</span>
          </button>
        </div>
        {root.data.dirs.map((dir) => (
          <GitRepoTreeNode
            key={dir}
            path={dir}
            repoUrl={repoUrl}
            branch={branch}
            credentialId={credentialId}
            depth={1}
            selectedPath={selectedPath}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
}

interface GitRepoTreeNodeProps {
  /** Full path from the repo root, e.g. "docs" or "docs/architecture". */
  path: string;
  repoUrl: string;
  branch: string;
  credentialId?: string;
  depth: number;
  selectedPath: string;
  onSelect: (path: string) => void;
}

function GitRepoTreeNode({ path, repoUrl, branch, credentialId, depth, selectedPath, onSelect }: GitRepoTreeNodeProps) {
  const { t } = useTranslation('app');
  const [expanded, setExpanded] = useState(false);
  const name = path.split('/').pop() ?? path;

  const children = useQuery({
    queryKey: ['git-tree', repoUrl, branch, credentialId, path],
    queryFn: () => api.getGitTree({ repoUrl, branch, path, credentialId }),
    enabled: expanded,
    retry: false,
  });

  return (
    <div>
      <div className="flex items-center gap-0.5" style={{ paddingLeft: `${depth * 14}px` }}>
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-label={t('sidebar.createSpace.rootPathTreeToggle')}
          className="shrink-0 rounded p-0.5 text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          {expanded && children.isLoading ? (
            <Loader2 size={12} className="animate-spin" aria-hidden="true" />
          ) : expanded ? (
            <ChevronDown size={12} aria-hidden="true" />
          ) : (
            <ChevronRight size={12} aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          onClick={() => onSelect(path)}
          title={path}
          className={`flex min-w-0 flex-1 items-center gap-1 truncate rounded px-1 py-0.5 text-left ${
            selectedPath === path
              ? 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900'
              : 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800'
          }`}
        >
          <Folder size={12} className="shrink-0" aria-hidden="true" />
          <span className="truncate">{name}</span>
        </button>
      </div>
      {expanded && children.data && (
        <div>
          {children.data.dirs.length === 0 ? (
            <p
              className="py-0.5 text-xs text-neutral-400 dark:text-neutral-500"
              style={{ paddingLeft: `${(depth + 1) * 14 + 20}px` }}
            >
              {t('sidebar.createSpace.rootPathTreeEmpty')}
            </p>
          ) : (
            children.data.dirs.map((dir) => (
              <GitRepoTreeNode
                key={dir}
                path={`${path}/${dir}`}
                repoUrl={repoUrl}
                branch={branch}
                credentialId={credentialId}
                depth={depth + 1}
                selectedPath={selectedPath}
                onSelect={onSelect}
              />
            ))
          )}
        </div>
      )}
      {/* A nested node's OWN expand failure is local — no message, just
          stays collapsed-looking (chevron reverts once isLoading clears);
          clicking again retries. Never bubbles up to hide the whole tree. */}
    </div>
  );
}
