/**
 * Some PaaS platforms hand PUBLIC_URL to the container as a bare host — e.g.
 * a `${SERVICE_FQDN_APP}`-style variable resolves to "folio.example.com",
 * with NO scheme at all. shares.ts/invites.ts then built links like
 * "folio.example.com/share/<token>" straight from that value —
 * syntactically a RELATIVE path, not an absolute URL, so browsers/chat
 * clients never linkify it and a literal click resolves against whatever
 * page the link was pasted into instead of the real host.
 *
 * This is the ONE place that guards against it: every absolute link server
 * code builds from PUBLIC_URL must go through publicUrlOrOrigin() (which
 * itself always normalizes via normalizePublicUrl()) rather than reading
 * process.env.PUBLIC_URL directly.
 */

/**
 * Ensures `url` carries an explicit scheme. Already-schemed values (any
 * `scheme://`, not just http/https — e.g. a deliberate custom reverse-proxy
 * setup) are returned untouched. A bare host gets `https://`, EXCEPT
 * localhost/127.0.0.1 (with or without a port), which gets `http://` — same
 * convention `.env.example`'s dev default (`PUBLIC_URL=http://localhost:4871`)
 * and gitProviders.ts's schemeFor() both already use for "this is plainly a
 * local dev target, not a real deployment".
 */
export function normalizePublicUrl(url: string): string {
  const trimmed = url.trim().replace(/^\/+/, ''); // defensive: a stray leading "//" must not become "https:////host"
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  const host = trimmed.split('/')[0];
  const scheme = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host) ? 'http' : 'https';
  return `${scheme}://${trimmed}`;
}

/**
 * The request's own `scheme://host[:port]` — the fallback for every absolute
 * link when PUBLIC_URL is unset (home-server catalogs open Folio at
 * http://192.168.1.20:4870 with no address to configure). Built from
 * `request.host`, NOT `request.hostname`: Fastify 5's `hostname` drops the
 * port, which turned such a link into http://192.168.1.20/… — a dead address.
 * WHATWG-normalized (lowercase host, default :80/:443 dropped), so the same
 * place always yields the same string — OIDC compares redirect_uri verbatim.
 *
 * Scheme and host honour X-Forwarded-Proto / X-Forwarded-Host only from a
 * proxy TRUST_PROXY trusts (Fastify's trustProxy); the plain Host header is
 * whatever the client sent. A deployment that sends links to third parties
 * (invite emails, IdP registration) should therefore set PUBLIC_URL.
 */
export function requestOrigin(request: { protocol: string; host: string }): string {
  const raw = `${request.protocol}://${request.host}`;
  try {
    const origin = new URL(raw).origin;
    return origin === 'null' ? raw : origin;
  } catch {
    return raw;
  }
}

/**
 * PUBLIC_URL (scheme-normalized) if set to a non-empty value; otherwise
 * `originFallback` (already a full `scheme://host` computed from the
 * incoming request itself — e.g. routes.ts's requestOrigin() — so it never
 * needs normalizing). Trailing slash always stripped either way. Shared by
 * shares.ts and invites.ts for building an absolute share/invite URL.
 *
 * Build that fallback with requestOrigin() below.
 */
export function publicUrlOrOrigin(originFallback: string): string {
  const raw = process.env.PUBLIC_URL;
  const base = raw ? normalizePublicUrl(raw) : originFallback;
  return base.replace(/\/$/, '');
}

/**
 * The instance's own host from PUBLIC_URL (lowercase, no port, no trailing dot), '' when PUBLIC_URL is unset or
 * does not parse. The page index (indexV2/resolve.ts parseAppLink) reads an absolute URL on this host as a Folio
 * app link — the same host publicSites.ts mainHost() gives the chat link previews.
 */
export function instanceHost(): string {
  const raw = process.env.PUBLIC_URL;
  if (!raw || !raw.trim()) return '';
  try {
    return new URL(normalizePublicUrl(raw)).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}
