/**
 * Team skills over MCP: list_skills, get_skill and the prompts, real PG + files, through the SDK's in-memory transport.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '../shared/contracts.js';
import * as authStore from './auth/store.js';
import { query } from './db/pool.js';
import { deleteTestSpace, setUpTestSchema } from './db/testSchema.js';
import { FOLIO_MCP_INSTRUCTIONS, buildFolioMcpServer, type McpActor } from './mcp.js';
import * as pageAccess from './pageAccess.js';
import * as storage from './storage.js';

async function withClient<T>(actor: McpActor, fn: (client: Client) => Promise<T>): Promise<T> {
  const server = buildFolioMcpServer(actor);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}
const call = (actor: McpActor, name: string, args: Record<string, unknown> = {}) => withClient(actor, (c) => c.callTool({ name, arguments: args }));
const text = (r: Awaited<ReturnType<typeof call>>): string => (r.content as Array<{ text?: string }>)[0]?.text ?? '';

describe('MCP team skills (real PG)', () => {
  let teardownSchema: () => Promise<void>;
  let member: User;
  let outsider: User;
  let slug: string;
  let dir: string;
  const ids: Record<string, string> = {};
  const as = (user: User): McpActor => ({ user, scopes: ['read'], tokenId: `skills-${user.id}` });

  const put = async (rel: string, body: string): Promise<void> => {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), body);
  };

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const stamp = Date.now();
    member = await authStore.createUser({ email: `skills-m-${stamp}@example.com`, name: 'Member', passwordHash: 'x', isAdmin: false });
    outsider = await authStore.createUser({ email: `skills-o-${stamp}@example.com`, name: 'Outsider', passwordHash: 'x', isAdmin: false });
    slug = (await storage.createSpace(`Skills ${stamp}`, member.id)).slug;
    await authStore.setMembership(slug, member.id, 'admin');
    dir = storage.getSpaceDir(slug);
    await put('release.md', '---\ntags: [skill]\ndescription: How we cut a release\n---\n# Release process\n\n1. Tag.\n2. Ship.\n');
    await put('plain.md', '---\ntags: [notes]\n---\n# Plain page\n\nNot a skill.\n');
    await put('secret-skill.md', '---\ntags: [skill]\ndescription: Closed\n---\n# Secret skill\n\nHidden.\n');
    await put('folio-content.md', '---\ntags: [skill]\n---\n# folio-content\n\nShadows a built-in skill.\n');
    await storage.scanSpace(slug);
    await storage.scanSpace(slug);
    for (const rel of ['release.md', 'plain.md', 'secret-skill.md']) {
      const id = await storage.getEntryIdByExactPath(slug, rel);
      if (!id) throw new Error(`no page ${rel}`);
      ids[rel] = id;
    }
    await authStore.setMembership(slug, outsider.id, 'viewer');
    await pageAccess.setAccess(member, (await storage.getEntry(ids['secret-skill.md']))!, 'restricted', []);
  });
  afterAll(async () => {
    await deleteTestSpace(slug);
    await teardownSchema();
  });

  it('list_skills lists only tagged pages the caller can read, with name, description, id and date; a built-in name is left out', async () => {
    const mine = (await call(as(member), 'list_skills')).structuredContent as { skills: Array<Record<string, string>> };
    expect(mine.skills.map((s) => s.name).sort()).toEqual(['Release process', 'Secret skill']);
    expect(mine.skills.find((s) => s.name === 'Release process')).toMatchObject({ description: 'How we cut a release', id: ids['release.md'], space: slug, updatedAt: expect.any(String) });
    const theirs = (await call(as(outsider), 'list_skills')).structuredContent as { skills: Array<Record<string, string>> };
    expect(theirs.skills.map((s) => s.name)).toEqual(['Release process']);
  });

  it('get_skill returns the text by name or id; refuses a page the caller cannot read and a plain page', async () => {
    const byName = await call(as(outsider), 'get_skill', { skill: 'release process' });
    expect(byName.isError).toBeFalsy();
    expect(byName.structuredContent).toMatchObject({ id: ids['release.md'], markdown: expect.stringContaining('2. Ship.') });
    expect((await call(as(outsider), 'get_skill', { skill: ids['release.md'] })).isError).toBeFalsy();
    for (const ref of [ids['secret-skill.md'], 'Secret skill', ids['plain.md'], 'folio-content']) {
      const r = await call(as(outsider), 'get_skill', { skill: ref });
      expect(r.isError, ref).toBe(true);
      expect(text(r)).not.toContain('Hidden');
    }
    expect((await call(as(member), 'get_skill', { skill: 'Secret skill' })).isError).toBeFalsy();
  });

  it('a page tagged after the server started shows up on the next call, in the tools and in the prompts', async () => {
    await put('late.md', '---\ntags: [skill]\ndescription: Added later\n---\n# Late skill\n\nBody.\n');
    await storage.scanSpace(slug);
    const list = (await call(as(member), 'list_skills')).structuredContent as { skills: Array<{ name: string }> };
    expect(list.skills.map((s) => s.name)).toContain('Late skill');
    const prompts = await withClient(as(member), (c) => c.listPrompts());
    expect(prompts.prompts.map((p) => p.name)).toContain('late-skill');
    const got = await withClient(as(member), (c) => c.getPrompt({ name: 'late-skill' }));
    expect(JSON.stringify(got.messages)).toContain('Body.');
    const hidden = await withClient(as(outsider), (c) => c.listPrompts());
    expect(hidden.prompts.map((p) => p.name)).not.toContain('secret-skill');
  });

  it('a public-site actor gets no skills, no prompts', async () => {
    await query(`UPDATE spaces SET visibility = 'public' WHERE slug = $1`, [slug]);
    try {
      const visitor = await authStore.findUserById(authStore.PUBLIC_VISITOR_USER_ID);
      const publicActor: McpActor = { user: visitor!, scopes: ['read'], tokenId: 'skills-public', publicSpace: slug };
      expect((await call(publicActor, 'list_skills')).isError).toBe(true);
      expect((await call(publicActor, 'get_skill', { skill: ids['release.md'] })).isError).toBe(true);
      expect((await withClient(publicActor, (c) => c.listPrompts())).prompts).toEqual([]);
    } finally {
      await query(`UPDATE spaces SET visibility = 'private' WHERE slug = $1`, [slug]);
    }
  });

  it('the instructions mention the tools and stay within the Claude Code limit', () => {
    expect(FOLIO_MCP_INSTRUCTIONS).toContain('list_skills');
    expect(FOLIO_MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(2048);
  });
});
