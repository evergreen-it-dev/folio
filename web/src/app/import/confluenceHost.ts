/**
 * Round 22b: best-effort host extraction from a freely-typed Confluence page
 * URL, used by ConfluenceImportDialog to auto-match a saved credential by
 * host as the user types/pastes a link. `URL.host` already excludes the
 * scheme and never carries a trailing slash, so lower-casing it is the full
 * normalization needed to compare against a saved credential's own `host`
 * (ConfluenceCredentialInfo.host — server-normalized the same way, see
 * userGitCredentials.ts's normalizeHost, reused as-is by
 * userConfluenceCredentials.ts). Never throws — a partially-typed or
 * otherwise unparseable value just yields undefined ("no match"), so callers
 * can use this directly inside a render/useMemo without a try/catch of
 * their own.
 */
export function confluenceHostFromUrl(pageUrl: string): string | undefined {
  try {
    const host = new URL(pageUrl.trim()).host.toLowerCase();
    return host || undefined;
  } catch {
    return undefined;
  }
}
