import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Bot, FileText, LayoutDashboard, Plus, SpellCheck, Table2 } from 'lucide-react';
import { ChevronGlyph, RowIconBox, kindIconProps } from './PageGlyph';
import { AGENT_FOLDER } from '@shared/contracts';
import type { PageKind } from '@shared/contracts';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { useLocalStorage } from '../hooks';
import { AgentDemoNote } from '../AgentDemoNote';
import { useToast } from '../ui/Toast';
import { Menu, MenuItem } from '../ui/Menu';
import { TreeRow } from './TreeRow';
import type { DraggedNode } from './TreeRow';
import { collectDirectories, findAgentFolderNode } from './treeUtils';
import { newPageTitleKey } from './slugUtils';
import '../i18n/register';

export interface AgentSectionProps {
  space: string;
  /** My role in this space is admin — the ONLY gate this section is shown under (owner spec, 21.09.2026). Callers check this before rendering at all. */
  activeId: string | undefined;
  activeFolderPath: string | undefined;
}

/**
 * The `.agent` section — admin-only, own node, distinct from the normal page
 * tree (owner spec, 21.09.2026: "a place to drop pages describing how the
 * assistant should behave in this space"). Shares the `['tree', space]`
 * query cache with PageTree (no extra request); PageTree itself hides the
 * `.agent` node from the normal listing (treeUtils.excludeAgentFolder) so it
 * never appears twice.
 *
 * Rendered UNCONDITIONALLY once the caller has confirmed admin — even when
 * the space has no `.agent` pages yet, so there is always a "+" to create
 * the first one. A non-admin never even mounts this component (Sidebar.tsx
 * gates it), which is also, separately, exactly what the server already
 * guarantees (the `.agent` node simply isn't in their tree response).
 */

/** Conflict markers in `.agent` are not highlighted: this section is kept by
 *  admins by hand, and a git conflict in it is a rare case that shows in the
 *  space banner. An empty set, stable between renders. */
const NO_CONFLICTS: Set<string> = new Set();

export function AgentSection({ space, activeId, activeFolderPath }: AgentSectionProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const navigate = useNavigate();
  const showToast = useToast();
  const queryClient = useQueryClient();

  const { data } = useQuery({ queryKey: ['tree', space], queryFn: () => api.getTree(space) });
  const [open, setOpen] = useLocalStorage(`folio:agent-section-open:${space}`, false);
  const [expandedArray, setExpandedArray] = useLocalStorage<string[]>(`folio:agent-expanded:${space}`, []);
  const expanded = new Set(expandedArray);
  const setExpanded = (updater: (prev: Set<string>) => Set<string>) => {
    setExpandedArray((prevArray) => Array.from(updater(new Set(prevArray))));
  };
  const [dragged, setDragged] = useState<DraggedNode | null>(null);

  const agentNode = data ? findAgentFolderNode(data.tree) : undefined;
  const children = agentNode?.children ?? [];
  const directories = data ? collectDirectories(data.tree) : [AGENT_FOLDER];

  const createChild = useMutation({
    mutationFn: (kind: PageKind) => api.createPage({ space, parentPath: AGENT_FOLDER, title: t(newPageTitleKey(kind)), kind }),
    onSuccess: (page) => {
      queryClient.invalidateQueries({ queryKey: ['tree', space] });
      setOpen(true);
      navigate(`/s/${space}/p/${page.id}`);
    },
    onError: (err) => showToast(errorText(err, 'sidebar.createPageFailed')),
  });

  // "Create writing rules": offered until the space has `.agent/writing-rules.md` (SpaceInfo.agentRules.writingRules).
  const { data: spacesData } = useQuery({ queryKey: ['spaces'], queryFn: api.listSpaces });
  const hasWritingRules = spacesData?.spaces.find((s) => s.slug === space)?.agentRules?.writingRules === true;
  const createRules = useMutation({
    mutationFn: () => api.createWritingRules(space),
    onSuccess: (page) => {
      queryClient.invalidateQueries({ queryKey: ['tree', space] });
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
      setOpen(true);
      navigate(`/s/${space}/p/${page.id}`);
    },
    onError: (err) => showToast(errorText(err, 'sidebar.agent.createRulesFailed')),
  });

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        // The name ".agent" by itself tells nobody anything (the owner, 17.09:
        // "it has to be clear what this is") — a hint on hover explains the
        // section, and expanded it also explains itself with the text below.
        title={t('sidebar.agent.hint')}
        aria-label={`${AGENT_FOLDER} — ${t('sidebar.agent.hint')}`}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        className="group flex cursor-pointer items-center gap-2 rounded-md py-2 pl-1 pr-2 text-left text-[13px] leading-5 text-neutral-800 hover:bg-neutral-200/60 md:py-[3px] dark:text-neutral-200 dark:hover:bg-white/[0.06]"
      >
        <RowIconBox><Bot {...kindIconProps} /></RowIconBox>
        <span className="min-w-0 flex-1 truncate">{AGENT_FOLDER}</span>
        <span
          className="ml-auto shrink-0 opacity-0 focus-within:opacity-100 group-hover:opacity-100"
          onClick={(e) => e.stopPropagation()}
        >
          <Menu triggerLabel={t('sidebar.tree.addPage')} trigger={<Plus size={13} />}>
            {(close) => (
              <>
                <MenuItem
                  icon={<FileText size={14} />}
                  onSelect={() => {
                    close();
                    createChild.mutate('doc');
                  }}
                >
                  {t('sidebar.newPage')}
                </MenuItem>
                <MenuItem
                  icon={<LayoutDashboard size={14} />}
                  onSelect={() => {
                    close();
                    createChild.mutate('board');
                  }}
                >
                  {t('sidebar.newBoard')}
                </MenuItem>
                <MenuItem
                  icon={<Table2 size={14} />}
                  onSelect={() => {
                    close();
                    createChild.mutate('table');
                  }}
                >
                  {t('sidebar.newTable')}
                </MenuItem>
              </>
            )}
          </Menu>
        </span>
        <ChevronGlyph open={open} />
      </div>

      {open && (
        <div className="flex flex-col gap-0.5">
          <p className="px-3 pb-1 text-[11px] leading-snug text-neutral-400 dark:text-neutral-500">{t('sidebar.agent.about')}</p>
          <AgentDemoNote className="px-3 pb-1" />
          {spacesData && !hasWritingRules && (
            <button
              type="button"
              onClick={() => createRules.mutate()}
              disabled={createRules.isPending}
              title={t('sidebar.agent.createRulesHint')}
              className="mx-3 mb-1 flex items-center gap-1.5 rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              <SpellCheck size={12} aria-hidden="true" />
              {t('sidebar.agent.createRules')}
            </button>
          )}
          {children.length === 0 ? (
            <div className="px-3 py-1.5 text-xs text-neutral-400">{t('sidebar.agent.empty')}</div>
          ) : (
            children.map((node) => (
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
                siblings={children}
                parentPath={AGENT_FOLDER}
                dragged={dragged}
                setDragged={setDragged}
                canEdit
            conflictedIds={NO_CONFLICTS}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}
