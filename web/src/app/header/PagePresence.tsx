import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { positionMenu, type MenuCoords } from '../ui/Menu';
import type { PagePresencePerson } from '../presence';
import '../i18n/register';

export interface PagePresenceIndicatorProps {
  people: PagePresencePerson[];
}

/**
 * How long the panel survives the pointer leaving it. The portal puts the
 * panel outside the trigger's DOM subtree, so travelling from one to the other
 * fires a leave before the enter; 120ms turned out to be too tight in real use
 * (owner, 11.09: "the card hides"). The transparent bridge below removes the
 * geometric gap, and this covers the rest — a diagonal path that clips the
 * corner of neither box.
 */
const CLOSE_GRACE_MS = 260;

/** Matches the 4px positionMenu leaves under the trigger — see the bridge in the portal below. */
const PANEL_GAP = 4;

/**
 * "Who else has this page open" — a small circular counter shown in the
 * header, left of the page-action icons (Header.tsx), for all three page
 * kinds (doc/board/table — this is the one header shared by all of them,
 * see Header.tsx's own docblock).
 *
 * Hover OR keyboard focus reveals the list of names — a colour dot, the
 * name, and `@username` when set. The trigger's `aria-label` already spells
 * out the full list (not just a count), so a screen-reader user gets the
 * complete picture without needing to activate anything; `title` repeats it
 * as an ordinary hover tooltip for a sighted mouse user who doesn't open the
 * panel.
 *
 * The panel goes through a PORTAL as `position: fixed`, exactly like
 * ui/Menu.tsx (whose docblock has the full story, and whose positionMenu
 * this reuses). The first cut of this component rendered it inline as an
 * `absolute` sibling on the reasoning that "Header sets no overflow" — true
 * but irrelevant: Shell's ROOT is `flex h-full overflow-hidden`, and an
 * overflow ancestor clips absolutely-positioned descendants that paint
 * outside its bounds whatever their z-index. With five people in the room
 * the list was sliced off mid-row at the header's bottom edge (owner
 * screenshot). `position: fixed` resolves against the viewport and bypasses
 * that ancestor chain; positionMenu additionally flips the panel above the
 * trigger when it would run off the bottom.
 *
 * Round (page presence): shown starting at TWO people. A lone "1" badge only
 * ever means "just you", which is noise on every single-viewer page load —
 * deliberately not shown; flip the `< 2` below if the owner wants "always
 * show" instead.
 */
export function PagePresenceIndicator({ people }: PagePresenceIndicatorProps) {
  const { t } = useTranslation('app');
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<MenuCoords | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const openNow = useCallback(() => {
    cancelClose();
    setOpen(true);
  }, [cancelClose]);

  /** Trigger and panel are in different DOM trees (portal), so neither one's mouseleave alone means "the pointer left the widget" — hence the grace period. */
  const closeSoon = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_GRACE_MS);
  }, [cancelClose]);

  // Measure-then-position, same as Menu.tsx: the panel must exist (rendered
  // invisibly) before its real height is known, and a layout effect lands the
  // correction before the browser paints, so there's no flash at (0, 0).
  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    const triggerEl = triggerRef.current;
    const panelEl = panelRef.current;
    if (triggerEl && panelEl) {
      setCoords(positionMenu(triggerEl.getBoundingClientRect(), panelEl.getBoundingClientRect(), 'right'));
    }
  }, [open, people.length]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const dismiss = () => setOpen(false);
    document.addEventListener('keydown', onKey);
    // Fixed coordinates go stale the moment anything scrolls or resizes;
    // closing is enough (Menu.tsx makes the same call). Capture phase because
    // scroll doesn't bubble.
    window.addEventListener('scroll', dismiss, { capture: true });
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', dismiss, { capture: true });
      window.removeEventListener('resize', dismiss);
    };
  }, [open]);

  useEffect(() => cancelClose, [cancelClose]);

  if (people.length < 2) return null;

  const describe = (person: PagePresencePerson) => {
    const base = person.username ? `${person.name} (@${person.username})` : person.name;
    return person.isSelf ? `${base} — ${t('header.presence.you')}` : base;
  };
  const label = t('header.presence.summary', { count: people.length, names: people.map(describe).join(', ') });

  return (
    <div className="relative shrink-0" onMouseEnter={openNow} onMouseLeave={closeSoon}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="true"
        aria-expanded={open}
        onFocus={openNow}
        onBlur={closeSoon}
        onClick={() => (open ? setOpen(false) : openNow())}
        className="inline-flex h-6 min-w-[1.5rem] items-center justify-center rounded-full bg-neutral-100 px-1.5 text-[11px] font-medium text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
      >
        {people.length}
      </button>
      {open &&
        createPortal(
          // The outer box is a transparent BRIDGE: it starts where the trigger
          // ends and its padding recreates the 4px gap visually, so the pointer
          // never crosses dead space on its way down to the list. Without it
          // the gap is a hole that closes the panel mid-travel.
          <div
            ref={panelRef}
            onMouseEnter={openNow}
            onMouseLeave={closeSoon}
            style={{
              position: 'fixed',
              top: (coords?.top ?? 0) - PANEL_GAP,
              left: coords?.left ?? 0,
              paddingTop: PANEL_GAP,
              visibility: coords ? 'visible' : 'hidden',
            }}
            // z-[80] matches Menu.tsx: above every floating surface, the Folio AI panel included.
            className="z-[80]"
          >
            <div className="min-w-[190px] rounded-lg border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
              {/* A busy page can hold more people than the viewport has room for:
                  cap the list and let it scroll rather than run off the screen. */}
              <ul className="flex max-h-[min(60vh,20rem)] flex-col gap-0.5 overflow-y-auto">
                {people.map((person) => (
                  <li
                    key={person.key}
                    className="flex items-center gap-2 rounded-md px-2 py-1 text-sm text-neutral-700 dark:text-neutral-200"
                  >
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: person.color }} aria-hidden="true" />
                    <span className="truncate">
                      {person.name}
                      {person.isSelf && <span className="text-neutral-400"> · {t('header.presence.you')}</span>}
                    </span>
                    {person.username && (
                      <span className="ml-auto shrink-0 truncate pl-2 text-xs text-neutral-400">@{person.username}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
