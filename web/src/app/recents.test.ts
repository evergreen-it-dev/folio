import { describe, expect, it } from 'vitest';
import { addRecent } from './recents';
import type { RecentPage } from './recents';

describe('addRecent', () => {
  it('adds a new entry to the front', () => {
    const result = addRecent([], { space: 'eng', id: 'p1', title: 'Onboarding' }, '2026-01-01T00:00:00.000Z');
    expect(result).toEqual([{ space: 'eng', id: 'p1', title: 'Onboarding', visitedAt: '2026-01-01T00:00:00.000Z' }]);
  });

  it('moves a re-visited page to the front instead of duplicating it', () => {
    const start: RecentPage[] = [
      { space: 'eng', id: 'p1', title: 'A', visitedAt: '2026-01-01T00:00:00.000Z' },
      { space: 'eng', id: 'p2', title: 'B', visitedAt: '2026-01-01T00:00:01.000Z' },
    ];
    const result = addRecent(start, { space: 'eng', id: 'p1', title: 'A (renamed)' }, '2026-01-02T00:00:00.000Z');
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ space: 'eng', id: 'p1', title: 'A (renamed)', visitedAt: '2026-01-02T00:00:00.000Z' });
    expect(result[1].id).toBe('p2');
  });

  it('dedupes by (space, id) — same id in a different space is a distinct entry', () => {
    const start: RecentPage[] = [{ space: 'eng', id: 'p1', title: 'Eng page', visitedAt: '2026-01-01T00:00:00.000Z' }];
    const result = addRecent(start, { space: 'design', id: 'p1', title: 'Design page' }, '2026-01-02T00:00:00.000Z');
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.space).sort()).toEqual(['design', 'eng']);
  });

  it('caps the list at 15, dropping the oldest', () => {
    const start: RecentPage[] = Array.from({ length: 15 }, (_, i) => ({
      space: 'eng',
      id: `p${i}`,
      title: `Page ${i}`,
      visitedAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
    }));
    // `start` is already in "most-recent-first" order (index 0 = p0), same
    // as addRecent's own output shape, so p14 — the last element — is the
    // oldest entry and the one that should fall off the cap.
    const result = addRecent(start, { space: 'eng', id: 'new', title: 'New' }, '2026-01-02T00:00:00.000Z');
    expect(result).toHaveLength(15);
    expect(result[0].id).toBe('new');
    expect(result.some((r) => r.id === 'p14')).toBe(false);
    expect(result.some((r) => r.id === 'p0')).toBe(true);
  });

  it('carries icon through when present', () => {
    const result = addRecent([], { space: 'eng', id: 'p1', title: 'A', icon: '🚀' });
    expect(result[0].icon).toBe('🚀');
  });
});
