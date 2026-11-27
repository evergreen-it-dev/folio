import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ChevronRight, ClipboardList, Folder, LayoutDashboard, Presentation, Sheet, Table2, FileText, FileType2, Waypoints, Database, AppWindow } from 'lucide-react';
import { officeFormat, type TreeNode } from '@shared/contracts';
import { treeNodeDisplayTitles } from '../sidebar/treeUtils';
import { publicPageUrl, type PublicSiteRef } from './publicSite';
import { expandableIds, pathToNode } from './treePaths';
import '../i18n/register';

export interface PublicTreeProps {
  site: PublicSiteRef;
  /** The top-level nodes (sidebar/treeUtils' getTopLevelNodes of the public tree). */
  nodes: TreeNode[];
  /** The page on screen; highlighted, and its ancestors start open. */
  currentId?: string;
  /** `ancestors` (the sidebar): only the path to the current page is open. `all` (the home page's list): everything is. */
  defaultOpen?: 'ancestors' | 'all';
  /** Called when a page link is followed — the mobile drawer closes on it. */
  onNavigate?: () => void;
  ariaLabel: string;
}

/** The row's leading glyph: the page's emoji when it has one, else a glyph for kinds that look different once opened (a plain doc gets none, like the sidebar's). */
function NodeIcon({ node }: { node: TreeNode }): ReactNode {
  if (node.kind === 'folder') return <Folder size={14} className="shrink-0 opacity-60" aria-hidden="true" />;
  if (node.icon) return <span className="w-[14px] shrink-0 text-center text-[13px] leading-none">{node.icon}</span>;
  if (node.kind === 'board') return <LayoutDashboard size={14} className="shrink-0 opacity-60" aria-hidden="true" />;
  if (node.kind === 'table') return <Table2 size={14} className="shrink-0 opacity-60" aria-hidden="true" />;
  if (node.kind === 'pdf') return <FileType2 size={14} className="shrink-0 opacity-60" aria-hidden="true" />;
  if (node.kind === 'form') return <ClipboardList size={14} className="shrink-0 opacity-60" aria-hidden="true" />;
  if (node.kind === 'canvas') return <Waypoints size={14} className="shrink-0 opacity-60" aria-hidden="true" />;
  if (node.kind === 'base') return <Database size={14} className="shrink-0 opacity-60" aria-hidden="true" />;
  if (node.kind === 'artifact') return <AppWindow size={14} className="shrink-0 opacity-60" aria-hidden="true" />;
  if (node.kind === 'office') {
    const format = officeFormat(node.path);
    if (format === 'xlsx') return <Sheet size={14} className="shrink-0 opacity-60" aria-hidden="true" />;
    if (format === 'pptx') return <Presentation size={14} className="shrink-0 opacity-60" aria-hidden="true" />;
    return <FileText size={14} className="shrink-0 opacity-60" aria-hidden="true" />;
  }
  return <span className="w-[14px] shrink-0" aria-hidden="true" />;
}

/**
 * The read-only page tree of a public site: expand/collapse, the current page highlighted, every
 * page row a plain client-side <Link> to the site's own URL for it. Not the sidebar's PageTree on
 * purpose — that one is wired to the session (drag and drop, create/rename/move, stars, offline
 * pages) and to `useAuth`, none of which exists for an anonymous visitor.
 *
 * Folder rows (synthetic directories without a page of their own) only open and close; there is
 * no public folder listing to link to.
 */
export function PublicTree({ site, nodes, currentId, defaultOpen = 'ancestors', onNavigate, ariaLabel }: PublicTreeProps) {
  const { t } = useTranslation('app');
  // What the reader toggled by hand; everything else follows `defaultOpen`.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const defaultOpenIds = useMemo(() => {
    if (defaultOpen === 'all') return new Set(expandableIds(nodes));
    const chain = currentId ? pathToNode(nodes, currentId) : null;
    return new Set((chain ?? []).slice(0, -1).map((node) => node.id));
  }, [defaultOpen, nodes, currentId]);

  function isOpen(id: string): boolean {
    return toggled[id] ?? defaultOpenIds.has(id);
  }
  function toggle(id: string) {
    setToggled((prev) => ({ ...prev, [id]: !isOpen(id) }));
  }

  function renderNodes(list: TreeNode[], depth: number): ReactNode {
    const labels = treeNodeDisplayTitles(list);
    return list.map((node) => {
      const hasChildren = node.children.length > 0;
      const open = hasChildren && isOpen(node.id);
      const isFolder = node.kind === 'folder';
      const active = !isFolder && node.id === currentId;
      const title = labels.get(node.id) ?? node.title;
      const labelClass = `flex min-w-0 flex-1 items-center gap-1.5 truncate rounded-md px-1.5 py-1 text-left text-sm ${
        active
          ? 'bg-neutral-200/70 font-medium text-neutral-900 dark:bg-neutral-700/60 dark:text-neutral-50'
          : 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800/70'
      }`;
      return (
        <li key={node.id}>
          <div className="flex items-center" style={{ paddingLeft: `${depth * 0.75}rem` }}>
            {hasChildren ? (
              <button
                type="button"
                aria-label={t(open ? 'publicSite.tree.collapse' : 'publicSite.tree.expand', { title })}
                aria-expanded={open}
                onClick={() => toggle(node.id)}
                className="flex h-6 w-5 shrink-0 items-center justify-center rounded text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
              >
                <ChevronRight size={13} className={open ? 'rotate-90' : undefined} aria-hidden="true" />
              </button>
            ) : (
              <span className="w-5 shrink-0" aria-hidden="true" />
            )}
            {isFolder ? (
              <button type="button" onClick={() => toggle(node.id)} className={labelClass}>
                <NodeIcon node={node} />
                <span className="truncate">{title}</span>
              </button>
            ) : (
              <Link
                to={publicPageUrl(site, node.id)}
                aria-current={active ? 'page' : undefined}
                onClick={onNavigate}
                className={labelClass}
              >
                <NodeIcon node={node} />
                <span className="truncate">{title}</span>
              </Link>
            )}
          </div>
          {open && <ul>{renderNodes(node.children, depth + 1)}</ul>}
        </li>
      );
    });
  }

  return (
    <nav aria-label={ariaLabel}>
      <ul>{renderNodes(nodes, 0)}</ul>
    </nav>
  );
}
