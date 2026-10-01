/**
 * GitHub-style heading slug: lowercase, strip punctuation (keeping Unicode
 * letters/numbers so Cyrillic headings get readable native slugs rather
 * than being transliterated — matches how GitHub itself anchors non-Latin
 * headings, and this app treats GitHub-renderable fidelity as a hard
 * requirement), spaces collapse to a single hyphen.
 */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}
