/**
 * Optional product analytics (PostHog). OFF by default: an ordinary instance never contacts anybody,
 * and the public documentation promises exactly that. It is switched on by the operator with
 *
 *   FOLIO_POSTHOG_KEY    the PostHog project token (a public "phc_..." key). Without it nothing below does anything.
 *   FOLIO_POSTHOG_HOST   the ingestion host, e.g. https://eu.i.posthog.com (default https://us.i.posthog.com).
 *
 * We switch it on only for the public demo (CI variables, see opensource/demo/deploy/demo-env.sh).
 *
 * What it does:
 *  - GET /api/auth/state hands the key and host to the web app, which then loads posthog-js (web/src/analytics).
 *  - The two OAuth consent steps (/oauth/authorize is a server-rendered page without scripts) are reported from
 *    here, with the same anonymous visitor id the browser uses. The browser sends that id in the
 *    `x-folio-visitor` header on the sign-in and auth-state calls; it is kept in memory next to the session
 *    token and never written to disk or logged.
 *
 * Never sent: page content, titles, search text, emails, names. Only event names, kinds and slugs.
 */
import type { AnalyticsConfig } from '../shared/contracts.js';

export const VISITOR_HEADER = 'x-folio-visitor';

const DEFAULT_HOST = 'https://us.i.posthog.com';
const SEND_TIMEOUT_MS = 3000;
const MAX_VISITORS = 5000;

/** The configuration, or undefined when analytics is not switched on. */
export function analyticsConfig(): AnalyticsConfig | undefined {
  const key = (process.env.FOLIO_POSTHOG_KEY ?? '').trim();
  if (!key) return undefined;
  const rawHost = (process.env.FOLIO_POSTHOG_HOST ?? '').trim() || DEFAULT_HOST;
  let host: URL;
  try {
    host = new URL(rawHost);
  } catch {
    return undefined;
  }
  if (host.protocol !== 'https:' && host.protocol !== 'http:') return undefined;
  return { key, host: host.origin };
}

/** A distinct id as posthog-js makes it (a UUID) or any short token; anything else is ignored. */
export function cleanVisitorId(raw: unknown): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== 'string') return null;
  return /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : null;
}

const visitors = new Map<string, string>();

/** Remembers which anonymous visitor a browser session belongs to. In memory only; the oldest entries go first. */
export function rememberVisitor(sessionToken: string | undefined, raw: unknown): void {
  if (!analyticsConfig() || !sessionToken) return;
  const id = cleanVisitorId(raw);
  if (!id) return;
  visitors.delete(sessionToken);
  visitors.set(sessionToken, id);
  while (visitors.size > MAX_VISITORS) {
    const oldest = visitors.keys().next().value;
    if (oldest === undefined) break;
    visitors.delete(oldest);
  }
}

export function visitorFor(sessionToken: string | undefined): string | null {
  return sessionToken ? (visitors.get(sessionToken) ?? null) : null;
}

export function __resetAnalyticsForTests(): void {
  visitors.clear();
}

type Props = Record<string, string | number | boolean | null>;

/**
 * Sends one event from the server. Fire and forget: a slow or unreachable PostHog never delays or fails a request.
 * `sessionToken` finds the visitor id; with none known the event goes out under a shared anonymous id. No event creates a person profile.
 */
export function captureServerEvent(event: string, sessionToken: string | undefined, props: Props = {}): void {
  const cfg = analyticsConfig();
  if (!cfg) return;
  const distinctId = visitorFor(sessionToken);
  const body = {
    api_key: cfg.key,
    event,
    distinct_id: distinctId ?? 'folio-server',
    timestamp: new Date().toISOString(),
    properties: {
      ...props,
      $lib: 'folio-server',
      // The server's own address must not be taken for the visitor's location, and nobody gets a person profile.
      $geoip_disable: true,
      $process_person_profile: false,
    },
  };
  void fetch(`${cfg.host}/i/v0/e/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  }).catch(() => {
    // analytics is best effort
  });
}

/** An OAuth client's self-chosen name, clipped: it is shown on the consent screen and sent as an event property. */
export function clientNameProp(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, 80);
}
