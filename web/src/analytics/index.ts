/**
 * Optional product analytics (PostHog) for the public demo. OFF unless the server hands over a key:
 * GET /api/auth/state carries `analytics` only when the operator set FOLIO_POSTHOG_KEY (server/analytics.ts).
 * Without it, nothing in this file loads posthog-js or contacts anybody, and every `track*` is a no-op.
 *
 * What is sent: event names, page kinds (doc, board, table, ...) and space slugs. Never page text, titles,
 * search words, e-mail addresses or names. Session replay masks every input; page content carries the
 * `ph-mask` or `ph-no-capture` class (editor, tables, forms, boards, files, assistant, search results).
 * The visitor stays anonymous: there is no identify() call, ever (the demo login is shared).
 *
 * Cross-domain: the marketing site's "Try the demo" link carries `ph_did` (anonymous id) and `ph_sid` (session id).
 * `captureHandoff()` reads and removes them from the address bar before the app renders; `initAnalytics()` boots
 * posthog with them, so the demo continues the visit that began on the site.
 *
 * The id lives in sessionStorage (one tab, gone when the tab closes), not in a cookie, so a reload or the OAuth
 * sign-in round trip keeps the same visitor.
 */
import type { PostHog as PostHogClient } from 'posthog-js';
import type { AnalyticsConfig } from '@shared/contracts';

type PostHog = Pick<PostHogClient, 'capture' | 'debug' | 'get_distinct_id' | 'get_session_id'>;
type Props = Record<string, string | number | boolean | null>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Handoff {
  did: string;
  sid: string | null;
}

let handoff: Handoff | null = null;
let started = false;
let client: PostHog | null = null;
const queue: Array<[string, Props | undefined]> = [];
const seen = new Set<string>();

/** Reads `ph_did` / `ph_sid` from the address and removes them. Call once, before the first render. */
export function captureHandoff(loc: Location = window.location, hist: History = window.history): Handoff | null {
  const params = new URLSearchParams(loc.search);
  const did = params.get('ph_did');
  const sid = params.get('ph_sid');
  if (did === null && sid === null) return handoff;
  params.delete('ph_did');
  params.delete('ph_sid');
  const query = params.toString();
  try {
    hist.replaceState(hist.state, '', loc.pathname + (query ? `?${query}` : '') + loc.hash);
  } catch {
    // an address we cannot rewrite is left as it is
  }
  if (did && UUID.test(did)) handoff = { did, sid: sid && UUID.test(sid) ? sid : null };
  return handoff;
}

/** posthog-js options. Exported for the tests. */
export function posthogOptions(config: AnalyticsConfig, ids: Handoff | null) {
  return {
    api_host: config.host,
    ui_host: config.host.replace('.i.posthog.com', '.posthog.com'),
    defaults: '2025-05-24' as const,
    // No cookies. sessionStorage keeps the id for this tab only.
    persistence: 'sessionStorage' as const,
    // Anonymous visitors get no person profile, and nobody is ever identified: the shared demo login is not a person.
    person_profiles: 'identified_only' as const,
    respect_dnt: true,
    autocapture: false,
    capture_pageview: 'history_change' as const,
    capture_pageleave: true,
    disable_surveys: true,
    session_recording: { maskAllInputs: true },
    // The visit id handed over by the site is removed from the address before anything is captured (captureHandoff);
    // this masks it in captured URLs as well, should one ever slip through.
    mask_personal_data_properties: true,
    custom_personal_data_properties: ['ph_did', 'ph_sid'],
    ...(ids ? { bootstrap: { distinctID: ids.did, ...(ids.sid ? { sessionID: ids.sid } : {}) } } : {}),
  };
}

/** Starts analytics once the server has said it is on. Safe to call on every render: only the first call acts. */
export function initAnalytics(config: AnalyticsConfig | undefined): void {
  if (started || !config?.key || typeof window === 'undefined') return;
  started = true;
  void import('posthog-js').then(({ default: posthog }) => {
    posthog.init(config.key, {
      ...posthogOptions(config, handoff),
      loaded: (ph) => {
        client = ph;
        // ?ph_debug on the first page prints every event in the browser console.
        if (window.location.search.includes('ph_debug')) ph.debug();
        for (const [event, props] of queue.splice(0)) ph.capture(event, props);
      },
    });
  });
}

/** Sends an event. A no-op while analytics is off; held until posthog-js has loaded. */
export function track(event: string, props?: Props): void {
  if (!started) return;
  if (client) client.capture(event, props);
  else if (queue.length < 50) queue.push([event, props]);
}

/** Like track, but only the first time `key` is seen in this page load. */
export function trackOnce(event: string, key: string, props?: Props): void {
  const id = `${event}:${key}`;
  if (!started || seen.has(id)) return;
  seen.add(id);
  track(event, props);
}

export type PageKind = 'doc' | 'board' | 'table' | 'form' | 'pdf' | 'office' | 'agent';

export function trackPageOpen(kind: PageKind, space: string): void {
  track('page_open', { kind, space_slug: space });
}

/** `page_edit`: once per page and tab session, however many keystrokes follow. */
export function trackEdit(kind: PageKind, pageId: string, space?: string): void {
  trackOnce('page_edit', pageId, { kind, ...(space ? { space_slug: space } : {}) });
}

/** `board_edit` (and the generic `page_edit`): once per board and tab session. */
export function trackBoardEdit(pageId: string): void {
  trackOnce('board_edit', pageId);
  trackEdit('board', pageId);
}

/** The anonymous id for the `x-folio-visitor` header, so the server can tie the OAuth consent steps to this visitor. */
export function visitorId(): string | null {
  return client ? client.get_distinct_id() || null : null;
}

/** Headers for the sign-in and auth-state calls. Empty while analytics is off. */
export function visitorHeaders(): Record<string, string> {
  const id = visitorId();
  return id ? { 'x-folio-visitor': id } : {};
}

export function __resetAnalyticsForTests(): void {
  handoff = null;
  started = false;
  client = null;
  queue.length = 0;
  seen.clear();
}
