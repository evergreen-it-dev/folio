import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setUpTestSchema, deleteTestSpace } from '../db/testSchema.js';
import * as storage from '../storage.js';
import { buildSpaceZip } from './spaceZip.js';

describe('space ZIP export', () => {
  let teardownSchema: () => Promise<void>;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });

  afterAll(async () => {
    await teardownSchema();
  });

  it('preserves content paths and assets without exporting git internals', async () => {
    const space = await storage.createSpace(`ZIP export ${Date.now()}`, null);
    try {
      await storage.createPage({ space: space.slug, parentPath: '', title: 'Child', kind: 'doc' });
      const root = storage.getSpaceDir(space.slug);
      await fs.mkdir(path.join(root, 'assets'), { recursive: true });
      await fs.writeFile(path.join(root, 'assets', 'sample.txt'), 'asset-body');

      const archive = await JSZip.loadAsync(await buildSpaceZip(space.slug));
      const names = Object.keys(archive.files);
      expect(names).toContain('index.md');
      expect(names).toContain('child.md');
      expect(names).toContain('assets/sample.txt');
      expect(names.some((name) => name === '.git' || name.startsWith('.git/'))).toBe(false);
      expect(await archive.file('assets/sample.txt')!.async('string')).toBe('asset-body');
    } finally {
      await deleteTestSpace(space.slug);
    }
  });
});
