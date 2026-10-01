/**
 * Round 23 tail follow-up (owner): the space's PDF header/footer templates
 * (`server/export/spaceSettings.ts`) are sanitized at RENDER time by
 * css.ts's `sanitizeHeaderFooterHtml` into cutting every `src`/`href` that
 * isn't `data:` — that rule is correct and NOT to be weakened: the template
 * is rendered by a headless browser inside our network, and Chromium's own
 * `displayHeaderFooter` templates don't even load external resources anyway.
 *
 * The owner's actual ask: let an author write `<img src="https://…logo.svg">`
 * in the editor and have the LOGO WORK, without opening an SSRF hole. The
 * fix lives at SAVE time, not render time: when the PUT settles, THIS module
 * downloads every external `<img src="http(s)://…">` in the submitted
 * templates, validates it, and rewrites it in place to a `data:` URI before
 * `spaceSettings.ts` ever writes the file. By the time css.ts's sanitizer
 * sees the stored template, every `src` is already `data:` — no external
 * request happens during printing, ever.
 *
 * This makes the download itself a CONTROLLED SSRF GATEWAY: it is a server
 * process fetching a URL an authenticated space admin supplies, on request.
 * Every rule below exists to keep that gateway from being turned into a
 * probe of the private network it runs in:
 *
 *  1. scheme: `http`/`https` only — no `file:`, no `ftp:`, no anything else.
 *  2. host: the hostname is resolved and PINNED. We look it up ourselves,
 *     refuse to connect if ANY resolved address is loopback/private/
 *     link-local, and then connect directly to that validated IP (Host
 *     header / TLS SNI still carry the original hostname, so virtual
 *     hosting and certificate checking both still work). Pinning — not a
 *     `dns.lookup` hook run by the HTTP client — is deliberate: it performs
 *     exactly ONE resolution, used for both the check and the connection, so
 *     there is no window between "we checked" and "we connected" for a
 *     rebinding DNS answer to land in.
 *
 *     Ranges refused (the ones the owner named, verbatim): `127.0.0.0/8`,
 *     `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`
 *     (link-local — this is also where the cloud-metadata endpoint
 *     `169.254.169.254` lives), `::1`, `fc00::/7`. Refused ADDITIONALLY, as
 *     defence in depth beyond that literal list: `0.0.0.0/8`, the IPv6
 *     unspecified address `::`, IPv6 link-local `fe80::/10`, and an
 *     IPv4-mapped IPv6 literal (`::ffff:127.0.0.1`) — checked by recursing
 *     on the embedded v4 address, since it would otherwise sail past the
 *     v4-shaped checks above by virtue of merely being spelled differently.
 *  3. no redirects: a 3xx is treated as a failure outright rather than
 *     followed — a redirect to an internal URL is the textbook way to slip
 *     a same-origin-looking check past a check like this one.
 *  4. timeout: `FETCH_TIMEOUT_MS` (5s) — long enough for a normal small
 *     image host, short enough that a stalled or hostile host cannot hold a
 *     settings-save request open indefinitely.
 *  5. hard size cap: `MAX_HEADER_FOOTER_IMAGE_BYTES` (300 KB) — enforced
 *     against `Content-Length` up front where present, and independently
 *     against actual bytes received as they stream in (a header cannot be
 *     trusted). 300 KB: "a few hundred KB" as asked — comfortably more
 *     than any real favicon/logo needs, small enough that a couple of
 *     embedded images (base64 inflates by ~4/3, so ~400 KB each) still fit
 *     well inside css.ts's `MAX_HEADER_FOOTER_STORED_BYTES` cap on the
 *     template as finally stored.
 *  6. content-type allowlist: `image/svg+xml`, `png`, `jpeg`, `gif`, `webp`
 *     — anything else (in particular `text/html`, which a misconfigured or
 *     hostile server could return for ANY URL including an internal one) is
 *     refused.
 *  7. SVG is run through the SAME PRINCIPLE as the rest of this round's
 *     sanitization (`sanitizeSvgForEmbedding`, mirroring css.ts's own
 *     `sanitizeHeaderFooterHtml`): script/iframe/object/embed/foreignObject
 *     tags stripped, `on*` handlers stripped, every `href`/`xlink:href`/
 *     `src` that isn't `data:` or a same-document `#fragment` stripped. An
 *     SVG loaded via `<img src>` cannot script anyway (browsers disable
 *     scripting for SVG used as an image), but the owner asked for the same
 *     treatment as everything else in this file, and it costs nothing.
 *
 * A failure at ANY of the above is never swallowed: `inlineExternalImages`
 * throws a `badRequest` naming the offending URL and the reason, so the PUT
 * comes back with something the author can act on instead of a silently
 * dropped `<img>` tag.
 */
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { badRequest } from '../errors.js';

