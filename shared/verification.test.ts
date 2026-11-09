import { describe, expect, it } from 'vitest';
import { addDays, computeVerification, parseDay, parseOwner } from './verification.js';

const NOW = new Date('2026-11-09T12:00:00Z');

describe('parseDay', () => {
  it('reads dates and datetimes, the index spelling of a YAML date included', () => {
    expect(parseDay('2026-11-09')).toEqual({ day: '2026-11-09', instant: null });
    expect(parseDay('2026-11-09T00:00:00.000Z')).toEqual({ day: '2026-11-09', instant: null });
    expect(parseDay('2026-11-09T14:32:05')?.instant).toBe(Date.parse('2026-11-09T14:32:05Z'));
    expect(parseDay('2026-11-09T14:32:05.000Z')?.day).toBe('2026-11-09');
    expect(parseDay(new Date('2026-11-09T00:00:00Z'))).toEqual({ day: '2026-11-09', instant: null });
  });
  it('rejects what is not a real day', () => {
    for (const bad of ['2026-02-31', '2026-13-01', 'tomorrow', '', '09.11.2026', 20261109, null, undefined, {}, [], new Date('nope'), '2026-11-09T25:00:00']) {
      expect(parseDay(bad)).toBeNull();
    }
  });
});

describe('parseOwner', () => {
  it('normalises a username and ignores everything that is not one', () => {
    expect(parseOwner(' @Ann ')).toBe('ann');
    expect(parseOwner('')).toBeNull();
    expect(parseOwner(42)).toBeNull();
    expect(parseOwner(['ann'])).toBeNull();
  });
});

describe('computeVerification', () => {
  it('has nothing to say about a page without the three properties', () => {
    expect(computeVerification({}, '2026-11-01T00:00:00Z', NOW)).toBeNull();
    expect(computeVerification({ owner: '', verified: null }, '2026-11-01T00:00:00Z', NOW)).toBeNull();
    expect(computeVerification(undefined, undefined, NOW)).toBeNull();
  });

  it('unverified: no verified date, the page does not nag', () => {
    expect(computeVerification({ owner: 'ann' }, '2026-11-01T00:00:00Z', NOW)).toEqual({ state: 'unverified', owner: 'ann' });
  });

  it('verified: verified, deadline ahead, text not edited since', () => {
    const v = computeVerification({ owner: 'ann', verified: '2026-11-05T10:00:00', review_by: '2027-02-03' }, '2026-11-01T00:00:00Z', NOW);
    expect(v).toEqual({ state: 'verified', owner: 'ann', verified: '2026-11-05', reviewBy: '2027-02-03' });
  });

  it('changed: updated_at is later than verified', () => {
    const v = computeVerification({ verified: '2026-11-05T10:00:00', review_by: '2027-02-03' }, '2026-11-06T09:00:00Z', NOW);
    expect(v?.state).toBe('changed');
  });

  it('changed does not fire from the write of the verification itself (a few ms later), but does from a later edit', () => {
    const props = { verified: '2026-11-09T11:00:00', review_by: '2027-02-07' };
    expect(computeVerification(props, '2026-11-09T11:00:00.250Z', NOW)?.state).toBe('verified');
    expect(computeVerification(props, '2026-11-09T11:00:30Z', NOW)?.state).toBe('changed');
  });

  it('a verified date written by hand covers its whole day', () => {
    expect(computeVerification({ verified: '2026-11-05' }, '2026-11-05T23:59:00Z', NOW)?.state).toBe('verified');
    expect(computeVerification({ verified: '2026-11-05' }, '2026-11-06T00:00:01Z', NOW)?.state).toBe('changed');
  });

  it('overdue: review_by in the past, and it wins over changed; today is not overdue', () => {
    const v = computeVerification({ verified: '2026-08-01', review_by: '2026-11-01' }, '2026-10-01T00:00:00Z', NOW);
    expect(v).toMatchObject({ state: 'overdue', daysOverdue: 8 });
    expect(computeVerification({ verified: '2026-08-01', review_by: '2026-11-09' }, '2026-08-01T00:00:00Z', NOW)?.state).toBe('verified');
    expect(computeVerification({ review_by: '2026-11-01' }, '2026-08-01T00:00:00Z', NOW)?.state).toBe('overdue');
  });

  it('survives wrong values: bad dates are ignored and reported, a bad owner and a bad updated_at are harmless', () => {
    const v = computeVerification({ owner: 42, verified: 'yesterday', review_by: '2026-02-31' }, 'garbage', NOW);
    expect(v).toEqual({ state: 'unverified', invalid: ['verified', 'review_by'] });
    expect(computeVerification({ verified: '2026-11-05T10:00:00' }, 'garbage', NOW)?.state).toBe('verified');
    expect(computeVerification({ verified: '2026-11-05T10:00:00' }, null, NOW)?.state).toBe('verified');
    // a bad deadline next to a good verification
    expect(computeVerification({ verified: '2026-11-05T10:00:00', review_by: 'soon' }, '2026-11-01T00:00:00Z', NOW)).toMatchObject({ state: 'verified', invalid: ['review_by'] });
  });
});

describe('addDays', () => {
  it('moves a day across month and year ends', () => {
    expect(addDays('2026-11-09', 90)).toBe('2027-02-07');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});
