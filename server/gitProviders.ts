/**
 * Round 11: server-side calls to a git provider's own REST API (never the
 * browser — the saved PAT never leaves the server) to list repos the caller
 * has access to, for the create-space-from-repo dropdown.
 */
import type { GitProviderRepo, GitProviderRepos } from '../shared/contracts.js';
import { badRequest } from './errors.js';
import type { Provider } from './userGitCredentials.js';

/** localhost (and 127.0.0.1) get plain http — this is what makes GET /api/git/repos testable against a real local mock server; every real provider host gets https, always. */
function schemeFor(host: string): 'http' | 'https' {
  return /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host) ? 'http' : 'https';
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    // Never include `headers` (carries the token) in the thrown message — only the host.
    const host = (() => {
      try {
        return new URL(url).host;
      } catch {
        return url;
      }
    })();
    throw badRequest(`could not reach ${host}: ${err instanceof Error ? err.message : 'request failed'}`);
  }
  if (!res.ok) throw badRequest(`the provider API returned ${res.status} ${res.statusText}`);
  return res.json();
}

interface GitlabProject {
  name_with_namespace?: string;
  name: string;
  http_url_to_repo: string;
  default_branch: string | null;
  description: string | null;
}

interface GithubRepo {
  full_name?: string;
  name: string;
  clone_url: string;
  default_branch: string | null;
  description: string | null;
}

export async function listRepos(host: string, provider: Provider, token: string): Promise<GitProviderRepos> {
  const scheme = schemeFor(host);
  if (provider === 'gitlab') {
    const data = (await fetchJson(`${scheme}://${host}/api/v4/projects?membership=true&simple=true&per_page=100`, {
      'PRIVATE-TOKEN': token,
    })) as GitlabProject[];
    const repos: GitProviderRepo[] = data.map((p) => ({
      name: p.name_with_namespace ?? p.name,
      url: p.http_url_to_repo,
      defaultBranch: p.default_branch ?? null,
      description: p.description ?? undefined,
    }));
    return { provider: 'gitlab', host, repos };
  }

  // github.com itself is reached via api.github.com; a GitHub Enterprise host serves its own API under /api/v3.
  const url = host === 'github.com' ? `${scheme}://api.github.com/user/repos?per_page=100` : `${scheme}://${host}/api/v3/user/repos?per_page=100`;
  const data = (await fetchJson(url, { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' })) as GithubRepo[];
  const repos: GitProviderRepo[] = data.map((r) => ({
    name: r.full_name ?? r.name,
    url: r.clone_url,
    defaultBranch: r.default_branch ?? null,
    description: r.description ?? undefined,
  }));
  return { provider: 'github', host, repos };
}
