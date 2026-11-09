/**
 * Signing in to Codex with a personal ChatGPT subscription: `codex login
 * --device-auth` spawned per user, its URL and one-time code parsed out of the
 * output, and the resulting auth.json stored encrypted. One pending login per
 * user; it dies on cancel, after 16 minutes (the code itself lives 15) and when
 * the server shuts down. Nothing here touches the disk outside a private
 * directory that is removed when the login ends.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { AssistantCodexLoginState } from '../../shared/contracts.js';
import { assertCodexEnabled } from './providerFlags.js';
import {
  CODEX_RUN_ROOT,
  buildCodexChildEnv,
  createCodexRunDirs,
  parseChatgptAuthJson,
  readAuthJson,
  removeCodexRunDirs,
  resolveCodexBinary,
  runCodexCommand,
  withCodexAuth,
  withCodexUserLock,
  type CodexAuthStore,
  type CodexRunDirs,
} from './codexHome.js';

const DEVICE_CODE_WAIT_MS = 20_000;
const LOGIN_LIMIT_MS = 16 * 60_000;
const CODE_LIFETIME_MS = 15 * 60_000;
/** A finished login (connected or failed) stays readable for this long, so the settings screen that was polling sees the outcome. */
const RESULT_KEPT_MS = 10 * 60_000;
/** How long a settings-screen check waits for the user's lock. */
const CHECK_LOCK_WAIT_MS = 5_000;
const OUTPUT_MAX_CHARS = 20_000;
const ERROR_MAX_CHARS = 300;

export class CodexUnavailableError extends Error {
  constructor() {
    super('Codex is not available on this server');
    this.name = 'CodexUnavailableError';
  }
}

