/**
 * Server half of the content-loss fix (06.10.2026), against real PG and real
 * files:
 *  - a failed file write keeps the room's text in ydoc_state, and the next open
 *    resumes from it instead of letting the older file overwrite it;
 *  - a file that really did change while the room was closed still wins (the
 *    old, wanted behaviour) — and the room text it replaces is backed up;
 *  - a REST/MCP body write over a live room backs up what it replaces.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import * as Y from 'yjs';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import * as storage from './storage.js';
import * as collab from './collab.js';
import { query, queryOne } from './db/pool.js';
import * as git from './git.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileText = async (cmd: string, args: string[]): Promise<string> => (await promisify(execFile)(cmd, args)).stdout;

let teardownSchema: () => Promise<void>;
beforeAll(async () => {
  teardownSchema = await setUpTestSchema();
});
afterAll(async () => {
  await teardownSchema();
});

async function backups(pageId: string): Promise<Array<{ reason: string; body: string }>> {
  return query<{ reason: string; body: string }>('SELECT reason, body FROM page_text_backups WHERE page_id = $1 ORDER BY id', [pageId]);
}

describe('docFileWins', () => {
  it('the file wins without a marker, or when it changed since the marker; not when it is exactly what the room last wrote', () => {
    const marker = collab.fileBodyHash('# A\n\nold\n');
    expect(collab.docFileWins('# A\n\nold\n', null)).toBe(true);
    expect(collab.docFileWins('# A\n\nedited outside\n', marker)).toBe(true);
    expect(collab.docFileWins('# A\n\nold\n', marker)).toBe(false);
  });
});

describe('a failed file write never loses the room text', () => {
  it('persistDoc stores the snapshot without moving the marker; the next open keeps the snapshot and rewrites the file', async () => {
    const space = await storage.createSpace(`Content Safety ${Date.now()}`, null);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'Safety', kind: 'doc' });
      await storage.writeDocBody(page.id, '# Safety\n\nSaved text.\n');

      // A room opens and writes normally once: the marker now matches the file.
      const room = new Y.Doc();
      await collab.bindState(page.id, room);
      const text = room.getText('content');
      text.insert(text.length, 'Typed in the room.\n');
      expect(await collab.persistDoc(page.id, room)).toBe(true);
      const markerAfterWrite = (await queryOne<{ m: string }>('SELECT file_body_sha256 AS m FROM ydoc_state WHERE page_id = $1', [page.id]))!.m;
      expect(markerAfterWrite).toBe(collab.fileBodyHash(await storage.readFreshDocBody(page.id)));

      // More typing, and now the file cannot be written.
      text.insert(text.length, 'Typed while the disk refused.\n');
      const entry = await storage.requireEntry(page.id);
      // Writes are atomic (temp file + rename), so it is the directory that has to refuse.
      await fs.chmod(path.dirname(entry.absPath), 0o555);
      try {
        expect(await collab.persistDoc(page.id, room)).toBe(false);
      } finally {
        await fs.chmod(path.dirname(entry.absPath), 0o755);
      }
      // A failed atomic write leaves the old file whole and no temp file behind.
      expect(await storage.readFreshDocBody(page.id)).toContain('Typed in the room.');
      expect((await fs.readdir(path.dirname(entry.absPath))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
      expect(await storage.readFreshDocBody(page.id)).not.toContain('Typed while the disk refused.');
      const row = await collab.loadSnapshotRow(page.id);
      expect(row?.fileBodySha256).toBe(markerAfterWrite); // marker unchanged: the file did not change

      // The server restarts before any retry. The new room must resume the
      // snapshot (newer), not the file (older).
      const reopened = new Y.Doc();
      await collab.bindState(page.id, reopened);
      expect(reopened.getText('content').toString()).toContain('Typed while the disk refused.');
      // …and it writes it out on its own, without waiting for a keystroke.
      await collab.flushDoc(page.id);
      expect(await storage.readFreshDocBody(page.id)).toContain('Typed while the disk refused.');
    } finally {
      vi.restoreAllMocks();
      await deleteTestSpace(space.slug);
    }
  });
});

describe('the file still wins when it really changed, and what it replaces is kept', () => {
  it('an external edit made while the room was closed replaces the room text; the room text goes to page_text_backups', async () => {
    const space = await storage.createSpace(`Content Safety External ${Date.now()}`, null);
    try {
      const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'External', kind: 'doc' });
      await storage.writeDocBody(page.id, '# External\n\nv1\n');
      const room = new Y.Doc();
      await collab.bindState(page.id, room);
      room.getText('content').insert(room.getText('content').length, 'room-only line\n');
      expect(await collab.persistDoc(page.id, room)).toBe(true);

      // Someone edits the file directly (git pull, an editor on the server) while no room is open.
      await storage.writeDocBody(page.id, '# External\n\nv2 from outside\n');

      const reopened = new Y.Doc();
      await collab.bindState(page.id, reopened);
      expect(reopened.getText('content').toString()).toBe('# External\n\nv2 from outside\n');
      const kept = await backups(page.id);
      expect(kept).toHaveLength(1);
      expect(kept[0].reason).toMatch(/file changed/);
      expect(kept[0].body).toContain('room-only line');
    } finally {
      await deleteTestSpace(space.slug);
    }
  });
});

describe('page_text_backups', () => {
  it('backupRoomText keeps non-empty text, skips empty, and never throws', async () => {
    await collab.backupRoomText('no-such-page', 'test', '   ');
    expect(await backups('no-such-page')).toHaveLength(0);
    await collab.backupRoomText('no-such-page', 'test', 'kept');
    expect(await backups('no-such-page')).toEqual([{ reason: 'test', body: 'kept' }]);
    await query('DELETE FROM page_text_backups WHERE page_id = $1', ['no-such-page']);
  });

  it('keeps at most 50 per page, newest first', async () => {
    for (let i = 0; i < 53; i++) await collab.backupRoomText('prune-page', 'test', `v${i}`);
    const rows = await backups('prune-page');
    expect(rows).toHaveLength(50);
    expect(rows[0].body).toBe('v3');
    expect(rows[49].body).toBe('v52');
    await query('DELETE FROM page_text_backups WHERE page_id = $1', ['prune-page']);
  });
});

describe('a closed room never retries over a newer one (review of 54d4e76)', () => {
  it('room A fails to write, room B opens and writes, A\'s retry touches nothing', async () => {
    const space = await storage.createSpace(`Content Safety Retry ${Date.now()}`, null);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // y-websocket's own room map (the same CJS module instance collab.ts uses).
    const { docs } = createRequire(import.meta.url)('y-websocket/bin/utils') as { docs: Map<string, Y.Doc> };
    collab.setPersistRetryBaseMsForTests(30);
    try {
      const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'Retry', kind: 'doc' });
      await storage.writeDocBody(page.id, '# Retry\n\nbase\n');
      const dir = path.dirname((await storage.requireEntry(page.id)).absPath);

      const roomA = new Y.Doc();
      docs.set(page.id, roomA);
      await collab.bindState(page.id, roomA);
      roomA.getText('content').insert(roomA.getText('content').length, 'A old text\n');
      await fs.chmod(dir, 0o555);
      try {
        await collab.flushDoc(page.id); // fails; a retry is scheduled for A
      } finally {
        await fs.chmod(dir, 0o755);
      }

      // A closes; B opens (resuming A's snapshot) and writes newer text.
      const roomB = new Y.Doc();
      docs.set(page.id, roomB);
      await collab.bindState(page.id, roomB);
      const tb = roomB.getText('content');
      expect(tb.toString()).toContain('A old text');
      tb.delete(0, tb.length);
      tb.insert(0, '# Retry\n\nB newer text\n');
      await collab.flushDoc(page.id);
      expect(await storage.readFreshDocBody(page.id)).toBe('# Retry\n\nB newer text\n');

      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(await storage.readFreshDocBody(page.id)).toBe('# Retry\n\nB newer text\n');
      const reopened = new Y.Doc();
      Y.applyUpdate(reopened, (await collab.loadSnapshot(page.id))!);
      expect(reopened.getText('content').toString()).toBe('# Retry\n\nB newer text\n');
      docs.delete(page.id);
    } finally {
      collab.setPersistRetryBaseMsForTests(2_000);
      vi.restoreAllMocks();
      await deleteTestSpace(space.slug);
    }
  });
});

describe('a doc room never holds a carriage return (review of 54d4e76)', () => {
  it('normalizeEol', () => {
    expect(collab.normalizeEol('a\r\nb\rc\n')).toBe('a\nb\nc\n');
    expect(collab.normalizeEol('plain\n')).toBe('plain\n');
  });

  it('seeding from a CRLF file, the file-wins reconcile, a REST/MCP body write and an old CR snapshot all end up LF-only', async () => {
    const space = await storage.createSpace(`Content Safety CRLF ${Date.now()}`, null);
    try {
      const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'Crlf', kind: 'doc' });
      const entry = await storage.requireEntry(page.id);
      await fs.writeFile(entry.absPath, `---\nid: ${page.id}\n---\n# Crlf\r\n\r\none\r\n`, 'utf8');

      const seeded = new Y.Doc();
      await collab.bindState(page.id, seeded);
      expect(seeded.getText('content').toString()).toBe('# Crlf\n\none\n');

      // The file changes outside the room, with CRLF.
      await fs.writeFile(entry.absPath, `---\nid: ${page.id}\n---\n# Crlf\r\n\r\ntwo\r\n`, 'utf8');
      const resumed = new Y.Doc();
      await collab.bindState(page.id, resumed);
      expect(resumed.getText('content').toString()).toBe('# Crlf\n\ntwo\n');

      // A snapshot stored before this fix, with CRs inside: stripped on open, in place.
      const old = new Y.Doc();
      old.getText('content').insert(0, '# Crlf\r\n\r\nthree\r\n');
      await collab.storeSnapshot(page.id, old, '# Crlf\n\nthree\n');
      await storage.writeDocBody(page.id, '# Crlf\n\nthree\n');
      const fromOld = new Y.Doc();
      await collab.bindState(page.id, fromOld);
      expect(fromOld.getText('content').toString()).toBe('# Crlf\n\nthree\n');
      // The cleaned text is stored without waiting for an edit.
      await collab.flushDoc(page.id);
      const stored = new Y.Doc();
      Y.applyUpdate(stored, (await collab.loadSnapshot(page.id))!);
      expect(stored.getText('content').toString()).toBe('# Crlf\n\nthree\n');

      // Non-live body write: the file is written LF-only.
      await collab.editDocBody(page.id, '# Crlf\r\n\r\nfour\r\n');
      expect(await storage.readFreshDocBody(page.id)).toBe('# Crlf\n\nfour\n');
    } finally {
      await deleteTestSpace(space.slug);
    }
  });
});

describe('pruneTextBackups', () => {
  it('drops rows past retention for every page', async () => {
    await query(`INSERT INTO page_text_backups (page_id, reason, body, created_at) VALUES ('old-page', 'test', 'old', now() - interval '31 days'), ('new-page', 'test', 'new', now())`);
    await collab.pruneTextBackups();
    expect((await backups('old-page')).length).toBe(0);
    expect((await backups('new-page')).length).toBe(1);
    await query(`DELETE FROM page_text_backups WHERE page_id IN ('old-page', 'new-page')`);
  });
});

describe('writeFileAtomic temp files (review of 90def95)', () => {
  it('are never staged by git, and an orphaned one is removed by the next scan', async () => {
    const space = await storage.createSpace(`Content Safety Tmp ${Date.now()}`, null);
    try {
      const page = await storage.createPage({ space: space.slug, parentPath: '', title: 'Tmp', kind: 'doc' });
      const dir = path.dirname((await storage.requireEntry(page.id)).absPath);
      const orphan = path.join(dir, '.tmp.md.4242.abc123.tmp');
      const fresh = path.join(dir, '.tmp.md.4242.def456.tmp');
      await fs.writeFile(orphan, 'half a file');
      await fs.writeFile(fresh, 'a write in progress');
      const old = new Date(Date.now() - 5 * 60_000);
      await fs.utimes(orphan, old, old);
      expect(storage.isAtomicTempName('.tmp.md.4242.abc123.tmp')).toBe(true);
      expect(storage.isAtomicTempName('notes.md')).toBe(false);

      await git.commitAll(storage.getRepoDir(space.slug), 'test commit', { name: 't', email: 't@example.test' });
      const tracked = await execFileText('git', ['-C', storage.getRepoDir(space.slug), 'ls-files']);
      expect(tracked).not.toMatch(/\.tmp$/m);

      await storage.scanSpace(space.slug);
      const left = await fs.readdir(dir);
      expect(left).not.toContain('.tmp.md.4242.abc123.tmp');
      expect(left).toContain('.tmp.md.4242.def456.tmp'); // too young to be an orphan
    } finally {
      await deleteTestSpace(space.slug);
    }
  });
});
