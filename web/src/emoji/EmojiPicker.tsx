import { useMemo, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { EMOJI_CATEGORIES, EMOJI_NAMES, filterEmoji } from './names';
import { useEmojiFavorites } from './useEmojiFavorites';

export interface EmojiPickerProps {
  value?: string;
  /** Picking an emoji — either a grid/favorites cell or Enter in the free-text field. */
  onPick: (emoji: string) => void;
  /** Optional: omit to hide the "Remove icon" action entirely (e.g. a caller with nothing to clear yet). */
  onClear?: () => void;
  /** Escape inside the picker. The picker owns this key itself; positioning/backdrop/portal chrome stays the caller's job (ui/Menu.tsx for the page-icon flow). */
  onClose?: () => void;
  /**
   * A *partial* favorites-materialization failure (see useEmojiFavorites.ts)
   * — some but not all of the defaults-materializing writes landed. Optional
   * and left to the caller on purpose (this module stays context-free, no
   * app/ui/Toast dependency here) — app callers can wire it to their own
   * toast; editor/ callers can wire it to editor/toast.ts, or omit it.
   */
  onFavoritesError?: () => void;
}

/**
 * Shared emoji picker (round 6, moved out of app/page-meta/ into this
 * standalone module for the same reason markdown/ is standalone: editor/
 * needs it too, without pulling in app/'s router/auth context — see
 * useEmojiFavorites.ts's docblock for exactly what that hook does and
 * doesn't depend on). Categorized static catalog + search, no emoji-picker library.
 *
 * Layout: search input, then favorites (the user's working set, the twelve
 * defaults until they customize it), then localized category sections,
 * then a free-text field for anything not in the catalog, then
 * an optional clear action. Every cell shows a small star in the corner —
 * ★ filled and always visible once favorited, ☆ only on hover otherwise —
 * clicking the star toggles favorite status without picking the emoji;
 * clicking the emoji itself picks it.
 */
export function EmojiPicker({ value, onPick, onClear, onClose, onFavoritesError }: EmojiPickerProps) {
  const { t } = useTranslation('app');
  const [query, setQuery] = useState('');
  const [custom, setCustom] = useState('');
  const { favorites, isFavorite, toggleFavorite } = useEmojiFavorites(onFavoritesError);

  // Independent memoization: favorites and the static grid change on
  // different triggers (toggling a favorite never touches the grid array),
  // so there's no reason to re-filter both together.
  const filteredFavorites = useMemo(() => filterEmoji(query, favorites), [query, favorites]);
  const filteredCategories = useMemo(
    () =>
      EMOJI_CATEGORIES.map((category) => ({
        ...category,
        emojis: filterEmoji(query, category.emojis),
      })).filter((category) => category.emojis.length > 0),
    [query],
  );
  const nothingFound = filteredFavorites.length === 0 && filteredCategories.length === 0;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    event.stopPropagation();
    if (event.key === 'Escape') onClose?.();
  }

  return (
    <div className="w-80" onKeyDown={handleKeyDown}>
      <div className="p-1.5 pb-1">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('pageChrome.emojiPicker.search')}
          className="w-full rounded border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
        />
      </div>

      <div className="max-h-72 overflow-y-auto px-1.5 pb-1">
        {filteredFavorites.length > 0 && (
          <GridSection label={t('pageChrome.emojiPicker.favorites')}>
            {filteredFavorites.map((emoji) => (
              <Cell
                key={emoji}
                emoji={emoji}
                selected={value === emoji}
                favorite
                onPick={onPick}
                onToggleFavorite={toggleFavorite}
                addFavoriteLabel={t('pageChrome.emojiPicker.addFavorite', { emoji })}
                removeFavoriteLabel={t('pageChrome.emojiPicker.removeFavorite', { emoji })}
              />
            ))}
          </GridSection>
        )}

        {filteredCategories.map((category) => (
          <GridSection key={category.key} label={t(`pageChrome.emojiPicker.categories.${category.key}`)}>
            {category.emojis.map((emoji) => (
              <Cell
                key={emoji}
                emoji={emoji}
                selected={value === emoji}
                favorite={isFavorite(emoji)}
                onPick={onPick}
                onToggleFavorite={toggleFavorite}
                addFavoriteLabel={t('pageChrome.emojiPicker.addFavorite', { emoji })}
                removeFavoriteLabel={t('pageChrome.emojiPicker.removeFavorite', { emoji })}
              />
            ))}
          </GridSection>
        ))}

        {nothingFound && <p className="px-1 py-4 text-center text-xs text-neutral-400">{t('pageChrome.emojiPicker.nothingFound')}</p>}
      </div>

      <div className="border-t border-neutral-200 p-1.5 dark:border-neutral-700">
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && custom.trim()) onPick(custom.trim());
          }}
          placeholder={t('pageChrome.emojiPicker.custom')}
          className="w-full rounded border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
        />
      </div>

      {value && onClear && (
        <div className="border-t border-neutral-200 p-1 dark:border-neutral-700">
          <button
            type="button"
            onClick={onClear}
            className="w-full rounded px-2 py-1.5 text-left text-xs text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
          >
            {t('pageChrome.emojiPicker.clear')}
          </button>
        </div>
      )}
    </div>
  );
}

function GridSection({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="mb-1 last:mb-0">
      {label && <div className="px-1 pb-0.5 pt-1 text-[11px] font-medium text-neutral-400 dark:text-neutral-500">{label}</div>}
      <div className="grid grid-cols-8 gap-0.5">{children}</div>
    </div>
  );
}

interface CellProps {
  emoji: string;
  selected: boolean;
  favorite: boolean;
  onPick: (emoji: string) => void;
  onToggleFavorite: (emoji: string) => void;
  addFavoriteLabel: string;
  removeFavoriteLabel: string;
}

function Cell({ emoji, selected, favorite, onPick, onToggleFavorite, addFavoriteLabel, removeFavoriteLabel }: CellProps) {
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={() => onPick(emoji)}
        aria-label={emoji}
        title={EMOJI_NAMES[emoji]}
        className={`flex h-8 w-8 items-center justify-center rounded text-lg hover:bg-neutral-100 dark:hover:bg-neutral-800 ${
          selected ? 'bg-neutral-200 dark:bg-neutral-700' : ''
        }`}
      >
        {emoji}
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggleFavorite(emoji);
        }}
        aria-label={favorite ? removeFavoriteLabel : addFavoriteLabel}
        aria-pressed={favorite}
        className={`absolute -right-0.5 -top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full text-[10px] leading-none ${
          favorite
            ? 'text-amber-500 opacity-100'
            : 'text-neutral-400 opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
        }`}
      >
        {favorite ? '★' : '☆'}
      </button>
    </div>
  );
}
