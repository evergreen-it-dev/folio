/**
 * Everything about the Codex CLI that is not the run itself: where its native
 * binary is, the private directory a run or a login works in, and the explicit
 * environment its child process gets.
 *
 * The content of `auth.json` (the ChatGPT tokens of one user) is the secret.
 * It lives encrypted in assistant_provider_credentials and exists on disk only
 * while a run or a login needs it: in a private directory (0700) under
 * data/assistant/codex-run, which is removed afterwards and at server boot.
 * The CLI refreshes its tokens while it runs, so the file is read back and
 * stored again before the directory goes. One lock per user serialises the
 * runs of one person: a refresh token is single-use, and a run that started
 * from a stale copy would lose the refreshed one.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { REPOS_DIR } from '../storage.js';
import { codexEnabled } from './providerFlags.js';

const DATA_DIR = path.dirname(REPOS_DIR);
export const CODEX_RUN_ROOT = path.join(DATA_DIR, 'assistant', 'codex-run');

const AUTH_FILE = 'auth.json';
const AUTH_JSON_MAX_BYTES = 64 * 1024;

/** Name of the variable that carries the per-run MCP bearer token to the CLI (`bearer_token_env_var`). */
export const RUN_MCP_TOKEN_ENV = 'FOLIO_RUN_MCP_TOKEN';

/** The only variables copied from the server's environment into the CLI's: where to find programs, the time zone and the operator's network setup. */
const ENV_PASSTHROUGH = [
  'PATH', 'LANG', 'LC_ALL', 'TZ',
  'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'https_proxy', 'http_proxy', 'no_proxy', 'all_proxy',
] as const;

export class CodexNotConnectedError extends Error {
  constructor() {
    super('Codex is not connected: sign in with your ChatGPT account in the assistant settings');
    this.name = 'CodexNotConnectedError';
  }
}

// ---------- the native binary ----------

const PLATFORM_TARGETS: Record<string, string> = {
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
};

let cachedBinary: string | null | undefined;

/** Absolute path of the Codex native binary of this platform (from the @openai/codex-<platform> package), or null when it is not installed. */
export function resolveCodexBinary(): string | null {
  if (cachedBinary !== undefined) return cachedBinary;
  cachedBinary = null;
  const key = `${process.platform}-${process.arch}`;
  const target = PLATFORM_TARGETS[key];
  if (!target) return cachedBinary;
  try {
    const codexRequire = createRequire(createRequire(import.meta.url).resolve('@openai/codex/package.json'));
    const vendor = path.join(path.dirname(codexRequire.resolve(`@openai/codex-${key}/package.json`)), 'vendor');
    const binary = path.join(vendor, target, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
    if (existsSync(binary)) cachedBinary = binary;
  } catch {
    // not installed: unavailable
  }
  return cachedBinary;
}

/** Can this server run Codex at all (is the native binary of its platform installed)? */
export function codexRuntimeAvailable(): boolean {
  return resolveCodexBinary() !== null;
}

// ---------- auth.json ----------

export type ParsedAuthJson = { ok: true; email: string | null } | { ok: false; reason: string };

function jwtEmail(idToken: unknown): string | null {
  if (typeof idToken !== 'string') return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as { email?: unknown };
    return typeof payload.email === 'string' && payload.email.length <= 200 ? payload.email : null;
  } catch {
    return null;
  }
}

/** Only a ChatGPT sign-in is accepted: an auth.json that carries just an API key is a different (pay-per-token) product. */
export function parseChatgptAuthJson(raw: string): ParsedAuthJson {
  if (!raw.trim() || Buffer.byteLength(raw) > AUTH_JSON_MAX_BYTES) return { ok: false, reason: 'not an auth.json' };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'not an auth.json' };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return { ok: false, reason: 'not an auth.json' };
  const record = data as { auth_mode?: unknown; tokens?: { access_token?: unknown; refresh_token?: unknown; id_token?: unknown } | null };
  if (typeof record.auth_mode === 'string' && record.auth_mode.toLowerCase().includes('api')) return { ok: false, reason: 'an API key sign-in, not a ChatGPT account' };
  const tokens = record.tokens;
  if (typeof tokens !== 'object' || tokens === null || typeof tokens.access_token !== 'string' || !tokens.access_token || typeof tokens.refresh_token !== 'string' || !tokens.refresh_token) {
    return { ok: false, reason: 'no ChatGPT sign-in in it' };
  }
  return { ok: true, email: jwtEmail(tokens.id_token) };
}

