/**
 * Obsidian-style wikilinks — `[[target]]`, `[[target|alias]]`, `[[target#heading]]`,
 * `[[target#^block]]` and the embed form `![[target]]` — for the link index and
 * for the rename/move rewriters in links.ts (Obsidian vault compatibility,
 * wave 1a). Pure functions, no database: links.ts feeds them page paths.
 *
 * What Folio does with `[[`:
 *  - READ: every wikilink outside code is indexed in `page_links` (index v2,
 *    server/indexV2) as syntax 'wikilink' / 'embed', kind 'page' / 'unresolved'
 *    / 'asset', with its `#heading` / `#^block` fragment and `|alias`;
 *    rendering them is a later wave.
 *  - REWRITE: a rename or move of the target (or the source) re-aims the
 *    wikilink, keeping its form — `[[Old|alias]]` becomes `[[New|alias]]`, the
 *    `#heading` / `#^block` / `|alias` tail and the `!` of an embed stay as
 *    written, and so does everything around the link.
 *  - NEVER WRITE: Folio does not create wikilinks (the editor's `[[` picker
 *    still inserts relative markdown links) and never rewrites a file "while it
 *    is at it".
 *
 * Resolution (Obsidian's "shortest path when possible", the donor analysis
 * §2.7), for a link path as written, from a source page in `sourceDir`:
 *  1. a name without an extension means `<name>.md` (tried first); an explicit
 *     extension is tried as written (`Report.pdf`, `Note.md`); `%20` is literal
 *     first, then percent-decoded;
 *  2. the path relative to the source's folder (`./x`, `../x`, `sub/x`, `x`);
 *     a path that starts with `./` or `../` is ONLY ever tried this way;
 *  3. the path from the space root (how Obsidian writes a full path);
 *  4. any page whose path ENDS with the link path (`b/x` finds `a/b/x.md`, a bare
 *     name finds `x.md` anywhere) — a single match wins; several: the one nearest
 *     to the source's folder (most shared leading folders, then fewest folders,
 *     then alphabetical);
 *  5. otherwise unresolved. Matching ignores case (Obsidian does); when several
 *     paths differ only by case, the alphabetically first is taken.
 * A link with no path (`[[#Heading]]`) points into its own page and is skipped.
 */
import { posix as pathPosix } from 'node:path';
import { splitWikilinkInner, wikilinkRegExp } from '../shared/ofm/wikilink.js';
import { CODE_MASK_CHAR, maskCode } from './markdownAst.js';

// ---------------------------------------------------------------------------
// Code regions
// ---------------------------------------------------------------------------

/**
 * Code regions come from the same mdast parse the page index uses
 * (markdownAst.ts): fenced and indented code blocks and inline code spans are
 * blanked, so a link-shaped text inside code is neither indexed nor rewritten,
 * and the index and the rewriters cannot disagree about what is code.
 */
export { CODE_MASK_CHAR, maskCode };

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface WikiRef {
  /** Offset of the `!` / `[[` and the end of `]]` in the body. */
  start: number;
  end: number;
  embed: boolean;
  /** The link path as written — no `#...`, no `|...`; trimmed. May be empty (`[[#Heading]]`). */
  path: string;
  /** Whitespace that surrounded the path inside the brackets, restored on rewrite. */
  lead: string;
  trail: string;
  /** Everything after the path, verbatim: `#heading`, `#^block`, `|alias`, `\|alias` (the escaped pipe of a table cell). */
  rest: string;
}

/** The wikilinks of `body` outside code, in order. `masked` is `body` with its code already blanked (maskCode / markdownAst.maskRanges), when the caller has parsed it anyway. */
export function findWikilinks(body: string, masked?: string): WikiRef[] {
  if (!body.includes('[[')) return [];
  if (masked === undefined) masked = maskCode(body);
  const refs: WikiRef[] = [];
  const re = wikilinkRegExp();
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    // Offsets of group 2 in the original: same length as the masked copy. The grammar of the inside is shared/ofm/wikilink.ts.
    const { pathRaw, fragmentPart, aliasPart } = splitWikilinkInner(body.slice(m.indices![2][0], m.indices![2][1]));
    const trimmed = pathRaw.trim();
    const lead = trimmed ? pathRaw.slice(0, pathRaw.indexOf(trimmed)) : '';
    const trail = trimmed ? pathRaw.slice(pathRaw.indexOf(trimmed) + trimmed.length) : '';
    refs.push({
      start: m.index,
      end: m.index + m[0].length,
      embed: m[1] === '!',
      path: trimmed,
      lead,
      trail,
      rest: fragmentPart + aliasPart,
    });
  }
  return refs;
}

/** Link paths that are about a file, not a note: unresolved, they are recorded as 'asset' (like an unresolved markdown link to an image), not 'unresolved'. */
const ASSET_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'avif', 'ico', 'tif', 'tiff', 'heic',
  'mp3', 'wav', 'm4a', 'ogg', 'oga', 'flac', 'aac', 'webm', 'mp4', 'ogv', 'mov', 'mkv', 'avi', '3gp',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'epub',
  'zip', 'gz', 'tar', '7z', 'csv', 'tsv', 'txt', 'json', 'xml', 'yaml', 'yml', 'html', 'css', 'js',
  'canvas', 'base', 'excalidraw',
]);

