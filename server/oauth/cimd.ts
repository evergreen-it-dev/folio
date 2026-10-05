/**
 * Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document, adopted by the MCP
 * authorization spec): the client_id IS an https URL, and fetching it returns the client's
 * metadata. The fetch is attacker-steered (anyone can send us any URL as client_id), so it is
 * hardened against SSRF: https only, the resolved address is checked AT CONNECT TIME (so DNS
 * rebinding cannot swap it afterwards) and must be public, redirects are not followed, the
 * response is size- and time-limited.
 */
import * as dns from 'node:dns';
import * as https from 'node:https';
import * as net from 'node:net';
import { MAX_REDIRECT_URIS, redirectUriError, sanitizeDisplayName } from './validate.js';

const FETCH_TIMEOUT_MS = 5000;
const MAX_DOCUMENT_BYTES = 16 * 1024;

export interface ClientMetadata {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  clientUri: string | null;
}

export class ClientMetadataError extends Error {}

/** True when `value` is shaped like a CIMD client_id: https URL with a real path, no fragment, no credentials, no dot segments. */
export function isMetadataClientId(value: string): boolean {
  if (!value.startsWith('https://')) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash || value.includes('#') || url.username || url.password) return false;
  if (url.pathname === '/' || url.pathname === '') return false;
  // `new URL` collapses dot segments, so look at the string as given.
  const rawPath = value.slice('https://'.length).split(/[?#]/)[0].split('/').slice(1);
  if (rawPath.some((seg) => seg === '.' || seg === '..' || /^(%2e|\.)(%2e|\.)?$/i.test(seg))) return false;
  return value.length <= 2048;
}

/** Loopback, private, link-local, CGNAT, multicast, reserved, unspecified and IPv4-mapped equivalents are all refused. */
export function isPublicAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a >= 224) return false;
    return true;
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]);
    const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16);
      const lo = parseInt(mappedHex[2], 16);
      return isPublicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    if (lower === '::' || lower === '::1') return false;
    if (/^f[cd]/.test(lower)) return false; // unique local fc00::/7
    if (/^fe[89ab]/.test(lower)) return false; // link-local fe80::/10
    if (lower.startsWith('ff')) return false; // multicast
    if (lower.startsWith('64:ff9b:') || lower.startsWith('2001:db8')) return false; // NAT64 / documentation
    return true;
  }
  return false;
}

/** dns lookup that refuses non-public addresses; used as the `lookup` option of the https request, so it runs on the real connection. */
const guardedLookup: typeof dns.lookup = ((hostname: string, options: dns.LookupOptions | number | undefined, callback: (...args: unknown[]) => void) => {
  const opts = typeof options === 'object' && options !== null ? options : {};
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = addresses as dns.LookupAddress[];
    if (list.length === 0 || list.some((a) => !isPublicAddress(a.address))) {
      return callback(new ClientMetadataError('client metadata URL resolves to a non-public address'));
    }
    if (opts.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}) as typeof dns.lookup;

/** Default fetcher: GET the document, no redirects, bounded. Returns the parsed JSON. */
async function fetchDocument(url: string): Promise<unknown> {
  const parsed = new URL(url);
  // A literal IP in the URL skips DNS (and so the lookup guard): check it here.
  const bare = parsed.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(bare) && !isPublicAddress(bare)) throw new ClientMetadataError('client metadata URL points at a non-public address');
  return new Promise((resolve, reject) => {
    const req = https.request(
      parsed,
      { method: 'GET', headers: { accept: 'application/json', 'user-agent': 'Folio-OAuth-Client-Metadata/1' }, lookup: guardedLookup, timeout: FETCH_TIMEOUT_MS },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new ClientMetadataError(`client metadata URL answered HTTP ${res.statusCode ?? '?'} (redirects are not followed)`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_DOCUMENT_BYTES) {
            req.destroy(new ClientMetadataError('client metadata document is too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            reject(new ClientMetadataError('client metadata document is not valid JSON'));
          }
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new ClientMetadataError('client metadata fetch timed out')));
    req.on('error', (err) => reject(err instanceof ClientMetadataError ? err : new ClientMetadataError(`could not fetch client metadata: ${err.message}`)));
    req.end();
  });
}

let documentFetcher: (url: string) => Promise<unknown> = fetchDocument;

/** Test hook: replaces the network fetch (tests have no public https endpoint to serve a document from). */
export function __setClientMetadataFetcherForTests(fn: ((url: string) => Promise<unknown>) | null): void {
  documentFetcher = fn ?? fetchDocument;
}

/** Fetches and validates the metadata document at `clientId`. Throws ClientMetadataError with a reason a developer can act on. */
export async function fetchClientMetadata(clientId: string): Promise<ClientMetadata> {
  if (!isMetadataClientId(clientId)) throw new ClientMetadataError('client_id is not a valid metadata document URL');
  const doc = await documentFetcher(clientId);
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) throw new ClientMetadataError('client metadata document must be a JSON object');
  const d = doc as Record<string, unknown>;
  if (d.client_id !== clientId) throw new ClientMetadataError('client_id in the document does not match the URL it was fetched from');
  if ('client_secret' in d || 'client_secret_expires_at' in d) throw new ClientMetadataError('client metadata documents must not contain a client secret');
  if (d.token_endpoint_auth_method !== undefined && d.token_endpoint_auth_method !== 'none') {
    throw new ClientMetadataError('only token_endpoint_auth_method "none" (public client) is supported');
  }
  const uris = d.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) throw new ClientMetadataError(`redirect_uris must be an array of 1-${MAX_REDIRECT_URIS} URLs`);
  for (const uri of uris) {
    const problem = redirectUriError(uri);
    if (problem) throw new ClientMetadataError(problem);
  }
  const host = new URL(clientId).host;
  return {
    clientId,
    clientName: sanitizeDisplayName(d.client_name, host),
    redirectUris: uris as string[],
    clientUri: typeof d.client_uri === 'string' && redirectUriError(d.client_uri) === null ? d.client_uri : null,
  };
}
