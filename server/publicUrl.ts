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
 * PUBLIC_URL (scheme-normalized) if set to a non-empty value; otherwise
 * `originFallback` (already a full `scheme://host` computed from the
 * incoming request itself — e.g. routes.ts's requestOrigin() — so it never
 * needs normalizing). Trailing slash always stripped either way. Shared by
 * shares.ts and invites.ts for building an absolute share/invite URL.
 */
export function publicUrlOrOrigin(originFallback: string): string {
  const raw = process.env.PUBLIC_URL;
  const base = raw ? normalizePublicUrl(raw) : originFallback;
  return base.replace(/\/$/, '');
}