/** Per-image download cap — see the module doc, point 5, for the reasoning. */
export const MAX_HEADER_FOOTER_IMAGE_BYTES = 300 * 1024;

/** Long enough for a normal small logo fetch, short enough not to hang a save request. */
const FETCH_TIMEOUT_MS = 5_000;

const ALLOWED_IMAGE_TYPES = new Set(['image/svg+xml', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * True for any address this process must never connect to on an author's
 * say-so: loopback, the three RFC1918 private ranges, link-local (v4 and
 * v6 — v4 link-local is also where cloud metadata services listen),
 * IPv6 unique-local, and a couple of shapes (`0.0.0.0/8`, `::`, an
 * IPv4-mapped IPv6 literal) that are not on the owner's literal list but are
 * obvious variants of it. Fails CLOSED: an address shape this function does
 * not recognise (should not happen — `dns.lookup` only ever returns valid
 * IPv4/IPv6) is treated as disallowed, never as allowed.
 */
export function isPrivateOrLoopbackIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 127) return true; // 127.0.0.0/8 — loopback
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 — link-local, incl. 169.254.169.254 (cloud metadata)
    if (a === 0) return true; // 0.0.0.0/8 — "this network"/unspecified, defence in depth
    return false;
  }
  if (net.isIPv6(ip)) {
    const norm = ip.toLowerCase();
    if (norm === '::1') return true; // loopback
    if (norm === '::') return true; // unspecified, defence in depth
    if (/^f[cd][0-9a-f]{2}:/.test(norm) || norm === 'fc00::' || norm === 'fd00::') return true; // fc00::/7 — unique local
    if (/^fe[89ab][0-9a-f]:/.test(norm)) return true; // fe80::/10 — link-local, defence in depth
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(norm);
    if (mapped) return isPrivateOrLoopbackIp(mapped[1]); // IPv4-mapped IPv6 literal — recurse on the embedded v4
    return false;
  }
  return true; // not a recognisable IPv4/IPv6 literal — refuse rather than guess
}

/**
 * Resolves `hostname` and returns ONE address safe to connect to, refusing
 * the hostname outright (fail-closed) if ANY resolved address is
 * private/loopback — a hostname answering with a mix of public and private
 * addresses is exactly the shape of a DNS-rebinding attempt, and picking
 * "the first public one" would just make the attacker retry with a
 * different ordering.
 */
export async function resolvePublicAddress(hostname: string): Promise<string> {
  let addresses: { address: string; family: number }[];
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error(`could not resolve host "${hostname}"`);
  }
  if (addresses.length === 0) throw new Error(`could not resolve host "${hostname}"`);
  const blocked = addresses.find((a) => isPrivateOrLoopbackIp(a.address));
  if (blocked) throw new Error(`host "${hostname}" resolves to a private/loopback address (${blocked.address}) — refused`);
  return addresses[0].address;
}

function normalizeImageContentType(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const bare = header.split(';')[0]?.trim().toLowerCase();
  const mime = bare === 'image/jpg' ? 'image/jpeg' : bare;
  return mime && ALLOWED_IMAGE_TYPES.has(mime) ? mime : undefined;
}

interface FetchedImage {
  contentType: string;
  data: Buffer;
}

