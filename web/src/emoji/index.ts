/** Barrel for the shared emoji module — see EmojiPicker.tsx and useEmojiFavorites.ts for the ownership/context-free rationale. */
export { EmojiPicker } from './EmojiPicker';
export type { EmojiPickerProps } from './EmojiPicker';
export { useEmojiFavorites } from './useEmojiFavorites';
export { EMOJI_CATEGORIES, EMOJI_GRID, EMOJI_NAMES, filterEmoji } from './names';
export type { EmojiCategory, EmojiCategoryKey } from './names';
export { decideFavoriteWrites, seedFavorites, toggleFavorite } from './favorites';
export type { FavoriteWrite } from './favorites';
