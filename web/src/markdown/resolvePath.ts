/**
 * Pure path helpers for resolving relative links/images found inside a page's
 * markdown body against that page's own location in the space.
 *
 * All paths use forward slashes and are relative to the space root (no
 * leading slash in the result, no "./" or ".." segments left over).
 */

/** Directory part of a space-relative page path ("" for a root-level file). */
export function dirOf(pagePath: string): string {
  const idx = pagePath.lastIndexOf('/');
  return idx === -1 ? '' : pagePath.slice(0, idx);
}

/**
 * Resolves `relPath` (as found in a markdown link/image) against the
 * directory of `pagePath`. Handles "./", "../" and repeated slashes; a
 * leading "/" is treated as already-relative-to-the-space-root. `..` past
 * the space root clamps at the root instead of throwing.
 *
 * Examples:
 *   resolveRelativePath("architecture/data-flow.md", "../onboarding.md") -> "onboarding.md"
 *   resolveRelativePath("architecture/index.md", "./data-flow.md")        -> "architecture/data-flow.md"
 *   resolveRelativePath("index.md", "assets/logo.png")                   -> "assets/logo.png"
 */
export function resolveRelativePath(pagePath: string, relPath: string): string {
  const isAbsolute = relPath.startsWith('/');
  const baseParts = isAbsolute ? [] : dirOf(pagePath).split('/').filter(Boolean);
  const inputParts = (isAbsolute ? relPath.slice(1) : relPath).split('/');

  const stack = [...baseParts];
  for (const part of inputParts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (stack.length) stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join('/');
}

/** True for URLs with an explicit scheme (http:, mailto:, ...) or protocol-relative ("//host/..."). */
export function isExternalUrl(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');
}

/** Splits a query/fragment off a relative URL, e.g. "./x.md#sec?y=1" -> { path: "./x.md", hash: "#sec?y=1" }. */
export function splitFragment(href: string): { path: string; hash: string } {
  const hashIndex = href.indexOf('#');
  const withoutHash = hashIndex === -1 ? href : href.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : href.slice(hashIndex);
  const queryIndex = withoutHash.indexOf('?');
  const path = queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex);
  return { path, hash };
}

/** True if the (fragment/query-stripped) path looks like a link to another markdown page. */
export function isMarkdownPath(path: string): boolean {
  return /\.md$/i.test(path);
}
