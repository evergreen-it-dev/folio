import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import * as authStore from './auth/store.js';
import * as storage from './storage.js';
import * as session from './auth/session.js';
import { searchPages } from './search.js';
import { isAgentPath } from './agentPath.js';
import type { TreeNode } from '../shared/contracts.js';

const asRequest = (user: unknown) => ({ authUser: user }) as unknown as FastifyRequest;

describe('.agent — admin-only pages (owner spec, 21.09.2026)', () => {
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    teardown = await setUpTestSchema();
  });
  afterAll(async () => teardown());

  it('isAgentPath matches the folder and its contents only, not a same-prefixed sibling', () => {
    expect(isAgentPath('.agent')).toBe(true);
    expect(isAgentPath('.agent/rules.md')).toBe(true);
    expect(isAgentPath('.agent/nested/deep.md')).toBe(true);
    expect(isAgentPath('.agentx.md')).toBe(false);
    expect(isAgentPath('notes/.agent/nested.md')).toBe(false); // not the space's content root
    expect(isAgentPath('notes.md')).toBe(false);
  });

  it('a page under .agent/ is indexed, and is present for an admin but absent for an editor in the tree AND in search', async () => {
    const stamp = Date.now();
    const admin = await authStore.createUser({ email: `agent-admin-${stamp}@test.local`, name: 'Admin', passwordHash: 'x', isAdmin: false });
    const editor = await authStore.createUser({ email: `agent-editor-${stamp}@test.local`, name: 'Editor', passwordHash: 'x', isAdmin: false });
    const space = await storage.createSpace(`Agent Rules ${stamp}`, admin.id);
    await authStore.setMembership(space.slug, admin.id, 'admin');
    await authStore.setMembership(space.slug, editor.id, 'editor');

    const title = `AgentRulesMarker${stamp}`;
    const meta = await storage.createPage({ space: space.slug, parentPath: '.agent', title, kind: 'doc' });
    expect(isAgentPath(meta.path)).toBe(true);

    // Indexed: requireEntry finds it, and its role is admin-only.
    const entry = await storage.requireEntry(meta.id);
    expect(entry.relPath.startsWith('.agent/')).toBe(true);
    expect(await session.effectivePageRole(admin, entry)).toBe('admin');
    expect(await session.effectivePageRole(editor, entry)).toBeUndefined();

    // requirePageRole: 404 (not 403) for the editor — never reveals the page exists.
    await expect(session.requirePageRole(asRequest(editor), meta.id, 'viewer')).rejects.toMatchObject({ status: 404 });
    await expect(session.requirePageRole(asRequest(admin), meta.id, 'viewer')).resolves.toMatchObject({ id: meta.id });

    // Tree: present for the admin, absent for the editor.
    const adminAllowed = await session.readablePageIds(admin, space.slug);
    const editorAllowed = await session.readablePageIds(editor, space.slug);
    expect(adminAllowed.has(meta.id)).toBe(true);
    expect(editorAllowed.has(meta.id)).toBe(false);

    const adminTree = await storage.getTree(space.slug, adminAllowed);
    const editorTree = await storage.getTree(space.slug, editorAllowed);
    const treeHasAgentFolder = (nodes: TreeNode[]): boolean =>
      nodes.some((n) => n.path === '.agent' || (n.children.length > 0 && treeHasAgentFolder(n.children)));
    expect(treeHasAgentFolder(adminTree)).toBe(true);
    expect(treeHasAgentFolder(editorTree)).toBe(false);

    // Search: present for the admin, absent for the editor.
    const adminHits = await searchPages(title, { userId: admin.id, space: space.slug, isInstanceAdmin: false });
    const editorHits = await searchPages(title, { userId: editor.id, space: space.slug, isInstanceAdmin: false });
    expect(adminHits.some((h) => h.id === meta.id)).toBe(true);
    expect(editorHits.some((h) => h.id === meta.id)).toBe(false);

    await deleteTestSpace(space.slug);
  });
});
