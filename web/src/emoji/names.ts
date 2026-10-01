/**
 * Static categorized emoji catalog + name/alias map for the picker's search
 * input. It deliberately stays dependency-free: category aliases support
 * broad searches while the common emoji have individual names.
 *
 * Includes the three DEFAULT_EMOJI_FAVORITES (shared/contracts.ts) that
 * weren't already in the general grid — ➕/➖/🔜 — as their own short row,
 * so all seven defaults are both nameable *and* re-addable from the grid
 * after being removed from favorites, not reachable only via the
 * favorites row.
 */
export type EmojiCategoryKey = 'business' | 'smileys' | 'people' | 'nature' | 'food' | 'activity' | 'travel' | 'symbols';

export interface EmojiCategory {
  key: EmojiCategoryKey;
  emojis: readonly string[];
}

/** The original Folio set: intentionally kept together as the Business group. */
const BUSINESS_EMOJIS: readonly string[] = [
  '📄', '📝', '📋', '📌', '📎', '🗂️', '📁', '📚', '📖', '🔖',
  '💡', '🔥', '⭐', '✨', '🚀', '🎯', '🏆', '🎉', '🎨', '🧩',
  '⚙️', '🔧', '🔨', '🛠️', '🧪', '🔬', '📊', '📈', '📉', '🗺️',
  '🧭', '🔍', '🔒', '🔑', '🛡️', '⚡', '🌐', '💻', '🖥️', '📱',
  '☁️', '🗄️', '💾', '🔗', '🧱', '🏗️', '🏢', '🏠', '🚦', '🧰',
  '📅', '⏰', '⏳', '✅', '❌', '❓', '❗', '⚠️', '🆕', '📢',
  '💬', '📣', '✉️', '📮', '📦', '🧾', '💰', '💳', '🧮', '🎓',
  '🌱', '🌳', '🌍', '🌊', '❄️', '☀️', '🌙', '🌈', '🍀', '🪴',
  '🐛', '🐞', '🐝', '🦋', '🐢', '🦉', '🐙', '🦄', '🐳', '🦊',
  '❤️', '💛', '💚', '💙', '💜', '🖤', '🤍', '🧡', '💯', '🔵',
  '🔺', '🔶', '🎲', '🧵', '🧶', '🖇️', '🗒️', '🗞️', '📐', '📏',
  '🚩', '🏁', '🎬', '🎧', '🎤', '📷', '🖼️', '🧑‍💻', '🧑‍🎨', '🧑‍🔬',
  '➕', '➖', '🔜', '⛔', '🚫',
];

const SMILEY_EMOJIS: readonly string[] = [
  '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇',
  '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😋', '😛', '😜',
  '🤪', '🤨', '🧐', '🤓', '😎', '🥳', '😏', '😒', '😞', '😔',
  '😟', '😕', '🙁', '☹️', '😣', '😖', '😫', '😩', '🥺', '😢',
  '😭', '😤', '😠', '😡', '🤬', '🤯', '😳', '🥵', '🥶', '😱',
  '😨', '😰', '😥', '😓', '🤗', '🤔', '🫣', '🤭', '🫢', '🤫',
  '🫡', '🤥', '😶', '😐', '😑', '😬', '🙄', '😯', '😦', '😧',
  '😮', '😲', '🥱', '😴', '🤤', '😪', '😵‍💫', '🤐', '🤢', '🤮',
  '🤧', '😷', '🤒', '🤕', '🤑', '🤠', '😈', '👿', '👻', '💩', '🤖',
];

const PEOPLE_EMOJIS: readonly string[] = [
  '👋', '🤚', '🖐️', '✋', '🖖', '👌', '🤌', '🤏', '✌️', '🤞',
  '🫰', '🤟', '🤘', '🤙', '👈', '👉', '👆', '👇', '☝️', '👍',
  '👎', '✊', '👊', '🤛', '🤜', '👏', '🙌', '🫶', '🤝', '🙏',
  '💪', '🦾', '🧠', '👀', '🗣️', '👤', '👥', '🧑', '👩', '👨',
  '🧑‍🏫', '🧑‍🚀', '🧑‍⚕️', '🧑‍🚒', '🧑‍⚖️', '🧑‍💼',
];

