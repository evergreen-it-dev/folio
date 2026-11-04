/**
 * Inline comments in Reading mode — and so the only way a read-only viewer
 * comments, since the editor (and with it CodeMirror's selection toolbar) is
 * not mounted for them. The mapping between the rendered page and the source is
 * editor/comment-reading.ts's job; this file is the DOM glue: paint the
 * highlights, notice a click on one, offer a "Comment" button over a selection.
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { MessageSquarePlus } from 'lucide-react';
import { normalizeEol } from '../../editor/collab-sync';
import { isCommentShortcut, type CommentMark } from '../../editor/comment-highlights';
import { paintReadingHighlights, rangesInRendered, sourceRangeOfSelection, threadAtPoint } from '../../editor/comment-reading';
import { debounce } from '../../editor/debounce';
import '../i18n/register';

const PROSE = '.folio-editor__prose';

function proseOf(root: RefObject<HTMLElement | null>): HTMLElement | null {
  return root.current?.querySelector<HTMLElement>(PROSE) ?? null;
}

export interface ReadingCommentsOptions {
  enabled: boolean;
  canComment: boolean;
  rootRef: RefObject<HTMLElement | null>;
  /** The markdown Reading mode is showing. */
  markdown: string;
  marks: readonly CommentMark[];
  activeId: string | null;
  /** A card asked to be shown in the text. */
  reveal: { id: string } | null;
  onOpenThread(id: string): void;
  onStart(range: { from: number; to: number }): void;
  /** The selection could not be tied to the source. */
  onUnanchorable(): void;
}

export function useReadingComments(options: ReadingCommentsOptions): void {
  const { enabled, canComment, rootRef, markdown, marks, activeId, reveal, onOpenThread, onStart, onUnanchorable } = options;
  const text = useMemo(() => normalizeEol(markdown), [markdown]);
  const [ranges, setRanges] = useState<ReadonlyMap<string, Range>>(new Map());

  // Where each open thread sits on the page. The renderer may fill the page in
  // after this runs (code highlighting, diagrams), so DOM changes recompute.
  useEffect(() => {
    const prose = enabled ? proseOf(rootRef) : null;
    if (!prose) {
      setRanges((prev) => (prev.size === 0 ? prev : new Map()));
      return;
    }
    const compute = () => setRanges(rangesInRendered(prose, text, marks));
    compute();
    const later = debounce(compute, 250);
    const observer = new MutationObserver(later);
    observer.observe(prose, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      later.cancel();
    };
  }, [enabled, rootRef, text, marks]);

  useEffect(() => paintReadingHighlights(ranges, activeId), [ranges, activeId]);

  // A click on a highlight (not the end of a selection) opens its thread.
  useEffect(() => {
    const prose = enabled ? proseOf(rootRef) : null;
    if (!prose) return;
    const onClick = (event: MouseEvent) => {
      if (!window.getSelection()?.isCollapsed) return;
      const id = threadAtPoint(ranges, event.clientX, event.clientY);
      if (id) onOpenThread(id);
    };
    prose.addEventListener('click', onClick);
    return () => prose.removeEventListener('click', onClick);
  }, [enabled, rootRef, ranges, onOpenThread]);

  // Once per request: the ranges are recomputed whenever the page changes, which must not drag the reader back.
  const handled = useRef(reveal);
  useEffect(() => {
    const target = reveal ? ranges.get(reveal.id)?.startContainer.parentElement : null;
    if (!reveal || reveal === handled.current || !target) return;
    handled.current = reveal;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [reveal, ranges]);

  // ⌘⌥M with a selection on the page.
  useEffect(() => {
    if (!enabled || !canComment) return;
    const onKey = (event: KeyboardEvent) => {
      if (!isCommentShortcut(event)) return;
      const prose = proseOf(rootRef);
      const selection = window.getSelection();
      if (!prose || !selection || selection.rangeCount === 0 || selection.isCollapsed) return;
      const range = selection.getRangeAt(0);
      if (!prose.contains(range.commonAncestorContainer)) return;
      event.preventDefault();
      const found = sourceRangeOfSelection(prose, text, range);
      if (found) onStart(found);
      else onUnanchorable();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [enabled, canComment, rootRef, text, onStart, onUnanchorable]);
}

/** The "Comment" button that floats over a selection in the rendered page. */
export function ReadingCommentButton({
  rootRef,
  markdown,
  onStart,
  onUnanchorable,
}: {
  rootRef: RefObject<HTMLElement | null>;
  markdown: string;
  onStart(range: { from: number; to: number }): void;
  onUnanchorable(): void;
}) {
  const { t } = useTranslation('app');
  const [spot, setSpot] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const update = () => {
      const prose = proseOf(rootRef);
      const selection = window.getSelection();
      if (!prose || !selection || selection.rangeCount === 0 || selection.isCollapsed) return setSpot(null);
      const range = selection.getRangeAt(0);
      if (!prose.contains(range.commonAncestorContainer)) return setSpot(null);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return setSpot(null);
      // A phone shows its own selection menu above the text: go below it.
      const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
      setSpot({ x: rect.left + rect.width / 2, y: coarse ? rect.bottom + 36 : rect.top - 8 });
    };
    const later = debounce(update, 120);
    document.addEventListener('selectionchange', later);
    window.addEventListener('scroll', later, true);
    window.addEventListener('resize', later);
    return () => {
      document.removeEventListener('selectionchange', later);
      window.removeEventListener('scroll', later, true);
      window.removeEventListener('resize', later);
      later.cancel();
    };
  }, [rootRef]);

  if (!spot) return null;
  const run = () => {
    const prose = proseOf(rootRef);
    const selection = window.getSelection();
    if (!prose || !selection || selection.rangeCount === 0) return;
    const found = sourceRangeOfSelection(prose, normalizeEol(markdown), selection.getRangeAt(0));
    if (found) onStart(found);
    else onUnanchorable();
  };
  return createPortal(
    <button
      type="button"
      // Keeps the selection: a button that clears what was selected cannot comment on it.
      onMouseDown={(event) => event.preventDefault()}
      onClick={run}
      style={{ position: 'fixed', left: Math.max(48, Math.min(spot.x, window.innerWidth - 48)), top: Math.max(8, spot.y), transform: 'translate(-50%, -100%)' }}
      className="z-50 inline-flex items-center gap-1.5 rounded-full bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white shadow-lg hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
    >
      <MessageSquarePlus size={14} aria-hidden="true" />
      {t('comments.comment')}
    </button>,
    document.body,
  );
}
