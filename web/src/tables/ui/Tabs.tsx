import { useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

/**
 * Round 26 (DATA TABLES) — horizontal tab strip for the view tabs (spec §5).
 *
 * Implements the WAI-ARIA tabs pattern's keyboard contract, which is the
 * part that is easy to skip and annoying to live without: roving tabindex
 * (exactly one tab in the tab order, arrows move between them), Home/End,
 * and wrap-around. Activation is automatic on arrow (the usual choice for
 * cheap panel switches — switching a view is local state, not a fetch).
 *
 * `trailing` lets a tab carry its own «…» menu button without this component
 * knowing anything about views; that button sits OUTSIDE the tab element so
 * it is separately reachable and its click doesn't select the tab.
 *
 * Horizontal overflow scrolls rather than wraps — spec §14 asks for exactly
 * that on mobile, and it keeps the strip one row tall with many views.
 */

export interface TabItem {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Rendered next to the tab (e.g. its «…» menu); not part of the tab button. */
  trailing?: ReactNode;
}

export interface TabsProps {
  items: TabItem[];
  activeId: string;
  onSelect: (id: string) => void;
  label: string;
  /** Rendered after the last tab — the "+ view" button. */
  actions?: ReactNode;
  className?: string;
}

export function Tabs({ items, activeId, onSelect, label, actions, className }: TabsProps) {
  const stripRef = useRef<HTMLDivElement>(null);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = items.findIndex((item) => item.id === activeId);
    if (index === -1) return;
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % items.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else return;
    event.preventDefault();
    const target = items[next];
    if (!target) return;
    onSelect(target.id);
    // Move real DOM focus along with the selection, or the next arrow press
    // would start from wherever focus was left behind. Matched by scanning
    // rather than a `[data-tab-id="…"]` selector so an id containing quotes
    // or brackets can't produce an invalid selector (and so this doesn't
    // depend on CSS.escape, which isn't in every test DOM).
    const buttons = stripRef.current?.querySelectorAll<HTMLButtonElement>('[data-tab-id]');
    buttons?.forEach((button) => {
      if (button.dataset.tabId === target.id) button.focus();
    });
  }

  return (
    <div
      ref={stripRef}
      role="tablist"
      aria-label={label}
      aria-orientation="horizontal"
      onKeyDown={handleKeyDown}
      className={`flex items-center gap-1 overflow-x-auto ${className ?? ''}`}
    >
      {items.map((item) => {
        const active = item.id === activeId;
        return (
          <span key={item.id} className="group inline-flex shrink-0 items-center">
            <button
              type="button"
              role="tab"
              data-tab-id={item.id}
              aria-selected={active}
              // Roving tabindex: only the active tab is in the tab order.
              tabIndex={active ? 0 : -1}
              onClick={() => onSelect(item.id)}
              className={`inline-flex max-w-[14rem] items-center gap-1.5 rounded-t-md border-b-2 px-3 py-1.5 text-sm whitespace-nowrap transition-colors max-md:min-h-10 ${
                active
                  ? 'border-blue-600 font-medium text-neutral-900 dark:border-blue-400 dark:text-neutral-50'
                  : 'border-transparent text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-100'
              }`}
            >
              {item.icon}
              <span className="truncate">{item.label}</span>
            </button>
            {item.trailing}
          </span>
        );
      })}
      {actions}
    </div>
  );
}
