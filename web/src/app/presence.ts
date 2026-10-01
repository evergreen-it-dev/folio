/**
 * Page presence — "who else has this exact page open right now", for the
 * header's presence indicator (app/header/PagePresence.tsx). The pure
 * reducer here is in the same spirit as tables/collab/awareness.ts's
 * peersByCell: given RAW awareness state plus the local client's own
 * identity, it produces a deduplicated, render-ready list — testable
 * without a websocket, a Y.Doc or a React tree.
 *
 * Lives in app/, not editor/ or diagrams/, for the exact reason
 * app/collabIdentity.ts does (see that module's docblock): editor/ already
 * imports diagrams/, so the reverse edge would cycle, and app/'s own import
 * chain never reaches either zone — so this one copy is reachable from all
 * three collab call sites (editor/index.tsx, diagrams/BoardCanvas.tsx,
 * app/routes/TablePageView.tsx) with no duplication.
 */
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { Awareness } from 'y-protocols/awareness';

/**
 * What a call site's own identity needs to provide — the shape every collab
 * session's `user` field already has once it carries an authed identity
 * (see collabIdentity.ts's CollabIdentity, editor/collab.ts's AnonUser,
 * diagrams/boardCollab.ts's BoardAnonUser). `id`/`username` absent means an
 * anonymous share-link guest.
 */
export interface PresenceIdentityInput {
  id?: string;
  name: string;
  username?: string;
  color: string;
}

export interface PagePresencePerson {
  /**
   * Dedup key actually used to build the list: `id:<user id>` for a
   * signed-in person (stable across tabs and even across devices), or
   * `anon:<awareness clientId>` for a guest — see the module note below on
   * why an anonymous guest can't be deduped any further than that.
   */
  key: string;
  name: string;
  username?: string;
  color: string;
  /** True for exactly one entry: the local client viewing the page right now. */
  isSelf: boolean;
}

interface AwarenessUserRecord {
  id?: string;
  name?: string;
  username?: string;
  color?: string;
}

/**
 * Reduces raw awareness state — plus the local client's own identity, which
 * awareness deliberately never reports about itself — to "people with this
 * page open right now".
 *
 * Dedup rule: a signed-in person is one entry no matter how many tabs (or
 * devices) they have this page open in, keyed by `user.id`. An ANONYMOUS
 * guest (a share-link visitor — see collabIdentity.ts) has no `id` at all:
 * there is nothing stable to dedupe across tabs for them, so each anonymous
 * awareness connection (`clientId`) counts as its own person. That is a
 * deliberate, documented limitation, not a bug — two tabs opened by the same
 * anonymous guest will show as two people in the list.
 *
 * The LOCAL client is always included, marked `isSelf` — presence is "who's
 * here", and the viewer is one of them, not just an observer counting
 * everyone else. A malformed or partial peer record (an old bundle, or a
 * half-written state mid-reconnect) is skipped rather than allowed to throw,
 * same defensive stance as peersByCell.
 *
 * Order is stable: the local person first, then everyone else alphabetically
 * by name — so a re-render triggered by an unrelated awareness tick (e.g. a
 * peer's cursor moving) never reshuffles the popover's list under the mouse.
 */
