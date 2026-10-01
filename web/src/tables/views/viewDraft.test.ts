// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TableView } from '@shared/contracts';
import { clearDraft, draftKey, isDirty, loadDraft, makeView, saveDraft } from './viewDraft';

/**
 * Round 26 (DATA TABLES) — the local view draft (spec §5).
 *
 * jsdom, because the whole mechanism is localStorage-backed. The failure
 * modes matter as much as the happy path: a corrupt or unavailable store
 * must degrade to "no draft", never throw — a table that won't open because
 * of a stale draft would be a very bad bug for a shared, git-backed page.
 */

const base: TableView = {
  id: 'all',
  name: 'All records',
  columns: { hidden: [], order: [], width: {} },
  sort: [],
  filter: { op: 'and', rules: [] },
  frozen: 0,
  rowHeight: 'short',
};

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('isDirty', () => {
  it('is false for an untouched copy', () => {
    expect(isDirty(base, { ...base })).toBe(false);
  });

  it('is true once a filter rule is added', () => {
    const draft = { ...base, filter: { op: 'and' as const, rules: [{ column: 'x', operator: 'is_empty' as const }] } };
    expect(isDirty(base, draft)).toBe(true);
  });

  it('ignores name and icon — those are shared edits, not draftable', () => {
    expect(isDirty(base, { ...base, name: 'Renamed', icon: '🚀' })).toBe(false);
  });
});

describe('saveDraft / loadDraft', () => {
  it('round-trips the draftable slice', () => {
    const draft = { ...base, sort: [{ column: 'due', dir: 'asc' as const }] };
    saveDraft('page1', base, draft);
    expect(loadDraft('page1', base)?.sort).toEqual([{ column: 'due', dir: 'asc' }]);
  });

  it('keys drafts per page AND per view, so they do not collide', () => {
    saveDraft('page1', base, { ...base, rowHeight: 'tall' });
    expect(loadDraft('page2', base)).toBeNull();
    expect(loadDraft('page1', { ...base, id: 'other' })).toBeNull();
    expect(draftKey('p', 'v')).toBe('folio:table-draft:p:v');
  });

  it('clears the entry when the draft matches the saved view', () => {
    saveDraft('page1', base, { ...base, rowHeight: 'tall' });
    saveDraft('page1', base, { ...base });
    expect(window.localStorage.getItem(draftKey('page1', base.id))).toBeNull();
  });

  it('drops a persisted draft that is no longer different from the view', () => {
    // e.g. someone saved the same change into the shared view meanwhile.
    window.localStorage.setItem(draftKey('page1', base.id), JSON.stringify({ rowHeight: 'short' }));
    expect(loadDraft('page1', base)).toBeNull();
  });

  it('returns null on malformed JSON instead of throwing', () => {
    window.localStorage.setItem(draftKey('page1', base.id), '{not json');
    expect(loadDraft('page1', base)).toBeNull();
  });

  it('survives localStorage being unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    expect(loadDraft('page1', base)).toBeNull();
  });

  it('does not throw when the store rejects a write (quota)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    expect(() => saveDraft('page1', base, { ...base, rowHeight: 'tall' })).not.toThrow();
  });

  it('clearDraft removes the entry', () => {
    saveDraft('page1', base, { ...base, rowHeight: 'tall' });
    clearDraft('page1', base.id);
    expect(loadDraft('page1', base)).toBeNull();
  });
});

describe('makeView', () => {
  it('creates an empty view with no filters or sorting', () => {
    const view = makeView('v1', 'New');
    expect(view.filter.rules).toEqual([]);
    expect(view.sort).toEqual([]);
    expect(view.name).toBe('New');
  });

  it('copies a source view without sharing its arrays', () => {
    const source: TableView = {
      ...base,
      sort: [{ column: 'due', dir: 'asc' }],
      filter: { op: 'and', rules: [{ column: 'status', operator: 'is_any_of', value: ['DONE'] }] },
      columns: { hidden: ['x'], order: [], width: {} },
    };
    const copy = makeView('v2', 'Copy', source);
    copy.sort.push({ column: 'other', dir: 'desc' });
    copy.columns.hidden.push('y');
    // Mutating the copy must not reach back into the source.
    expect(source.sort).toHaveLength(1);
    expect(source.columns.hidden).toEqual(['x']);
    expect(copy.filter.rules[0]?.column).toBe('status');
  });
});