/** Colour and cursor codes the CLI puts in its banner. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '');
}

/** The verification URL and the one-time code out of the `codex login --device-auth` output. */
export function parseDeviceAuthOutput(raw: string): { url?: string; code?: string } {
  const clean = stripAnsi(raw);
  const url = clean.match(/https:\/\/[^\s<>"']+/)?.[0]?.replace(/[.,;)]+$/, '');
  const code = clean.match(/\b[A-Z0-9]{4,10}-[A-Z0-9]{4,10}\b/)?.[0];
  return { url, code };
}

/** Text of a CLI failure that is safe to show: no colour codes, no token-looking strings, short. */
export function safeCliText(raw: string, max = ERROR_MAX_CHARS): string {
  const text = stripAnsi(raw)
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted]')
    .replace(/\b(?:sk|rt|at)[-_][\w-]{16,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? text.slice(-max) : text;
}

interface ActiveLogin {
  state: AssistantCodexLoginState;
  child: ChildProcess | null;
  dirs: CodexRunDirs | null;
  timer: NodeJS.Timeout | null;
  output: string;
  cancelled: boolean;
  finishedAt: number | null;
}

const logins = new Map<string, ActiveLogin>();

export interface CodexLoginDeps {
  /** Stores the new auth.json (encrypted) for the user. Runs inside the user's lock. */
  save: (authJson: string, email: string | null) => Promise<void>;
  /** Called once after a successful sign-in has been stored. */
  onConnected?: () => void;
  // Test seams.
  spawnFn?: typeof spawn;
  binary?: string | null;
  base?: string;
}

function copy(state: AssistantCodexLoginState): AssistantCodexLoginState {
  return { ...state };
}

function endLogin(entry: ActiveLogin): void {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
  entry.finishedAt = Date.now();
  const child = entry.child;
  entry.child = null;
  try { child?.kill('SIGKILL'); } catch { /* already gone */ }
  const dirs = entry.dirs;
  entry.dirs = null;
  if (dirs) void removeCodexRunDirs(dirs);
}

function fail(entry: ActiveLogin, message: string): void {
  if (entry.state.status !== 'pending') return;
  entry.state = { status: 'failed', error: message };
  endLogin(entry);
}

export function getCodexLoginState(userId: string): AssistantCodexLoginState {
  const entry = logins.get(userId);
  if (!entry) return { status: 'idle' };
  if (entry.finishedAt !== null && Date.now() - entry.finishedAt > RESULT_KEPT_MS) {
    logins.delete(userId);
    return { status: 'idle' };
  }
  return copy(entry.state);
}

/** Starts a device-code login, or returns the one still pending. Resolves as soon as the URL and code are known (or it failed). */
export async function startCodexLogin(userId: string, deps: CodexLoginDeps): Promise<AssistantCodexLoginState> {
  assertCodexEnabled();
  const existing = logins.get(userId);
  if (existing?.state.status === 'pending') return copy(existing.state);
  const binary = deps.binary === undefined ? resolveCodexBinary() : deps.binary;
  if (!binary) throw new CodexUnavailableError();

  const startedAt = Date.now();
  // Registered before the first await, so a second POST in the meantime sees this login and returns it.
  const entry: ActiveLogin = { state: { status: 'pending' }, child: null, dirs: null, timer: null, output: '', cancelled: false, finishedAt: null };
  logins.set(userId, entry);
  let dirs: CodexRunDirs;
  try {
    dirs = await createCodexRunDirs(deps.base ?? CODEX_RUN_ROOT);
  } catch (error) {
    if (logins.get(userId) === entry) logins.delete(userId);
    throw error;
  }
  if (entry.cancelled) {
    await removeCodexRunDirs(dirs);
    return { status: 'idle' };
  }
  entry.dirs = dirs;

  let child: ChildProcess;
  try {
    child = (deps.spawnFn ?? spawn)(binary, ['-c', 'cli_auth_credentials_store="file"', 'login', '--device-auth'], {
      env: buildCodexChildEnv(dirs),
      cwd: dirs.work,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    fail(entry, 'The Codex CLI could not be started');
    return copy(entry.state);
  }
  entry.child = child;
  const onData = (chunk: Buffer | string): void => {
    if (entry.output.length < OUTPUT_MAX_CHARS) entry.output += chunk.toString();
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  entry.timer = setTimeout(() => fail(entry, 'The sign-in code expired — start again'), LOGIN_LIMIT_MS);
  entry.timer.unref?.();

  child.once('error', () => fail(entry, 'The Codex CLI could not be started'));
  child.once('exit', (code) => {
    if (entry.cancelled || entry.state.status !== 'pending') return;
    void finishLogin(userId, entry, code, deps);
  });

  // The URL and the code are what the caller is waiting for.
  await new Promise<void>((resolve) => {
    const check = (): void => {
      const { url, code } = parseDeviceAuthOutput(entry.output);
      if (entry.state.status !== 'pending') return finish();
      if (url && code) {
        entry.state = { status: 'pending', verificationUrl: url, userCode: code, expiresAt: new Date(startedAt + CODE_LIFETIME_MS).toISOString() };
        finish();
      }
    };
    const timeout = setTimeout(() => {
      fail(entry, 'OpenAI did not return a sign-in code in time — try again');
      finish();
    }, DEVICE_CODE_WAIT_MS);
    const finish = (): void => {
      clearTimeout(timeout);
      child.stdout?.off('data', check);
      child.stderr?.off('data', check);
      child.off('exit', check);
      child.off('error', check);
      resolve();
    };
    child.stdout?.on('data', check);
    child.stderr?.on('data', check);
    child.once('exit', check);
    child.once('error', check);
    check();
  });
  return copy(entry.state);
}

async function finishLogin(userId: string, entry: ActiveLogin, code: number | null, deps: CodexLoginDeps): Promise<void> {
  try {
    if (code !== 0) {
      fail(entry, safeCliText(entry.output) || `The sign-in ended with code ${code ?? 'unknown'}`);
      return;
    }
    const authJson = entry.dirs ? await readAuthJson(entry.dirs) : null;
    const parsed = authJson ? parseChatgptAuthJson(authJson) : null;
    if (!authJson || !parsed?.ok) {
      fail(entry, 'The sign-in finished without a ChatGPT account login');
      return;
    }
    if (entry.cancelled || entry.state.status !== 'pending') return;
    let stored = false;
    await withCodexUserLock(userId, async () => {
      // Cancelled (or ended) while waiting for the lock: nothing is stored.
      if (entry.cancelled || entry.state.status !== 'pending') return;
      await deps.save(authJson, parsed.email);
      stored = true;
    });
    if (!stored || entry.cancelled) return;
    entry.state = { status: 'connected' };
    endLogin(entry);
    deps.onConnected?.();
  } catch (error) {
    // Typically a missing FOLIO_SECRET or a database error; never the credential.
    console.warn('[codex] storing the sign-in failed:', error instanceof Error ? error.name : 'error');
    fail(entry, 'The sign-in could not be saved on this server');
  }
}

/** Cancels the pending login of a user, and forgets a finished one. */
export function cancelCodexLogin(userId: string): void {
  const entry = logins.get(userId);
  if (!entry) return;
  entry.cancelled = true;
  endLogin(entry);
  logins.delete(userId);
}

/** Server shutdown: no child process and no auth.json outlives it. */
export function shutdownCodexLogins(): void {
  for (const userId of [...logins.keys()]) cancelCodexLogin(userId);
}

/** Does the CLI itself consider the stored sign-in valid? Runs `codex login status` against a materialised home. */
export async function checkCodexLogin(userId: string, store: CodexAuthStore): Promise<boolean> {
  assertCodexEnabled();
  if (!resolveCodexBinary()) throw new CodexUnavailableError();
  try {
    // A check is a quick interactive call: it waits only briefly for a run of the same user, and fails (CodexBusyError) rather than hang.
    return await withCodexAuth(userId, store, async (dirs) => {
      const { code, output } = await runCodexCommand(['login', 'status'], dirs);
      return code === 0 && !/not logged in/i.test(stripAnsi(output));
    }, { maxWaitMs: CHECK_LOCK_WAIT_MS });
  } catch (error) {
    if (error instanceof Error && error.name === 'CodexNotConnectedError') return false;
    throw error;
  }
}
