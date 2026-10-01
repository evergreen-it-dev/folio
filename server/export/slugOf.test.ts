/**
 * `slugOf` — the name of the downloaded export file.
 *
 * The owner downloaded the PDF of the "Strategy & Vision" section and got
 * `index.pdf`: for a directory page the file is called `index.md`, so the
 * stem is "index", and it is THE SAME for every such page in the wiki (a
 * second downloaded section silently overwrites the first in the downloads
 * folder). Its meaningful name is the name of the directory this index.md
 * lies in.
 */
import { describe, expect, it } from 'vitest';
import { slugOf } from './routes.js';
import type { PageIndexEntry } from '../storage.js';

function entry(relPath: string, kind: PageIndexEntry['kind'], isIndex: boolean): PageIndexEntry {
  return { relPath, kind, isIndex, space: 'wiki' } as unknown as PageIndexEntry;
}

describe('slugOf — export filename stem', () => {
  it('uses the FOLDER name for a directory index page, not the bare "index"', () => {
    expect(slugOf(entry('strategy-vision/index.md', 'doc', true))).toBe('strategy-vision');
    expect(slugOf(entry('product/flow/index.md', 'doc', true))).toBe('flow');
  });

  it('falls back to the space slug for the space root, which has no folder above it', () => {
    expect(slugOf(entry('index.md', 'doc', true))).toBe('wiki');
  });

  it('leaves ordinary pages, boards and tables exactly as they were', () => {
    expect(slugOf(entry('notes/plan.md', 'doc', false))).toBe('plan');
    expect(slugOf(entry('notes/board.excalidraw.svg', 'board', false))).toBe('board');
    expect(slugOf(entry('notes/weekly.table.md', 'table', false))).toBe('weekly');
  });

  it('does not hijack a page that is merely NAMED index but is not a directory index', () => {
    expect(slugOf(entry('notes/index.md', 'doc', false))).toBe('index');
  });
});
