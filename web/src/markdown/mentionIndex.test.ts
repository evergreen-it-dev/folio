import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MentionableUser } from '@shared/contracts';
import { MENTION_RETRY_MS, clearMentionIndex, ensureMentionIndex, mentionIndex, mentionName, onMentionsLoaded } from './mentionIndex';

const USERS: MentionableUser[] = [
  { username: 'ann', name: 'Ann Lee' },
  { username: 'bob', name: 'Bob Smith' },
];

function stubFetch(response: { ok: boolean; status?: number; body?: unknown } = { ok: true, body: { users: USERS } }) {
  const fn = vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    json: () => Promise.resolve(response.body ?? {}),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearMentionIndex();
});

describe('ensureMentionIndex / mentionName', () => {
  it('resolves with the fetched list and populates mentionName', async () => {
    stubFetch();
    const users = await ensureMentionIndex('eng');
    expect(users).toEqual(USERS);
    expect(mentionName('eng', 'ann')).toBe('Ann Lee');
    expect(mentionName('eng', 'ANN')).toBe('Ann Lee'); // lookup is case-insensitive
    expect(mentionName('eng', 'ghost')).toBeUndefined();
  });

  it('requests the right URL, space-encoded', async () => {
    const fetchMock = stubFetch();
    await ensureMentionIndex('a space/b');
    expect(fetchMock).toHaveBeenCalledWith('/api/spaces/a%20space%2Fb/mentionable', expect.any(Object));
  });

  it('never fires a second request for the same space once loaded', async () => {
    const fetchMock = stubFetch();
    await ensureMentionIndex('eng');
    await ensureMentionIndex('eng');
    await ensureMentionIndex('eng');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent calls into a single in-flight request', async () => {
    const fetchMock = stubFetch();
    const [a, b, c] = await Promise.all([ensureMentionIndex('eng'), ensureMentionIndex('eng'), ensureMentionIndex('eng')]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual(USERS);
    expect(b).toEqual(USERS);
    expect(c).toEqual(USERS);
  });

  it('keeps separate caches per space', async () => {
    const fetchMock = stubFetch({ ok: true, body: { users: [{ username: 'ann', name: 'Ann Lee' }] } });
    await ensureMentionIndex('eng');
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ users: [{ username: 'cat', name: 'Cat Doe' }] }) });
    await ensureMentionIndex('design');
    expect(mentionName('eng', 'ann')).toBe('Ann Lee');
    expect(mentionName('eng', 'cat')).toBeUndefined();
    expect(mentionName('design', 'cat')).toBe('Cat Doe');
  });

  it('filters out entries with no username (cannot ever be written as @…)', async () => {
    stubFetch({ ok: true, body: { users: [{ username: '', name: 'No Handle' }, { username: 'ann', name: 'Ann Lee' }] } });
    const users = await ensureMentionIndex('eng');
    expect(users.map((u) => u.username)).toEqual(['ann']);
  });

  it('degrades to an empty list on a non-ok response, without throwing', async () => {
    stubFetch({ ok: false, status: 403 });
    const users = await ensureMentionIndex('eng');
    expect(users).toEqual([]);
    expect(mentionIndex('eng')).toEqual([]);
  });

  it('degrades to an empty list on a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const users = await ensureMentionIndex('eng');
    expect(users).toEqual([]);
  });

  it('retries after a failure once MENTION_RETRY_MS has passed, not before', async () => {
    // ensureMentionIndex's `now` param only gates the READ check — the actual
    // failure timestamp is always recorded via a real Date.now() call (see
    // its .catch()), so a real clock can't reliably hit millisecond-precise
    // boundaries; mock Date.now itself so both sides agree on "now".
    const dateSpy = vi.spyOn(Date, 'now');
    try {
      dateSpy.mockReturnValue(1_000_000);
      const failing = stubFetch({ ok: false, status: 500 });
      await ensureMentionIndex('eng');
      expect(failing).toHaveBeenCalledTimes(1);

      // Still within the retry window: no new request fired.
      dateSpy.mockReturnValue(1_000_000 + 1000);
      await ensureMentionIndex('eng');
      expect(failing).toHaveBeenCalledTimes(1);

      // Past the window: tries again, and can now succeed.
      dateSpy.mockReturnValue(1_000_000 + MENTION_RETRY_MS + 1);
      const succeeding = stubFetch();
      const users = await ensureMentionIndex('eng');
      expect(succeeding).toHaveBeenCalledTimes(1);
      expect(users).toEqual(USERS);
    } finally {
      dateSpy.mockRestore();
    }
  });

  it('notifies onMentionsLoaded listeners once the list lands, but only for the matching space', async () => {
    stubFetch();
    const seen: string[] = [];
    const off = onMentionsLoaded((space) => seen.push(space));
    await ensureMentionIndex('eng');
    await ensureMentionIndex('design'); // different space: fetches again with the same stub, fires again
    off();
    await ensureMentionIndex('other');
    expect(seen).toEqual(['eng', 'design']); // 'other' fired after off() unsubscribed
  });
});
