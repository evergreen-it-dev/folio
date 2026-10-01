import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as gitProviders from './gitProviders.js';

/** Spins a tiny real HTTP server standing in for a GitLab/GitHub API, and records exactly what it received (path + headers) so tests can assert the request shape, not just the parsed response. */
function startMockProvider(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ host: string; server: http.Server }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ host: `127.0.0.1:${port}`, server });
    });
  });
}

describe('gitProviders.ts (round 11, real local mock HTTP server -- no real network)', () => {
  let openServer: http.Server | undefined;
  afterEach(async () => {
    if (openServer) await new Promise((r) => openServer!.close(r));
    openServer = undefined;
  });

  it('listRepos(gitlab): hits /api/v4/projects with PRIVATE-TOKEN and maps the response into GitProviderRepos', async () => {
    let receivedPath = '';
    let receivedToken: string | undefined;
    const { host, server } = await startMockProvider((req, res) => {
      receivedPath = req.url ?? '';
      receivedToken = req.headers['private-token'] as string | undefined;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify([
          { name: 'repo-one', name_with_namespace: 'group / repo-one', http_url_to_repo: 'https://gitlab.example.com/group/repo-one.git', default_branch: 'main', description: 'First repo' },
          { name: 'repo-two', http_url_to_repo: 'https://gitlab.example.com/group/repo-two.git', default_branch: null, description: null },
        ]),
      );
    });
    openServer = server;

    const result = await gitProviders.listRepos(host, 'gitlab', 'glpat-mock-token');

    expect(receivedPath).toContain('/api/v4/projects');
    expect(receivedPath).toContain('membership=true');
    expect(receivedToken).toBe('glpat-mock-token');
    expect(result.provider).toBe('gitlab');
    expect(result.host).toBe(host);
    expect(result.repos).toEqual([
      { name: 'group / repo-one', url: 'https://gitlab.example.com/group/repo-one.git', defaultBranch: 'main', description: 'First repo' },
      { name: 'repo-two', url: 'https://gitlab.example.com/group/repo-two.git', defaultBranch: null, description: undefined },
    ]);
  });

  it('listRepos(github): hits /api/v3/user/repos (Enterprise-shaped for a non-github.com host) with a Bearer Authorization header', async () => {
    let receivedPath = '';
    let receivedAuth: string | undefined;
    const { host, server } = await startMockProvider((req, res) => {
      receivedPath = req.url ?? '';
      receivedAuth = req.headers.authorization;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify([{ name: 'repo', full_name: 'org/repo', clone_url: 'https://github.example.com/org/repo.git', default_branch: 'main', description: 'A repo' }]));
    });
    openServer = server;

    const result = await gitProviders.listRepos(host, 'github', 'ghp-mock-token');

    expect(receivedPath).toContain('/api/v3/user/repos');
    expect(receivedAuth).toBe('Bearer ghp-mock-token');
    expect(result.provider).toBe('github');
    expect(result.repos).toEqual([{ name: 'org/repo', url: 'https://github.example.com/org/repo.git', defaultBranch: 'main', description: 'A repo' }]);
  });

  it('a non-2xx provider response becomes a clean badRequest, never a raw stack trace or the token', async () => {
    const { host, server } = await startMockProvider((_req, res) => {
      res.statusCode = 401;
      res.end('Unauthorized');
    });
    openServer = server;

    await expect(gitProviders.listRepos(host, 'gitlab', 'a-bad-token')).rejects.toThrow(/401/);
    try {
      await gitProviders.listRepos(host, 'gitlab', 'a-bad-token');
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain('a-bad-token');
    }
  });

  it('an unreachable host fails with a clean message naming the host, never the token', async () => {
    // Port 1 is reserved/unroutable -- a fast, reliable "connection refused" without a real network call.
    await expect(gitProviders.listRepos('127.0.0.1:1', 'gitlab', 'a-secret-token')).rejects.toThrow(/127\.0\.0\.1:1/);
    try {
      await gitProviders.listRepos('127.0.0.1:1', 'gitlab', 'a-secret-token');
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain('a-secret-token');
    }
  });
});
