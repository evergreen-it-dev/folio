import { describe, expect, it, vi } from 'vitest';
import {
  failSpaceImport,
  finishSpaceImport,
  getSpaceImport,
  startSpaceImport,
  updateSpaceImport,
} from './spaceImportProgress.js';

describe('space import progress', () => {
  it('reports monotonic progress only to the user who started the import', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T10:00:00Z'));
    startSpaceImport('job-owner', 'user-a');
    vi.advanceTimersByTime(1_250);
    updateSpaceImport('job-owner', { phase: 'scanning', percent: 48, processedFiles: 12, totalFiles: 25 });
    updateSpaceImport('job-owner', { percent: 30 });

    expect(getSpaceImport('job-owner', 'user-b')).toBeUndefined();
    expect(getSpaceImport('job-owner', 'user-a')).toEqual({
      id: 'job-owner',
      phase: 'scanning',
      percent: 48,
      processedFiles: 12,
      totalFiles: 25,
      elapsedMs: 1_250,
      done: false,
    });
    vi.useRealTimers();
  });

  it('marks completed and failed imports as terminal', () => {
    startSpaceImport('job-done', 'user');
    finishSpaceImport('job-done');
    expect(getSpaceImport('job-done', 'user')).toMatchObject({ phase: 'done', percent: 100, done: true });

    startSpaceImport('job-error', 'user');
    failSpaceImport('job-error', 'clone failed');
    expect(getSpaceImport('job-error', 'user')).toMatchObject({ phase: 'error', done: true, error: 'clone failed' });
  });
});