// ---------- the CLI's environment ----------

/**
 * The environment of every Codex child process, built from scratch: the CLI
 * must not see DATABASE_URL, FOLIO_SECRET, provider keys or anything else the
 * server was started with. HOME and CODEX_HOME are the private directory.
 */
export function buildCodexChildEnv(dirs: Pick<CodexRunDirs, 'home' | 'tmp'>, extra: Record<string, string> = {}, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ENV_PASSTHROUGH) {
    const value = source[name];
    if (value) env[name] = value;
  }
  env.PATH ??= '/usr/local/bin:/usr/bin:/bin';
  env.HOME = dirs.home;
  env.CODEX_HOME = dirs.home;
  env.TMPDIR = dirs.tmp;
  return { ...env, ...extra };
}

/** Config for every CLI invocation: credentials in the file of CODEX_HOME (never the OS keyring), and nothing but what a run asks for. */
export const CODEX_BASE_CONFIG = { cli_auth_credentials_store: 'file' } as const;

// ---------- private directories ----------

export interface CodexRunDirs {
  /** The run's own directory; everything below is removed with it. */
  root: string;
  /** CODEX_HOME and HOME: holds auth.json while the run lasts. */
  home: string;
  /** An empty working directory: the only place the model's "current directory" points at. */
  work: string;
  tmp: string;
}

export async function createCodexRunDirs(base: string = CODEX_RUN_ROOT): Promise<CodexRunDirs> {
  await mkdir(base, { recursive: true, mode: 0o700 });
  await chmod(base, 0o700);
  const root = await mkdtemp(path.join(base, 'run-'));
  await chmod(root, 0o700);
  const dirs: CodexRunDirs = { root, home: path.join(root, 'home'), work: path.join(root, 'work'), tmp: path.join(root, 'tmp') };
  await Promise.all([dirs.home, dirs.work, dirs.tmp].map((dir) => mkdir(dir, { mode: 0o700 })));
  return dirs;
}

export async function removeCodexRunDirs(dirs: Pick<CodexRunDirs, 'root'>): Promise<void> {
  await rm(dirs.root, { recursive: true, force: true }).catch(() => undefined);
}

/** At server boot: a directory left behind by a crash may still hold an auth.json. */
export async function cleanupCodexRunRoot(base: string = CODEX_RUN_ROOT): Promise<void> {
  await rm(base, { recursive: true, force: true }).catch((error) => {
    console.warn('[codex] could not remove leftover run directories:', error instanceof Error ? error.message : error);
  });
}

export async function writeAuthJson(dirs: Pick<CodexRunDirs, 'home'>, content: string): Promise<void> {
  await writeFile(path.join(dirs.home, AUTH_FILE), content, { mode: 0o600 });
}

export async function readAuthJson(dirs: Pick<CodexRunDirs, 'home'>): Promise<string | null> {
  try {
    return await readFile(path.join(dirs.home, AUTH_FILE), 'utf8');
  } catch {
    return null;
  }
}

// ---------- one lock per user ----------

/** How long a run waits for an earlier Codex request of the same user before it gives up. */
export const CODEX_LOCK_WAIT_MS = 120_000;

export class CodexBusyError extends Error {
  constructor() {
    super('Another Codex request of yours is still running. Wait for it to finish and try again.');
    this.name = 'CodexBusyError';
  }
}

interface UserLock {
  /** Callers waiting for the holder, in order; each one is woken by handing the lock over. */
  waiters: Array<() => void>;
}

/** An entry exists exactly while someone holds the lock for that user. */
const userLocks = new Map<string, UserLock>();

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('aborted');
}

async function acquireUserLock(userId: string, signal: AbortSignal | undefined, maxWaitMs: number): Promise<void> {
  if (signal?.aborted) throw abortError(signal);
  const lock = userLocks.get(userId);
  if (!lock) {
    userLocks.set(userId, { waiters: [] });
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    // Leaving the queue never touches the holder or the lock entry: only this waiter's own slot goes away.
    const leave = (error: Error): void => {
      const index = lock.waiters.indexOf(wake);
      if (index === -1) return;
      lock.waiters.splice(index, 1);
      cleanup();
      reject(error);
    };
    const onAbort = (): void => leave(abortError(signal!));
    const wake = (): void => { cleanup(); resolve(); };
    const timer = setTimeout(() => leave(new CodexBusyError()), maxWaitMs);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    lock.waiters.push(wake);
  });
}

