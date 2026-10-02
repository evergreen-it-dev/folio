/**
 * Security review F-05 — the assistant must not load another space's `.agent`
 * rules (or anything else keyed by a client-supplied `space`) for a user who
 * cannot read that space.
 *
 * The hole: POST /api/assistant/runs (and the compatibility POST
 * /chat/stream) took `space` from the request body and handed it to startRun;
 * preparing the conversation workspace then called buildAgentContext(space)
 * with no user and no membership check, so any signed-in user who knew a
 * private space's slug got that space's `.agent` pages written into their own
 * conversation workspace and sent to the model provider.
 *
 * Everything below runs against real PostgreSQL, the real routes, the real
 * RunManager and the real workspace code. Only the Cursor SDK (`@cursor/sdk`)
 * is mocked, so "the provider was never called" is a plain assertion on the
 * mock, and no API key or network is ever involved.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../../shared/contracts.js';

// --- Mocks (hoisted above the imports below) ---------------------------------

const sdkMock = vi.hoisted(() => {
  const prompts: string[] = [];
  const run = {
    supports: () => false,
    wait: async () => ({ status: 'finished', result: 'Stub reply' }),
    cancel: async () => {},
  };
  const agent = {
    reload: async () => {},
    send: vi.fn(async (prompt: string) => {
      prompts.push(prompt);
      return run;
    }),
    close: async () => {},
  };
  return {
    prompts,
    send: agent.send,
    resume: vi.fn(async () => agent),
    create: vi.fn(async () => agent),
    configure: vi.fn(),
  };
});

vi.mock('@cursor/sdk', () => ({
  Cursor: { configure: sdkMock.configure },
  JsonlLocalAgentStore: class {},
  Agent: { resume: sdkMock.resume, create: sdkMock.create },
}));

// Writes ~/.cursor/cli-config.json — must never run from a test.
vi.mock('./cursorCliConfig.js', () => ({ ensureAssistantCursorPermissions: vi.fn() }));

// The real buildAgentContext, wrapped so a test can see whether it was reached.
vi.mock('./agentContext.js', async (importActual) => {
  const actual = await importActual<typeof import('./agentContext.js')>();
  return { ...actual, buildAgentContext: vi.fn(actual.buildAgentContext) };
});

// cursorRuntime.ts gates on Node >= 22.13 (what the real SDK needs). The SDK is mocked here, so on an older
// Node the version is faked for the duration of this file; the real runtime code (workspace, prompt) still runs.
const realNodeVersions = process.versions;
{
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    Object.defineProperty(process, 'versions', { value: { ...process.versions, node: '22.13.0' }, configurable: true });
  }
}

const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-assistant-ws-'));
const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-assistant-state-'));
process.env.CURSOR_AGENT_WORKSPACE_ROOT = workspaceRoot;
process.env.CURSOR_AGENT_STATE_DIR = stateDir;
// An operator key placeholder so the routes get past "connect a Cursor key"; the SDK is a mock, nothing ever sees it.
process.env.CURSOR_API_KEY = 'placeholder-operator-key';

const { setUpTestSchema, deleteTestSpace } = await import('../db/testSchema.js');
const authStore = await import('../auth/store.js');
const storage = await import('../storage.js');
const session = await import('../auth/session.js');
const pageAccess = await import('../pageAccess.js');
const { HttpError } = await import('../errors.js');
const assistantStore = await import('./store.js');
const runs = await import('./runs.js');
const agentContext = await import('./agentContext.js');
const workspace = await import('./workspace.js');
const { registerAssistantRoutes } = await import('./routes.js');

const buildAgentContextSpy = vi.mocked(agentContext.buildAgentContext);

// --- Helpers -----------------------------------------------------------------

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('authUser', null);
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
  });
  await app.register(fastifyCookieModule.default);
  await app.register(async (protectedScope) => {
    protectedScope.addHook('onRequest', session.requireSession);
    registerAssistantRoutes(protectedScope);
  });
  await app.ready();
  return app;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForRunDone(runId: string): Promise<void> {
  await waitUntil(() => runs.peek(runId)?.status === 'done');
}

/** True when any file under `dir` (recursively) contains `needle`. */
async function treeContains(dir: string, needle: string): Promise<boolean> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (await treeContains(full, needle)) return true;
    } else if ((await fs.readFile(full, 'utf8').catch(() => '')).includes(needle)) {
      return true;
    }
  }
  return false;
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true, () => false);
}

/** Everything the provider has been asked so far, joined — what "sent to the provider" means here. */
const allPrompts = (): string => sdkMock.prompts.join('\n=====\n');

