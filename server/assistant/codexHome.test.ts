/** The private directory, the lock and the environment of the Codex CLI: no network, no database, no real CLI. */
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCodexChildEnv, cleanupCodexRunRoot, createCodexRunDirs, parseChatgptAuthJson, withCodexAuth, withCodexUserLock, type CodexAuthStore } from './codexHome.js';

const jwt = (payload: object): string => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;
const chatgptAuth = (extra: object = {}): string => JSON.stringify({
  OPENAI_API_KEY: null,
  tokens: { id_token: jwt({ email: 'person@example.com' }), access_token: 'access-1', refresh_token: 'refresh-1', account_id: 'acc' },
  last_refresh: '2026-11-09T00:00:00Z',
  ...extra,
});

let base: string;
beforeEach(async () => { base = await mkdtemp(path.join(tmpdir(), 'codex-home-test-')); });
afterEach(async () => { await rm(base, { recursive: true, force: true }); });

function memoryStore(initial: string | null): CodexAuthStore & { value: string | null; saves: number } {
  const store = {
    value: initial,
    saves: 0,
    load: async () => store.value,
    save: async (json: string) => { if (store.value !== null) { store.value = json; store.saves += 1; } },
  };
  return store;
}

describe('parseChatgptAuthJson', () => {
  it('accepts ChatGPT tokens and reads the e-mail address of the account', () => {
    expect(parseChatgptAuthJson(chatgptAuth())).toEqual({ ok: true, email: 'person@example.com' });
  });

  it('rejects an auth.json that carries only an API key', () => {
    expect(parseChatgptAuthJson(JSON.stringify({ OPENAI_API_KEY: 'sk-test-not-real' })).ok).toBe(false);
    expect(parseChatgptAuthJson(JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test-not-real' })).ok).toBe(false);
    expect(parseChatgptAuthJson(chatgptAuth({ auth_mode: 'apikey' })).ok).toBe(false);
  });

  it('rejects things that are not an auth.json', () => {
    for (const raw of ['', 'nope', '[]', '{}', JSON.stringify({ tokens: { access_token: 'a' } })]) expect(parseChatgptAuthJson(raw).ok).toBe(false);
  });
});

describe('buildCodexChildEnv', () => {
  it('starts from nothing: none of the server\'s secrets reach the CLI', () => {
    const source = {
      PATH: '/usr/bin',
      LANG: 'C.UTF-8',
      HTTPS_PROXY: 'http://proxy:3128',
      DATABASE_URL: 'postgres://user:pass@db/folio',
      FOLIO_SECRET: 'folio-secret',
      CURSOR_API_KEY: 'cursor-key',
      ANTHROPIC_API_KEY: 'anthropic-key',
      MINIMAX_API_KEY: 'minimax-key',
      SENTRY_DSN: 'https://dsn',
      OPENAI_API_KEY: 'openai-key',
      CODEX_HOME: '/root/.codex',
      HOME: '/root',
    };
    const env = buildCodexChildEnv({ home: '/run/home', tmp: '/run/tmp' }, { FOLIO_RUN_MCP_TOKEN: 'run-token' }, source);
    expect(env).toEqual({
      PATH: '/usr/bin',
      LANG: 'C.UTF-8',
      HTTPS_PROXY: 'http://proxy:3128',
      HOME: '/run/home',
      CODEX_HOME: '/run/home',
      TMPDIR: '/run/tmp',
      FOLIO_RUN_MCP_TOKEN: 'run-token',
    });
    expect(JSON.stringify(env)).not.toMatch(/folio-secret|postgres|cursor-key|anthropic-key|minimax-key|openai-key|sentry/i);
  });

  it('gives the real process environment no way through', () => {
    process.env.FOLIO_SECRET = 'folio-secret-for-test';
    try {
      expect(Object.values(buildCodexChildEnv({ home: '/h', tmp: '/t' })).join('\n')).not.toContain('folio-secret-for-test');
    } finally {
      delete process.env.FOLIO_SECRET;
    }
  });
});

describe('withCodexAuth', () => {
  it('materialises auth.json privately, stores a refreshed copy and removes the directory', async () => {
    const store = memoryStore(chatgptAuth());
    let seenDir = '';
    await withCodexAuth('u1', store, async (dirs) => {
      seenDir = dirs.root;
      expect((await stat(dirs.root)).mode & 0o777).toBe(0o700);
      expect((await stat(dirs.home)).mode & 0o777).toBe(0o700);
      const file = path.join(dirs.home, 'auth.json');
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(await readFile(file, 'utf8')).toBe(chatgptAuth());
      expect(await readdir(dirs.work)).toEqual([]);
      // The CLI refreshes its tokens while it runs.
      await writeFile(file, chatgptAuth().replace('refresh-1', 'refresh-2'));
    }, { base });
    expect(store.value).toContain('refresh-2');
    expect(store.saves).toBe(1);
    await expect(stat(seenDir)).rejects.toThrow();
    expect(await readdir(base)).toEqual([]);
  });

  it('writes nothing back when nothing changed, and still cleans up when the work fails', async () => {
    const store = memoryStore(chatgptAuth());
    let seenDir = '';
    await expect(withCodexAuth('u1', store, async (dirs) => { seenDir = dirs.root; throw new Error('boom'); }, { base })).rejects.toThrow('boom');
    expect(store.saves).toBe(0);
    await expect(stat(seenDir)).rejects.toThrow();
  });

  it('refuses a missing sign-in and an API-key auth.json without creating anything', async () => {
    await expect(withCodexAuth('u1', memoryStore(null), async () => 1, { base })).rejects.toThrow(/not connected/);
    await expect(withCodexAuth('u1', memoryStore(JSON.stringify({ OPENAI_API_KEY: 'sk-x' })), async () => 1, { base })).rejects.toThrow(/not connected/);
    expect(await readdir(base)).toEqual([]);
  });

  it('does not store a write-back that is no longer a ChatGPT sign-in', async () => {
    const store = memoryStore(chatgptAuth());
    await withCodexAuth('u1', store, async (dirs) => { await writeFile(path.join(dirs.home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-x' })); }, { base });
    expect(store.saves).toBe(0);
  });

  it('serialises the runs of one user, so the second starts from the refreshed tokens', async () => {
    const store = memoryStore(chatgptAuth());
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = withCodexAuth('u1', store, async (dirs) => {
      order.push('first-start');
      await gate;
      await writeFile(path.join(dirs.home, 'auth.json'), chatgptAuth().replace('refresh-1', 'refresh-2'));
      order.push('first-end');
    }, { base });
    const second = withCodexAuth('u1', store, async (dirs) => {
      order.push(`second-sees-${(await readFile(path.join(dirs.home, 'auth.json'), 'utf8')).includes('refresh-2') ? 'refreshed' : 'stale'}`);
    }, { base });
    // Independent file-system calls of the two users finish in no fixed order: wait until the first run is really inside.
    await vi.waitFor(() => expect(order).toEqual(['first-start']));
    const other = withCodexAuth('u2', memoryStore(chatgptAuth()), async () => { order.push('other-user'); }, { base });
    await other;
    expect(order).toEqual(['first-start', 'other-user']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'other-user', 'first-end', 'second-sees-refreshed']);
  });
});

describe('withCodexUserLock', () => {
  it('lets a waiting caller give up when its signal aborts, without blocking the ones behind it', async () => {
    let release!: () => void;
    const holder = withCodexUserLock('u9', () => new Promise<void>((resolve) => { release = resolve; }));
    const controller = new AbortController();
    const waiting = withCodexUserLock('u9', async () => 'never', controller.signal);
    const behind = withCodexUserLock('u9', async () => 'behind');
    controller.abort();
    await expect(waiting).rejects.toThrow();
    release();
    await holder;
    await expect(behind).resolves.toBe('behind');
  });
});

describe('withCodexUserLock holder safety', () => {
  it('does not let a later caller in while the holder runs, even after the tail waiter aborted', async () => {
    let release!: () => void;
    let holderRunning = false;
    const holder = withCodexUserLock('u8', () => new Promise<void>((resolve) => { holderRunning = true; release = () => { holderRunning = false; resolve(); }; }));
    const controller = new AbortController();
    const waiting = withCodexUserLock('u8', async () => 'never', controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow();
    let enteredWhileHolding: boolean | null = null;
    const later = withCodexUserLock('u8', async () => { enteredWhileHolding = holderRunning; return 'later'; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(enteredWhileHolding).toBeNull();
    release();
    await holder;
    await expect(later).resolves.toBe('later');
    expect(enteredWhileHolding).toBe(false);
  });

  it('gives up with a clear message after the bounded wait, without touching the holder', async () => {
    let release!: () => void;
    const holder = withCodexUserLock('u7', () => new Promise<void>((resolve) => { release = resolve; }));
    await expect(withCodexUserLock('u7', async () => 'x', undefined, 20)).rejects.toThrow(/another codex request of yours is still running/i);
    release();
    await holder;
    await expect(withCodexUserLock('u7', async () => 'free')).resolves.toBe('free');
  });
});

describe('leftovers', () => {
  it('are removed at boot, auth.json included', async () => {
    const dirs = await createCodexRunDirs(base);
    await writeFile(path.join(dirs.home, 'auth.json'), chatgptAuth());
    await cleanupCodexRunRoot(base);
    await expect(stat(base)).rejects.toThrow();
  });
});
