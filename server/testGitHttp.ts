/**
 * A real, local, smart-HTTP git remote for tests — `http://127.0.0.1:<port>/
 * <name>.git`, clonable AND pushable.
 *
 * Why this exists: git.validateRepoUrl (server/git.ts) accepts only
 * http(s)/ssh/git@ URLs, and since QA-3's P0 every route that takes a
 * repoUrl enforces that unconditionally — a plain local bare-repo path, the
 * fixture every other git test in this codebase uses, is exactly the shape
 * that hole was made of, so an HTTP-level test can no longer use one. Tests
 * that call storage/git functions DIRECTLY still can (git.ts's
 * __allowLocalRepoPathsForTests); tests that go through a route need a
 * genuinely allowed URL, which is this.
 *
 * Implementation is git's own `git-http-backend` CGI (ships with git, found
 * via `git --exec-path`) behind ~40 lines of node:http — no network beyond
 * loopback, no fixtures checked in, and unlike the dumb-http static-file
 * server in gitNative.test.ts it supports receive-pack, so `connect-git`'s
 * "add origin and push" path is exercised for real. `http.receivepack` is
 * set per repo; anonymous access is fine (GIT_HTTP_EXPORT_ALL) — there is no
 * auth story to test here, only the URL shape and the transport.
 *
 * NOT a production module: nothing under server/ imports it outside tests.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

/** git's own identity flags — the test host may have no user.name/user.email configured at all. */
const IDENT = ['-c', 'user.name=Folio Test', '-c', 'user.email=test@folio.local'];

export interface GitHttpServer {
  /** The URL of a repo served by this instance, whether or not it exists yet. */
  url(name: string): string;
  /** A brand-new bare repo with ZERO refs (what `isEmptyRemote` reports true for). Returns its URL. */
  createEmptyRepo(name: string): Promise<string>;
  /** A bare repo seeded with one commit on `branch`. Returns its URL. */
  createSeededRepo(name: string, files: Record<string, string>, branch?: string): Promise<string>;
  /** Stops the server and removes every repo it served. */
  close(): Promise<void>;
}

/** Streams one request through `git-http-backend`, translating its CGI response into an http.ServerResponse. */
function handle(execPath: string, projectRoot: string, req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const child = spawn(path.join(execPath, 'git-http-backend'), [], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: projectRoot,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.replace(/^\?/, ''),
      REQUEST_METHOD: req.method ?? 'GET',
      CONTENT_TYPE: req.headers['content-type'] ?? '',
      CONTENT_LENGTH: req.headers['content-length'] ?? '',
      HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '',
    },
  });

  req.pipe(child.stdin);

  // CGI puts its headers, then a blank line, then the body — all on stdout.
  let pending = Buffer.alloc(0);
  let headersSent = false;
  child.stdout.on('data', (chunk: Buffer) => {
    if (headersSent) {
      res.write(chunk);
      return;
    }
    pending = Buffer.concat([pending, chunk]);
    const split = pending.indexOf('\r\n\r\n');
    if (split === -1) return;

    let status = 200;
    for (const line of pending.subarray(0, split).toString('utf8').split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      const key = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (key.toLowerCase() === 'status') status = Number.parseInt(value, 10) || 500;
      else res.setHeader(key, value);
    }
    res.writeHead(status);
    res.write(pending.subarray(split + 4));
    headersSent = true;
  });

  child.on('error', () => {
    if (!headersSent) res.writeHead(500);
    res.end();
  });
  child.on('close', () => {
    if (!headersSent) res.writeHead(500);
    res.end();
  });
}

export async function startGitHttpServer(): Promise<GitHttpServer> {
  const execPath = (await execFileAsync('git', ['--exec-path'])).stdout.trim();
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-test-githttp-'));

  const server = http.createServer((req, res) => handle(execPath, projectRoot, req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;

  async function createEmptyRepo(name: string): Promise<string> {
    const dir = path.join(projectRoot, `${name}.git`);
    await execFileAsync('git', ['init', '--bare', '-q', '-b', 'main', dir]);
    // Smart HTTP refuses pushes unless the repo opts in.
    await execFileAsync('git', ['config', 'http.receivepack', 'true'], { cwd: dir });
    return `${base}/${name}.git`;
  }

  return {
    url: (name) => `${base}/${name}.git`,
    createEmptyRepo,
    async createSeededRepo(name, files, branch = 'main') {
      const repoUrl = await createEmptyRepo(name);
      const work = path.join(projectRoot, `seed-${name}`);
      await fs.mkdir(work, { recursive: true });
      await execFileAsync('git', ['init', '-q', '-b', branch], { cwd: work });
      for (const [relPath, content] of Object.entries(files)) {
        const abs = path.join(work, relPath);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content, 'utf8');
      }
      await execFileAsync('git', ['add', '-A'], { cwd: work });
      await execFileAsync('git', [...IDENT, 'commit', '-q', '-m', 'seed'], { cwd: work });
      await execFileAsync('git', ['push', '-q', repoUrl, `HEAD:refs/heads/${branch}`], {
        cwd: work,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      await fs.rm(work, { recursive: true, force: true });
      return repoUrl;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(projectRoot, { recursive: true, force: true }).catch(() => {});
    },
  };
}