const NATURE_EMOJIS: readonly string[] = [
  '🐶', '🐱', '🐭', '🐹', '🐰', '🐻', '🐼', '🐨', '🐯', '🦁',
  '🐮', '🐷', '🐸', '🐵', '🐔', '🐧', '🐦', '🦆', '🦅', '🐺',
  '🐗', '🐴', '🐍', '🦎', '🦖', '🐬', '🐟', '🦈', '🦀', '🌸',
  '🌻', '🌹', '🌵', '🍁', '🍂', '🌿', '🌴', '🌾', '🍄', '🪨',
];

const FOOD_EMOJIS: readonly string[] = [
  '🍏', '🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐',
  '🍒', '🍑', '🥭', '🍍', '🥝', '🍅', '🥑', '🥦', '🥕', '🌽',
  '🍞', '🥐', '🧀', '🥚', '🍔', '🍕', '🌭', '🥪', '🌮', '🍜',
  '🍣', '🍪', '🍩', '🍰', '🍫', '☕', '🍵', '🥤', '🍺', '🍷',
];

const ACTIVITY_EMOJIS: readonly string[] = [
  '⚽', '🏀', '🏈', '⚾', '🎾', '🏐', '🏉', '🥏', '🎳', '🏓',
  '🏸', '🥅', '🏒', '🏹', '🎣', '🥊', '🥋', '⛳', '⛸️', '🎿',
  '🏋️', '🤸', '🏃', '🚴', '🧘', '🎮', '🕹️', '🎻', '🎸', '🎹',
];

const TRAVEL_EMOJIS: readonly string[] = [
  '🚗', '🚕', '🚌', '🚎', '🏎️', '🚓', '🚑', '🚒', '🚚', '🚲',
  '🛴', '🏍️', '🚂', '🚆', '🚇', '🚊', '✈️', '🛫', '🛬', '🚁',
  '🚢', '⛵', '🚤', '🗼', '🏰', '🏯', '🏟️', '🏖️', '🏝️', '⛰️',
];

const SYMBOL_EMOJIS: readonly string[] = [
  '🟢', '🟡', '🟠', '🔴', '🟣', '⚫', '⚪', '🟤', '🟥', '🟧',
  '🟨', '🟩', '🟦', '🟪', '⬛', '⬜', '◀️', '▶️', '⬆️', '⬇️',
  '↔️', '↕️', '🔄', '✔️', '☑️', '➗', '✖️', '♾️', '‼️', '⁉️',
];

export const EMOJI_CATEGORIES: readonly EmojiCategory[] = [
  { key: 'business', emojis: BUSINESS_EMOJIS },
  { key: 'smileys', emojis: SMILEY_EMOJIS },
  { key: 'people', emojis: PEOPLE_EMOJIS },
  { key: 'nature', emojis: NATURE_EMOJIS },
  { key: 'food', emojis: FOOD_EMOJIS },
  { key: 'activity', emojis: ACTIVITY_EMOJIS },
  { key: 'travel', emojis: TRAVEL_EMOJIS },
  { key: 'symbols', emojis: SYMBOL_EMOJIS },
];

export const EMOJI_GRID: readonly string[] = EMOJI_CATEGORIES.flatMap((category) => category.emojis);

/**
 * emoji -> space-joined lowercase search keywords. This table holds the
 * English ones; every other language lives in its own module under
 * ./keywords/ and is merged in below. Which languages a build can search in
 * is decided by which of those modules exist.
 */
