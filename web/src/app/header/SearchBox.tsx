import { Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '../i18n/register';

export interface SearchBoxProps {
  /** Opens the Cmd+K quick switcher (round 5) — this button is now just its entry point in the header; the actual search/recents/actions UI lives there. See switcher/QuickSwitcher.tsx and Shell.tsx's global keydown listener. */
  onOpen: () => void;
}

/** Header search entry point: a button styled like an input, opening the Cmd+K quick switcher. */
export function SearchBox({ onOpen }: SearchBoxProps) {
  const { t } = useTranslation('app');
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent);

  return (
    <button
      type="button"
      onClick={onOpen}
      // Round 14: <md shrinks this to a bare icon button (no width utility
      // in the base classes at all, so it just sizes to the icon + p-1.5) —
      // the full pill with its text/kbd hint only returns at md+, where
      // header.searchAndGo becomes visible text again instead of the
      // aria-label/title carrying it alone.
      aria-label={t('header.searchAndGo')}
      title={t('header.searchAndGo')}
      // QA-3 P1 (the other half of the breadcrumb squeeze): this was
      // `shrink-0 … md:w-full md:max-w-sm`, i.e. a hard 384px claim on the
      // header at EVERY width from 768px up. At 1024px that left the
      // breadcrumb <nav> 171px total for a space name, two ancestors and the
      // page's own title. The pill now steps up with the viewport (12rem at
      // md, 16rem at lg, the original 24rem only at xl+) and keeps
      // shrink:1/min-w-0 at md+ so it yields a little more when the header is
      // genuinely tight; its label truncates and the ⌘K hint stays put.
      // shrink-0 is retained only below md, where this is already a bare
      // 40px icon button with nothing left to give.
      className="flex h-9 items-center gap-2 rounded-md border border-neutral-300 bg-white px-2.5 text-left text-sm text-neutral-400 hover:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:border-neutral-600 max-md:min-h-10 max-md:min-w-10 max-md:shrink-0 max-md:justify-center md:w-full md:min-w-0 md:max-w-[11rem] lg:max-w-[14rem] xl:max-w-[18rem]"
    >
      <Search size={14} className="shrink-0" aria-hidden="true" />
      <span className="hidden min-w-0 flex-1 truncate md:inline">{t('header.searchAndGo')}</span>
      <kbd className="hidden shrink-0 rounded border border-neutral-300 bg-neutral-50 px-1.5 py-0.5 font-sans text-xs text-neutral-400 dark:border-neutral-700 dark:bg-neutral-800 md:inline">
        {isMac ? '⌘K' : 'Ctrl K'}
      </kbd>
    </button>
  );
}
