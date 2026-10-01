import type { ButtonHTMLAttributes, Ref, ReactNode } from 'react';

/**
 * Round 26 (DATA TABLES) — minimal Button.
 *
 * DEV-PLAN R26 records that Folio's UI kit (web/src/app/ui/**) has Menu,
 * Modal, ComboBox, ConfirmDialog, LabeledInput and Toast, but no Button,
 * Tooltip, Tabs, Checkbox or Select — every button in the app so far is a
 * bare <button> with its Tailwind classes written out inline. That is fine
 * for one or two buttons per screen; the table toolbar has a dozen, so this
 * zone factors the three shapes it actually needs and nothing more.
 *
 * Kept inside web/src/tables/ui rather than promoted to web/src/app/ui on
 * purpose: app/** belongs to SHELL-TABLES this round, and a shared primitive
 * landing in two agents' diffs at once is how parallel rounds break. If
 * these prove useful elsewhere, promoting them later is a pure move.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  /** Renders icon-only: `children` becomes the accessible name via aria-label instead of visible text. */
  iconOnly?: boolean;
  /**
   * Plain prop, no forwardRef wrapper: React 19 passes `ref` to function
   * components like any other prop. Needed where a button anchors a popover
   * (SelectionBar's bulk-value setter).
   */
  ref?: Ref<HTMLButtonElement>;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary:
    'bg-blue-600 text-white hover:bg-blue-700 disabled:hover:bg-blue-600 dark:bg-blue-600 dark:hover:bg-blue-500',
  secondary:
    'border border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-100 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700',
  ghost:
    'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800',
  danger:
    'border border-red-300 bg-white text-red-600 hover:bg-red-50 dark:border-red-800 dark:bg-neutral-800 dark:text-red-400 dark:hover:bg-red-950/40',
};

// max-md:min-h-10 — the same 40px touch-target floor ui/Menu.tsx applies to
// its trigger, so the toolbar stays usable at 375px (spec §14).
const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'gap-1 px-2 py-1 text-xs max-md:min-h-10',
  md: 'gap-1.5 px-3 py-1.5 text-sm max-md:min-h-10',
};

export function Button({
  variant = 'secondary',
  size = 'sm',
  icon,
  iconOnly,
  children,
  className,
  type,
  ref,
  ...rest
}: ButtonProps) {
  const label = iconOnly && typeof children === 'string' ? children : undefined;
  return (
    <button
      ref={ref}
      // Every button in this zone lives inside some form-ish container at
      // some point (the column editor, the filter rule row); defaulting to
      // "button" stops any of them from submitting one by accident.
      type={type ?? 'button'}
      aria-label={label}
      title={label}
      className={`inline-flex items-center justify-center rounded-md font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-50 ${VARIANT_CLASS[variant]} ${SIZE_CLASS[size]} ${className ?? ''}`}
      {...rest}
    >
      {icon}
      {iconOnly ? null : children}
    </button>
  );
}
