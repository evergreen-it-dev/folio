/**
 * Round 22 admin-api: GET /api/admin/spaces. routes.ts registers Fastify
 * routes and has no HTTP-level test harness in this codebase (no other
 * server/*.test.ts spins up a Fastify app either — every existing test
 * calls the underlying module functions directly against a real PG test
 * schema). buildAdminSpacesList is exported from routes.ts alongside
 * registerRoutes specifically so its assembly logic (spaces + per-space
 * members-with-roles + local/remote kind) is testable the same way,
 * independent of the route handler's own thin auth-check-then-call body.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import * as storage from './storage.js';
import * as authStore from './auth/store.js';
import { buildAdminSpacesList, buildAgentRulesInfo } from './routes.js';

describe('buildAdminSpacesList (round 22 admin-api, real PG)', () => {
  let teardownSchema: () => Promise<void>;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });
  afterAll(async () => {
    await teardownSchema();
  });

  it('reports pageCount, kind=local (no origin), and members with roles+details for a local space', async () => {
    const ownerEmail = `admin-list-owner-${Date.now()}@test.local`;
    const owner = await authStore.createUser({ email: ownerEmail, name: 'Owner', passwordHash: 'x', isAdmin: false });
    const viewer = await authStore.createUser({ email: `admin-list-viewer-${Date.now()}@test.local`, name: 'Viewer', passwordHash: 'x', isAdmin: false });

    const spaceName = `Admin List Local ${Date.now()}`;
    const space = await storage.createSpace(spaceName, owner.id);
    await authStore.setMembership(space.slug, owner.id, 'admin');
    await authStore.setMembership(space.slug, viewer.id, 'viewer');
    await storage.createPage({ space: space.slug, parentPath: '', title: 'Second Page', kind: 'doc' });

    const all = await buildAdminSpacesList();
    const found = all.find((s) => s.slug === space.slug);
    expect(found).toBeDefined();
    expect(found!.kind).toBe('local');
    expect(found!.pageCount).toBe(2); // index.md + Second Page
    expect(found!.name).toBe(spaceName);
    expect(found!.git).toMatchObject({ repoUrl: null, status: 'local' });

    // Flat member shape (userId/name/email/username?/role) — NOT the nested
    // {user: {...}, role} shape the existing members-dialog endpoint uses.
    const roles = Object.fromEntries(found!.members.map((m) => [m.userId, m.role]));
    expect(roles[owner.id]).toBe('admin');
    expect(roles[viewer.id]).toBe('viewer');
    const ownerMember = found!.members.find((m) => m.userId === owner.id)!;
    expect(ownerMember.email.toLowerCase()).toBe(ownerEmail.toLowerCase());
    expect(ownerMember.name).toBe('Owner');
    expect((ownerMember as { passwordHash?: string }).passwordHash).toBeUndefined(); // never leaked
    expect('user' in ownerMember).toBe(false); // flat, not nested

    await deleteTestSpace(space.slug);
  });

  it('reports kind=remote for a space cloned from a repo (has an origin)', async () => {
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const git = await import('./git.js');
    // Local bare repo standing in for a remote — opt in, the clone family
    // refuses schemeless local paths by default (git.ts, QA-3 P0).
    git.__allowLocalRepoPathsForTests();

    const bareDir = path.join(os.tmpdir(), `folio-test-admin-list-remote-${Date.now()}.git`);
    await execFileAsync('git', ['init', '--bare', '-b', 'main', bareDir]);

    const space = await storage.createSpaceFromRepo({ name: `Admin List Remote ${Date.now()}`, repoUrl: bareDir, branch: 'main', rootPath: '', createdBy: null });

    try {
      const all = await buildAdminSpacesList();
      const found = all.find((s) => s.slug === space.slug);
      expect(found).toBeDefined();
      expect(found!.kind).toBe('remote');
    } finally {
      await deleteTestSpace(space.slug);
      await fs.rm(bareDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);

  it('a space with zero members reports an empty members array, not an error', async () => {
    const space = await storage.createSpace(`Admin List No Members ${Date.now()}`, null);
    const all = await buildAdminSpacesList();
    const found = all.find((s) => s.slug === space.slug);
    expect(found?.members).toEqual([]);
    await deleteTestSpace(space.slug);
  });

  it('username is present when the member has one set, and omitted (not just undefined) when they don\'t', async () => {
    const withHandle = await authStore.createUser({ email: `admin-list-handle-${Date.now()}@test.local`, name: 'Handle', passwordHash: 'x', isAdmin: false });
    await authStore.updateUsername(withHandle.id, 'handle-user');
    const noHandle = await authStore.createUser({ email: `admin-list-nohandle-${Date.now()}@test.local`, name: 'No Handle', passwordHash: 'x', isAdmin: false });

    const space = await storage.createSpace(`Admin List Username ${Date.now()}`, null);
    await authStore.setMembership(space.slug, withHandle.id, 'viewer');
    await authStore.setMembership(space.slug, noHandle.id, 'viewer');

    const all = await buildAdminSpacesList();
    const found = all.find((s) => s.slug === space.slug)!;
    const withHandleMember = found.members.find((m) => m.userId === withHandle.id)!;
    const noHandleMember = found.members.find((m) => m.userId === noHandle.id)!;

    expect(withHandleMember.username).toBe('handle-user');
    expect(noHandleMember.username).toBeUndefined();
    expect('username' in noHandleMember).toBe(false); // omitted, not just undefined

    await deleteTestSpace(space.slug);
  });
});

// Owner report (22.09.2026): a viewer had no sign that `.agent` rules apply
// to their assistant runs at all. Pure, no DB — buildAgentRulesInfo is the
// exact shape GET /api/spaces sends per caller.
describe('buildAgentRulesInfo — member vs. admin visibility (GET /api/spaces)', () => {
  it('a member (non-admin) sees {used, pages} but no path', () => {
    expect(buildAgentRulesInfo(3, false)).toEqual({ used: true, pages: 3 });
    expect('path' in buildAgentRulesInfo(3, false)).toBe(false);
  });

  it('an admin sees the same used/pages plus the path link target', () => {
    expect(buildAgentRulesInfo(3, true)).toEqual({ used: true, pages: 3, path: '.agent' });
  });

  it('used is false (for both roles) when the space has no .agent pages', () => {
    expect(buildAgentRulesInfo(0, false)).toEqual({ used: false, pages: 0 });
    expect(buildAgentRulesInfo(0, true)).toEqual({ used: false, pages: 0, path: '.agent' });
  });
});
