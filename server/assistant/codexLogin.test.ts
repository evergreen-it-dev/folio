// Codex is off by default (providerFlags.ts); these tests are about it switched on. Read at call time.
process.env.FOLIO_CODEX_ENABLED = '1';
/** The device-code login against a scripted child process: no network, no real CLI. */
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelCodexLogin, getCodexLoginState, parseDeviceAuthOutput, safeCliText, shutdownCodexLogins, startCodexLogin, stripAnsi } from './codexLogin.js';

// The banner of `codex login --device-auth` 0.167.0, colour codes included.
const BANNER = [
  'Welcome to Codex [v\u001b[90m0.167.0\u001b[0m]',
  "\u001b[90mOpenAI's command-line coding agent\u001b[0m",
  '',
  'Follow these steps to sign in with ChatGPT using device code authorization:',
  '',
  '1. Open this link in your browser and sign in to your account',
  '   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m',
  '',
  '2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m',
  '   \u001b[94mAB12-CD345\u001b[0m',
  '',
].join('\n');

const chatgptAuth = JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: 'a.b.c', access_token: 'access', refresh_token: 'refresh' } });

describe('device output parsing', () => {
  it('finds the URL and the code through the colour codes', () => {
    expect(parseDeviceAuthOutput(BANNER)).toEqual({ url: 'https://auth.openai.com/codex/device', code: 'AB12-CD345' });
  });

  it('finds them when the output arrives in pieces', () => {
    expect(parseDeviceAuthOutput(BANNER.slice(0, 200))).toEqual({ url: undefined, code: undefined });
    expect(parseDeviceAuthOutput(BANNER.slice(0, 330)).url).toBe('https://auth.openai.com/codex/device');
  });

  it('strips colour and cursor codes, and hides tokens in an error text', () => {
    expect(stripAnsi('\u001b[1;31mred\u001b[0m \u001b[2K\u001b[1Gplain')).toBe('red plain');
    expect(safeCliText('\u001b[31mfailed\u001b[0m eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl and more')).toBe('failed [redacted] and more');
  });
});

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  kill: (signal?: string) => boolean;
}

function fakeSpawn(onStart: (child: FakeChild, options: { env: Record<string, string>; cwd: string }) => void): { spawnFn: typeof spawn; children: FakeChild[]; calls: Array<{ args: string[]; env: Record<string, string> }> } {
  const children: FakeChild[] = [];
  const calls: Array<{ args: string[]; env: Record<string, string> }> = [];
  const spawnFn = ((_binary: string, args: string[], options: { env: Record<string, string>; cwd: string }) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      killed: false,
      kill() { this.killed = true; return true; },
    }) as FakeChild;
    children.push(child);
    calls.push({ args, env: options.env });
    queueMicrotask(() => onStart(child, options));
    return child;
  }) as unknown as typeof spawn;
  return { spawnFn, children, calls };
}

let base: string;
beforeEach(async () => { base = await mkdtemp(path.join(tmpdir(), 'codex-login-test-')); });
afterEach(async () => {
  shutdownCodexLogins();
  await rm(base, { recursive: true, force: true });
});

