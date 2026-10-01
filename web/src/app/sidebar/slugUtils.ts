import { officeFormat, type PageKind } from '@shared/contracts';

/** url-git-friendly: lowercase latin letters, digits, hyphen — must not START with a hyphen. Mirrors the SERVER slug-api's own validation (DEV-PLAN Round 22). */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function isValidSlug(value: string): boolean {
  return SLUG_PATTERN.test(value);
}

// A directory's own page — see server/storage.ts's PageIndexEntry.isIndex
// doc comment: "index.md, or README.md when index.md is absent there".
// PageMeta/TreeNode don't expose `isIndex` to the client, so this infers it
// from the basename alone, same rule.
const INDEX_BASENAMES = new Set(['index.md', 'README.md']);

export interface PageSlugInfo {
  /** Editable slug shown to the user: the directory's own name for a directory-index page, otherwise the file's basename with its extension stripped. */
  slug: string;
  /** True when `path` is a directory's index (index.md, or README.md standing in for it) — changing its slug renames the CONTAINING DIRECTORY, not the index file itself. */
  isDirectoryIndex: boolean;
}

function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

/**
 * The file extension a page of this kind is stored under — the single place
 * the client encodes that mapping. Round 26 added `table`: a data table is
 * `<slug>.table.md`, still a `.md` file so GitHub renders it (spec §2), which
 * makes the ORDER of these checks load-bearing — `.table.md` also ends with
 * `.md`, so a plain `.md` test first would leave `<slug>.table` as the slug.
 * Mirrors server/storage.ts's own extension table.
 *
 * `path` disambiguates 'office' — the kind alone doesn't say which of
 * docx/xlsx/pptx a given page is, officeFormat(path) does; without a path
 * (there is none yet — an office page is never created blank, see
 * newPageTitleKey below) this falls back to '.docx'.
 */
export function extensionForKind(kind: PageKind, path?: string): string {
  if (kind === 'board') return '.excalidraw.svg';
  if (kind === 'table') return '.table.md';
  if (kind === 'form') return '.form.md';
  if (kind === 'pdf') return '.pdf';
  if (kind === 'office') {
    const fmt = path ? officeFormat(path) : undefined;
    return `.${fmt ?? 'docx'}`;
  }
  return '.md';
}

/** i18n key for the default title a newly created page of this kind gets. Never called for 'pdf'/'office' — those pages always have an uploaded filename, never a generated "New …" title. */
export function newPageTitleKey(kind: PageKind): string {
  if (kind === 'board') return 'sidebar.newBoard';
  if (kind === 'table') return 'sidebar.newTable';
  if (kind === 'form') return 'sidebar.newForm';
  return 'sidebar.newPage';
}

function stripExtension(base: string, kind: PageKind): string {
  const ext = extensionForKind(kind, base);
  return base.endsWith(ext) ? base.slice(0, -ext.length) : base;
}

/**
 * DEV-PLAN Round 22 (SHELL-4): "the current slug (the last segment of the path
 * without .md; for a directory index — the directory name)". A directory-index page (no
 * parent segment, i.e. sitting at the space root) has no directory name to
 * edit — `slug` comes back `''` in that case, which callers should treat as
 * "nothing editable here" (in practice this never reaches the tree row's
 * "…" menu at all: the space-root index.md is never rendered as a TreeRow —
 * see treeUtils.getTopLevelNodes).
 */
export function getPageSlugInfo(path: string, kind: PageKind): PageSlugInfo {
  const base = basename(path);
  if (kind !== 'board' && INDEX_BASENAMES.has(base)) {
    const segments = path.split('/');
    segments.pop(); // drop "index.md"/"README.md"
    return { slug: segments.pop() ?? '', isDirectoryIndex: true };
  }
  return { slug: stripExtension(base, kind), isDirectoryIndex: false };
}

/**
 * Informational preview of the resulting path after applying `newSlug` —
 * the slug-api itself is the actual source of truth for the rename
 * (git mv, backlink rewriting, etc.); this never round-trips to the server.
 */
export function previewSlugPath(path: string, kind: PageKind, newSlug: string): string {
  const { isDirectoryIndex } = getPageSlugInfo(path, kind);
  const segments = path.split('/');
  if (isDirectoryIndex) {
    segments[segments.length - 2] = newSlug;
  } else {
    segments[segments.length - 1] = `${newSlug}${extensionForKind(kind, path)}`;
  }
  return segments.join('/');
}
