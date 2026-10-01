import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  ChevronsRight,
  Info,
  Lightbulb,
  ListTree,
  MessageSquareWarning,
  OctagonAlert,
  Square,
  StickyNote,
  X,
  type LucideIcon,
} from 'lucide-react';
import { scrollActiveEditorToHeading, scrollActiveEditorToOffset } from '../../editor';
import { extractHeadings, HEADING_ID_PREFIX } from '../../markdown/headings';
import { extractNotes, type NoteKind } from '../../markdown/notes';
import { useLocalStorage } from '../hooks';
import '../i18n/register';
import { useLiveDocText } from '../liveDocText';

/** One icon per NoteEntry.kind — a compact visual hint for what kind of entry a row is. */
const NOTE_ICONS: Record<NoteKind, LucideIcon> = {
  note: Info,
  tip: Lightbulb,
  important: MessageSquareWarning,
  warning: AlertTriangle,
  caution: OctagonAlert,
  task: Square,
};

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
export function OutlinePanel({ markdown, pageId }: OutlinePanelProps) {
  const { t } = useTranslation('app');
  // Live text wins while someone is typing; the server snapshot is the
  // fallback for reading-only surfaces and for the moment before the collab
  // session connects.
  const live = useLiveDocText(pageId);
  const source = live ?? markdown;
  const headings = useMemo(() => extractHeadings(source), [source]);
  const notes = useMemo(() => extractNotes(source), [source]);
  const [outlineOpen, setOutlineOpen] = useLocalStorage('folio:outline-open', true);
  // Round 30 tail (owner, 11.09: "now notes open only together with the
  // outline, and they have to be independent"): the two lists are separate reading aids
  // — a long document you're navigating by heading is exactly the document
  // whose notes you may want out of the way, and vice versa. So each keeps its
  // own persisted open/closed state, and the rail shows an icon for whichever
  // one is currently put away.
  const [notesOpen, setNotesOpen] = useLocalStorage('folio:notes-open', true);
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
    const targets = headings
      .map((h) => document.getElementById(HEADING_ID_PREFIX + h.slug))
      .filter((el): el is HTMLElement => el !== null);
    if (targets.length === 0) return; // source/live editor mode: no heading DOM to observe

    const visible = new Set<string>();
    const observer = new IntersectionObserver(
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
    targets.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [headings]);

  if (headings.length === 0 && notes.length === 0) return null;

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
  }

  // Shared between the docked panel and the <1100px drawer — null renders
  // nothing at all (no entries means no section, per the owner's ask), a
  // completed checklist item stays counted (doneTasks/totalTasks) but out of
  // the visible list (visibleNotes already filtered it out above).
  function notesSection(variant: 'docked' | 'mobile', onHide?: () => void) {
    if (notes.length === 0) return null;
    const textSize = variant === 'docked' ? 'text-xs' : 'text-sm';
    const rowPad = variant === 'docked' ? 'py-1' : 'py-2';
    return (
      <div className="mt-3">
        <div className="mb-1 flex items-center gap-1 px-1.5">
          <span className="text-xs font-medium text-neutral-400 dark:text-neutral-500">{t('notes.label')}</span>
          {doneTasks > 0 && (
            <span className="text-[11px] text-neutral-400 dark:text-neutral-500">
              {t('notes.tasksDone', { done: doneTasks, total: totalTasks })}
            </span>
          )}
          {onHide && (
            <button
              type="button"
              onClick={onHide}
              aria-label={t('notes.hide')}
              title={t('notes.hide')}
              className="ml-auto rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            >
              <ChevronsRight size={14} />
            </button>
          )}
        </div>
        {visibleNotes.length > 0 && (
          <ul className="flex flex-col gap-0.5">
            {visibleNotes.map(({ entry, index }) => {
              const Icon = NOTE_ICONS[entry.kind];
              return (
                <li key={index}>
                  <button
                    type="button"
                    onClick={() => {
                      scrollToNote(entry.pos, index);
                      if (variant === 'mobile') setMobileOpen(false);
                    }}
                    title={entry.text}
                    className={`flex w-full items-center gap-1.5 truncate rounded pl-1.5 pr-1.5 text-left ${textSize} ${rowPad} text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200`}
                  >
                    <Icon size={variant === 'docked' ? 12 : 14} className="shrink-0" />
                    <span className="truncate">{entry.text}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  }

  // The ≥1100px docked panel — collapsed (icon-only rail) or expanded,
  // exactly as before this fix. Built as a variable rather than an early
  // return so it can sit alongside the always-present <1100px trigger/drawer
  // below (both need to coexist in one returned tree — CSS decides which is
  // actually visible at a given width, not React).
  const hasHeadings = headings.length > 0;
  const hasNotes = notes.length > 0;
  const showOutline = hasHeadings && outlineOpen;
  const showNotes = hasNotes && notesOpen;

  /** The put-away sections, as icons that bring their own list back — nothing else. */
  const railButtons = (
    <>
      {hasHeadings && !outlineOpen && (
        <button
          type="button"
          onClick={() => setOutlineOpen(true)}
          aria-label={t('outline.show')}
          title={t('outline.show')}
          className="rounded-md p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
        >
          <ListTree size={16} />
        </button>
      )}
      {hasNotes && !notesOpen && (
        <button
          type="button"
          onClick={() => setNotesOpen(true)}
          aria-label={t('notes.show')}
          title={t('notes.show')}
          className="rounded-md p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
        >
          <StickyNote size={16} />
        </button>
      )}
    </>
  );

  const outlineSection = (
    <div>
      <div className="mb-1 flex items-center justify-between px-1.5">
        <span className="text-xs font-medium text-neutral-400 dark:text-neutral-500">{t('outline.label')}</span>
        <button
          type="button"
          onClick={() => setOutlineOpen(false)}
          aria-label={t('outline.hide')}
          title={t('outline.hide')}
          className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
        >
          <ChevronsRight size={14} />
        </button>
      </div>
      <ul className="flex flex-col gap-0.5">
        {headings.map((h) => (
          <li key={h.slug}>
            <button
              type="button"
              onClick={() => scrollTo(h.slug)}
              title={h.text}
              style={{ paddingLeft: `${(h.level - 1) * 10 + 6}px` }}
              className={`block w-full truncate rounded py-1 pr-1.5 text-left text-xs ${
                activeSlug === h.slug
                  ? 'font-medium text-neutral-900 dark:text-neutral-100'
                  : 'text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200'
              }`}
            >
              {h.text}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );

  // The ≥1100px docked column. Either list can be open on its own, so this is
  // "whatever is open, plus a rail icon for whatever is not" rather than one
  // panel with one switch. With nothing open it degrades to the icon-only rail
  // this panel has always had.
  const dockedPanel = !showOutline && !showNotes ? (
    <div className="hidden shrink-0 flex-col gap-1 p-2 min-[1100px]:flex">
      <div className="sticky top-3 flex flex-col gap-1">{railButtons}</div>
    </div>
  ) : (
    <nav
      aria-label={showOutline ? t('outline.label') : t('notes.label')}
      className="hidden w-56 shrink-0 min-[1100px]:block"
    >
      <div className="sticky top-3 max-h-[calc(100vh-4.5rem)] overflow-y-auto pb-6 pl-2 pr-1">
        {/* A section that's away is one click from coming back, without
            disturbing the one that stayed. */}
        {(!outlineOpen || !notesOpen) && <div className="mb-1 flex items-center gap-1">{railButtons}</div>}
        {showOutline && outlineSection}
        {showNotes && notesSection('docked', () => setNotesOpen(false))}
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
            <div className="flex-1 overflow-y-auto p-2">
              <ul className="flex flex-col gap-0.5">
                {headings.map((h) => (
                  <li key={h.slug}>
                    <button
                      type="button"
                      onClick={() => {
                        scrollTo(h.slug);
                        setMobileOpen(false);
                      }}
                      title={h.text}
                      style={{ paddingLeft: `${(h.level - 1) * 10 + 6}px` }}
                      className={`block w-full truncate rounded py-2 pr-1.5 text-left text-sm ${
                        activeSlug === h.slug
                          ? 'font-medium text-neutral-900 dark:text-neutral-100'
                          : 'text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100'
                      }`}
                    >
                      {h.text}
                    </button>
                  </li>
                ))}
              </ul>
              {notesSection('mobile')}
            </div>
          </nav>
        </div>
      )}
    </>
  );
}
