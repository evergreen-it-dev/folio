/**
 * Round 27 (access and rights) — the REQUIRED acceptance suite from
 * docs/spec-access.md §11.1: "an instance admin without a membership" tested across all
 * six paths (page, tree/sidebar, search, collab WS, MCP/PAT, mentionable).
 * Every test below sets up an instance-admin with a real user row but
 * DELIBERATELY no space_members row anywhere, then proves each surface
 * denies/omits/scopes-down access to a private space — and, for a couple of
 * paths, that a `visibility: 'instance'` space (spec §3) correctly grants
 * the implicit read-only viewer instead.
 *
 * Each `it()` name below is written to be quoted directly in the round's
 * report against its numbered path in the spec.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import * as http from 'node:http';
import WS from 'ws';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { setUpTestSchema, deleteTestSpace } from '../db/testSchema.js';
import * as storage from '../storage.js';
import * as authStore from '../auth/store.js';
import * as session from '../auth/session.js';
import { searchPages } from '../search.js';
import * as collab from '../collab.js';
import { buildFolioMcpServer } from '../mcp.js';

describe('spec-access.md §11.1 — instance-admin without membership, all six paths (real PG)', () => {
  let teardownSchema: () => Promise<void>;
  let collabServer: http.Server;
  let collabPort: number;

  let admin: Awaited<ReturnType<typeof authStore.createUser>>;
  let privateSpace: Awaited<ReturnType<typeof storage.createSpace>>;
  let instanceSpace: Awaited<ReturnType<typeof storage.createSpace>>;
  let privatePageId: string;
  let instancePageId: string;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    collab.initCollab();
    collabServer = http.createServer();
    collab.attachToServer(collabServer);
    await new Promise<void>((resolve) => collabServer.listen(0, '127.0.0.1', resolve));
    const addr = collabServer.address();
    collabPort = typeof addr === 'object' && addr ? addr.port : 0;

    admin = await authStore.createUser({ email: `boundary-admin-${Date.now()}@t.local`, name: 'Boundary Admin', passwordHash: 'x', isAdmin: true });

    privateSpace = await storage.createSpace(`Boundary Private ${Date.now()}`, null);
    const privatePage = await storage.createPage({ space: privateSpace.slug, parentPath: '', title: 'Private Secret Roadmap', kind: 'doc' });
    privatePageId = privatePage.id;

    instanceSpace = await storage.createSpace(`Boundary Instance ${Date.now()}`, null);
    await authStore.setSpaceVisibility(instanceSpace.slug, 'instance');
    const instancePage = await storage.createPage({ space: instanceSpace.slug, parentPath: '', title: 'Company Wide Handbook', kind: 'doc' });
    instancePageId = instancePage.id;

    // Deliberately NOT calling authStore.setMembership anywhere for `admin` —
    // that's the whole point of this suite.
  });

  afterAll(async () => {
    collabServer.closeAllConnections?.();
    await new Promise<void>((resolve) => collabServer.close(() => resolve()));
    await deleteTestSpace(privateSpace.slug);
    await deleteTestSpace(instanceSpace.slug);
    await teardownSchema();
  });

  it('path 1 — cannot open a page in a space they are not a member of (requireSpaceRole/requirePageRole throw); CAN open one in a visibility:instance space as a read-only viewer', async () => {
    const fakeRequest = { authUser: admin } as unknown as FastifyRequest;
    await expect(session.requireSpaceRole(fakeRequest, privateSpace.slug, 'viewer')).rejects.toThrow();
    await expect(session.requirePageRole(fakeRequest, privatePageId, 'viewer')).rejects.toThrow();

    const role = await session.requireSpaceRole(fakeRequest, instanceSpace.slug, 'viewer');
    expect(role).toBe('viewer');
    // ...but never as an editor — the implicit grant is read-only (spec §3).
    await expect(session.requireSpaceRole(fakeRequest, instanceSpace.slug, 'editor')).rejects.toThrow();
  });

  it('path 2 — does not see the private space in the page tree / space switcher (membershipsFor); DOES see the visibility:instance space', async () => {
    const memberships = await session.membershipsFor(admin);
    expect(memberships[privateSpace.slug]).toBeUndefined();
    expect(memberships[instanceSpace.slug]).toBe('viewer');
  });

  it('path 3 — does not find the private space\'s content via search; DOES find the visibility:instance space\'s content', async () => {
    const privateHits = await searchPages('Secret Roadmap', { userId: admin.id });
    expect(privateHits.some((h) => h.space === privateSpace.slug)).toBe(false);

    const instanceHits = await searchPages('Company Wide Handbook', { userId: admin.id });
    expect(instanceHits.some((h) => h.space === instanceSpace.slug)).toBe(true);
  });

  it('path 4 — cannot connect to the private space\'s collab websocket room (rejected before the WS upgrade completes); CAN connect read-only to the visibility:instance space\'s room', async () => {
    const { token } = await authStore.createSession(admin.id);
    const cookieHeader = `folio_session=${token}`;

    const privateStatus = await attemptCollabUpgrade(collabPort, privatePageId, cookieHeader);
    expect(privateStatus).not.toBe(101);
    expect(privateStatus).toBe(403);

    const instanceStatus = await attemptCollabUpgrade(collabPort, instancePageId, cookieHeader);
    expect(instanceStatus).toBe(101); // upgrade succeeds — makeReadOnly() enforces the no-write part, exercised in shareCollab.test.ts's view-mode case
  });

  it('path 5 — MCP tools scope down the same way: list_spaces omits the private space (and includes the instance one), search_pages finds nothing there, read_page errors', async () => {
    const mcpServer = buildFolioMcpServer({ user: admin, scopes: ['read', 'write'], tokenId: 'test-token' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const listResult = await client.callTool({ name: 'list_spaces', arguments: {} });
      const listText = (listResult.content as { type: string; text: string }[])[0].text;
      expect(listText).not.toContain(privateSpace.slug);
      expect(listText).toContain(instanceSpace.slug);

      const searchResult = await client.callTool({ name: 'search_pages', arguments: { query: 'Secret Roadmap' } });
      const searchText = (searchResult.content as { type: string; text: string }[])[0].text;
      expect(searchText).not.toContain(privateSpace.slug);

      const readResult = await client.callTool({ name: 'read_page', arguments: { id: privatePageId } });
      expect(readResult.isError).toBe(true);

      const readInstance = await client.callTool({ name: 'read_page', arguments: { id: instancePageId } });
      expect(readInstance.isError).toBeFalsy();
    } finally {
      await client.close();
      await mcpServer.close();
    }
  });

  it('path 6 — not offered as a mentionable user in the private space; IS offered in the visibility:instance space', async () => {
    await authStore.updateUsername(admin.id, 'boundary-admin-handle');
    const privateMentionable = await authStore.listMentionableUsers(privateSpace.slug);
    expect(privateMentionable.some((u) => u.username === 'boundary-admin-handle')).toBe(false);

    const instanceMentionable = await authStore.listMentionableUsers(instanceSpace.slug);
    expect(instanceMentionable.some((u) => u.username === 'boundary-admin-handle')).toBe(true);
  });

  it('bonus: a disabled user gets nothing via either explicit membership or visibility:instance', async () => {
    const disabledUser = await authStore.createUser({ email: `boundary-disabled-${Date.now()}@t.local`, name: 'Disabled', passwordHash: 'x', isAdmin: false });
    await authStore.setMembership(instanceSpace.slug, disabledUser.id, 'admin');
    await authStore.updateUser(disabledUser.id, { disabled: true });
    const disabled = { ...disabledUser, disabled: true };

    expect(await session.effectiveRole(disabled, instanceSpace.slug)).toBeUndefined();
    expect(await session.membershipsFor(disabled)).toEqual({});
  });
});

/** Attempts a raw WS upgrade to /collab/<pageId> with the given Cookie header; resolves the HTTP status the server actually responded with (101 = upgraded, anything else = collab.ts's rejectUpgrade wrote that status and closed the socket without upgrading). */
function attemptCollabUpgrade(port: number, pageId: string, cookieHeader: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WS(`ws://127.0.0.1:${port}/collab/${pageId}`, { headers: { Cookie: cookieHeader } });
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error('collab upgrade attempt timed out'));
    }, 8000);
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timeout);
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.on('open', () => {
      clearTimeout(timeout);
      resolve(101);
      ws.close();
    });
    ws.on('error', () => {
      // 'unexpected-response' already handles the rejectUpgrade case; a plain
      // socket error here (after settling) is just the subsequent close/reset
      // — ignore rather than reject a promise that may already be resolved.
    });
  });
}