describe('F-05: the assistant authorizes the client-supplied space before it loads anything (real PG, fastify inject, mocked Cursor SDK)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  const stamp = Date.now();

  // Space A: alice's. Space B: private, bob's, has .agent rules. Space C: visible to the whole instance.
  let alice: User;
  let bob: User;
  let vic: User;
  let eve: User;
  let aliceCookie: string;
  let bobCookie: string;
  let vicCookie: string;
  let eveCookie: string;
  let slugA: string;
  let slugB: string;
  let slugC: string;
  let pageInA: string;
  let pageInB: string;

  const markerA = `RULES-MARKER-A-${stamp}`;
  const markerB = `RULES-MARKER-B-${stamp}`;
  const markerBRestricted = `RULES-MARKER-B-RESTRICTED-${stamp}`;
  const markerC = `RULES-MARKER-C-${stamp}`;
  const createdSpaces: string[] = [];

  const cookieFor = async (user: User): Promise<string> => `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(user.id)).token}`;

  function postRun(cookie: string, body: Record<string, unknown>, url = '/api/assistant/runs') {
    return app.inject({ method: 'POST', url, payload: { message: 'What are the rules here?', runMode: 'ask', startNew: true, ...body }, headers: { cookie } });
  }

  async function addAgentRule(space: string, title: string, body: string) {
    return storage.createPage({ space, parentPath: '.agent', title, kind: 'doc' }, { docBody: body });
  }

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();

    const mk = (name: string) => authStore.createUser({ email: `f05-${name}-${stamp}@test.local`, name, passwordHash: 'x', isAdmin: false });
    [alice, bob, vic, eve] = await Promise.all([mk('alice'), mk('bob'), mk('vic'), mk('eve')]);
    [aliceCookie, bobCookie, vicCookie, eveCookie] = await Promise.all([cookieFor(alice), cookieFor(bob), cookieFor(vic), cookieFor(eve)]);

    const spaceA = await storage.createSpace(`F05 Alpha ${stamp}`, alice.id);
    const spaceB = await storage.createSpace(`F05 Bravo ${stamp}`, bob.id);
    const spaceC = await storage.createSpace(`F05 Common ${stamp}`, bob.id);
    [slugA, slugB, slugC] = [spaceA.slug, spaceB.slug, spaceC.slug];
    createdSpaces.push(slugA, slugB, slugC);

    await authStore.setMembership(slugA, alice.id, 'editor');
    await authStore.setMembership(slugB, bob.id, 'admin');
    await authStore.setMembership(slugB, vic.id, 'viewer');
    await authStore.setMembership(slugC, bob.id, 'admin');
    await authStore.setSpaceVisibility(slugC, 'instance');

    pageInA = (await storage.createPage({ space: slugA, parentPath: '', title: 'Alpha notes', kind: 'doc' })).id;
    pageInB = (await storage.createPage({ space: slugB, parentPath: '', title: 'Bravo notes', kind: 'doc' })).id;
    await addAgentRule(slugA, 'Tone', `Be brief. ${markerA}`);
    await addAgentRule(slugB, 'Tone', `Never mention the budget. ${markerB}`);
    await addAgentRule(slugC, 'Tone', `Answer in plain words. ${markerC}`);

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    for (const slug of createdSpaces) await deleteTestSpace(slug).catch(() => {});
    await teardownSchema();
    delete process.env.CURSOR_API_KEY;
    Object.defineProperty(process, 'versions', { value: realNodeVersions, configurable: true });
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(() => {
    buildAgentContextSpy.mockClear();
    sdkMock.send.mockClear();
    sdkMock.resume.mockClear();
    sdkMock.create.mockClear();
    sdkMock.configure.mockClear();
    sdkMock.prompts.length = 0;
  });

  /** The directory under which every workspace of one user lives (resolveConversationWorkspace = <root>/<hash(user)>/<hash(conversation)>). */
  const userWorkspaceDir = (user: User): string => path.dirname(workspace.resolveConversationWorkspace(user.id, 'any'));
  const conversationCount = async (user: User): Promise<number> => (await assistantStore.listConversations(user.id, 100)).length;
  const snapshot = async (user: User) => ({ conversations: await conversationCount(user), hadWorkspaceDir: await exists(userWorkspaceDir(user)) });

  /** The whole "nothing happened" contract for a refused request, against a snapshot taken before it. */
  async function expectNothingStarted(user: User, secretMarker: string, before: Awaited<ReturnType<typeof snapshot>>) {
    expect(buildAgentContextSpy).not.toHaveBeenCalled();
    expect(sdkMock.send).not.toHaveBeenCalled();
    expect(sdkMock.resume).not.toHaveBeenCalled();
    expect(sdkMock.create).not.toHaveBeenCalled();
    expect(await treeContains(userWorkspaceDir(user), secretMarker)).toBe(false);
    expect(await exists(userWorkspaceDir(user))).toBe(before.hadWorkspaceDir);
    expect(await conversationCount(user)).toBe(before.conversations);
    expect(runs.getActiveRunForUser(user.id)).toBeNull();
  }

  // -------------------------------------------------------------------------
  // The exploit, on both entry points
  // -------------------------------------------------------------------------

  it('POST /runs: a member of space A only cannot start a run in private space B — refused before B is read, before any workspace, before the provider', async () => {
    const before = await snapshot(alice);
    const res = await postRun(aliceCookie, { space: slugB });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'space not found' });
    await expectNothingStarted(alice, markerB, before);
  });

  it('POST /chat/stream (compatibility route): same refusal, same nothing-started contract', async () => {
    const before = await snapshot(alice);
    const res = await postRun(aliceCookie, { space: slugB }, '/api/assistant/chat/stream');

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'space not found' });
    await expectNothingStarted(alice, markerB, before);
  });

  it('the refusal is identical for a private space and for a slug that does not exist (no existence oracle)', async () => {
    const privateRes = await postRun(aliceCookie, { space: slugB });
    const missingRes = await postRun(aliceCookie, { space: `no-such-space-${stamp}` });

    expect(privateRes.statusCode).toBe(missingRes.statusCode);
    expect(privateRes.json()).toEqual(missingRes.json());
    expect(privateRes.statusCode).toBe(404);
  });

  it('an explicit conversationId does not get around the check: continuing a conversation of A with space B is refused and leaves the conversation untouched', async () => {
    const first = await postRun(aliceCookie, { space: slugA });
    expect(first.statusCode).toBe(202);
    const { conversationId, runId } = first.json() as { conversationId: string; runId: string };
    await waitForRunDone(runId);
    const messagesBefore = (await assistantStore.listMessages(conversationId)).length;
    buildAgentContextSpy.mockClear();
    sdkMock.send.mockClear();

    for (const url of ['/api/assistant/runs', '/api/assistant/chat/stream']) {
      const res = await postRun(aliceCookie, { space: slugB, conversationId, startNew: false }, url);
      expect(res.statusCode, url).toBe(404);
    }

    expect(buildAgentContextSpy).not.toHaveBeenCalled();
    expect(sdkMock.send).not.toHaveBeenCalled();
    expect((await assistantStore.listMessages(conversationId)).length).toBe(messagesBefore);
    expect(runs.getActiveRunForConversation(conversationId)).toBeNull();
    expect(await treeContains(workspaceRoot, markerB)).toBe(false);
  });

  it('a space revoked after the conversation began: the next request is refused, and a later run elsewhere rewrites the rules file (no stale rules reach the model)', async () => {
    const dana = await authStore.createUser({ email: `f05-dana-${stamp}@test.local`, name: 'Dana', passwordHash: 'x', isAdmin: false });
    const danaCookie = await cookieFor(dana);
    await authStore.setMembership(slugB, dana.id, 'viewer');

    const first = await postRun(danaCookie, { space: slugB });
    expect(first.statusCode).toBe(202);
    const { conversationId, runId } = first.json() as { conversationId: string; runId: string };
    await waitForRunDone(runId);
    const rulesFile = path.join(workspace.resolveConversationWorkspace(dana.id, conversationId), '.folio', 'context', 'agent-rules.md');
    expect(await fs.readFile(rulesFile, 'utf8')).toContain(markerB);

    await authStore.removeMembership(slugB, dana.id);
    sdkMock.prompts.length = 0;
    sdkMock.send.mockClear();
    buildAgentContextSpy.mockClear();

    const refused = await postRun(danaCookie, { space: slugB, conversationId, startNew: false });
    expect(refused.statusCode).toBe(404);
    expect(sdkMock.send).not.toHaveBeenCalled();

    // Same conversation, a space she has no rules in at all: the file is rewritten, B's text is gone.
    const again = await postRun(danaCookie, { space: null, conversationId, startNew: false });
    expect(again.statusCode).toBe(202);
    await waitForRunDone((again.json() as { runId: string }).runId);
    expect(await fs.readFile(rulesFile, 'utf8')).not.toContain(markerB);
    expect(allPrompts()).not.toContain(markerB);
  });

  // -------------------------------------------------------------------------
  // What must keep working
  // -------------------------------------------------------------------------

  it('a member of B still gets B\'s rules — in the model request and in the conversation workspace', async () => {
    const res = await postRun(bobCookie, { space: slugB });
    expect(res.statusCode).toBe(202);
    const { conversationId, runId } = res.json() as { conversationId: string; runId: string };
    await waitForRunDone(runId);

    expect(sdkMock.prompts).toHaveLength(1);
    expect(sdkMock.prompts[0]).toContain(markerB);
    expect(sdkMock.prompts[0]).not.toContain(markerA);
    const rulesFile = path.join(workspace.resolveConversationWorkspace(bob.id, conversationId), '.folio', 'context', 'agent-rules.md');
    expect(await fs.readFile(rulesFile, 'utf8')).toContain(markerB);
  });

  it('a member of A gets A\'s rules and nothing from B (also through the compatibility route)', async () => {
    const res = await postRun(aliceCookie, { space: slugA }, '/api/assistant/chat/stream');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"type":"complete"');

    expect(sdkMock.prompts).toHaveLength(1);
    expect(sdkMock.prompts[0]).toContain(markerA);
    expect(allPrompts()).not.toContain(markerB);
  });

  it('a request without a space still works and carries no rules', async () => {
    const res = await postRun(aliceCookie, {});
    expect(res.statusCode).toBe(202);
    await waitForRunDone((res.json() as { runId: string }).runId);

    expect(sdkMock.prompts).toHaveLength(1);
    expect(allPrompts()).not.toContain(markerA);
    expect(allPrompts()).not.toContain(markerB);
    expect(allPrompts()).not.toContain(markerC);
  });

  it('an instance-visible space works for a non-member exactly as the access model says (implicit viewer): its rules load; a private space still does not', async () => {
    // eve has no membership anywhere.
    expect(await session.effectiveRole(eve, slugC)).toBe('viewer');
    expect(await session.effectiveRole(eve, slugB)).toBeUndefined();

    const ok = await postRun(eveCookie, { space: slugC });
    expect(ok.statusCode).toBe(202);
    await waitForRunDone((ok.json() as { runId: string }).runId);
    expect(allPrompts()).toContain(markerC);

    buildAgentContextSpy.mockClear();
    const denied = await postRun(eveCookie, { space: slugB });
    expect(denied.statusCode).toBe(404);
    expect(buildAgentContextSpy.mock.calls.flat()).not.toContain(slugB);
    expect(allPrompts()).not.toContain(markerB);

    // Visibility flips back to private: the very same request is now refused.
    await authStore.setSpaceVisibility(slugC, 'private');
    try {
      const after = await postRun(eveCookie, { space: slugC });
      expect(after.statusCode).toBe(404);
    } finally {
      await authStore.setSpaceVisibility(slugC, 'instance');
    }
  });

  it('a disabled user gets nothing, not even from an instance-visible space', async () => {
    const gone = await authStore.createUser({ email: `f05-gone-${stamp}@test.local`, name: 'Gone', passwordHash: 'x', isAdmin: false });
    await authStore.setMembership(slugB, gone.id, 'viewer');
    await expect(agentContext.buildAgentContext({ ...gone, disabled: true }, slugB, 'http://localhost')).rejects.toMatchObject({ status: 404 });
    await expect(agentContext.buildAgentContext({ ...gone, disabled: true }, slugC, 'http://localhost')).rejects.toMatchObject({ status: 404 });
  });

  // -------------------------------------------------------------------------
  // pageId must belong to the space
  // -------------------------------------------------------------------------

  it('a pageId from another space is refused, whether the space is one the caller can read or not', async () => {
    const before = await snapshot(alice);
    const mismatch = await postRun(aliceCookie, { space: slugA, pageId: pageInB });
    expect(mismatch.statusCode).toBe(404);
    expect(mismatch.json()).toEqual({ error: 'page not found' });

    const viaOtherSpace = await postRun(aliceCookie, { space: slugB, pageId: pageInB });
    expect(viaOtherSpace.statusCode).toBe(404);
    expect(viaOtherSpace.json()).toEqual({ error: 'space not found' });

    const compat = await postRun(aliceCookie, { space: slugA, pageId: pageInB }, '/api/assistant/chat/stream');
    expect(compat.statusCode).toBe(404);

    expect(buildAgentContextSpy).not.toHaveBeenCalled();
    expect(sdkMock.send).not.toHaveBeenCalled();
    expect(await treeContains(userWorkspaceDir(alice), markerB)).toBe(false);
    expect(await snapshot(alice)).toEqual(before);
  });

  it('an unknown pageId and a pageId without a space are refused too; a pageId that belongs to the space is fine', async () => {
    const unknown = await postRun(aliceCookie, { space: slugA, pageId: '00000000-0000-4000-8000-000000000000' });
    expect(unknown.statusCode).toBe(404);

    const noSpace = await postRun(aliceCookie, { pageId: pageInA });
    expect(noSpace.statusCode).toBe(400);

    expect(sdkMock.send).not.toHaveBeenCalled();

    const fine = await postRun(aliceCookie, { space: slugA, pageId: pageInA });
    expect(fine.statusCode).toBe(202);
    await waitForRunDone((fine.json() as { runId: string }).runId);
    expect(sdkMock.prompts[0]).toContain(pageInA);
  });

  // -------------------------------------------------------------------------
  // The layers below the routes enforce it on their own (a future caller cannot skip the route check)
  // -------------------------------------------------------------------------

  it('startRun itself refuses an unauthorized space: no message, no run row, no provider call', async () => {
    const conversation = await assistantStore.insertConversation({ userId: alice.id, title: 'direct', cursorAgentId: `agent-direct-${stamp}`, model: 'auto' });

    await expect(
      runs.startRun({ user: alice, conversation, message: 'hello', runMode: 'ask', currentPath: null, space: slugB, pageId: null, apiKey: 'placeholder' }),
    ).rejects.toMatchObject({ status: 404 });

    expect(await assistantStore.listMessages(conversation.id)).toEqual([]);
    expect(runs.getActiveRunForConversation(conversation.id)).toBeNull();
    expect(sdkMock.send).not.toHaveBeenCalled();
    expect(buildAgentContextSpy).not.toHaveBeenCalled();
  });

  it('prepareAssistantWorkspace refuses an unauthorized space before it creates the workspace directory', async () => {
    const conversationId = `conv-direct-${stamp}`;
    const root = workspace.resolveConversationWorkspace(alice.id, conversationId);

    await expect(
      workspace.prepareAssistantWorkspace({ user: alice, conversationId, runMode: 'ask', currentPath: '/s/x', space: slugB, pageId: null }),
    ).rejects.toMatchObject({ status: 404 });

    expect(await exists(root)).toBe(false);
    expect(buildAgentContextSpy).not.toHaveBeenCalled();
  });

  it('buildAgentContext requires the user: a non-member is refused (404) before any page of the space is rendered; a member gets the rules', async () => {
    const listSpy = vi.spyOn(storage, 'listEntries');
    try {
      await expect(agentContext.buildAgentContext(alice, slugB, 'http://localhost')).rejects.toMatchObject({ status: 404 });
      expect(listSpy).not.toHaveBeenCalled();

      const built = await agentContext.buildAgentContext(bob, slugB, 'http://localhost');
      expect(listSpy).toHaveBeenCalledWith(slugB); // the spy does see a real read, so the "not called" above means something
      expect(built.blob).toContain(markerB);
      expect(built.pagesUsed).toBeGreaterThan(0);
    } finally {
      listSpy.mockRestore();
    }
  });

  // -------------------------------------------------------------------------
  // Page-level access on individual .agent pages
  // -------------------------------------------------------------------------

  it('an .agent page restricted by page-level access is skipped for users it is hidden from; the space\'s other rules still reach every member (by design)', async () => {
    const restricted = await addAgentRule(slugB, 'Restricted', `Board-only guidance. ${markerBRestricted}`);
    const entry = await storage.requireEntry(restricted.id);
    await pageAccess.setAccess(bob, entry, 'restricted', []);

    // The assistant is the one place non-admin members see .agent text (docs/FEATURES.md §10: rules are mixed into every run
    // of the space), so vic — a plain viewer of B, who cannot open any .agent page — still gets the general rules...
    const viewerCtx = await agentContext.buildAgentContext(vic, slugB, 'http://localhost');
    expect(viewerCtx.blob).toContain(markerB);
    // ...but not the page that page-level access hides from her.
    expect(viewerCtx.blob).not.toContain(markerBRestricted);

    // Its owner (and anyone granted) does get it.
    const ownerCtx = await agentContext.buildAgentContext(bob, slugB, 'http://localhost');
    expect(ownerCtx.blob).toContain(markerBRestricted);
    expect(ownerCtx.blob).toContain(markerB);

    // End to end through the route as the viewer: nothing of the restricted page reaches the provider or the workspace.
    const res = await postRun(vicCookie, { space: slugB });
    expect(res.statusCode).toBe(202);
    await waitForRunDone((res.json() as { runId: string }).runId);
    expect(allPrompts()).toContain(markerB);
    expect(allPrompts()).not.toContain(markerBRestricted);
    expect(await treeContains(workspaceRoot, markerBRestricted)).toBe(false);
  });
});