function releaseUserLock(userId: string): void {
  const lock = userLocks.get(userId);
  if (!lock) return;
  const next = lock.waiters.shift();
  // Hand the lock straight to the next waiter (the entry stays), or forget it when nobody is waiting.
  if (next) next();
  else userLocks.delete(userId);
}

/**
 * Runs `work` once every earlier holder for this user has finished. A waiting caller stops waiting when
 * `signal` aborts or after `maxWaitMs` (CodexBusyError); either way it leaves the queue without releasing
 * a lock it never held.
 */
export async function withCodexUserLock<T>(userId: string, work: () => Promise<T>, signal?: AbortSignal, maxWaitMs = CODEX_LOCK_WAIT_MS): Promise<T> {
  await acquireUserLock(userId, signal, maxWaitMs);
  try {
    return await work();
  } finally {
    releaseUserLock(userId);
  }
}

// ---------- shutdown ----------

const shutdownController = new AbortController();
const inFlightAuths = new Set<Promise<unknown>>();

/** Aborts when the server is shutting down; a Codex run combines it with its own signals. */
export const codexShutdownSignal: AbortSignal = shutdownController.signal;

/** Server shutdown: stops every Codex run, then waits (at most `capMs`) for the write-back and the cleanup of their directories. */
export async function shutdownCodexRuns(capMs = 5_000): Promise<void> {
  shutdownController.abort(new Error('The server is shutting down'));
  if (inFlightAuths.size === 0) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.allSettled([...inFlightAuths]),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, capMs); }),
  ]);
  clearTimeout(timer);
}

export interface CodexAuthStore {
  /** The user's current auth.json (decrypted) or null. Read inside the lock, so a refresh by an earlier run is seen. */
  load: () => Promise<string | null>;
  /** Stores a changed auth.json. Must do nothing when the credential was removed in the meantime. */
  save: (authJson: string) => Promise<void>;
}

/**
 * Materialises the user's auth.json in a private directory for `work`, then
 * stores whatever the CLI refreshed in it and removes the directory, whatever
 * `work` did. Serialised per user.
 */
export async function withCodexAuth<T>(
  userId: string,
  store: CodexAuthStore,
  work: (dirs: CodexRunDirs) => Promise<T>,
  options: { signal?: AbortSignal; base?: string; maxWaitMs?: number } = {},
): Promise<T> {
  const finished = withCodexUserLock(userId, async () => {
    const authJson = await store.load();
    if (!authJson) throw new CodexNotConnectedError();
    if (!parseChatgptAuthJson(authJson).ok) throw new CodexNotConnectedError();
    const dirs = await createCodexRunDirs(options.base);
    try {
      await writeAuthJson(dirs, authJson);
      return await work(dirs);
    } finally {
      try {
        const after = await readAuthJson(dirs);
        if (after !== null && after.trim() !== authJson.trim() && parseChatgptAuthJson(after).ok) await store.save(after);
      } catch (error) {
        // Never the content: only that the write-back failed.
        console.warn('[codex] could not store the refreshed sign-in:', error instanceof Error ? error.name : 'error');
      }
      await removeCodexRunDirs(dirs);
    }
  }, options.signal, options.maxWaitMs);
  inFlightAuths.add(finished);
  const forget = (): void => { inFlightAuths.delete(finished); };
  finished.then(forget, forget);
  return finished;
}

// ---------- short CLI commands ----------

export interface CodexCommandResult {
  code: number | null;
  output: string;
}

/** Runs `codex <args>` to the end in a prepared private directory with the explicit environment, collecting stdout and stderr. */
export function runCodexCommand(args: string[], dirs: Pick<CodexRunDirs, 'home' | 'tmp' | 'work'>, timeoutMs = 20_000): Promise<CodexCommandResult> {
  return new Promise((resolve, reject) => {
    if (!codexEnabled()) return reject(new Error('Codex is not enabled on this server'));
    const binary = resolveCodexBinary();
    if (!binary) return reject(new Error('The Codex CLI is not installed on this server'));
    const child = spawn(binary, ['-c', `cli_auth_credentials_store="file"`, ...args], {
      env: buildCodexChildEnv(dirs),
      cwd: dirs.work,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const onData = (chunk: Buffer): void => { if (output.length < 20_000) output += chunk.toString(); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}
