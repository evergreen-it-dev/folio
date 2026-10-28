/**
 * Same-origin return paths for the sign-in round-trips (GitHub connect, OIDC, SAML): where the browser lands after
 * the provider sends it back. Only a relative app path is ever accepted, so a crafted `returnTo` can never turn
 * the callback into an open redirect.
 */

const MAX_RETURN_LENGTH = 1024;
const PROBE_ORIGIN = 'http://folio.invalid';

/**
 * Where to land after the round-trip: a same-origin PATH only (its query and
 * fragment dropped), never an absolute or protocol-relative URL — anything
 * else falls back to "/". Exported for tests.
 */
export function safeReturnPath(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  try {
    const parsed = new URL(raw, PROBE_ORIGIN);
    if (parsed.origin !== PROBE_ORIGIN) return '/';
    return parsed.pathname || '/';
  } catch {
    return '/';
  }
}

/**
 * The page a person opened before signing in, kept with its query and fragment: `/s/team/p/abc?x=1#h`.
 * Returns null (= "use the default landing") for anything that is not a plain same-origin app path: no leading single
 * `/`, `//`, backslashes or control characters anywhere, an absolute URL, `/api/*`, the bare root or `/login`.
 */
export function safeAppPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_RETURN_LENGTH) return null;
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  // eslint-disable-next-line no-control-regex
  if (raw.includes('\\') || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw, PROBE_ORIGIN);
  } catch {
    return null;
  }
  if (parsed.origin !== PROBE_ORIGIN) return null;
  const path = parsed.pathname;
  if (path === '/' || path === '/login' || path === '/api' || path.startsWith('/api/')) return null;
  const result = `${path}${parsed.search}${parsed.hash}`;
  return result.length > MAX_RETURN_LENGTH || result.startsWith('//') ? null : result;
}

/** `returnTo` with `authError=<code>` added to its query (before the fragment), or `/?authError=<code>` without one. */
export function withAuthError(returnTo: string | null | undefined, code: string): string {
  const safe = safeAppPath(returnTo);
  if (!safe) return `/?authError=${code}`;
  const parsed = new URL(safe, PROBE_ORIGIN);
  parsed.searchParams.set('authError', code);
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
