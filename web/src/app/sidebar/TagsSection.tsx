import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Hash, MoreHorizontal, Pencil, Tags } from 'lucide-react';
import { ChevronGlyph, DisclosureChevron, RowIconBox, kindIconProps } from './PageGlyph';
import { api } from '../api';
import { useLocalStorage } from '../hooks';
import { Menu, MenuItem } from '../ui/Menu';
import { RenameTagDialog } from './RenameTagDialog';
import { buildTagTree } from './tagTree';
import type { TagNode } from './tagTree';
import '../i18n/register';

export interface TagsSectionProps {
  space: string;
  /** Editor+ in this space: the rename action is offered. */
  canEdit: boolean;
  /** A tag was picked: the host opens the quick switcher with `tag:<tag>`. */
  onOpenTag: (tag: string) => void;
}

/**
 * "Tags": every tag the caller can see in the space (GET /tags), as the tree its `/`
 * hierarchy describes, with page counts. Clicking a tag searches it (the quick switcher
 * already lists pages); editors get "Rename tag…" in a row menu. Collapsed by default and
 * absent altogether while the space has no tags (or the server predates the route).
 */
export function TagsSection({ space, canEdit, onOpenTag }: TagsSectionProps) {
  const { t } = useTranslation('app');
  const { data } = useQuery({
    queryKey: ['space-tags', space],
    queryFn: () => api.getSpaceTags(space),
    staleTime: 30_000,
    retry: false,
  });
  const [open, setOpen] = useLocalStorage<boolean>(`folio:tags-open:${space}`, false);
  const [expandedArray, setExpandedArray] = useLocalStorage<string[]>(`folio:tags-expanded:${space}`, []);
  const [renaming, setRenaming] = useState<string | null>(null);

  const tags = data?.tags;
  const tree = useMemo(() => buildTagTree(Array.isArray(tags) ? tags : []), [tags]);
  if (tree.length === 0) return null;

  const expanded = new Set(expandedArray);
  const toggle = (tag: string) =>
    setExpandedArray((previous) => (previous.includes(tag) ? previous.filter((item) => item !== tag) : [...previous, tag]));

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="group flex w-full items-center gap-2 rounded-md py-2 pl-1 pr-2 text-left text-[13px] leading-5 text-neutral-800 hover:bg-neutral-200/60 md:py-[3px] dark:text-neutral-200 dark:hover:bg-white/[0.06]"
      >
        <RowIconBox><Tags {...kindIconProps} /></RowIconBox>
        <span className="min-w-0 flex-1 truncate">{t('tags.title')}</span>
        <span className="shrink-0 text-xs text-neutral-400">{tags?.length}</span>
        <ChevronGlyph open={open} />
      </button>

      {open && (
        <div className="flex flex-col gap-0.5">
          {tree.map((node) => (
            <TagRow
              key={node.tag}
              node={node}
              depth={0}
              expanded={expanded}
              onToggle={toggle}
              canEdit={canEdit}
              onOpenTag={onOpenTag}
              onRename={setRenaming}
            />
          ))}
        </div>
      )}

      {renaming && <RenameTagDialog space={space} tag={renaming} onClose={() => setRenaming(null)} />}
    </div>
  );
}

interface TagRowProps {
  node: TagNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (tag: string) => void;
  canEdit: boolean;
  onOpenTag: (tag: string) => void;
  onRename: (tag: string) => void;
}

function TagRow({ node, depth, expanded, onToggle, canEdit, onOpenTag, onRename }: TagRowProps) {
  const { t } = useTranslation('app');
  const hasChildren = node.children.length > 0;
  const isOpen = expanded.has(node.tag);

  return (
    <div>
      <div
        className="group flex items-center rounded-md pr-1 hover:bg-neutral-200/60 dark:hover:bg-neutral-800/70"
        style={{ paddingLeft: depth * 12 + 4 }}
      >
        <button
          type="button"
          title={t('tags.search', { tag: node.tag })}
          onClick={() => onOpenTag(node.tag)}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-2 text-left text-sm text-neutral-700 md:py-1 dark:text-neutral-300"
        >
          <Hash size={12} className="shrink-0 opacity-50" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
          {node.pages !== null && <span className="shrink-0 text-xs text-neutral-400">{node.pages}</span>}
        </button>
        {canEdit && (
          <span className="shrink-0 opacity-0 focus-within:opacity-100 group-hover:opacity-100 max-md:opacity-100">
            <Menu triggerLabel={t('tags.menu', { tag: node.tag })} align="right" trigger={<MoreHorizontal size={13} />}>
              {(close) => (
                <MenuItem
                  icon={<Pencil size={14} />}
                  onSelect={() => {
                    close();
                    onRename(node.tag);
                  }}
                >
                  {t('tags.rename.menu')}
                </MenuItem>
              )}
            </Menu>
          </span>
        )}
        {hasChildren && (
          <DisclosureChevron
            open={isOpen}
            label={t(isOpen ? 'tags.collapse' : 'tags.expand', { tag: node.tag })}
            onToggle={() => onToggle(node.tag)}
          />
        )}
      </div>
      {hasChildren && isOpen && (
        <div className="flex flex-col gap-0.5">
          {node.children.map((child) => (
            <TagRow
              key={child.tag}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              canEdit={canEdit}
              onOpenTag={onOpenTag}
              onRename={onRename}
            />
          ))}
        </div>
      )}
    </div>
  );
}