/**
 * Fetches `url` by connecting DIRECTLY to `ip` (already validated by
 * `resolvePublicAddress`) — the actual "no second DNS lookup, no
 * rebinding window" step. `Host`/TLS `servername` still carry the ORIGINAL
 * hostname, so name-based virtual hosting and certificate hostname
 * verification both keep working against the real target.
 */
export function fetchViaPinnedIp(url: URL, ip: string): Promise<FetchedImage> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const isHttps = url.protocol === 'https:';
    const port = url.port ? Number(url.port) : isHttps ? 443 : 80;

    // `https.RequestOptions` is a superset of `http.RequestOptions` (adds TLS
    // options like `servername`), so this one object is valid for either
    // module's `.request()` — typed explicitly to sidestep the two modules'
    // separately-overloaded call signatures when picking between them below.
    const options: https.RequestOptions = {
      protocol: url.protocol,
      host: ip,
      port,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: { Host: url.host, Accept: 'image/*', 'User-Agent': 'Folio-ExportHeaderFooter/1.0' },
      // TLS SNI + certificate hostname check use `servername`, NOT `host` — this
      // is what lets us connect to the pinned IP while still verifying the cert
      // against the real domain name.
      ...(isHttps ? { servername: url.hostname } : {}),
      timeout: FETCH_TIMEOUT_MS,
    };

    const onResponse = (res: http.IncomingMessage): void => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        settle(() => reject(new Error(`redirect (HTTP ${status}) — redirects are not followed`)));
        res.destroy();
        return;
      }
      if (status < 200 || status >= 300) {
        settle(() => reject(new Error(`HTTP ${status}`)));
        res.destroy();
        return;
      }

      const contentType = normalizeImageContentType(res.headers['content-type']);
      if (!contentType) {
        settle(() => reject(new Error(`unsupported or missing content type ("${res.headers['content-type'] ?? 'none'}")`)));
        res.destroy();
        return;
      }

      const declaredLength = Number(res.headers['content-length']);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_HEADER_FOOTER_IMAGE_BYTES) {
        settle(() => reject(new Error(`image exceeds ${MAX_HEADER_FOOTER_IMAGE_BYTES} bytes (Content-Length: ${declaredLength})`)));
        res.destroy();
        return;
      }

      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_HEADER_FOOTER_IMAGE_BYTES) {
          settle(() => reject(new Error(`image exceeds ${MAX_HEADER_FOOTER_IMAGE_BYTES} bytes`)));
          res.destroy();
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        settle(() => resolve({ contentType, data: Buffer.concat(chunks) }));
      });
      res.on('error', (err) => {
        settle(() => reject(err instanceof Error ? err : new Error(String(err))));
      });
    };

    // `onResponse` closes over `req` (to abort mid-stream on an oversized
    // body) before `req` is assigned below — safe: the callback only ever
    // RUNS once `.request()` has returned and `req` is initialized.
    const req = isHttps ? https.request(options, onResponse) : http.request(options, onResponse);

    req.on('timeout', () => {
      settle(() => reject(new Error(`timed out after ${FETCH_TIMEOUT_MS}ms`)));
      req.destroy();
    });
    req.on('error', (err) => {
      settle(() => reject(err instanceof Error ? err : new Error(String(err))));
    });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// SVG sanitization (same principle as css.ts's sanitizeHeaderFooterHtml)
// ---------------------------------------------------------------------------

