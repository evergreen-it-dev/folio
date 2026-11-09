/**
 * Owner, verification date and review reminders against a real PG test schema
 * and a real space on disk: the three properties are written to Git by the same
 * path as the properties panel, survive a rescan, reach agents through
 * toPageMeta, and drive the weekly review_due reminder.
 */
import * as fs from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseBaseConfig } from '../shared/bases/parse.js';
import type { User } from '../shared/contracts.js';
import { userViewer } from './accessSql.js';
import { queryBase } from './bases/query.js';
import * as authStore from './auth/store.js';
import { query } from './db/pool.js';
import { deleteTestSpace, setUpTestSchema } from './db/testSchema.js';
import { listNotifications } from './notifications/routes.js';
import { readDeclaredTypes } from './propertyTypes.js';
import * as storage from './storage.js';
import { countRecentReviewReminders, runReviewReminders, updateVerification } from './verification.js';

describe('page verification (real PG + git)', () => {
  let teardownSchema: () => Promise<void>;
  let slug: string;
  let admin: User;
  let editor: User;
  let owner: User;
  let outsider: User;
  const stamp = Date.now();

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    admin = await authStore.createUser({ email: `ver-admin-${stamp}@example.com`, name: 'Admin', passwordHash: 'x', isAdmin: false });
    editor = await authStore.createUser({ email: `ver-editor-${stamp}@example.com`, name: 'Editor', passwordHash: 'x', isAdmin: false });
    owner = await authStore.createUser({ email: `ver-owner-${stamp}@example.com`, name: 'Owner', passwordHash: 'x', isAdmin: false, username: `own${stamp}` });
    outsider = await authStore.createUser({ email: `ver-out-${stamp}@example.com`, name: 'Outsider', passwordHash: 'x', isAdmin: false, username: `out${stamp}` });
    slug = (await storage.createSpace(`Verification ${stamp}`, admin.id)).slug;
    await authStore.setMembership(slug, admin.id, 'admin');
    await authStore.setMembership(slug, editor.id, 'editor');
    await authStore.setMembership(slug, owner.id, 'editor');
  });
  afterAll(async () => {
    await deleteTestSpace(slug);
    await teardownSchema();
  });

  const newPage = async (title: string) => (await storage.createPage({ space: slug, parentPath: '', title, kind: 'doc' })).id;
  const verificationOf = async (id: string) => storage.toPageMeta(await storage.requireEntry(id)).verification;
  const writeProps = async (id: string, patch: Record<string, string>) => {
    const entry = await storage.requireEntry(id);
    let raw = await fs.readFile(entry.absPath, 'utf8');
    const block = Object.entries(patch).map(([k, v]) => `${k}: ${v}\n`).join('');
    raw = raw.startsWith('---\n') ? raw.replace('---\n', `---\n${block}`) : `---\n${block}---\n${raw}`;
    await fs.writeFile(entry.absPath, raw, 'utf8');
    await storage.scanSpace(slug);
  };

  it('mark as verified: the three properties land in the file, the types are declared, and a rescan keeps the state', async () => {
    const id = await newPage('Marked');
    const result = await updateVerification(await storage.requireEntry(id), editor, { owner: owner.username!, markVerified: true });
    expect(result.written).toBe(true);
    expect(result.verification).toMatchObject({ state: 'verified', owner: owner.username });

    const raw = await fs.readFile((await storage.requireEntry(id)).absPath, 'utf8');
    expect(raw).toMatch(new RegExp(`owner: ${owner.username}`));
    expect(raw).toMatch(/verified: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\n/);
    expect(raw).toMatch(/review_by: \d{4}-\d{2}-\d{2}\n/);

    const types = (await readDeclaredTypes(slug)).types;
    expect(types).toMatchObject({ owner: 'text', verified: 'datetime', review_by: 'date' });

    // The reindex: pages_index is rebuilt from the file, the state is the same.
    await storage.scanSpace(slug);
    expect(await verificationOf(id)).toMatchObject({ state: 'verified', owner: owner.username });
    // ... and so after the file's mtime moved (a git checkout): a fresh scan of the row from scratch.
    await query('DELETE FROM pages_index WHERE id = $1', [id]);
    await storage.scanSpace(slug);
    const again = await verificationOf(id);
    expect(again?.owner).toBe(owner.username);
    expect(again?.verified).toBeTruthy();
    expect(again?.reviewBy).toBeTruthy();
  });

  it('the default period is 90 days, and a later mark keeps a period the page already had', async () => {
    const id = await newPage('Period');
    const first = await updateVerification(await storage.requireEntry(id), editor, { markVerified: true }, new Date('2026-11-09T10:00:00Z'));
    expect(first.verification?.reviewBy).toBe('2027-02-07');
    await updateVerification(await storage.requireEntry(id), editor, { reviewBy: '2026-12-09' }, new Date('2026-11-09T10:00:00Z'));
    const second = await updateVerification(await storage.requireEntry(id), editor, { markVerified: true }, new Date('2026-12-01T10:00:00Z'));
    // 30 days between the first mark and the chosen deadline: the next deadline is 30 days after the new mark.
    expect(second.verification?.reviewBy).toBe('2026-12-31');
  });

  it('after the mark the page is verified, after a text edit it is changed; changing the owner or the deadline is not an edit', async () => {
    const id = await newPage('Edited');
    await updateVerification(await storage.requireEntry(id), editor, { markVerified: true });
    expect((await verificationOf(id))?.state).toBe('verified');

    await updateVerification(await storage.requireEntry(id), editor, { owner: owner.username!, reviewBy: '2027-05-05' });
    expect((await verificationOf(id))?.state).toBe('verified');
    await storage.scanSpace(slug);
    expect((await verificationOf(id))?.state).toBe('verified');

    await new Promise((resolve) => setTimeout(resolve, 3200)); // past the grace of the write itself
    await storage.writeDocBody(id, '# Edited\n\nNew text after the check.\n');
    expect((await verificationOf(id))?.state).toBe('changed');
    await storage.scanSpace(slug);
    expect((await verificationOf(id))?.state).toBe('changed');

    // Marking again confirms the new text.
    await updateVerification(await storage.requireEntry(id), editor, { markVerified: true });
    expect((await verificationOf(id))?.state).toBe('verified');
  }, 20_000);

  it('refuses an owner that does not exist and a bad deadline, writing nothing', async () => {
    const id = await newPage('Refused');
    await expect(updateVerification(await storage.requireEntry(id), editor, { owner: 'nobody-here' })).rejects.toMatchObject({ status: 400 });
    await expect(updateVerification(await storage.requireEntry(id), editor, { reviewBy: '2026-02-31' })).rejects.toMatchObject({ status: 400 });
    expect(await verificationOf(id)).toBeUndefined();
  });

  it('wrong dates and a missing owner in the file do not break the state', async () => {
    const id = await newPage('Hand edited');
    await writeProps(id, { owner: 'ghost-user', verified: 'last tuesday', review_by: 'soon' });
    expect(await verificationOf(id)).toEqual({ state: 'unverified', owner: 'ghost-user', invalid: ['verified', 'review_by'] });
    // 2026-02-31 is read by the YAML parser as a date that rolls over (3 March): the state is still computed, nothing throws.
    const rolled = await newPage('Rolled date');
    await writeProps(rolled, { owner: owner.username!, verified: '2026-02-31', review_by: '2026-02-31' });
    expect((await verificationOf(rolled))?.state).toBe('overdue');
    const run = await runReviewReminders();
    expect(run.checked).toBeGreaterThanOrEqual(2); // the unparseable deadline is skipped, the job went through
  });

  it('the daily job: an overdue page reminds its owner once a week, also across a restart', async () => {
    const id = await newPage('Overdue');
    await writeProps(id, { owner: owner.username!, verified: '2026-01-01', review_by: '2026-02-01' });
    expect((await verificationOf(id))?.state).toBe('overdue');

    const first = await runReviewReminders();
    expect(first.reminded).toBeGreaterThanOrEqual(1);
    const feed = (await listNotifications(owner)).items.filter((n) => n.kind === 'review_due' && n.pageId === id);
    expect(feed).toHaveLength(1);
    expect(feed[0].payload).toMatchObject({ reviewBy: '2026-02-01', pageTitle: 'Overdue', space: slug });
    // Not told: the outsider, who cannot read it (not a member), and the page's editor who is not the owner.
    expect((await listNotifications(outsider)).items.filter((n) => n.pageId === id)).toHaveLength(0);
    expect((await listNotifications(editor)).items.filter((n) => n.pageId === id)).toHaveLength(0);

    // Next day, and the process "restarted" (the job keeps nothing in memory): still one row.
    const second = await runReviewReminders(new Date(Date.now() + 24 * 3600 * 1000));
    expect(second.throttled).toBeGreaterThanOrEqual(1);
    expect(await countRecentReviewReminders(id)).toBe(1);

    // After the week it reminds again.
    await query(`UPDATE notifications SET created_at = now() - interval '8 days' WHERE kind = 'review_due' AND page_id = $1`, [id]);
    await runReviewReminders();
    expect(await countRecentReviewReminders(id, 30)).toBe(2);
  });

  it('without an owner, or with an owner who does not exist, the space admins are told', async () => {
    const noOwner = await newPage('Ownerless');
    await writeProps(noOwner, { verified: '2026-01-01', review_by: '2026-02-01' });
    const ghost = await newPage('Ghost owner');
    await writeProps(ghost, { owner: 'does-not-exist', review_by: '2026-02-01' });
    await runReviewReminders();
    const adminFeed = (await listNotifications(admin)).items.filter((n) => n.kind === 'review_due');
    expect(adminFeed.map((n) => n.pageId)).toEqual(expect.arrayContaining([noOwner, ghost]));
    expect((await listNotifications(editor)).items.filter((n) => n.pageId === noOwner || n.pageId === ghost)).toHaveLength(0);
  });

  it('a base with review_by < today() lists exactly the pages whose deadline has passed', async () => {
    const past = await newPage('Base past');
    await writeProps(past, { review_by: '2026-01-01' });
    const future = await newPage('Base future');
    await writeProps(future, { review_by: '2999-01-01' });
    const none = await newPage('Base none');
    const config = parseBaseConfig('filters:\n  and:\n    - \'review_by < today()\'\n').config!;
    const result = await queryBase({ space: slug, config, viewer: userViewer(admin), spaceEditor: true, tokenMayWrite: true, thisPageId: null });
    const listed = new Set(result.rows.map((r) => r.path));
    const pathOf = async (id: string) => (await storage.requireEntry(id)).relPath;
    expect(listed.has(await pathOf(past))).toBe(true);
    expect(listed.has(await pathOf(future))).toBe(false);
    expect(listed.has(await pathOf(none))).toBe(false);
  });
});
