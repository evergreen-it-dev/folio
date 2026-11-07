import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

export interface PanelSectionProps {
  label: string;
  /** Short count/summary after the label. */
  count?: ReactNode;
  open: boolean;
  onToggle: () => void;
  /** Title of the header button (what clicking does). */
  toggleTitle?: string;
  /** Controls on the right of the header (filter, depth, expand…). */
  actions?: ReactNode;
  /** The section's `aria-label`, when it differs from the visible label. */
  ariaLabel?: string;
  /** The panel's first section: a taller (h-10) header row that also carries `trailing` at its far right. */
  first?: boolean;
  trailing?: ReactNode;
  children: ReactNode;
}

/**
 * One section of the page's right panel: a full-width disclosure header (chevron, small-caps label, count) with
 * optional controls on its right, and a body that starts at the same left edge as the header (the panel's one content edge).
 */
export function PanelSection({ label, count, open, onToggle, toggleTitle, actions, ariaLabel, first, trailing, children }: PanelSectionProps) {
  return (
    <section aria-label={ariaLabel ?? label} className="min-w-0">
      <div className={`flex items-center gap-1 ${first ? 'h-10' : 'h-7'}`}>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={ariaLabel}
          title={toggleTitle}
          className="flex h-full min-w-0 flex-1 items-center gap-1 rounded text-left text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200"
        >
          {open ? <ChevronDown size={12} className="shrink-0" aria-hidden="true" /> : <ChevronRight size={12} className="shrink-0" aria-hidden="true" />}
          <span className="truncate text-[11px] font-semibold uppercase tracking-wide">{label}</span>
          {count != null && count !== '' && <span className="shrink-0 text-[11px] font-normal normal-case tabular-nums tracking-normal text-neutral-400 dark:text-neutral-500">{count}</span>}
        </button>
        {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
        {trailing}
      </div>
      {open && <div className="min-w-0 pt-0.5">{children}</div>}
    </section>
  );
}
