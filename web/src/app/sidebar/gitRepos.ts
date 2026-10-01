import type { GitProviderRepo } from '@shared/contracts';
import { humanize } from '../header/Breadcrumbs';

/**
 * Round 19 (#6-ux): case-insensitive substring filter for the create-space
 * repository combobox — same "type to narrow" pattern as gitBranches.ts's
 * filterBranches, generalized to repo objects rather than plain strings.
 *
 * Matches against EITHER the repo's readable name or its url. The
 * combobox's own text value IS repoUrl (so typing a url directly still
 * works with zero suggestion source at all, same "always-editable input"
 * philosophy BranchField already established) — but once a repo has
 * actually been picked, that value is a url, not a name. Filtering on
 * `name` alone would make refocusing the field with nothing retyped filter
 * every suggestion away (the current value, a url, wouldn't match ANY
 * repo's name as a substring) instead of showing the already-selected repo
 * again.
 *
 * A query that's an EXACT match for some repo's own url — i.e. the field
 * was just focused again with nothing retyped, not a partial search in
 * progress — returns every repo instead of only that one: without this,
 * having picked repo A once would leave the combobox permanently unable to
 * suggest repo B on a plain refocus (the literal substring rule would only
 * ever match A, since A's own url doesn't contain B's name or url) —
 * confirmed by CreateSpaceDialog.test.tsx's reselect regression test, not
 * just reasoned through. Narrowing resumes as soon as the user actually
 * types something that ISN'T a complete, already-known url.
 */
export function filterProviderRepos(query: string, repos: readonly GitProviderRepo[]): GitProviderRepo[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...repos];
  if (repos.some((r) => r.url.toLowerCase() === q)) return [...repos];
  return repos.filter((r) => r.name.toLowerCase().includes(q) || r.url.toLowerCase().includes(q));
}

/**
 * Human-readable space-name suggestion from a repo's LAST path segment —
 * used to prefill "Name" once a repository is picked (create-space's
 * existing touched-flag pattern keeps a manual edit from being clobbered by
 * a later reselect — see CreateSpaceDialog.tsx's nameTouched). Reuses
 * Breadcrumbs.tsx's own humanize() (hyphens/underscores -> spaces, each
 * word capitalized) rather than re-deriving that same transform here.
 *
 * Works for both a provider API's repo.name (GitProviderRepo — may itself
 * be a namespaced "group/repo" path, e.g. GitLab) and a raw repoUrl typed
 * by hand (an https remote with a .git suffix, or a git@host:org/repo SSH
 * shorthand) — both just need their trailing path segment split out first.
 */
export function humanizeRepoName(nameOrUrl: string): string {
  const cleaned = nameOrUrl.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  const segments = cleaned.split('/');
  const last = segments[segments.length - 1] ?? '';
  return humanize(last);
}

/**
 * Turns `SpaceGitInfo.repoUrl` into a plain `https://host/path` string safe
 * to render as a clickable "Open the repository" link — the sidebar space
 * menu's own use, see Sidebar.tsx. `repoUrl` is stored verbatim (round 3's
 * createSpaceGit/round-X's connectSpaceGitBodySchema accept whatever the
 * user or a provider's API handed over), which can be:
 *  - a plain https url, sometimes with embedded `user:token@` credentials —
 *    those must NEVER reach the rendered page (a visible link/tooltip is a
 *    much bigger leak than argv/logs, which is all the rest of this app's
 *    git plumbing already goes out of its way to protect);
 *  - an `ssh://[user@]host[:port]/path` url;
 *  - the scp-like shorthand `user@host:path` (no scheme at all);
 *  - or, for local dev/ops (a bare filesystem path used as a stand-in
 *    remote — see server/gitNative.test.ts) or plain garbage, something
 *    that isn't a reshapeable url at all.
 *
 * Returns null for that last case — DEV-PLAN is explicit that an
 * unrecognizable form must render as inert text, never as a broken or
 * misleading link. Always emits an `https://` origin regardless of the
 * ORIGINAL scheme (including a plain `http://`) — "normalize into a
 * human https URL for display" per the owner's own ask; this is a
 * link a human clicks to browse the repo's web UI, not a git remote to
 * operate against, and every real host this matters for serves both.
 */
export function normalizeRepoUrlForDisplay(repoUrl: string): string | null {
  const trimmed = repoUrl.trim();
  if (!trimmed) return null;

  // scp-like shorthand — user@host:path, no scheme. Must be checked before
  // `new URL()` below: that constructor doesn't understand this form at all
  // (throws), and the `://` guard keeps an ordinary "https://user@host/..."
  // url (which also contains "@" and ":") from being misparsed as scp-like.
  if (!trimmed.includes('://')) {
    const scpMatch = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(trimmed);
    if (scpMatch) return buildDisplayUrl(scpMatch[1], scpMatch[2]);
    return null; // no scheme and not scp-like — a bare local path or garbage
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  // http(s)/ssh only — file:// (local filesystem) and any git remote-helper
  // scheme (ext::, etc.) are exactly the forms server/git.ts's own
  // validateRepoUrl refuses to even clone from, for the same SSRF/RCE
  // reasons; showing THOSE as a clickable link would be actively misleading
  // regardless (they were never meant to be browsed).
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'ssh:') return null;
  if (!url.hostname) return null;
  const hostWithPort = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  return buildDisplayUrl(hostWithPort, url.pathname);
}

function buildDisplayUrl(hostWithPort: string, rawPath: string): string | null {
  const path = rawPath.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!path) return null; // a host with no repo path isn't a usable link either
  return `https://${hostWithPort}/${path}`;
}
