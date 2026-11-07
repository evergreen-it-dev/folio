import type { ReactNode } from 'react';

/** Small uppercase label above a sidebar section, left-aligned with the row icon boxes. */
export function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="pb-1 pl-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">{children}</div>;
}