const SVG_STRIP_TAGS_RE = /<\s*(script|iframe|object|embed|link|meta|base|foreignObject)\b[\s\S]*?<\s*\/\s*\1\s*>/gi;
const SVG_STRIP_SELFCLOSE_RE = /<\s*(script|iframe|object|embed|link|meta|base|foreignObject)\b[^>]*\/?>/gi;
const SVG_EVENT_ATTR_RE = /\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const SVG_EXTERNAL_REF_RE = /\s(href|xlink:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

/**
 * An SVG loaded via `<img src="data:image/svg+xml;...">` cannot execute
 * script (browsers disable scripting for SVG used as an image) — but the
 * owner asked for "the same principle" applied here anyway, so this strips
 * exactly what `sanitizeHeaderFooterHtml` strips: executable tags, event
 * handlers, and any `href`/`xlink:href`/`src` that isn't `data:` or a
 * same-document `#fragment` (the one legitimate use inside an SVG, e.g.
 * `<use xlink:href="#icon">`).
 */
export function sanitizeSvgForEmbedding(svg: string): string {
  return svg
    .replace(SVG_STRIP_TAGS_RE, '')
    .replace(SVG_STRIP_SELFCLOSE_RE, '')
    .replace(SVG_EVENT_ATTR_RE, '')
    .replace(SVG_EXTERNAL_REF_RE, (whole, _attr: string, dq?: string, sq?: string, bare?: string) => {
      const value = (dq ?? sq ?? bare ?? '').trim();
      return /^data:/i.test(value) || value.startsWith('#') ? whole : '';
    });
}

// ---------------------------------------------------------------------------
// the <img src="http(s)://…"> -> data: rewrite
// ---------------------------------------------------------------------------

const IMG_SRC_RE = /<img\b([^>]*?)\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')([^>]*)>/gi;

async function fetchAsDataUri(rawUrl: string, resolveAddress: (hostname: string) => Promise<string>): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`unsupported scheme "${parsed.protocol}" — only http/https are allowed`);
  }

  const ip = await resolveAddress(parsed.hostname);
  const { contentType, data } = await fetchViaPinnedIp(parsed, ip);
  if (data.length === 0) throw new Error('empty response body');

  const bytes = contentType === 'image/svg+xml' ? Buffer.from(sanitizeSvgForEmbedding(data.toString('utf8')), 'utf8') : data;
  return `data:${contentType};base64,${bytes.toString('base64')}`;
}

/**
 * Replaces every `<img src="http(s)://…">` in `html` with the fetched image
 * inlined as a `data:` URI, leaving every other `<img>` (already `data:`,
 * relative, or otherwise) untouched. Identical URLs appearing more than once
 * (a logo in both header and footer, say) are fetched once.
 *
 * Throws `badRequest` — never silently drops the tag — naming the URL and
 * the reason on ANY failure: bad scheme, DNS/private-address refusal,
 * timeout, oversized response, wrong content type, or a network error.
 *
 * `resolveAddress` defaults to the real `resolvePublicAddress` (the SSRF
 * gate) and is not meant to be overridden in production — the parameter
 * exists so headerFooterImages.test.ts can point the fetch+sanitize+encode
 * pipeline at a real local test server without that server needing to bind
 * a routable, non-private address (which a sandboxed test run cannot rely
 * on). The gate itself (`resolvePublicAddress`/`isPrivateOrLoopbackIp`) is
 * tested separately, and unmocked, against real loopback/private literals.
 */
export async function inlineExternalImages(
  html: string,
  resolveAddress: (hostname: string) => Promise<string> = resolvePublicAddress,
): Promise<string> {
  const urls = new Set<string>();
  for (const m of html.matchAll(IMG_SRC_RE)) {
    const src = (m[2] ?? m[3] ?? '').trim();
    if (/^https?:\/\//i.test(src)) urls.add(src);
  }
  if (urls.size === 0) return html;

  const dataUriByUrl = new Map<string, string>();
  for (const url of urls) {
    try {
      dataUriByUrl.set(url, await fetchAsDataUri(url, resolveAddress));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw badRequest(`failed to load header/footer image ${url}: ${reason}`);
    }
  }

  return html.replace(IMG_SRC_RE, (whole, before: string, dq?: string, sq?: string, after: string = '') => {
    const src = (dq ?? sq ?? '').trim();
    const dataUri = dataUriByUrl.get(src);
    if (!dataUri) return whole;
    const quote = dq !== undefined ? '"' : "'";
    return `<img${before} src=${quote}${dataUri}${quote}${after}>`;
  });
}
