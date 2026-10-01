import type { ReactNode } from 'react';

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
}: SelectProps<T>) {
  const select = (
    <select
      value={value}
      disabled={disabled}
      aria-label={hideLabel ? label : undefined}
      onChange={(event) => onChange(event.target.value as T)}
      className="min-w-0 rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-200"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  );

  if (hideLabel) return <span className={className}>{select}</span>;

  return (
    <label className={`inline-flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400 ${className ?? ''}`}>
      <span>{label}</span>
      {select}
    </label>
  );
}
