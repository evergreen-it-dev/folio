import { describe, expect, it } from 'vitest';
import {
  checkCellLength,
  checkColumnCount,
  checkOptionCount,
  checkRowCount,
  checkViewCount,
  isOverHardRowLimit,
  TABLE_LIMITS,
} from './limits.js';

describe('limits: spec §13 thresholds', () => {
  it('rows: ok under soft, warn between soft and hard, error over hard', () => {
    expect(checkRowCount(TABLE_LIMITS.rows.soft).level).toBe('ok');
    expect(checkRowCount(TABLE_LIMITS.rows.soft + 1).level).toBe('warn');
    expect(checkRowCount(TABLE_LIMITS.rows.hard + 1).level).toBe('error');
  });

  it('columns: 40 soft / 80 hard', () => {
    expect(checkColumnCount(40).level).toBe('ok');
    expect(checkColumnCount(41).level).toBe('warn');
    expect(checkColumnCount(81).level).toBe('error');
  });

  it('cell length: 10 000 soft / 50 000 hard', () => {
    expect(checkCellLength(10_000).level).toBe('ok');
    expect(checkCellLength(10_001).level).toBe('warn');
    expect(checkCellLength(50_001).level).toBe('error');
  });

  it('options: 100 soft / 500 hard', () => {
    expect(checkOptionCount(100).level).toBe('ok');
    expect(checkOptionCount(101).level).toBe('warn');
    expect(checkOptionCount(501).level).toBe('error');
  });

  it('views: 20 soft / 50 hard', () => {
    expect(checkViewCount(20).level).toBe('ok');
    expect(checkViewCount(21).level).toBe('warn');
    expect(checkViewCount(51).level).toBe('error');
  });

  it('isOverHardRowLimit gates the "open read-only" behavior', () => {
    expect(isOverHardRowLimit(TABLE_LIMITS.rows.hard)).toBe(false);
    expect(isOverHardRowLimit(TABLE_LIMITS.rows.hard + 1)).toBe(true);
  });
});
