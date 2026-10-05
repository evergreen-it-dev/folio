/**
 * Pure validation helpers for the OAuth 2.1 endpoints: redirect URIs, PKCE, scopes, display
 * names. No I/O here, so every rule below is unit-testable on its own.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { ApiTokenScope } from '../../shared/contracts.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const MAX_REDIRECT_URI_LENGTH = 2048;
export const MAX_REDIRECT_URIS = 10;

/** A scope string the server understands. Folio has exactly the two PAT scopes. */
export const SUPPORTED_SCOPES: readonly ApiTokenScope[] = ['read', 'write'];

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/**
 * Redirect URI rules for a registered client: absolute https, or http on a loopback host (native
 * apps and CLIs, RFC 8252); no fragment, no credentials. Returns an error message, or null when OK.
 */
export function redirectUriError(uri: unknown): string | null {
  if (typeof uri !== 'string' || uri.length === 0) return 'redirect_uri must be a non-empty string';
  if (uri.length > MAX_REDIRECT_URI_LENGTH) return 'redirect_uri is too long';
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return 'redirect_uri must be an absolute URL';
  }
  if (url.hash || uri.includes('#')) return 'redirect_uri must not contain a fragment';
  if (url.username || url.password) return 'redirect_uri must not contain credentials';
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return null;
  return 'redirect_uri must use https, or http on a loopback address (localhost, 127.0.0.1, [::1])';
}

/**
 * Does `requested` match one of the client's registered redirect URIs? Exact string comparison —
 * except that for loopback http URIs the PORT is ignored (RFC 8252 §7.3: a native app picks a free
 * port at runtime). Scheme, host, path and query must still match exactly.
 */
export function redirectUriMatches(registered: readonly string[], requested: string): boolean {
  if (redirectUriError(requested)) return false;
  if (registered.includes(requested)) return true;
  const req = new URL(requested);
  if (req.protocol !== 'http:' || !isLoopbackHost(req.hostname)) return false;
  return registered.some((r) => {
    let reg: URL;
    try {
      reg = new URL(r);
    } catch {
      return false;
    }
    return reg.protocol === 'http:' && isLoopbackHost(reg.hostname) && reg.hostname === req.hostname && reg.pathname === req.pathname && reg.search === req.search;
  });
}

/** S256 code_challenge is base64url(sha256(verifier)) without padding: always 43 chars. */
export function isValidCodeChallenge(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

/** RFC 7636 §4.1: 43-128 chars from the unreserved set. */
export function isValidCodeVerifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9\-._~]{43,128}$/.test(value);
}

export function pkceMatches(verifier: string, challenge: string): boolean {
  const computed = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Parses the `scope` request parameter (space-separated). Unknown scopes are dropped (RFC 6749
 * lets a server ignore what it does not understand); a request with only unknown scopes is
 * rejected (null). No parameter at all means "whatever the app needs": read + write, which the
 * user can still narrow on the consent screen. `write` always implies `read`.
 */
export function parseRequestedScopes(raw: unknown): ApiTokenScope[] | null {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return ['read', 'write'];
  if (typeof raw !== 'string') return null;
  const asked = new Set(raw.split(/\s+/).filter(Boolean));
  const known = SUPPORTED_SCOPES.filter((s) => asked.has(s));
  if (known.length === 0) return null;
  return known.includes('write') ? ['read', 'write'] : ['read'];
}

/** Strips control characters and clamps length: client names are untrusted text shown on the consent screen. */
export function sanitizeDisplayName(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
  return cleaned || fallback;
}

/** Host (with port, if any) of a redirect URI, for the consent screen. */
export function redirectHost(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}
