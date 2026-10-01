/**
 * Client-side port of server/translit.ts's `translitSlug` — DEV-PLAN "Round
 * 2": ru+uk Cyrillic -> latin, then lowercase/non-alnum-to-dash/collapse.
 * Duplicated rather than imported: server/ is a separate Node runtime, never
 * bundled into the browser (same reasoning as every other app/<->markdown/
 * duplication this codebase already has — see e.g. treeUtils.ts's dirname).
 *
 * Used by CreateSpaceDialog.tsx to live-preview the git root-path field as
 * the user types the space name, matching what SERVER will actually slug
 * the space to — must stay byte-for-byte in sync with server/translit.ts's
 * CYRILLIC_TO_LATIN table if that ever changes.
 */
const CYRILLIC_TO_LATIN: Record<string, string> = {
  я: 'ya', ю: 'yu', ж: 'zh', ч: 'ch', ш: 'sh', щ: 'shch', х: 'kh', ц: 'ts',
  є: 'ye', ї: 'yi', і: 'i', ґ: 'g', й: 'y', ь: '', ъ: '',
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', з: 'z', и: 'i',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', ы: 'y', э: 'e',
};

export function translitSlug(input: string): string {
  const lower = input.trim().toLowerCase();
  let out = '';
  for (const ch of lower) {
    out += CYRILLIC_TO_LATIN[ch] ?? ch;
  }
  const slug = out.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || `item-${Date.now().toString(36)}`;
}