export const EMOJI_NAMES: Record<string, string> = {
  '📄': 'document page',
  '📝': 'note edit memo todo',
  '📋': 'clipboard checklist',
  '📌': 'pin pushpin',
  '📎': 'paperclip attachment',
  '🗂️': 'folder index',
  '📁': 'folder directory',
  '📚': 'books docs',
  '📖': 'book guide',
  '🔖': 'bookmark tag',

  '💡': 'idea insight',
  '🔥': 'fire hot',
  '⭐': 'star favorite',
  '✨': 'sparkles new magic',
  '🚀': 'rocket launch',
  '🎯': 'target goal dart',
  '🏆': 'trophy award',
  '🎉': 'party celebration',
  '🎨': 'art design',
  '🧩': 'puzzle integration',

  '⚙️': 'gear settings',
  '🔧': 'wrench fix repair',
  '🔨': 'hammer build',
  '🛠️': 'tools hammer',
  '🧪': 'test tube experiment qa',
  '🔬': 'microscope research',
  '📊': 'chart stats',
  '📈': 'chart up growth trend',
  '📉': 'chart down decline',
  '🗺️': 'map roadmap',

  '🧭': 'compass navigation',
  '🔍': 'search magnify',
  '🔒': 'lock locked',
  '🔑': 'key access',
  '🛡️': 'shield security',
  '⚡': 'lightning fast',
  '🌐': 'globe web',
  '💻': 'laptop code',
  '🖥️': 'desktop monitor',
  '📱': 'phone mobile',

  '☁️': 'cloud storage',
  '🗄️': 'cabinet database',
  '💾': 'save disk',
  '🔗': 'link url',
  '🧱': 'brick foundation',
  '🏗️': 'construction wip',
  '🏢': 'office company',
  '🏠': 'home house',
  '🚦': 'traffic light status',
  '🧰': 'toolbox kit',

  '📅': 'calendar date',
  '⏰': 'alarm deadline',
  '⏳': 'hourglass pending',
  '✅': 'check done',
  '❌': 'cross cancel',
  '❓': 'question help',
  '❗': 'exclamation important',
  '⚠️': 'warning alert',
  '🆕': 'new fresh',
  '📢': 'announcement megaphone',

  '💬': 'chat comment',
  '📣': 'megaphone broadcast',
  '✉️': 'envelope email',
  '📮': 'mailbox post',
  '📦': 'package box release',
  '🧾': 'receipt invoice',
  '💰': 'money budget',
  '💳': 'card payment',
  '🧮': 'abacus calculation',
  '🎓': 'graduation education',

  '🌱': 'seedling growth',
  '🌳': 'tree nature',
  '🌍': 'earth world global',
  '🌊': 'wave flow',
  '❄️': 'snowflake cold frozen',
  '☀️': 'sun sunny light',
  '🌙': 'moon night dark',
  '🌈': 'rainbow colorful',
  '🍀': 'clover luck',
  '🪴': 'plant grow',

  '🐛': 'bug defect',
  '🐞': 'ladybug bugfix',
  '🐝': 'bee busy',
  '🦋': 'butterfly transform',
  '🐢': 'turtle slow',
  '🦉': 'owl wise',
  '🐙': 'octopus multitask',
  '🦄': 'unicorn special',
  '🐳': 'whale big',
  '🦊': 'fox clever',

  '❤️': 'heart love red',
  '💛': 'yellow heart yellow',
  '💚': 'green heart green',
  '💙': 'blue heart blue',
  '💜': 'purple heart purple',
  '🖤': 'black heart black',
  '🤍': 'white heart white',
  '🧡': 'orange heart orange',
  '💯': 'hundred perfect',
  '🔵': 'blue circle dot',

  '🔺': 'triangle alert',
  '🔶': 'diamond orange diamond',
  '🎲': 'dice random',
  '🧵': 'thread sewing',
  '🧶': 'yarn thread bundle',
  '🖇️': 'paperclips attach',
  '🗒️': 'notepad notes',
  '🗞️': 'newspaper news',
  '📐': 'ruler triangle design',
  '📏': 'ruler measure',

  '🚩': 'flag report',
  '🏁': 'checkered flag finish done',
  '🎬': 'clapper video',
  '🎧': 'headphones audio',
  '🎤': 'microphone voice',
  '📷': 'camera photo',
  '🖼️': 'picture image',
  '🧑‍💻': 'developer engineer',
  '🧑‍🎨': 'artist designer',
  '🧑‍🔬': 'scientist researcher',

  '➕': 'plus add',
  '➖': 'minus remove',
  '🔜': 'soon coming wip',
  '⛔': 'stop no entry noentry',
  '🚫': 'prohibited forbidden',
};

