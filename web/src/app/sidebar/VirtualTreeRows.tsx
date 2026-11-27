import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { defaultRangeExtractor, observeElementRect, useVirtualizer, type Range } from '@tanstack/react-virtual';
import type { TreeNode } from '@shared/contracts';
import { TreeIndentGuide, TreeRow, type TreeRowProps } from './TreeRow';
import { visibleTreeRows } from './treeUtils';

type Props = Omit<TreeRowProps, 'node' | 'depth' | 'siblings' | 'parentPath' | 'displayTitle' | 'flat' | 'onKeepMountedChange'> & {
  nodes: TreeNode[];
  scrollTo: { id: string; block: ScrollLogicalPosition } | null;
};

const FOCUS_TARGETS = '[data-tree-page-id], button:not(:disabled), input:not([type="file"]):not(:disabled)';

export function VirtualTreeRows({ nodes, scrollTo, ...props }: Props) {
  const holder = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => visibleTreeRows(nodes, props.expanded), [nodes, props.expanded]);
  const virtual = rows.length > 100;
  const rowHeight = typeof matchMedia === 'function' && matchMedia('(max-width: 767px)').matches ? 56 : 27;
  const [margin, setMargin] = useState(0);
  const [kept, setKept] = useState<ReadonlySet<string>>(() => new Set());
  const [focused, setFocused] = useState<string | null>(null);
  const [focusTo, setFocusTo] = useState<{ index: number; last: boolean } | null>(null);
  const indexById = useMemo(() => new Map(rows.map((row, index) => [row.node.id, index])), [rows]);
  const getItemKey = useCallback((index: number) => rows[index].node.id, [rows]);
  const keepMounted = useCallback((id: string, keep: boolean) => {
    setKept((previous) => {
      if (previous.has(id) === keep) return previous;
      const next = new Set(previous);
      if (keep) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const pinned = useMemo(() => {
    const ids = [...kept, focused, props.dragged?.node.id, scrollTo?.id];
    const indices = ids.flatMap((id) => {
      const index = id ? indexById.get(id) : undefined;
      return index === undefined ? [] : [index];
    });
    if (focusTo) indices.push(focusTo.index);
    return indices;
  }, [kept, focused, props.dragged, scrollTo, indexById, focusTo]);
  const virtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count: rows.length,
    enabled: virtual,
    getScrollElement: () => holder.current?.closest('nav') ?? null,
    getItemKey,
    estimateSize: () => rowHeight,
    overscan: 8,
    indexAttribute: 'data-tree-row-index',
    scrollMargin: margin,
    initialRect: { width: 280, height: 600 },
    observeElementRect: (instance, callback) => observeElementRect(instance, (rect) => callback({ width: rect.width || 280, height: rect.height || 600 })),
    measureElement: (element) => element.getBoundingClientRect().height || rowHeight,
    scrollToFn: (offset, options, instance) => {
      const element = instance.scrollElement;
      if (!element) return;
      if (typeof element.scrollTo === 'function') element.scrollTo({ top: offset + (options.adjustments ?? 0), behavior: options.behavior });
      else {
        element.scrollTop = offset + (options.adjustments ?? 0);
        queueMicrotask(() => element.dispatchEvent(new Event('scroll')));
      }
    },
    rangeExtractor: useCallback((range: Range) => [...new Set([...defaultRangeExtractor(range), ...pinned])].sort((a, b) => a - b), [pinned]),
  });

  // The page-tree shares its scrolling nav with the section label and the
  // templates/agent/tag sections. Account for its position rather than add a
  // nested scrollbar or take those sections out of the normal document flow.
  useLayoutEffect(() => {
    const element = holder.current;
    const scroller = element?.closest('nav');
    if (!element || !scroller || !virtual) return;
    const measure = () => setMargin(element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop);
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : undefined;
    observer?.observe(element);
    observer?.observe(scroller);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [virtual]);

  useLayoutEffect(() => {
    if (!scrollTo || !virtual) return;
    const index = indexById.get(scrollTo.id);
    if (index !== undefined) virtualizer.scrollToIndex(index, { align: scrollTo.block === 'center' ? 'center' : 'auto' });
  }, [scrollTo, indexById, margin, virtual, virtualizer]);

  useEffect(() => {
    if (!focusTo) return;
    if (virtual) virtualizer.scrollToIndex(focusTo.index, { align: 'auto' });
    const row = holder.current?.querySelector<HTMLElement>(`[data-tree-row-index="${focusTo.index}"]`);
    const targets = row?.querySelectorAll<HTMLElement>(FOCUS_TARGETS);
    const target = targets?.[focusTo.last ? targets.length - 1 : 0];
    target?.focus({ preventScroll: true });
    setFocusTo(null);
  }, [focusTo, virtual, virtualizer]);

  const items = virtual ? virtualizer.getVirtualItems() : rows.map((_, index) => ({ index, key: rows[index].node.id, start: 0 }));
  return (
    <div
      ref={holder}
      role="tree"
      className="relative"
      style={virtual ? { height: virtualizer.getTotalSize() } : undefined}
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        const target = event.target as HTMLElement;
        const wrapper = target.closest<HTMLElement>('[data-tree-row-index]');
        if (!wrapper || target.matches('input, textarea, [contenteditable="true"]')) return;
        const index = Number(wrapper.dataset.treeRowIndex);
        const atRow = target.hasAttribute('data-tree-page-id');
        let next: number | undefined;
        if (atRow && event.key === 'ArrowDown') next = index + 1;
        if (atRow && event.key === 'ArrowUp') next = index - 1;
        if (atRow && event.key === 'Home') next = 0;
        if (atRow && event.key === 'End') next = rows.length - 1;
        if (atRow && event.key === 'ArrowRight' && rows[index].node.children.length) {
          event.preventDefault();
          if (props.expanded.has(rows[index].node.id)) next = index + 1;
          else props.setExpanded((previous) => new Set(previous).add(rows[index].node.id));
        }
        if (atRow && event.key === 'ArrowLeft') {
          event.preventDefault();
          if (props.expanded.has(rows[index].node.id)) props.setExpanded((previous) => { const result = new Set(previous); result.delete(rows[index].node.id); return result; });
          else {
            for (let parent = index - 1; parent >= 0; parent--) {
              if (rows[parent].depth < rows[index].depth) { next = parent; break; }
            }
          }
        }
        if (event.key === 'Tab') {
          const focusables = [...wrapper.querySelectorAll<HTMLElement>(FOCUS_TARGETS)];
          if (!event.shiftKey && target === focusables.at(-1) && !holder.current?.querySelector(`[data-tree-row-index="${index + 1}"]`)) next = index + 1;
          if (event.shiftKey && target === focusables[0] && !holder.current?.querySelector(`[data-tree-row-index="${index - 1}"]`)) next = index - 1;
        }
        if (next !== undefined && next >= 0 && next < rows.length) {
          event.preventDefault();
          setFocusTo({ index: next, last: event.key === 'Tab' && event.shiftKey });
        }
      }}
    >
      {items.map((item) => {
        const row = rows[item.index];
        return (
          <div
            key={item.key}
            data-tree-row-index={item.index}
            role="treeitem"
            aria-level={row.depth + 1}
            aria-posinset={row.siblingIndex + 1}
            aria-setsize={row.siblings.length}
            aria-expanded={row.node.children.length ? props.expanded.has(row.node.id) : undefined}
            ref={virtual ? virtualizer.measureElement : undefined}
            className="relative"
            style={virtual ? { position: 'absolute', top: item.start - margin, left: 0, width: '100%' } : undefined}
            onFocusCapture={() => setFocused(row.node.id)}
            onBlurCapture={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused((current) => current === row.node.id ? null : current);
            }}
          >
            {Array.from({ length: row.depth }, (_, depth) => <TreeIndentGuide key={depth} depth={depth} />)}
            <TreeRow {...props} {...row} flat onKeepMountedChange={keepMounted} />
          </div>
        );
      })}
    </div>
  );
}
