/**
 * DEV-PLAN "Round 2" translit slugs: Cyrillic -> latin, then the usual
 * lowercase/non-alnum-to-dash/collapse slug treatment. Used for NEW space
 * slugs and NEW page/board filenames (both kinds now share one naming
 * scheme — see storage.ts). Existing files are never renamed by this.
 */
const CYRILLIC_TO_LATIN: Record<string, string> = {
  // Digraphs/trigraphs and letters that don't map 1:1, exactly as specified.
  я: 'ya', ю: 'yu', ж: 'zh', ч: 'ch', ш: 'sh', щ: 'shch', х: 'kh', ц: 'ts',
  є: 'ye', ї: 'yi', і: 'i', ґ: 'g', й: 'y', ь: '', ъ: '',
  // Remaining Cyrillic letters, including those only some alphabets have,
  // 1:1 to their obvious Latin equivalent.
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
