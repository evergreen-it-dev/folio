import type { InputHTMLAttributes } from 'react';

export interface LabeledInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
}

/** Labeled text input shared by the auth screens and the admin dialogs. */
export function LabeledInput({ label, ...inputProps }: LabeledInputProps) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-neutral-600 dark:text-neutral-400">{label}</span>
      <input
        {...inputProps}
        className="rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:text-neutral-100"
      />
    </label>
  );
}
