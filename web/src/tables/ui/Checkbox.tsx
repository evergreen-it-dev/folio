import type { ChangeEvent } from 'react';

/**
 * Round 26 (DATA TABLES) — checkbox with an indeterminate state.
 *
 * A plain <input type="checkbox"> covers most of this; what it does NOT
 * cover declaratively is `indeterminate`, which is a DOM *property* with no
 * matching HTML attribute — React will not set it from JSX, so the
 * bulk-selection header checkbox ("some rows selected") needs the ref
 * callback below. That single fact is why this wrapper exists.
 */

export interface CheckboxProps {
  checked: boolean;
  /** Renders the dash state; `checked` is ignored while true. */
  indeterminate?: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  /** Hide the text and use `label` as the accessible name (row/select-all boxes). */
  hideLabel?: boolean;
  disabled?: boolean;
  className?: string;
}

export function Checkbox({
  checked,
  indeterminate = false,
  onChange,
  label,
  hideLabel,
  disabled,
  className,
}: CheckboxProps) {
  const input = (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      aria-label={hideLabel ? label : undefined}
      // The only way to reach the indeterminate DOM property from JSX.
      ref={(node) => {
        if (node) node.indeterminate = indeterminate && !checked;
      }}
      onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.checked)}
      className="h-4 w-4 shrink-0 cursor-pointer rounded border-neutral-300 text-blue-600 accent-blue-600 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-600"
    />
  );

  if (hideLabel) return <span className={className}>{input}</span>;

  return (
    <label
      className={`inline-flex cursor-pointer items-center gap-2 text-sm text-neutral-700 select-none dark:text-neutral-200 ${
        disabled ? 'cursor-not-allowed opacity-50' : ''
      } ${className ?? ''}`}
    >
      {input}
      <span className="truncate">{label}</span>
    </label>
  );
}
