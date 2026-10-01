import { describe, expect, it } from 'vitest';
import { getBootScanStatus, runBootScan } from './bootScan.js';

/**
 * Production, 15.09: one space whose scan threw brought main() down before
 * app.listen — the process died on every start of any image. Here is the
 * isolation rule: the failure of one space is recorded, the rest is indexed,
 * runBootScan does not throw.
 */
describe('runBootScan', () => {
  it('records a failed space and goes on, never throwing', async () => {
    const scanned: string[] = [];
    const scanOne = async (slug: string) => {
      scanned.push(slug);
      if (slug === 'broken') throw new Error('duplicate key value violates unique constraint\nstack…');
    };

    const result = await runBootScan(['alpha', 'broken', 'omega'], scanOne);

    expect(scanned).toEqual(['alpha', 'broken', 'omega']);
    expect(result.total).toBe(3);
    expect(result.current).toBeNull();
    expect(result.finishedAt).not.toBeNull();
    expect(result.results.map((r) => [r.slug, r.ok])).toEqual([
      ['alpha', true],
      ['broken', false],
      ['omega', true],
    ]);
    // Only the first line — the stack is not dragged into the API.
    expect(result.results[1].error).toBe('duplicate key value violates unique constraint');
  });

  it('the state is available through getBootScanStatus and is not mutated from outside', async () => {
    await runBootScan(['one'], async () => {});
    const snapshot = getBootScanStatus();
    snapshot.results.push({ slug: 'injected', ok: true, ms: 0 });
    expect(getBootScanStatus().results.map((r) => r.slug)).toEqual(['one']);
  });
});
