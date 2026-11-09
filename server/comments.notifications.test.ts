/**
 * Notifications from comments (real PG): an @mention is delivered once — also
 * when an agent writes the comment through MCP — to people who can read the
 * page only; a reply tells the other participants of the thread, never its
 * author; access-request rows keep working next to them.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '../shared/contracts.js';
import * as authStore from './auth/store.js';
import * as comments from './comments.js';
import { deleteTestSpace, setUpTestSchema } from './db/testSchema.js';
import { buildFolioMcpServer } from './mcp.js';
import { createAccessRequest, listNotifications } from './notifications/routes.js';
import * as storage from './storage.js';

describe('comment notifications (real PG)', () => {
  let teardownSchema: () => Promise<void>;
  let space: string;
  let pageId: string;
  let author: User;
  let editor: User;
  let viewer: User;
  let outsider: User;
  const anchor = { anchorFrom: 'AQID', anchorTo: 'BAUG', quotedText: 'handbook' };

  const feed = async (user: User) => (await listNotifications(user)).items.filter((i) => i.kind.startsWith('comment_'));

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const stamp = Date.now();
    const mk = (n: string) => authStore.createUser({ email: `${n}-${stamp}@cn-test.local`, name: n, passwordHash: 'x', isAdmin: false, username: `${n}${stamp}`.toLowerCase() });
    [author, editor, viewer, outsider] = await Promise.all([mk('Author'), mk('Editor'), mk('Viewer'), mk('Outsider')]);
    space = (await storage.createSpace(`CommentNotif ${stamp}`, author.id)).slug;
    await authStore.setMembership(space, author.id, 'admin');
    await authStore.setMembership(space, editor.id, 'editor');
    await authStore.setMembership(space, viewer.id, 'viewer');
    pageId = (await storage.createPage({ space, parentPath: '', title: 'Handbook', kind: 'doc' }, { docBody: '# Handbook\n\nThe retry limit is 3.\n' })).id;
  });

  afterAll(async () => {
    await deleteTestSpace(space);
    await teardownSchema();
  });

  it('parseMentions: usernames only, trailing punctuation dropped, e-mail addresses ignored', () => {
    expect(comments.parseMentions('hi @Bob, and @al.ice. mail me@host.com @bob')).toEqual(['bob', 'al.ice']);
  });

  it('a mention is delivered once, to a reader of the page only; the author is not told about their own comment', async () => {
    const body = `ping @${viewer.username} @${outsider.username} @${author.username} @${viewer.username}`;
    const thread = await comments.createThread(pageId, author.id, { ...anchor, body });

    const got = await feed(viewer);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: 'comment_mention', pageId, payload: { space, pageTitle: 'Handbook', threadId: thread.id, authorName: 'Author' } });
    expect(await feed(outsider)).toEqual([]);
    expect(await feed(author)).toEqual([]);

    // The same comment delivered again (a retry) adds nothing.
    const delivered = await (await import('./notifications/dispatch.js')).deliverToPage([viewer.id], 'comment_mention', pageId, { commentId: thread.comments[0].id });
    expect(delivered).toEqual([]);
    expect(await feed(viewer)).toHaveLength(1);
  });

  it('a comment written by an agent over MCP notifies the mentioned person once', async () => {
    const server = buildFolioMcpServer({ user: editor, scopes: ['read', 'write'], tokenId: 'cn-test' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const result = await client.callTool({ name: 'add_comment', arguments: { page: pageId, quote: 'retry limit is 3', body: `@${author.username} please check` } });
      expect(result.isError).not.toBe(true);
    } finally {
      await client.close();
    }
    const got = await feed(author);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: 'comment_mention', payload: { authorName: 'Editor' } });
    expect(await feed(editor)).toEqual([]);
  });

  it('a reply tells the other participants but not its author; a mentioned participant gets only the mention', async () => {
    const thread = await comments.createThread(pageId, editor.id, { ...anchor, body: 'opening' });
    await comments.addReply(thread.id, viewer.id, 'viewer joins');
    const before = { author: (await feed(author)).length, editor: (await feed(editor)).length, viewer: (await feed(viewer)).length };

    await comments.addReply(thread.id, author.id, `thanks @${viewer.username}`);
    const editorNew = (await feed(editor)).length - before.editor;
    const viewerNew = (await feed(viewer)).length - before.viewer;
    expect(editorNew).toBe(1);
    expect((await feed(editor))[0].kind).toBe('comment_reply');
    expect(viewerNew).toBe(1);
    expect((await feed(viewer))[0].kind).toBe('comment_mention');
    expect((await feed(author)).length).toBe(before.author);
  });

  it('access requests still arrive in the same feed', async () => {
    const asker = await authStore.createUser({ email: `asker-${Date.now()}@cn-test.local`, name: 'Asker', passwordHash: 'x', isAdmin: false });
    const created = await createAccessRequest(asker, { space });
    const items = (await listNotifications(author)).items.filter((i) => i.kind === 'access_request');
    expect(items.map((i) => i.accessRequest?.id)).toContain(created.id);
  });
});
