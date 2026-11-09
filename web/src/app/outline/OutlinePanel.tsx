import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  ChevronDown,
  Circle,
  Info,
  Lightbulb,
  ListTree,
  MessageSquareWarning,
  OctagonAlert,
  Square,
  PanelRightClose,
  PanelRightOpen,
  X,
  type LucideIcon,
} from 'lucide-react';
import { scrollActiveEditorToHeading, scrollActiveEditorToOffset } from '../../editor';
import { extractHeadings, HEADING_ID_PREFIX } from '../../markdown/headings';
import { extractNotes, type NoteKind } from '../../markdown/notes';
import { extractTodos } from '../../markdown/todos';
import { flashEditorTodo, flashReadingNote, flashReadingTodo } from './todoFlash';
import { setPanelHidden, usePanelHidden, useRegisterPanel, useToolbarButtonMounted } from './panelVisibility';
import { useLocalStorage } from '../hooks';
import '../i18n/register';
import { useLiveDocText } from '../liveDocText';
import { useParams } from 'react-router';
import { LocalGraphSection } from '../graph/LocalGraphSection';
import { PanelSection } from './PanelSection';

/** One icon per NoteEntry.kind — a compact visual hint for what kind of entry a row is. */
const NOTE_ICONS: Record<NoteKind, LucideIcon> = {
  note: Info,
  tip: Lightbulb,
  important: MessageSquareWarning,
  warning: AlertTriangle,
  caution: OctagonAlert,
  task: Square,
};