export function reducePagePresence(
  states: ReadonlyMap<number, unknown>,
  localClientId: number,
  localIdentity: PresenceIdentityInput,
): PagePresencePerson[] {
  const byKey = new Map<string, PagePresencePerson>();

  const localKey = localIdentity.id ? `id:${localIdentity.id}` : `anon:${localClientId}`;
  byKey.set(localKey, {
    key: localKey,
    name: localIdentity.name,
    username: localIdentity.username,
    color: localIdentity.color,
    isSelf: true,
  });

  for (const [clientId, raw] of states) {
    if (clientId === localClientId) continue;
    if (!raw || typeof raw !== 'object') continue;
    const record = (raw as { user?: AwarenessUserRecord }).user;
    if (!record || typeof record.name !== 'string' || typeof record.color !== 'string') continue;
    const key = typeof record.id === 'string' && record.id ? `id:${record.id}` : `anon:${clientId}`;
    // Already counted — either the local person's OTHER open tab (same id,
    // different clientId), or (in principle) a duplicate id from a
    // misbehaving client. Either way the first entry wins.
    if (byKey.has(key)) continue;
    byKey.set(key, {
      key,
      name: record.name,
      username: typeof record.username === 'string' ? record.username : undefined,
      color: record.color,
      isSelf: false,
    });
  }

  return [...byKey.values()].sort((a, b) => {
    if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

const EMPTY_PRESENCE: PagePresencePerson[] = [];

/**
 * Live "who has this page open" list, re-derived whenever the awareness
 * state changes. `awareness`/`localIdentity` are null while there is no
 * collab session yet (still connecting) or none at all (a synthetic page) —
 * this returns an empty list rather than throwing either way.
 */
export function usePagePresence(
  awareness: Awareness | null,
  localIdentity: PresenceIdentityInput | null,
): PagePresencePerson[] {
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!awareness) return;
    const bump = () => setVersion((v) => v + 1);
    awareness.on('change', bump);
    // Bump ONCE right after subscribing, and this is not belt-and-braces: the
    // memo below read getStates() during the render that produced this effect,
    // and peers can already be in there by the time the effect runs. The
    // server sends the whole awareness snapshot the instant the socket opens
    // (y-websocket's setupWSConnection), so on a page that already has people
    // on it the states land in the FIRST tick after the session appears —
    // ahead of React committing this subscription whenever the commit is
    // deprioritised, which a backgrounded tab does routinely. Miss that one
    // event and nothing recomputes until some peer's next keep-alive renewal,
    // which y-protocols only sends every ~15s: measured live, a second tab sat
    // with no indicator for 22 seconds before one appeared by itself.
    bump();
    return () => awareness.off('change', bump);
  }, [awareness]);

  return useMemo(() => {
    if (!awareness || !localIdentity) return EMPTY_PRESENCE;
    return reducePagePresence(awareness.getStates() as ReadonlyMap<number, unknown>, awareness.clientID, localIdentity);
    // `version` is the subscription's change signal — awareness.getStates()
    // mutates in place, same reasoning as useCellPresence's own note in
    // tables/collab/awareness.ts, so there is nothing else to key this on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awareness, localIdentity, version]);
}

/**
 * The header-publishing channel — a SEPARATE small context from Shell.tsx's
 * own HeaderInfo, on purpose, not another field folded into it. HeaderInfo
 * changes rarely (title/path/icon change on navigation, roughly); page
 * presence changes on every awareness tick from EVERY peer in the room
 * (someone's cursor moving, a tab opening or closing), which on a busy page
 * can be many times a second. Folding this into HeaderInfo would mean every
 * such tick re-runs useSetHeaderInfo's own effect and re-renders every
 * consumer of that context — most of which (breadcrumbs, the table view
 * picker) have nothing to do with presence. Keeping the two channels apart
 * means a presence tick only ever re-renders the presence indicator itself.
 *
 * Lives here rather than inlined in Shell.tsx so editor/index.tsx and
 * diagrams/BoardCanvas.tsx — which need `usePublishPagePresence` — don't
 * have to import Shell.tsx itself (and, transitively, the whole app shell:
 * Sidebar, QuickSwitcher, the admin banner…) just to reach one hook. Shell.tsx
 * imports `SetPagePresenceContext` directly to wire up the Provider and holds
 * the actual state; this module only owns the channel's shape.
 */
export const SetPagePresenceContext = createContext<(people: PagePresencePerson[] | null) => void>(() => {});

/**
 * Call from routed page content (PageEditor, BoardCanvas, TablePageView) to
 * publish "who has THIS page open" up to the header; pass `null` while there
 * is no collab session yet. Mirrors Shell.tsx's useSetHeaderInfo shape
 * deliberately — same publish-on-mount/clear-on-unmount contract — just on
 * its own context (see the block comment above).
 */
export function usePublishPagePresence(people: PagePresencePerson[] | null) {
  const setPeople = useContext(SetPagePresenceContext);
  useEffect(() => {
    setPeople(people);
    return () => setPeople(null);
  }, [people, setPeople]);
}
