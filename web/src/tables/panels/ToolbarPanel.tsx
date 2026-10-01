import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AnchoredPanel } from '../ui/AnchoredPanel';
import { useIsMobile } from '../useMobile';

/**
 * Round 26 (DATA TABLES) — the toolbar button + panel used by Filter, Sort
 * and Hide (spec §5).
 *
 * Two presentations behind one API, chosen by viewport:
 *  - desktop: a popover anchored under the button (AnchoredPanel);
 *  - phone: a bottom-sheet, because spec §14 says so — and because a
 *    360px-wide popover anchored to a button in a horizontally-scrolling
 *    toolbar is unusable.
 *
 * The COUNT is not decoration. Spec §5 asks for «Filter 1» / «Hide 18»
 * specifically so that a filtered view can't be mistaken for the whole
 * table — the single most common "where did my rows go" support question in
 * every tool that has views. It is rendered as part of the button's
 * accessible name too, not just as a coloured pill.
 */

export interface ToolbarPanelProps {
  icon: ReactNode;
  label: string;
  /** Shown as a pill and folded into the accessible name when > 0. */
  count?: number;
  children: (close: () => void) => ReactNode;
  /** Widen the desktop popover for the filter builder's rule rows. */
  wide?: boolean;
}

export function ToolbarPanel({ icon, label, count = 0, children, wide }: ToolbarPanelProps) {
  const { t } = useTranslation('tables');
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const mobile = useIsMobile();

  const close = () => setOpen(false);
  const accessibleName = count > 0 ? `${label} (${count})` : label;

  const body = (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b border-neutral-200 px-3 py-2 dark:border-neutral-700">
        <p className="text-xs font-medium text-neutral-700 dark:text-neutral-200">{label}</p>
        <button
          type="button"
          onClick={close}
          aria-label={t('common.close')}
          className="rounded p-1 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
        >
          <X size={14} />
        </button>
      </div>
      <div className="max-h-[60vh] overflow-y-auto p-3">{children(close)}</div>
    </div>
  );

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={accessibleName}
        onClick={() => setOpen((value) => !value)}
        className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors max-md:min-h-10 ${
          count > 0
            ? 'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300'
            : 'border-neutral-300 bg-white text-neutral-600 hover:bg-neutral-100 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700'
        }`}
      >
        {icon}
        <span>{label}</span>
        {count > 0 && (
          <span className="rounded-full bg-blue-600 px-1.5 text-[10px] leading-4 font-medium text-white">
            {count}
          </span>
        )}
      </button>

      {open && !mobile && (
        <AnchoredPanel anchorRef={buttonRef} onClose={close} label={label} className={wide ? 'w-[26rem]' : 'w-72'}>
          {body}
        </AnchoredPanel>
      )}

      {open &&
        mobile &&
        createPortal(
          <div className="fixed inset-0 z-[65] flex items-end bg-black/40" onClick={close}>
            <div
              role="dialog"
              aria-label={label}
              onClick={(event) => event.stopPropagation()}
              className="max-h-[80dvh] w-full rounded-t-2xl border-t border-neutral-200 bg-white pb-[env(safe-area-inset-bottom)] shadow-xl dark:border-neutral-700 dark:bg-neutral-900"
            >
              {body}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
