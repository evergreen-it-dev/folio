import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { LayoutTemplate, Plus } from 'lucide-react';
import { ChevronGlyph, RowIconBox, kindIconProps } from '../sidebar/PageGlyph';
import type { TreeNode } from '@shared/contracts';
import { useLocalStorage } from '../hooks';
import { useConnectivity } from '../offline/connectivity';
import { TreeRow } from '../sidebar/TreeRow';
import type { DraggedNode } from '../sidebar/TreeRow';
import { TEMPLATES_FOLDER, collectDirectories } from '../sidebar/treeUtils';
import { MakeTemplateDialog } from './MakeTemplateDialog';
import { OPEN_TEMPLATES_SECTION_EVENT, templatesSectionOpenKey } from './templatesSectionState';
import { useTemplates, useTemplatesTree } from './useTemplates';
import '../i18n/register';

export interface TemplatesSectionProps {
  space: string;
  activeId: string | undefined;
  activeFolderPath: string | undefined;
}

/** Template rows show no git-conflict dots; an empty set, stable between renders. */
const NO_CONFLICTS: Set<string> = new Set();

/**
 * The sidebar's "Templates" section (editors only — Sidebar gates it): the
 * space's `_templates/` folder, hidden from the page tree, as a tree of its
 * own. Collapsed until opened (remembered per space). Rows are the ordinary
 * TreeRow in `templateMode`: open, rename, delete, add a subpage.
 */
export function TemplatesSection({ space, activeId, activeFolderPath }: TemplatesSectionProps) {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const offline = useConnectivity() === 'offline';

  const [open, setOpen] = useLocalStorage(templatesSectionOpenKey(space), false);
  // "Make template" opens the section so the new template is in sight (templatesSectionState.ts).
  useEffect(() => {
    const onOpen = (event: Event) => {
      if ((event as CustomEvent<{ space?: string }>).detail?.space === space) setOpen(true);
    };
    window.addEventListener(OPEN_TEMPLATES_SECTION_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_TEMPLATES_SECTION_EVENT, onOpen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [space]);
  const [expandedArray, setExpandedArray] = useLocalStorage<string[]>(`folio:templates-expanded:${space}`, []);
  const expanded = useMemo(() => new Set(expandedArray), [expandedArray]);
  const setExpanded = (updater: (prev: Set<string>) => Set<string>) => {
    setExpandedArray((prevArray) => Array.from(updater(new Set(prevArray))));
  };
  const [dragged, setDragged] = useState<DraggedNode | null>(null);

  // The count in the header comes from the (cheap) top-level list; the tree is fetched once the section is opened.
  const { templates } = useTemplates(space);
  const { data: treeData, isLoading, isError, refetch } = useTemplatesTree(space, open);
  const nodes = useMemo<TreeNode[]>(() => {
    if (!treeData) return [];
    // Tolerate the folder itself coming back as the single root.
    if (treeData.length === 1 && treeData[0].kind === 'folder' && treeData[0].path === TEMPLATES_FOLDER) return treeData[0].children;
    return treeData;
  }, [treeData]);
  const directories = useMemo(() => collectDirectories(nodes), [nodes]);

  // Descriptions of the top-level templates, shown as the rows' tooltips.
  const descriptions = useMemo(() => new Map(templates.filter((tpl) => tpl.description).map((tpl) => [tpl.id, tpl.description as string])), [templates]);
  const [creating, setCreating] = useState(false);

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        title={t('sidebar.templates.hint')}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        className="group flex cursor-pointer items-center gap-2 rounded-md py-2 pl-1 pr-2 text-left text-[13px] leading-5 text-neutral-800 hover:bg-neutral-200/60 md:py-[3px] dark:text-neutral-200 dark:hover:bg-white/[0.06]"
      >
        <RowIconBox><LayoutTemplate {...kindIconProps} /></RowIconBox>
        <span className="min-w-0 flex-1 truncate">{t('sidebar.templates.title')}</span>
        {templates.length > 0 && <span className="shrink-0 text-xs text-neutral-400 dark:text-neutral-500">{templates.length}</span>}
        <button
          type="button"
          aria-label={t('sidebar.templates.add')}
          title={offline ? t('sidebar.templates.offlineHint') : t('sidebar.templates.add')}
          disabled={offline}
          onClick={(e) => {
            e.stopPropagation();
            setCreating(true);
          }}
          className="flex shrink-0 items-center justify-center rounded p-1 text-neutral-500 hover:bg-neutral-200 disabled:opacity-50 max-md:min-h-10 max-md:min-w-10 dark:text-neutral-400 dark:hover:bg-neutral-700"
        >
          <Plus size={13} />
        </button>
        <ChevronGlyph open={open} />
      </div>

      {open && (
        <div className="flex flex-col gap-0.5">
          {isLoading ? (
            <div className="px-3 py-1.5 text-xs text-neutral-400">{t('sidebar.tree.loading')}</div>
          ) : isError && !treeData ? (
            <div className="px-3 py-1.5 text-xs text-red-600 dark:text-red-400">
              {t('sidebar.tree.loadFailed')}{' '}
              <button type="button" onClick={() => void refetch()} className="underline underline-offset-2">
                {t('auth.retry')}
              </button>
            </div>
          ) : nodes.length === 0 ? (
            <div className="px-3 py-1.5 text-xs text-neutral-400">{t('sidebar.templates.empty')}</div>
          ) : (
            nodes.map((node) => (
              <TreeRow
                key={node.id}
                node={node}
                space={space}
                depth={0}
                activeId={activeId}
                activeFolderPath={activeFolderPath}
                expanded={expanded}
                setExpanded={setExpanded}
                directories={directories}
                siblings={nodes}
                parentPath={TEMPLATES_FOLDER}
                dragged={dragged}
                setDragged={setDragged}
                canEdit
                conflictedIds={NO_CONFLICTS}
                templateMode
                descriptions={descriptions}
              />
            ))
          )}
        </div>
      )}

      {creating && (
        <MakeTemplateDialog space={space} mode="new" onClose={() => setCreating(false)} onCreated={(page) => navigate(`/s/${space}/p/${page.id}`)} />
      )}
    </div>
  );
}
