/** Path helpers shared by the live-preview widgets. Pure, no DOM, unit-tested. */

/** Directory part of a space-relative page path ("a/b/page.md" -> "a/b", "page.md" -> ""). */
export function dirname(pagePath: string): string {
  const clean = pagePath.replace(/^\/+/, '');
  const i = clean.lastIndexOf('/');
  return i < 0 ? '' : clean.slice(0, i);
}

/**
 * Directory that holds `pagePath`'s children, mirroring app/sidebar/treeUtils.ts's
 * `childDirOf` — but for a plain space-relative path rather than a TreeNode,
 * and only for the "doc" shapes this markdown editor can ever be showing (a
 * board or a table page is edited elsewhere):
 *
 *  - an index page ("index.md" / "README.md") IS its directory, so its
 *    children are that directory's other entries;
 *  - any other "dir/x.md" (or the round-26 "dir/x.table.md" table-file shape)
 *    gets its own "dir/x/".
 */
export function childPageDir(pagePath: string): string {
  const dir = dirname(pagePath);
  const base = dir ? pagePath.slice(dir.length + 1) : pagePath;
  if (base === 'index.md' || base === 'README.md') return dir;
  const stem = base.endsWith('.table.md') ? base.slice(0, -'.table.md'.length) : base.replace(/\.md$/, '');
  return dir ? `${dir}/${stem}` : stem;
}

/** Collapse "." and ".." segments in a posix-style relative path. */
export function normalizeRelative(path: string): string {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

const ABSOLUTE = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/\/)/;

/**
 * Resolve a markdown image/asset src to a URL the browser can load.
 * Absolute URLs, protocol-relative URLs and root-relative paths are kept as-is;
 * everything else resolves against `/files/<space>/<dir-of-page>/`.
 */
export function resolveAssetSrc(src: string, space: string, pagePath: string, shareToken?: string): string {
  const raw = src.trim().replace(/^<(.*)>$/, '$1');
  if (!raw) return '';
  if (ABSOLUTE.test(raw) || raw.startsWith('/')) return raw;
  const dir = dirname(pagePath);
  const joined = normalizeRelative(dir ? `${dir}/${raw}` : raw);
  const url = `/files/${space}/${joined}`;
  // A guest editing through a share link has no session, so /files answers 401
  // without the token — the markdown renderer already appends it the same way
  // (markdown/relativeLinks.ts's filesUrl). Round 8's ?share=<token>.
  return shareToken ? `${url}?share=${encodeURIComponent(shareToken)}` : url;
}

/**
 * Path of `target` written relative to the page at `fromPagePath`, the way it
 * has to appear inside a markdown link. Both arguments are space-relative.
 *
 *   ("architecture/data-flow.md", "onboarding.md")        -> "../onboarding.md"
 *   ("index.md",                  "architecture/index.md") -> "architecture/index.md"
 */
export function relativePath(fromPagePath: string, target: string): string {
  const from = normalizeRelative(dirname(fromPagePath)).split('/').filter(Boolean);
  const to = normalizeRelative(target).split('/').filter(Boolean);
  if (to.length === 0) return '';

  const toDir = to.slice(0, -1);
  let common = 0;
  while (common < from.length && common < toDir.length && from[common] === toDir[common]) common++;

  const up = new Array<string>(from.length - common).fill('..');
  const down = to.slice(common);
  return [...up, ...down].join('/');
}

/**
 * Markdown link destinations cannot contain raw spaces or parentheses; those
 * paths have to be wrapped in angle brackets. Cyrillic needs no escaping.
 */
export function formatLinkTarget(path: string): string {
  return /[\s()<>]/.test(path) ? `<${path}>` : path;
}
