import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * Round 26 (DATA TABLES) — styled native <select>.
 *
 * Deliberately native, not a custom listbox. It is used for the *structural*
 * dropdowns — which column a filter rule targets, which operator, sort
 * direction, row height — where the option list is short, plain text, and
 * has no colours or descriptions. A native select gets keyboard support,
 * type-ahead, mobile's native picker wheel (spec §14 cares) and screen
 * reader support for free, and none of that is worth reimplementing here.
 *
 * The *value* dropdowns are the opposite case — coloured chips, per-option
 * descriptions, search, "create" — and those are OptionPicker
 * (../cells/OptionPicker.tsx), which is a real custom popover.
 */

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string> {
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  label: string;
  /** Hide the visible label and use `label` as the accessible name. */
  hideLabel?: boolean;
  disabled?: boolean;
  className?: string;
  /** Extra classes for the <select> itself (e.g. `w-full` to fill a flex item). */
  selectClassName?: string;
  children?: ReactNode;
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  hideLabel,
  disabled,
  className,
  selectClassName,
}: SelectProps<T>) {
  const select = (
    <select
      value={value}
      disabled={disabled}
      aria-label={hideLabel ? label : undefined}
      onChange={(event) => onChange(event.target.value as T)}
      className={`min-w-0 truncate appearance-none rounded-md border border-neutral-300 bg-white py-1 pr-6 pl-2 text-xs text-neutral-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-200 ${selectClassName ?? ''}`}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  );
  // Native arrow is hidden (appearance-none) so it can't sit on the border;
  // this icon replaces it and never intercepts clicks.
  const chevron = (
    <ChevronDown
      size={12}
      aria-hidden
      className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2 text-neutral-400 dark:text-neutral-500"
    />
  );

  if (hideLabel) {
    return (
      <span className={`relative inline-flex ${className ?? ''}`}>
        {select}
        {chevron}
      </span>
    );
  }

  return (
    <label className={`inline-flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400 ${className ?? ''}`}>
      <span>{label}</span>
      <span className="relative inline-flex min-w-0">
        {select}
        {chevron}
      </span>
    </label>
  );
}
