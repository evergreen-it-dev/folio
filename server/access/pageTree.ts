/**
 * Which pages are "below" a page, for inherited page restrictions
 * (docs/spec-access.md §13). The TypeScript twin of roleSql.ts childPrefixSql;
 * pageTree.test.ts checks both against storage.ts relPathStem, the rule
 * getTree / getSubtree build the sidebar from. Imports nothing on purpose.
 */

/** Characters `relPathStem` strips per page kind (`doc`: `.md`, or `.mdx`). */
const SUFFIX_LENGTH: Record<string, number> = {
  board: '.excalidraw.svg'.length,
  table: '.table.md'.length,
  form: '.form.md'.length,
  pdf: '.pdf'.length,
  canvas: '.canvas'.length,
  base: '.base'.length,
  artifact: '.artifact'.length,
  office: '.docx'.length,
};

export interface TreePage {
  /** Space-relative path (`pages_index.path`, `PageIndexEntry.relPath`). */
  path: string;
  kind: string;
  isIndex: boolean;
}

/**
 * The folder prefix (`dir/`) whose contents are the children of `page`:
 * a directory index's own folder, otherwise the same-named folder next to it.
 * undefined for the space's root index page — its restriction is not
 * inherited (it stands for the space; see childPrefixSql).
 */
export function childPrefixOf(page: TreePage): string | undefined {
  if (page.isIndex) {
    const slash = page.path.lastIndexOf('/');
    return slash === -1 ? undefined : page.path.slice(0, slash + 1);
  }
  const docSuffix = /\.mdx$/i.test(page.path) ? '.mdx'.length : '.md'.length;
  return `${page.path.slice(0, page.path.length - (SUFFIX_LENGTH[page.kind] ?? docSuffix))}/`;
}

/** True when `descendant` lies below `ancestor` (never for the page itself). */
export function isBelow(ancestor: TreePage, descendantPath: string): boolean {
  const prefix = childPrefixOf(ancestor);
  return prefix !== undefined && descendantPath !== ancestor.path && descendantPath.startsWith(prefix);
}