export function isAssetLinkPath(linkPath: string): boolean {
  const m = /\.([a-z0-9]+)$/i.exec(linkPath);
  return m !== null && ASSET_EXTENSIONS.has(m[1].toLowerCase());
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface PagePathIndex {
  /** Every page path, as indexed (space-relative, `/`-separated). */
  readonly paths: ReadonlySet<string>;
  /** lower-cased full path -> the paths that fold to it. */
  readonly byLower: ReadonlyMap<string, readonly string[]>;
  /** lower-cased last segment -> the paths ending with it. */
  readonly byBase: ReadonlyMap<string, readonly string[]>;
}

function lastSegment(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

export function buildPagePathIndex(paths: Iterable<string>): PagePathIndex {
  const all = new Set<string>();
  const byLower = new Map<string, string[]>();
  const byBase = new Map<string, string[]>();
  const push = (map: Map<string, string[]>, key: string, value: string) => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };
  for (const p of paths) {
    if (all.has(p)) continue;
    all.add(p);
    push(byLower, p.toLowerCase(), p);
    push(byBase, lastSegment(p).toLowerCase(), p);
  }
  return { paths: all, byLower, byBase };
}

/** Collapses `.` / `..` / empty segments against `baseDir`; null when `..` climbs out of the space. */
function joinNormalized(baseDir: string, rel: string): string | null {
  const segments = baseDir ? baseDir.split('/') : [];
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(seg);
    }
  }
  return segments.join('/');
}

function lookupExact(index: PagePathIndex, p: string): string | null {
  if (index.paths.has(p)) return p;
  const folded = index.byLower.get(p.toLowerCase());
  return folded && folded.length > 0 ? [...folded].sort()[0] : null;
}

function sharedLeadingFolders(a: string, b: string): number {
  const x = a ? a.split('/') : [];
  const y = b ? b.split('/') : [];
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
}

function lookupBySuffix(index: PagePathIndex, sourceDir: string, name: string): string | null {
  const wanted = joinNormalized('', name);
  if (!wanted || name.split('/').includes('..')) return null;
  const lowered = wanted.toLowerCase();
  const candidates = (index.byBase.get(lastSegment(lowered)) ?? []).filter((p) => {
    const lp = p.toLowerCase();
    return lp === lowered || lp.endsWith(`/${lowered}`);
  });
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  return [...candidates].sort((a, b) => {
    const near = sharedLeadingFolders(dirOf(b), sourceDir) - sharedLeadingFolders(dirOf(a), sourceDir);
    if (near !== 0) return near;
    const depth = a.split('/').length - b.split('/').length;
    if (depth !== 0) return depth;
    return a < b ? -1 : a > b ? 1 : 0;
  })[0];
}

function decodedVariants(linkPath: string): string[] {
  const out = [linkPath];
  if (linkPath.includes('%')) {
    try {
      const decoded = decodeURIComponent(linkPath);
      if (decoded !== linkPath) out.push(decoded);
    } catch {
      /* a malformed escape: the path stays as written */
    }
  }
  return out;
}

/** The indexed page a wikilink path means from a source page in `sourceDir`, or null. See the module comment for the order. */
export function resolveWikilinkPath(index: PagePathIndex, sourceDir: string, linkPath: string): string | null {
  for (const variant of decodedVariants(linkPath)) {
    const names = /\.mdx?$/i.test(variant) ? [variant] : [`${variant}.md`, `${variant}.mdx`, variant];
    const explicitRelative = variant.startsWith('./') || variant.startsWith('../');
    for (const name of names) {
      const relative = joinNormalized(sourceDir, name);
      const fromRelative = relative !== null ? lookupExact(index, relative) : null;
      if (fromRelative) return fromRelative;
      if (explicitRelative) continue; // `./x` / `../x` mean exactly that folder, never "somewhere in the space"
      const fromRoot = joinNormalized('', name);
      const hitRoot = fromRoot !== null && fromRoot !== relative ? lookupExact(index, fromRoot) : null;
      if (hitRoot) return hitRoot;
      const hitSuffix = lookupBySuffix(index, sourceDir, name);
      if (hitSuffix) return hitSuffix;
    }
  }
  return null;
}

