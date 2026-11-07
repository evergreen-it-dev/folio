import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';
import {
  WHATS_NEW_OPEN_EVENT,
  WHATS_NEW_STEPS,
  findVisibleAnchor,
  hasSeenWhatsNew,
  markWhatsNewSeen,
  type WhatsNewStep,
} from './whatsNewSteps';
import '../i18n/register';

export { openWhatsNewTour } from './whatsNewSteps';

const SHORTCUT = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent) ? '⌘K' : 'Ctrl+K';
/** Gap between an anchor and its tag, px. */
const GAP = 10;

interface Pin {
  step: WhatsNewStep;
  style: React.CSSProperties;
}

/** Where a step's tag goes for the anchor's current rect; null when the anchor is gone or scrolled out of view. */
function placePin(step: WhatsNewStep): Pin | null {
  const el = findVisibleAnchor(step.selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) return null;
  if (step.side === 'right') return { step, style: { left: r.right + GAP, top: r.top + r.height / 2, transform: 'translateY(-50%)' } };
  if (step.side === 'left') return { step, style: { left: r.left - GAP, top: r.top + Math.min(r.height / 2, 28), transform: 'translate(-100%, -50%)' } };
  if (step.side === 'belowLeft') return { step, style: { left: Math.max(8, r.left), top: r.bottom + GAP } };
  // below, right-aligned with the anchor
  return { step, style: { left: Math.min(r.right, vw - 8), top: r.bottom + GAP, transform: 'translateX(-100%)' } };
}

/** The little arrow of a tag, pointing back at its anchor. */
const ARROW: Record<WhatsNewStep['side'], string> = {
  right: 'left-[-3px] top-1/2 -mt-[3.5px]',
  left: 'right-[-3px] top-1/2 -mt-[3.5px]',
  below: 'right-3 top-[-3px]',
  belowLeft: 'left-3 top-[-3px]',
};

/**
 * One-time «we refreshed the design» hint (owner, 07.11.2026). Not a modal tour:
 * small accent tags sit next to the places that moved — the same callouts the
 * approved mockup used — and a compact card at the bottom says what this is,
 * with «Got it». The app stays usable underneath; nothing is dimmed and the
 * tags never take clicks. Anchors are `data-tour` attributes on the owning
 * components (whatsNewSteps.ts); a tag whose anchor is not on screen is simply
 * not drawn. With no anchor at all (a phone) the card lists the changes instead.
 *
 * «Seen» is a localStorage flag (there is no per-user flag mechanism on the
 * server worth extending for this); «Got it» and Esc set it.
 */
export function WhatsNewTour({ delayMs = 800 }: { delayMs?: number }) {
  const { t } = useTranslation('app');
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  // null until the first measure, so the card never flashes its «no anchors» list.
  const [pins, setPins] = useState<Pin[] | null>(null);

  const show = useCallback(() => setOpen(true), []);
  const close = useCallback(() => {
    markWhatsNewSeen();
    setOpen(false);
  }, []);

  // First show: once per browser, never in demo mode.
  useEffect(() => {
    if (hasSeenWhatsNew()) return;
    const demo = (queryClient.getQueryData(['auth', 'state']) as { demo?: unknown } | undefined)?.demo;
    if (demo) return;
    const timer = window.setTimeout(show, delayMs);
    return () => window.clearTimeout(timer);
  }, [queryClient, show, delayMs]);

  useEffect(() => {
    window.addEventListener(WHATS_NEW_OPEN_EVENT, show);
    return () => window.removeEventListener(WHATS_NEW_OPEN_EVENT, show);
  }, [show]);

  // Follow the anchors: panels open and close, the tree scrolls, pages load.
  useEffect(() => {
    if (!open) {
      setPins(null);
      return;
    }
    const measure = () => setPins(WHATS_NEW_STEPS.map(placePin).filter((p): p is Pin => p !== null));
    measure();
    const timer = window.setInterval(measure, 400);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  if (!open || pins === null) return null;
  const noAnchors = pins.length === 0;

  return (
    <div className="pointer-events-none fixed inset-0 z-[90]" data-report-exclude="">
      {pins.map(({ step, style }) => (
        <span
          key={step.id}
          className="absolute whitespace-nowrap rounded-md bg-indigo-600 px-2 py-[3px] font-mono text-[11px] font-semibold leading-4 text-white shadow-[0_2px_8px_rgb(0_0_0/0.2)] dark:bg-indigo-500"
          style={style}
        >
          <span aria-hidden="true" className={`absolute h-[7px] w-[7px] rotate-45 bg-inherit ${ARROW[step.side]}`} />
          {t(`whatsNew.pins.${step.i18nKey}`, { shortcut: SHORTCUT })}
        </span>
      ))}

      <div
        role="dialog"
        aria-labelledby="whats-new-title"
        className="pointer-events-auto absolute bottom-5 left-1/2 w-[min(92vw,30rem)] -translate-x-1/2 rounded-xl bg-neutral-900 px-4 py-3 text-white shadow-[0_12px_32px_rgb(0_0_0/0.28)] dark:bg-white dark:text-neutral-900"
      >
        <div className="flex items-center gap-3">
          <Sparkles size={16} className="shrink-0 text-indigo-300 dark:text-indigo-600" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div id="whats-new-title" className="text-sm font-semibold">
              {t('whatsNew.title')}
            </div>
            <div className="text-[13px] leading-snug text-neutral-300 dark:text-neutral-600">
              {noAnchors ? t('whatsNew.introTextNoAnchors') : t('whatsNew.banner')}
            </div>
          </div>
          <button
            type="button"
            autoFocus
            onClick={close}
            className="shrink-0 rounded-md bg-indigo-500 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-indigo-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300 dark:bg-indigo-600 dark:hover:bg-indigo-700"
          >
            {t('whatsNew.gotIt')}
          </button>
        </div>
        {noAnchors && (
          <ul className="mt-2.5 space-y-1.5 border-t border-white/10 pt-2.5 text-[13px] dark:border-neutral-200">
            {WHATS_NEW_STEPS.map((s) => (
              <li key={s.id}>
                <span className="font-medium">{t(`whatsNew.steps.${s.i18nKey}.title`)}</span>
                <span className="text-neutral-300 dark:text-neutral-600"> — {t(`whatsNew.steps.${s.i18nKey}.text`, { shortcut: SHORTCUT })}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
