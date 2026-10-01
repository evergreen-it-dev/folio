/**
 * Emoji name map for the `:shortcode` and `((` pickers.
 *
 * Local to the editor for now: the shared `web/src/emoji/` module SHELL is
 * extracting does not exist yet. `EMOJI` is exported in a plain shape so that
 * module can adopt it verbatim when it lands.
 *
 * The rows below carry the English aliases. Aliases in other languages live
 * in ./emoji-aliases/, one module per language, keyed by the canonical name,
 * and are merged in — so `:plus` and its translations find the same emoji.
 * Which languages a build knows is decided by which modules exist.
 */
export interface EmojiEntry {
  emoji: string;
  /** Canonical shortcode: what `:name:` expands and what the row shows. */
  name: string;
  aliases: string[];
  /** Higher wins ties; the set the owner asked for sits above everything else. */
  priority: number;
}

type Row = readonly [emoji: string, name: string, aliases: string];

/** The set the owner named explicitly — these must always be first-class. */
const REQUIRED: Row[] = [
  ['➕', 'plus', 'add'],
  ['➖', 'minus', 'remove'],
  ['🔜', 'soon', 'later'],
  ['🛠️', 'tools', 'hammer fix'],
  ['⚠️', 'warning', 'attention'],
  ['🆕', 'new', 'fresh'],
  ['⭐', 'star', 'favourite favorite'],
];

const COMMON: Row[] = [
  // status
  ['✅', 'check', 'done ok'],
  ['❌', 'cross', 'cancel no'],
  ['✔️', 'tick', ''],
  ['❗', 'exclamation', 'important'],
  ['❓', 'question', 'question'],
  ['🚫', 'prohibited', 'nope no_entry forbidden'],
  ['⛔', 'stop', 'noentry no_entry'],
  ['🔴', 'red_circle', 'blocked'],
  ['🟡', 'yellow_circle', 'risk'],
  ['🟢', 'green_circle', 'ok'],
  ['🔵', 'blue_circle', ''],
  ['⏳', 'hourglass', 'waiting'],
  ['⏰', 'alarm', 'deadline'],
  ['📅', 'calendar', 'date'],
  ['🔒', 'lock', 'private'],
  ['🔓', 'unlock', ''],
  // work
  ['🚀', 'rocket', 'launch release'],
  ['🔥', 'fire', 'hot'],
  ['👀', 'eyes', 'review'],
  ['🤔', 'thinking', 'hmm'],
  ['💡', 'bulb', 'idea'],
  ['🐛', 'bug', ''],
  ['🧪', 'test', 'qa'],
  ['🧹', 'broom', 'cleanup'],
  ['📌', 'pin', ''],
  ['📎', 'clip', 'attachment'],
  ['📝', 'memo', 'note'],
  ['📄', 'page', 'document'],
  ['📁', 'folder', ''],
  ['📊', 'chart', 'stats'],
  ['📈', 'up', 'growth'],
  ['📉', 'down', ''],
  ['🎯', 'target', 'goal'],
  ['🏁', 'finish', ''],
  ['🔗', 'link', ''],
  ['🔍', 'search', ''],
  ['⚙️', 'gear', 'settings'],
  ['🧩', 'puzzle', ''],
  ['🗑️', 'trash', 'delete'],
  ['📦', 'package', ''],
  ['🏗️', 'construction', 'wip'],
  ['🧠', 'brain', ''],
  ['🤖', 'robot', 'ai'],
  ['💬', 'speech', 'comment'],
  ['📣', 'megaphone', 'announce'],
  ['🙏', 'pray', 'please thanks'],
  ['👍', 'thumbsup', 'like'],
  ['👎', 'thumbsdown', ''],
  ['👋', 'wave', 'hello'],
  ['🎉', 'tada', 'party'],
  ['✨', 'sparkles', 'nice'],
  ['❤️', 'heart', 'love'],
  ['😀', 'smile', 'happy'],
  ['😅', 'sweat_smile', ''],
  ['😉', 'wink', ''],
  ['😎', 'cool', ''],
  ['😢', 'cry', 'sad'],
  ['😱', 'scream', ''],
  ['🤝', 'handshake', 'deal'],
  ['💪', 'muscle', ''],
  ['☕', 'coffee', 'break'],
  ['🍕', 'pizza', ''],
  ['🌍', 'globe', 'world'],
  ['⚡', 'zap', 'fast'],
  ['🌟', 'glow', ''],
  ['💰', 'money', 'cost'],
  ['⏭️', 'next', 'skip'],
  ['🔁', 'repeat', 'loop'],
  ['🧭', 'compass', ''],
  ['🗺️', 'map', 'roadmap'],
  ['🏷️', 'tag', 'label'],
  ['🔔', 'bell', 'notify'],
  // numbers
  ['1️⃣', 'one', '1'],
  ['2️⃣', 'two', '2'],
  ['3️⃣', 'three', '3'],
  ['4️⃣', 'four', '4'],
  ['5️⃣', 'five', '5'],
  ['6️⃣', 'six', '6'],
  ['7️⃣', 'seven', '7'],
  ['8️⃣', 'eight', '8'],
  ['9️⃣', 'nine', '9'],
  ['🔟', 'ten', '10'],
  ['#️⃣', 'hash', ''],
];

const LANGUAGE_ALIASES = Object.values(
  import.meta.glob<Record<string, string>>(['./emoji-aliases/*.ts', '!./emoji-aliases/*.test.ts'], { eager: true, import: 'default' }),
);

function toEntry([emoji, name, aliases]: Row, priority: number): EmojiEntry {
  const all = [aliases, ...LANGUAGE_ALIASES.map((language) => language[name] ?? '')].join(' ');
  return { emoji, name, aliases: all.split(' ').filter(Boolean), priority };
}

export const EMOJI: EmojiEntry[] = [
  ...REQUIRED.map((row) => toEntry(row, 100)),
  ...COMMON.map((row) => toEntry(row, 0)),
];

const BY_NAME = new Map<string, EmojiEntry>();
for (const entry of EMOJI) {
  BY_NAME.set(entry.name, entry);
  for (const alias of entry.aliases) if (!BY_NAME.has(alias)) BY_NAME.set(alias, entry);
}

/** Exact lookup used by the `:name:` closing-colon expansion. */
export function emojiByName(name: string): EmojiEntry | undefined {
  return BY_NAME.get(name.toLowerCase());
}
