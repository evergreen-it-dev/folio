import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setUpTestSchema } from './db/testSchema.js';
import * as assets from './assets.js';

describe('AssetStore (local backend round-trip)', () => {
  let teardownSchema: () => Promise<void>;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });
  afterAll(async () => {
    await teardownSchema();
  });

  it('stores content-addressed bytes and reads them back with the right metadata', async () => {
    const data = Buffer.from('hello asset store');
    const stored = await assets.putAsset(data, { mime: 'text/plain', filename: 'greeting.txt' }, null);
    expect(stored.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.size).toBe(data.length);
    expect(stored.url).toBe(`/a/${stored.sha256}/greeting.txt`);

    const loaded = await assets.getAsset(stored.sha256);
    expect(loaded?.data.toString('utf8')).toBe('hello asset store');
    expect(loaded?.mime).toBe('text/plain');
    expect(loaded?.filename).toBe('greeting.txt');
  });

  it('dedups identical content: a second upload of the same bytes reuses the same sha and file', async () => {
    const data = Buffer.from('identical payload');
    const first = await assets.putAsset(data, { mime: 'text/plain', filename: 'a.txt' }, null);
    const second = await assets.putAsset(data, { mime: 'text/plain', filename: 'b.txt' }, null);
    expect(second.sha256).toBe(first.sha256);
    // filename in the DB stays whatever the FIRST upload said (ON CONFLICT DO NOTHING)
    const loaded = await assets.getAsset(first.sha256);
    expect(loaded?.filename).toBe('a.txt');
  });

  it('an unknown sha resolves to null, not an error', async () => {
    const loaded = await assets.getAsset('0'.repeat(64));
    expect(loaded).toBeNull();
  });

  it('rejects a malformed sha without querying anything', async () => {
    const loaded = await assets.getAsset('not-a-real-sha');
    expect(loaded).toBeNull();
  });
});