/** The row's text without its `@handle` tokens (they are shown after it, in the accent colour). */
function todoBody(text: string, assignees: readonly string[]): string {
  const stripped = text.replace(/^\s*TODO\b[:\s]*/i, '').replace(/(^|\s)@[\p{L}\p{N}_.-]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return stripped || text;
}

/** The filter choice for "no assignee" — a value no `@handle` can collide with. */
const NO_ASSIGNEE = ':none';

export interface OutlinePanelProps {
  /** Raw page markdown — frontmatter (icon/cover) is stripped internally by extractHeadings, no need to pre-clean it here. */
  markdown: string;
  /**
   * The page being summarised. Only used to pick up the LIVE document text
   * (app/liveDocText.ts) when an editor is mounted for it — without this the
   * lists are built from the server's last snapshot and a heading typed in
   * Live edit never appears (owner, 11.09). Undefined on surfaces that have
   * no editor (a share view), where `markdown` is the only source anyway.
   */
  pageId?: string;
  /**
   * The page's title. A leading H1 equal to it is not listed in the outline: the title is right there on the page and
   * a first entry that repeats it only pushes the real sections down.
   */
  title?: string;
}

/**
 * Right-side table-of-contents panel for doc pages (Round 5). Headings come
 * from the same extractHeadings() + HEADING_ID_PREFIX the rendering pipeline
 * uses (markdown/headings.ts, markdown/headingIds.ts) so a clicked entry's
 * target id always matches what the pipeline actually assigned — *when* a
 * match exists in the DOM at all.
 *
 * This panel mounts for every doc page regardless of the editor's own mode
 * (source/live/reading — see editor/index.tsx), but only "reading" mode
 * renders real `<h1-6 id="user-content-...">` elements (via <Markdown>);
 * source/live show plain CodeMirror text with no heading DOM at all. Round
 * 19 QA fix (#2-shell, was a deliberate no-op in source/live — the owner
 * didn't want that): clicking now goes through editor/'s own
 * scrollActiveEditorToHeading(slug) first, which reaches whichever
 * CodeMirror view is actually mounted (editor/index.tsx registers/clears it
 * on mount/unmount — see scroll-to-heading.ts) without this panel ever
 * touching an EditorView itself, puts the caret on that heading's line and
 * scrolls it to the top. That returns false in reading mode (no CodeMirror
 * mounted there at all) or if the slug genuinely isn't in the document, and
 * scrollTo() below falls back to the old getElementById(...).scrollIntoView
 * for exactly that case — reading mode's own <h1-6 id> DOM. The
 * IntersectionObserver active-heading highlight below is unchanged: it only
 * ever observes DOM elements that exist, so it still simply never lights
 * anything up in source/live (nothing to fix there — there is no scroll
 * position of a CodeMirror surface for it to track against these slugs).
 *
 * Heading *source*: this panel is fed the page's last REST-fetched markdown
 * (PageContent's `data.markdown`), not the editor's live Yjs document —
 * those can drift apart during an active collaborative edit in source/live
 * mode (see editor/index.tsx's useDocumentText). Acceptable: they're seeded
 * from the same content and only diverge while someone is actively typing
 * unsaved changes, and reading mode (where the outline actually does
 * anything) always shows the live text via the same <Markdown> instance
 * this panel's slugs are computed to match.
 *
 * The DOCKED panel (below) auto-hides below ~1100px viewport width via the
 * min-[1100px]: variant (CSS-only — stays mounted rather than unmounting on
 * a resize, so the open/closed choice and the observer subscription survive
 * it). Round 22 (owner prod QA on a real tablet/narrow viewport): that CSS
 * cutoff used to mean NO way at all to reach the TOC below 1100px — between
 * that and Header.tsx's own, unrelated 768px reflow (its "⋯" popover only
 * covers History/Share/Star), the outline was simply unreachable on
 * anything narrower than 1100px. `mobileOpen` below is a second, independent
 * (non-persisted) open state for a `min-[1100px]:hidden` floating trigger +
 * full-height overlay drawer, covering exactly that gap — entirely
 * self-contained here rather than threaded up into Header/Shell, since the
 * heading data/scroll wiring already lives in this file alone.
 *
 * The "Notes" section below the heading list (owner ask, round 30ish) is the
 * same idea one level down: markdown/notes.ts's extractNotes() finds every
 * `[!TYPE]` callout and checklist item on the page, purely from `markdown`,
 * the same way extractHeadings() finds headings — and a click resolves the
 * same two-step way scrollTo() below already does for a heading slug: the
 * mounted CodeMirror view first (scrollActiveEditorToOffset, keyed by raw
 * offset rather than a slug — a note entry has no slug of its own), then the
 * reading view's own rendered DOM, found by `data-note-index` rather than
 * `id` (markdown/noteIds.ts stamps it in the SAME order extractNotes finds
 * entries in — see that module's own doc comment for the one deliberate gap,
 * a checklist marker inside a table cell). A completed checklist item is
 * still counted (so the "N done" counter and the numbering both include it)
 * but hidden from the visible list by default — see doneCount/totalTasks
 * below.
 */
export function OutlinePanel({ markdown, pageId, title }: OutlinePanelProps) {
  const { t } = useTranslation('app');
  // Live text wins while someone is typing; the server snapshot is the
  // fallback for reading-only surfaces and for the moment before the collab
  // session connects.
  const live = useLiveDocText(pageId);
  const source = live ?? markdown;
  const allHeadings = useMemo(() => extractHeadings(source), [source]);
  const headings = useMemo(() => {
    const first = allHeadings[0];
    if (first && first.level === 1 && title !== undefined && first.text.trim().toLowerCase() === title.trim().toLowerCase()) return allHeadings.slice(1);
    return allHeadings;
  }, [allHeadings, title]);
  const notes = useMemo(() => extractNotes(source), [source]);
  const todos = useMemo(() => extractTodos(source), [source]);
  const [outlineOpen, setOutlineOpen] = useLocalStorage('folio:outline-open', true);
  // Round 30 tail (owner, 11.09: "now notes open only together with the
  // outline, and they have to be independent"): the two lists are separate reading aids
  // — a long document you're navigating by heading is exactly the document
  // whose notes you may want out of the way, and vice versa. So each keeps its
  // own persisted open/closed state, and the rail shows an icon for whichever
  // one is currently put away.
  const [notesOpen, setNotesOpen] = useLocalStorage('folio:notes-open', true);
  // TODO lines (markdown/todos.ts) are a fourth section with the same own open/closed state, plus an
  // assignee filter: 'all', '@handle' or NO_ASSIGNEE.
  const [todosOpen, setTodosOpen] = useLocalStorage('folio:todos-open', true);
  const [assigneeChoice, setAssigneeChoice] = useLocalStorage('folio:todos-assignee', 'all');
  // Graph view (16.10.2026): the page's local graph, a third section with its own open/closed state. Only where
  // there is a space and a page (not on a share link).
  const { space } = useParams<{ space: string }>();
  const panelHidden = usePanelHidden();
  // The show/hide button lives in the editor's toolbar row; only where there is no such row (no editor on the page)
  // does the panel carry its own.
  const toolbarButton = useToolbarButtonMounted();
  const hasGraph = !!space && !!pageId;
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);

  // `data-note-index` (assigned by noteIds.ts) is this entry's position in
  // the FULL `notes` array, not in whatever filtered subset ends up on
  // screen — carry it alongside each entry so a completed task hidden from
  // view still resolves to the right element.
  const indexedNotes = useMemo(() => notes.map((entry, index) => ({ entry, index })), [notes]);
  const visibleNotes = indexedNotes.filter(({ entry }) => !(entry.kind === 'task' && entry.checked));
  const totalTasks = notes.filter((entry) => entry.kind === 'task').length;
  const doneTasks = notes.filter((entry) => entry.kind === 'task' && entry.checked).length;

  const assigneeHandles = useMemo(
    () => [...new Set(todos.flatMap((entry) => entry.assignees))].sort(),
    [todos],
  );
  const someUnassigned = todos.some((entry) => entry.assignees.length === 0);
  const assigneeOptions = ['all', ...assigneeHandles.map((handle) => `@${handle}`), ...(someUnassigned ? [NO_ASSIGNEE] : [])];
  // A choice remembered from another page may not exist here: act as "All" without overwriting it.
  const assignee = assigneeOptions.includes(assigneeChoice) ? assigneeChoice : 'all';
  const visibleTodos = todos.filter((entry) =>
    assignee === 'all'
      ? true
      : assignee === NO_ASSIGNEE
        ? entry.assignees.length === 0
        : entry.assignees.includes(assignee.slice(1)),
  );

  // Escape closes the <1100px overlay drawer — same convention as
  // ui/Modal.tsx's own keydown handler.
  useEffect(() => {
    if (!mobileOpen) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setMobileOpen(false);
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [mobileOpen]);

  useEffect(() => {
    if (headings.length === 0) return;
    let observer: IntersectionObserver | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const attach = () => {
      const targets = headings
        .map((h) => document.getElementById(HEADING_ID_PREFIX + h.slug))
        .filter((el): el is HTMLElement => el !== null);
      if (targets.length === 0) {
        // No heading DOM (yet): the reading view may still be loading — look again for a few seconds. In
        // source/live there never is any, and the retries simply run out.
        if (attempts++ < 20) retry = setTimeout(attach, 500);
        return;
      }
      const visible = new Set<string>();
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const slug = entry.target.id.slice(HEADING_ID_PREFIX.length);
            if (entry.isIntersecting) visible.add(slug);
            else visible.delete(slug);
          }
          if (visible.size === 0) return;
          // Earliest heading in document order that's currently on screen.
          const active = headings.find((h) => visible.has(h.slug));
          if (active) setActiveSlug(active.slug);
        },
        // Counts a heading as "current" only once it's within the top ~30% of
        // the viewport, not merely anywhere on screen.
        { rootMargin: '0px 0px -70% 0px', threshold: 0 },
      );
      targets.forEach((el) => observer!.observe(el));
    };
    attach();
    return () => {
      if (retry) clearTimeout(retry);
      observer?.disconnect();
    };
  }, [headings]);

  const hasContent = headings.length > 0 || notes.length > 0 || todos.length > 0 || hasGraph;
  useRegisterPanel(hasContent);
  if (!hasContent) return null;

  function scrollTo(slug: string) {
    // source/live: hands off to the mounted CodeMirror view (see this file's
    // own docblock). Returns false in reading mode (nothing mounted there)
    // or if the slug isn't in the document — either way, fall back to the
    // reading view's own rendered heading DOM, exactly as before this fix.
    if (scrollActiveEditorToHeading(slug)) return;
    document.getElementById(HEADING_ID_PREFIX + slug)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Same two-step handoff as scrollTo() above, keyed by offset + data-note-index
  // instead of slug + id — see this file's own docblock.
  function scrollToNote(pos: number, index: number) {
    if (scrollActiveEditorToOffset(pos)) return;
    document.querySelector(`[data-note-index="${index}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    flashReadingNote(index);
  }

  const hasHeadings = headings.length > 0;
  const hasNotes = notes.length > 0;
  const hasTodos = todos.length > 0;

  function scrollToTodo(pos: number, index: number) {
    if (scrollActiveEditorToOffset(pos)) {
      flashEditorTodo(pos);
      return;
    }
    document.querySelector(`[data-todo-index="${index}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    flashReadingTodo(index);
  }

  // The same anatomy docked and in the drawer: only the touch size of a row differs.
  const rowPad = (variant: 'docked' | 'mobile') => (variant === 'docked' ? 'py-0' : 'py-1');
  const closeDrawer = (variant: 'docked' | 'mobile') => {
    if (variant === 'mobile') setMobileOpen(false);
  };

  function outlineSection(variant: 'docked' | 'mobile', first = false) {
    if (!hasHeadings) return null;
    return (
      <PanelSection first={first} trailing={first ? hideButton : undefined} label={t('outline.label')} count={headings.length} open={outlineOpen} onToggle={() => setOutlineOpen((v) => !v)} toggleTitle={outlineOpen ? t('outline.hide') : t('outline.show')}>
        {/* A rail: one hairline on the left, the active heading marked by an accent bar on it. */}
        <ul className="relative flex flex-col gap-px pl-0.5 before:absolute before:top-0.5 before:bottom-0.5 before:left-[5px] before:w-px before:bg-neutral-200 dark:before:bg-neutral-800">
          {headings.map((h) => {
            const active = activeSlug === h.slug;
            const deep = h.level >= 3;
            return (
              <li key={h.slug}>
                <button
                  type="button"
                  onClick={() => {
                    scrollTo(h.slug);
                    closeDrawer(variant);
                  }}
                  title={h.text}
                  aria-current={active ? 'location' : undefined}
                  className={`relative block w-full rounded-[5px] pr-1.5 text-left leading-[1.35] hover:bg-black/[0.045] dark:hover:bg-white/5 ${variant === 'docked' ? 'py-[3px]' : 'py-1.5'} ${deep ? 'pl-7 text-[12.5px]' : 'pl-4 text-[13px]'} ${
                    active
                      ? "font-medium text-neutral-900 before:absolute before:inset-y-1 before:left-0.5 before:w-0.5 before:rounded-sm before:bg-indigo-600 before:content-[''] dark:text-neutral-100 dark:before:bg-indigo-300"
                      : deep
                        ? 'text-neutral-400 hover:text-neutral-900 dark:text-neutral-500 dark:hover:text-neutral-100'
                        : 'text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100'
                  }`}
                >
                  <span className="line-clamp-2">{h.text}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </PanelSection>
    );
  }

  function notesSection(variant: 'docked' | 'mobile', first = false) {
    if (!hasNotes) return null;
    return (
      <PanelSection
        first={first}
        trailing={first ? hideButton : undefined}
        label={t('notes.label')}
        count={doneTasks > 0 ? t('notes.tasksDone', { done: doneTasks, total: totalTasks }) : visibleNotes.length}
        open={notesOpen}
        onToggle={() => setNotesOpen((v) => !v)}
        toggleTitle={notesOpen ? t('notes.hide') : t('notes.show')}
      >
        {visibleNotes.length > 0 && (
          <ul className="flex flex-col gap-2">
            {visibleNotes.map(({ entry, index }) => {
              const Icon = NOTE_ICONS[entry.kind];
              return (
                <li key={index}>
                  <button
                    type="button"
                    onClick={() => {
                      scrollToNote(entry.pos, index);
                      closeDrawer(variant);
                    }}
                    title={entry.text}
                    className={`flex w-full items-start gap-2 text-left text-[13px] leading-[1.4] text-neutral-700 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-100 ${rowPad(variant)}`}
                  >
                    <Icon size={12} className="mt-[3px] shrink-0 text-neutral-400 dark:text-neutral-500" aria-hidden="true" />
                    <span className="line-clamp-2 min-w-0">{entry.text}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </PanelSection>
    );
  }

  // The filter is only offered once somebody on the page is named; its options are derived from the entries.
  function todosSection(variant: 'docked' | 'mobile', first = false) {
    if (!hasTodos) return null;
    return (
      <PanelSection
        first={first}
        trailing={first ? hideButton : undefined}
        label={t('todos.label')}
        count={visibleTodos.length}
        open={todosOpen}
        onToggle={() => setTodosOpen((v) => !v)}
        toggleTitle={todosOpen ? t('todos.hide') : t('todos.show')}
        actions={
          assigneeHandles.length > 0 && (
            <div className="relative">
              <select
                value={assignee}
                onChange={(event) => setAssigneeChoice(event.target.value)}
                aria-label={t('todos.filterLabel')}
                title={t('todos.filterLabel')}
                className="h-6 max-w-28 appearance-none rounded-md border-0 bg-neutral-100 px-2 pr-6 text-[12px] text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
              >
                {assigneeOptions.map((option) => (
                  <option key={option} value={option} className="text-neutral-900">
                    {option === 'all' ? t('todos.all') : option === NO_ASSIGNEE ? t('todos.none') : option}
                  </option>
                ))}
              </select>
              <ChevronDown size={12} className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2 text-neutral-500" aria-hidden="true" />
            </div>
          )
        }
      >
        <ul className="flex flex-col gap-2">
          {visibleTodos.map((entry) => (
            <li key={entry.index}>
              <button
                type="button"
                onClick={() => {
                  scrollToTodo(entry.pos, entry.index);
                  closeDrawer(variant);
                }}
                title={entry.text}
                className={`flex w-full items-start gap-2 text-left text-[13px] leading-[1.4] text-neutral-700 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-100 ${rowPad(variant)}`}
              >
                <Circle size={12} className="mt-[3px] shrink-0 text-neutral-400 dark:text-neutral-500" aria-hidden="true" />
                <span className="line-clamp-2 min-w-0">
                  {todoBody(entry.text, entry.assignees)}
                  {entry.assignees.map((handle) => (
                    <span key={handle} className="ml-1 text-[11px] text-indigo-600 dark:text-indigo-300">
                      @{handle}
                    </span>
                  ))}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </PanelSection>
    );
  }

  const hideButton = toolbarButton ? undefined : (
    <button
      type="button"
      onClick={() => setPanelHidden(true)}
      aria-label={t('outline.hidePanel')}
      title={t('outline.hidePanel')}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
    >
      <PanelRightClose size={16} />
    </button>
  );

  /** The whole panel is put away: one slim rail with the button that brings it back. */
  const dockedPanel = panelHidden ? (
    toolbarButton ? null : <div className="hidden w-10 shrink-0 border-l border-neutral-200 min-[1100px]:block dark:border-neutral-800">
      <div className="flex h-10 items-center justify-center">
        <button
          type="button"
          onClick={() => setPanelHidden(false)}
          aria-label={t('outline.showPanel')}
          title={t('outline.showPanel')}
          className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
        >
          <PanelRightOpen size={16} />
        </button>
      </div>
    </div>
  ) : (
    <nav
      aria-label={t('outline.label')}
      className="ph-mask hidden w-64 shrink-0 border-l border-neutral-200 min-[1100px]:block dark:border-neutral-800"
    >
      <div className="sticky top-0 max-h-screen overflow-x-hidden overflow-y-auto px-3 pb-6">
        <div className="flex flex-col gap-4">
          {hasGraph && <LocalGraphSection space={space!} pageId={pageId!} variant="docked" first trailing={hideButton} />}
          {outlineSection('docked', !hasGraph)}
          {notesSection('docked', !hasGraph && !hasHeadings)}
          {todosSection('docked', !hasGraph && !hasHeadings && !hasNotes)}
        </div>
      </div>
    </nav>
  );

  return (
    <>
      {dockedPanel}

      {/* <1100px only: floating trigger, independent of the ≥1100px `open`
          state above (see this file's own docblock — Round 22 prod-QA fix). */}
      <button
        type="button"
        onClick={() => setMobileOpen(true)}
        aria-label={t('outline.show')}
        title={t('outline.show')}
        data-outline-fab=""
        className="fixed right-4 bottom-4 z-40 flex h-11 w-11 items-center justify-center rounded-full bg-white text-neutral-600 shadow-lg ring-1 ring-neutral-200 min-[1100px]:hidden dark:bg-neutral-900 dark:text-neutral-300 dark:ring-neutral-700"
      >
        <ListTree size={18} />
      </button>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 min-[1100px]:hidden" role="dialog" aria-modal="true" aria-label={t('outline.label')}>
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} aria-hidden="true" />
          <nav
            aria-label={t('outline.label')}
            className="absolute inset-y-0 right-0 flex w-72 max-w-[85vw] flex-col bg-white shadow-xl dark:bg-neutral-950"
          >
            <div className="flex shrink-0 items-center justify-between border-b border-neutral-200 p-3 dark:border-neutral-800">
              <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">{t('outline.label')}</span>
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                aria-label={t('ui.close')}
                className="rounded p-1 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                <X size={16} />
              </button>
            </div>
            {/* flex-1 + overflow-y-auto lives on this wrapper rather than the
                <ul> itself, so the heading list and the Notes section below
                it scroll together as one region within the drawer's fixed
                height — matching the docked panel's own single scrolling
                container. */}
            <div className="flex-1 overflow-x-hidden overflow-y-auto px-3 py-2">
              <div className="flex flex-col gap-4">
                      {outlineSection('mobile')}
                {notesSection('mobile')}
                {todosSection('mobile')}
                {hasGraph && <LocalGraphSection space={space!} pageId={pageId!} variant="mobile" onNavigate={() => setMobileOpen(false)} />}
              </div>
            </div>
          </nav>
        </div>
      )}
    </>
  );
}
