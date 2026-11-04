/**
 * What a folder is called for a reader. In Folio a folder is usually a PAGE
 * with a title: the directory's `index.md` (or `README.md` when there is no
 * index.md), or the one page `X.md` / `X.table.md` / … whose stem names the
 * directory `X/` (the same rule as the page tree, server/graph.ts treeParents).
 * The graph legend and the file.folder column of a base show that title
 * instead of the slug; a folder without a page keeps its slug. Pure, so the
 * server and the web app share it.
 */

export interface FolderTitlePage {
  path: string;
  title: string;
}

/** The suffixes a page file may carry; the stem is what is left (the directory a same-named page claims). */
const SUFFIXES = ['.excalidraw.svg', '.table.md', '.form.md', '.canvas', '.base', '.pdf', '.md', '.mdx'];

function stemOf(fileName: string): string | null {
  const lower = fileName.toLowerCase();
  for (const s of SUFFIXES) if (lower.endsWith(s)) return fileName.slice(0, fileName.length - s.length);
  const dot = fileName.lastIndexOf('.');
  // Office files and the like: `plan.docx` claims `plan/`.
  return dot > 0 ? fileName.slice(0, dot) : null;
}

const dirOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const nameOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

/**
 * Directory (space-relative, no slashes at the ends) → the title of its page.
 * Only directories that hold something can be claimed; a stem claimed by two
 * pages is ambiguous and left out.
 */
export function folderTitleMap(pages: readonly FolderTitlePage[]): Map<string, string> {
  const out = new Map<string, string>();
  const hasIndexMd = new Set<string>();
  for (const p of pages) if (/^index\.mdx?$/.test(nameOf(p.path))) hasIndexMd.add(dirOf(p.path));
  for (const p of pages) {
    const name = nameOf(p.path);
    const dir = dirOf(p.path);
    if (dir === '') continue; // the root's index page is the space home, not a folder
    if (/^index\.mdx?$/.test(name) || (/^README\.mdx?$/.test(name) && !hasIndexMd.has(dir))) {
      if (p.title.trim()) out.set(dir, p.title.trim());
    }
  }
  const used = new Set<string>();
  for (const p of pages) for (let d = dirOf(p.path); d !== '' && !used.has(d); d = dirOf(d)) used.add(d);
  const claims = new Map<string, string[]>();
  for (const p of pages) {
    const name = nameOf(p.path);
    if (/^(index|README)\.mdx?$/.test(name)) continue;
    const stem = stemOf(name);
    if (!stem) continue;
    const dir = dirOf(p.path);
    const candidate = dir ? `${dir}/${stem}` : stem;
    if (!used.has(candidate) || out.has(candidate) || !p.title.trim()) continue;
    const list = claims.get(candidate) ?? [];
    list.push(p.title.trim());
    claims.set(candidate, list);
  }
  for (const [dir, titles] of claims) if (titles.length === 1) out.set(dir, titles[0]);
  return out;
}

/**
 * The folder's display name: the titles of its pages from the top, joined by ` / `
 * (`Tech / Prompts`); a segment without a page shows its slug. '' (the root) → null:
 * the caller words the root itself.
 */
export function folderDisplay(dir: string, titles: ReadonlyMap<string, string>, sep = ' / '): string | null {
  const clean = dir.replace(/^\/+|\/+$/g, '');
  if (clean === '') return null;
  const parts = clean.split('/');
  return parts.map((seg, i) => titles.get(parts.slice(0, i + 1).join('/')) ?? seg).join(sep);
}
