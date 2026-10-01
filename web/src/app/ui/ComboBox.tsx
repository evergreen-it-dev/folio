import { useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { useOutsideClick } from '../hooks';

export interface ComboBoxOption {
  value: string;
  label: string;
  /** Optional secondary text shown after the label (e.g. a repo's description). */
  hint?: string;
}

export interface ComboBoxProps {
  value: string;
  onChange: (value: string) => void;
  /** Fires in addition to onChange when an option is picked (click or Enter) — vs. plain typing, which only calls onChange. */
  onSelect?: (option: ComboBoxOption) => void;
  /** Already filtered by the caller against `value` (see e.g. sidebar/gitBranches.ts's filterBranches, sidebar/gitRepos.ts's filterProviderRepos) — undefined means "no suggestion source at all yet", NOT "filtered down to nothing". */
  options: ComboBoxOption[] | undefined;
  loading?: boolean;
  placeholder?: string;
  /** Unique per instance — becomes the listbox's id and the input's aria-controls. */
  listboxId: string;
  ariaLabel?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  required?: boolean;
}

/**
 * Round 19 (#6-ux) generalization of the create-space git-branch combobox
 * (originally sidebar/BranchField.tsx, round 5 follow-up) — pulled out so
 * the repository field can use the exact same interaction ("the same
 * combobox pattern" per DEV-PLAN.md's Round 19 SHELL section) instead of a
 * second, parallel implementation: a plain, always-editable text input that
 * additionally becomes a filterable, keyboard-navigable dropdown once a
 * suggestion source exists. BranchField is now a thin wrapper around this.
 *
 * Not portaled: every current caller lives inside CreateSpaceDialog's Modal,
 * which has no overflow/scroll of its own to clip an absolutely-positioned
 * dropdown — unlike the sidebar context ui/Menu.tsx's own portal exists for.
 * A future caller placed somewhere WITH clipping overflow would need to
 * either portal this too or accept the clip; nothing today needs it.
 */
export function ComboBox({
  value,
  onChange,
  onSelect,
  options,
  loading,
  placeholder,
  listboxId,
  ariaLabel,
  disabled,
  autoFocus,
  required,
}: ComboBoxProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  useOutsideClick([rootRef], () => setOpen(false));

  const showDropdown = open && options !== undefined && options.length > 0;

  function select(option: ComboBoxOption) {
    onChange(option.value);
    onSelect?.(option);
    setOpen(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!showDropdown) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, options!.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter') {
      const option = options![activeIndex];
      if (option) {
        event.preventDefault();
        select(option);
      }
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <div className="relative">
        <input
          value={value}
          required={required}
          disabled={disabled}
          autoFocus={autoFocus}
          aria-label={ariaLabel}
          onChange={(e) => {
            onChange(e.target.value);
            setActiveIndex(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          role="combobox"
          aria-expanded={showDropdown}
          aria-controls={listboxId}
          aria-autocomplete="list"
          className="w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 pr-8 text-sm text-neutral-900 outline-none focus:border-neutral-500 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-100"
        />
        {loading && (
          <Loader2
            size={14}
            className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-neutral-400"
            aria-hidden="true"
          />
        )}
      </div>

      {showDropdown && (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute left-0 right-0 z-20 mt-1 max-h-48 overflow-y-auto rounded-md border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
        >
          {options!.map((option, i) => (
            <li key={option.value}>
              <button
                type="button"
                role="option"
                aria-selected={i === activeIndex}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => select(option)}
                className={`block w-full truncate rounded px-2 py-1 text-left text-sm ${
                  i === activeIndex ? 'bg-neutral-100 dark:bg-neutral-800' : 'text-neutral-800 dark:text-neutral-200'
                }`}
              >
                {option.label}
                {option.hint && <span className="ml-1.5 text-xs text-neutral-400 dark:text-neutral-500">{option.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