describe('startCodexLogin', () => {
  it('returns the URL and code, passes the CLI nothing of the server\'s environment, and keeps one login per user', async () => {
    process.env.FOLIO_SECRET = 'folio-secret-for-test';
    process.env.DATABASE_URL = 'postgres://secret';
    try {
      const { spawnFn, children, calls } = fakeSpawn((child) => child.stdout.write(BANNER));
      const save = vi.fn();
      const state = await startCodexLogin('u1', { save, spawnFn, binary: '/fake/codex', base });
      expect(state).toMatchObject({ status: 'pending', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'AB12-CD345' });
      expect(Date.parse(state.expiresAt!)).toBeGreaterThan(Date.now());
      expect(calls[0]!.args).toEqual(['-c', 'cli_auth_credentials_store="file"', 'login', '--device-auth']);
      expect(Object.keys(calls[0]!.env).sort()).toEqual(['CODEX_HOME', 'HOME', 'PATH', 'TMPDIR'].filter((key) => key in calls[0]!.env).sort());
      expect(JSON.stringify(calls[0]!.env)).not.toMatch(/folio-secret-for-test|postgres/);
      expect(calls[0]!.env.HOME).toBe(calls[0]!.env.CODEX_HOME);

      // The same pending login again: no second process.
      expect(await startCodexLogin('u1', { save, spawnFn, binary: '/fake/codex', base })).toEqual(state);
      expect(children).toHaveLength(1);
      expect(getCodexLoginState('u1')).toEqual(state);
      expect(getCodexLoginState('u2')).toEqual({ status: 'idle' });
    } finally {
      delete process.env.FOLIO_SECRET;
      delete process.env.DATABASE_URL;
    }
  });

  it('stores the auth.json when the CLI succeeds, then removes the directory', async () => {
    const { spawnFn } = fakeSpawn(async (child, options) => {
      child.stdout.write(BANNER);
      await writeFile(path.join(options.env.CODEX_HOME!, 'auth.json'), chatgptAuth);
      child.emit('exit', 0);
    });
    const save = vi.fn(async () => undefined);
    const onConnected = vi.fn();
    const state = await startCodexLogin('u1', { save, onConnected, spawnFn, binary: '/fake/codex', base });
    expect(state.status).toBe('pending');
    await vi.waitFor(() => expect(getCodexLoginState('u1')).toEqual({ status: 'connected' }));
    expect(save).toHaveBeenCalledWith(chatgptAuth, null);
    expect(onConnected).toHaveBeenCalledTimes(1);
    await vi.waitFor(async () => expect(await readdir(base)).toEqual([]));
  });

  it('does not store an API-key auth.json', async () => {
    const { spawnFn } = fakeSpawn(async (child, options) => {
      child.stdout.write(BANNER);
      await writeFile(path.join(options.env.CODEX_HOME!, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-test-not-real' }));
      child.emit('exit', 0);
    });
    const save = vi.fn();
    await startCodexLogin('u1', { save, spawnFn, binary: '/fake/codex', base });
    await vi.waitFor(() => expect(getCodexLoginState('u1').status).toBe('failed'));
    expect(save).not.toHaveBeenCalled();
    expect(JSON.stringify(getCodexLoginState('u1'))).not.toContain('sk-test');
  });

  it('reports a failed CLI without colour codes', async () => {
    const { spawnFn } = fakeSpawn((child) => {
      child.stderr.write('\u001b[31mError: device code request failed\u001b[0m\n');
      child.emit('exit', 1);
    });
    const state = await startCodexLogin('u1', { save: vi.fn(), spawnFn, binary: '/fake/codex', base });
    expect(state).toEqual({ status: 'failed', error: 'Error: device code request failed' });
    await vi.waitFor(async () => expect(await readdir(base)).toEqual([]));
  });

  it('kills the child and removes everything on cancel', async () => {
    const { spawnFn, children } = fakeSpawn((child) => child.stdout.write(BANNER));
    await startCodexLogin('u1', { save: vi.fn(), spawnFn, binary: '/fake/codex', base });
    expect(await readdir(base)).toHaveLength(1);
    cancelCodexLogin('u1');
    expect(children[0]!.killed).toBe(true);
    expect(getCodexLoginState('u1')).toEqual({ status: 'idle' });
    await vi.waitFor(async () => expect(await readdir(base)).toEqual([]));
  });

  it('kills the child on shutdown', async () => {
    const { spawnFn, children } = fakeSpawn((child) => child.stdout.write(BANNER));
    await startCodexLogin('u1', { save: vi.fn(), spawnFn, binary: '/fake/codex', base });
    shutdownCodexLogins();
    expect(children[0]!.killed).toBe(true);
  });

  it('is unavailable without the binary', async () => {
    await expect(startCodexLogin('u1', { save: vi.fn(), binary: null, base })).rejects.toThrow(/not available/);
  });
});

describe('Codex switched off', () => {
  it('starts no child process for a login or a check', async () => {
    const spawnFn = vi.fn();
    delete process.env.FOLIO_CODEX_ENABLED;
    try {
      await expect(startCodexLogin('u-off', { binary: '/bin/codex', spawnFn: spawnFn as never, save: vi.fn(), onConnected: vi.fn() })).rejects.toThrow(/not enabled/);
      expect(spawnFn).not.toHaveBeenCalled();
    } finally {
      process.env.FOLIO_CODEX_ENABLED = '1';
    }
  });
});