const CATEGORY_SEARCH_ALIASES: Record<EmojiCategoryKey, string> = {
  business: 'business work office main',
  smileys: 'smileys emotion face emoji',
  people: 'people gestures hands',
  nature: 'animals nature plants',
  food: 'food drink',
  activity: 'activity sport music games',
  travel: 'travel places transport',
  symbols: 'symbols signs colors',
};

const ADDITIONAL_EMOJI_NAMES: Record<string, string> = {
  '😀': 'grinning smile happy',
  '😃': 'smile happy',
  '😄': 'smile happy laugh',
  '😁': 'grin smile',
  '😂': 'tears joy laugh',
  '🤣': 'rofl laugh',
  '😊': 'blush smile kind',
  '😍': 'love eyes',
  '🥰': 'love hearts',
  '😎': 'cool sunglasses',
  '🥳': 'party celebration',
  '🤔': 'thinking',
  '😐': 'neutral',
  '🙄': 'rolling eyes',
  '🥱': 'yawn',
  '😴': 'sleep tired',
  '😢': 'sad cry',
  '😭': 'cry tears',
  '😠': 'angry',
  '😡': 'angry rage',
  '🤯': 'mind blown',
  '😱': 'fear scream',
  '🤗': 'hug',
  '🫡': 'salute',
  '🤢': 'sick nauseated',
  '🤮': 'vomit',
  '😷': 'mask sick',
  '🤒': 'fever ill',
  '🤕': 'hurt bandage',
  '🤑': 'money face',
  '🤠': 'cowboy',
  '👻': 'ghost',
  '💩': 'poop',
  '🤖': 'robot',
  '👋': 'wave hello bye',
  '👍': 'thumbs up like',
  '👎': 'thumbs down dislike',
  '👏': 'clap applause',
  '🙌': 'raised hands hooray',
  '🫶': 'heart hands',
  '🤝': 'handshake agreement',
  '🙏': 'please thanks prayer',
  '💪': 'strong muscle',
  '🧠': 'brain mind',
  '👀': 'eyes look',
};

/** One language's search keywords. */
export interface EmojiKeywords {
  /** Broad words that find a whole category. */
  categories: Partial<Record<EmojiCategoryKey, string>>;
  /** emoji -> space-joined lowercase keywords. */
  emoji: Record<string, string>;
}

const LANGUAGE_KEYWORDS = Object.values(
  import.meta.glob<EmojiKeywords>(['./keywords/*.ts', '!./keywords/*.test.ts'], { eager: true, import: 'default' }),
);

// Category aliases make broad searches ("smileys", "business") useful, while
// the specific names above handle the common individual cases.
for (const category of EMOJI_CATEGORIES) {
  for (const emoji of category.emojis) {
    EMOJI_NAMES[emoji] = [
      EMOJI_NAMES[emoji],
      ADDITIONAL_EMOJI_NAMES[emoji],
      CATEGORY_SEARCH_ALIASES[category.key],
      ...LANGUAGE_KEYWORDS.flatMap((language) => [language.emoji[emoji], language.categories[category.key]]),
    ]
      .filter(Boolean)
      .join(' ');
  }
}
// Emoji that are named but sit outside the grid (the default favorites row).
for (const language of LANGUAGE_KEYWORDS) {
  for (const [emoji, keywords] of Object.entries(language.emoji)) {
    if (!(EMOJI_NAMES[emoji] ?? '').includes(keywords)) {
      EMOJI_NAMES[emoji] = `${EMOJI_NAMES[emoji] ?? ''} ${keywords}`.trim();
    }
  }
}

/**
 * Case-insensitive filter: an emoji matches if the query is a substring of
 * its own name/alias string, OR the query literally *is* that emoji
 * (pasting/typing the character itself always finds itself). Empty query
 * returns the list unchanged, in order.
 */
export function filterEmoji(query: string, emojiList: readonly string[]): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...emojiList];
  return emojiList.filter((emoji) => emoji === query.trim() || (EMOJI_NAMES[emoji] ?? '').includes(q));
}
