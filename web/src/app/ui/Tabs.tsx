/**
 * Small segmented tab strip — round 27's "Access" page (§6) is the first
 * caller (three tabs: People / Matrix / Spaces). No shared tab primitive
 * existed in web/src/app/ui before this; NOT the same component as
 * web/src/tables/ui's own Tabs (a different, zone-scoped agent's build for
 * the tables feature) — this one is plain Tailwind, matching the rest of
 * web/src/app/ui/**'s hand-rolled style rather than importing across zones.
 */
export interface TabItem {
  key: string;
  label: string;
}

export interface TabsProps {
  items: TabItem[];
  active: string;
  onSelect: (key: string) => void;
  className?: string;
}

export function Tabs({ items, active, onSelect, className }: TabsProps) {
  return (
    <div role="tablist" className={`flex items-center gap-1 border-b border-neutral-200 dark:border-neutral-800 ${className ?? ''}`}>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="tab"
          aria-selected={active === item.key}
          onClick={() => onSelect(item.key)}
          className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
            active === item.key
              ? 'border-neutral-900 text-neutral-900 dark:border-white dark:text-white'
              : 'border-transparent text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200'
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