/** The last path segments of `linkPath` (lower-cased, with and without `.md`, decoded too) — what a database lookup needs to load just the candidate pages. */
export function wikilinkBasenames(linkPath: string): string[] {
  const out = new Set<string>();
  for (const variant of decodedVariants(linkPath)) {
    const base = lastSegment(variant).toLowerCase();
    if (!base) continue;
    out.add(base);
    if (!/\.mdx?$/.test(base)) out.add(`${base}.md`).add(`${base}.mdx`);
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Rewriting
// ---------------------------------------------------------------------------

/** Path of `toPath` written relative to the folder `fromDir` (no leading `./`). */
function relativePath(fromDir: string, toPath: string): string {
  const fromParts = fromDir ? fromDir.split('/').filter(Boolean) : [];
  const toParts = toPath.split('/').filter(Boolean);
  let common = 0;
  while (common < fromParts.length && common < toParts.length - 1 && fromParts[common] === toParts[common]) common++;
  return [...Array(fromParts.length - common).fill('..'), ...toParts.slice(common)].join('/');
}

/**
 * The link path to write so that, from a source in `newDir`, it resolves to
 * `target` in the world described by `newIndex` — in the same FORM as the old
 * text `orig` (a bare name stays a bare name, `../x` stays relative, `b/x`
 * stays a trailing path of the same length), with the same extension habit
 * (`.md` written or not) and percent-encoding. If that form would no longer
 * resolve to `target` (the new bare name is now ambiguous, say), it falls back
 * to the path from the space root, then to a relative path. Null: nothing
 * resolves (cannot happen for an indexed `target`, but never guess).
 */
function composeLinkPath(orig: string, oldTarget: string, target: string, newDir: string, newIndex: PagePathIndex): string | null {
  const wroteMd = /\.mdx?$/i.test(orig);
  const targetIsMd = /\.mdx?$/i.test(target);
  const strip = (p: string) => (targetIsMd && !wroteMd ? p.replace(/\.mdx?$/i, '') : p);
  const encodeLike = (p: string) => (orig.includes('%') ? p.replace(/ /g, '%20') : p);
  const style = orig.startsWith('./') || orig.startsWith('../') ? 'relative' : orig.includes('/') ? 'path' : 'name';

  const candidates: string[] = [];
  if (style === 'name') candidates.push(strip(lastSegment(target)));
  if (style === 'relative') {
    const rel = relativePath(newDir, target);
    candidates.push(strip(orig.startsWith('./') && !rel.startsWith('../') ? `./${rel}` : rel));
  }
  if (style === 'path' && dirOf(oldTarget) === dirOf(target)) {
    // Only the name changed: keep the trailing path as long as it was (`b/x` stays `b/y`, not `a/b/y`). A target that changed folder gets the full path below.
    const segments = orig.replace(/^\/+/, '').split('/').length;
    const targetSegments = target.split('/');
    if (targetSegments.length >= segments) candidates.push(strip(`${orig.startsWith('/') ? '/' : ''}${targetSegments.slice(-segments).join('/')}`));
  }
  candidates.push(strip(target), strip(relativePath(newDir, target)));

  for (const candidate of candidates) {
    const written = encodeLike(candidate);
    if (resolveWikilinkPath(newIndex, newDir, written) === target) return written;
  }
  return null;
}

export interface WikiRewriteArgs {
  /** Folder the source page lived in before the change, and where it lives now. */
  oldDir: string;
  newDir: string;
  /** The space's page paths before and after the change. */
  oldIndex: PagePathIndex;
  newIndex: PagePathIndex;
  /** Where a page that existed before ends up (identity for pages that did not move). */
  mapTarget: (oldTargetPath: string) => string;
  /** Only wikilinks whose OLD target is this path (a single-target rename). Omitted: every wikilink whose target or source moved. */
  onlyTarget?: string;
}

/**
 * Re-aims the wikilinks of `body` after a rename/move: a link is rewritten when
 * it resolved to some page in the old world and its text no longer resolves to
 * where that page went in the new one — so `[[page]]` keeps working untouched
 * when only a folder changed, and `[[folder/page]]` / `[[../page]]` follow their
 * target or their moving source. Returns the SAME string when nothing changed.
 */
export function rewriteWikilinks(body: string, args: WikiRewriteArgs): string {
  const refs = findWikilinks(body);
  if (refs.length === 0) return body;
  let out = '';
  let cursor = 0;
  let changed = false;
  for (const ref of refs) {
    if (!ref.path) continue;
    const oldTarget = resolveWikilinkPath(args.oldIndex, args.oldDir, ref.path);
    if (oldTarget === null) continue; // unresolved before: not ours to fix
    if (args.onlyTarget !== undefined && oldTarget !== args.onlyTarget) continue;
    const newTarget = args.mapTarget(oldTarget);
    if (newTarget === oldTarget && args.oldDir === args.newDir) continue; // neither end moved
    if (resolveWikilinkPath(args.newIndex, args.newDir, ref.path) === newTarget) continue; // the text still points where it should
    const newPath = composeLinkPath(ref.path, oldTarget, newTarget, args.newDir, args.newIndex);
    if (newPath === null || newPath === ref.path) continue;
    out += body.slice(cursor, ref.start);
    out += `${ref.embed ? '!' : ''}[[${ref.lead}${newPath}${ref.trail}${ref.rest}]]`;
    cursor = ref.end;
    changed = true;
  }
  if (!changed) return body;
  return out + body.slice(cursor);
}

/** Posix dirname that maps '.' to ''. */
export function dirOf(p: string): string {
  const d = pathPosix.dirname(p);
  return d === '.' ? '' : d;
}
