import { describe, expect, it } from 'vitest';
import type { GitProviderRepo } from '@shared/contracts';
import { filterProviderRepos, humanizeRepoName, normalizeRepoUrlForDisplay } from './gitRepos';

const REPOS: GitProviderRepo[] = [
  { name: 'architecture-docs', url: 'https://github.com/acme/architecture-docs.git', defaultBranch: 'main' },
  { name: 'onboarding-guide', url: 'https://github.com/acme/onboarding-guide.git', defaultBranch: 'main' },
  { name: 'infra', url: 'https://gitlab.com/acme/infra.git', defaultBranch: 'master' },
];

describe('filterProviderRepos', () => {
  it('returns every repo, in order, for an empty query', () => {
    expect(filterProviderRepos('', REPOS)).toEqual(REPOS);
    expect(filterProviderRepos('   ', REPOS)).toEqual(REPOS);
  });

  it('matches by name, case-insensitively', () => {
    expect(filterProviderRepos('ONBOARDING', REPOS)).toEqual([REPOS[1]]);
  });

  it('matches by url substring — e.g. a host or org fragment', () => {
    expect(filterProviderRepos('gitlab', REPOS)).toEqual([REPOS[2]]);
  });

  it('returns every repo again when the query is an EXACT match for one repo\'s own url — refocusing an already-picked field, not a partial search', () => {
    // Simulates refocusing the field with nothing retyped: value === the
    // selected repo's own url. Narrowing to just that one repo would make
    // it impossible to pick a DIFFERENT repo without clearing the field by
    // hand first — see this function's own docblock.
    expect(filterProviderRepos(REPOS[0]!.url, REPOS)).toEqual(REPOS);
  });

  it('still narrows normally on a partial url fragment that is not a complete match', () => {
    expect(filterProviderRepos('acme/onboarding', REPOS)).toEqual([REPOS[1]]);
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterProviderRepos('nonexistent-xyz', REPOS)).toEqual([]);
  });
});

describe('humanizeRepoName', () => {
  it('humanizes a bare repo name', () => {
    expect(humanizeRepoName('architecture-docs')).toBe('Architecture Docs');
  });

  it('takes only the last segment of a namespaced provider name', () => {
    expect(humanizeRepoName('group/subgroup/architecture-docs')).toBe('Architecture Docs');
  });

  it('strips a .git suffix and derives from an https url', () => {
    expect(humanizeRepoName('https://github.com/acme/onboarding_guide.git')).toBe('Onboarding Guide');
  });

  it('handles an SSH shorthand url', () => {
    expect(humanizeRepoName('git@github.com:acme/data-flow.git')).toBe('Data Flow');
  });

  it('handles a trailing slash with no .git suffix', () => {
    expect(humanizeRepoName('https://gitlab.com/acme/infra/')).toBe('Infra');
  });
});

describe('normalizeRepoUrlForDisplay', () => {
  it('passes a plain https url through, dropping only the .git suffix', () => {
    expect(normalizeRepoUrlForDisplay('https://github.com/acme/architecture-docs.git')).toBe(
      'https://github.com/acme/architecture-docs',
    );
  });

  it('strips embedded credentials from an https url — never rendered, even in a tooltip', () => {
    expect(normalizeRepoUrlForDisplay('https://x-access-token:glpat-secret123@gitlab.com/acme/infra.git')).toBe(
      'https://gitlab.com/acme/infra',
    );
    expect(normalizeRepoUrlForDisplay('https://deploy-user@gitlab.com/acme/infra.git')).toBe('https://gitlab.com/acme/infra');
  });

  it('converts the scp-like shorthand (git@host:org/repo.git) to an https url', () => {
    expect(normalizeRepoUrlForDisplay('git@github.com:acme/data-flow.git')).toBe('https://github.com/acme/data-flow');
  });

  it('converts ssh:// (with or without an explicit port) to an https url', () => {
    expect(normalizeRepoUrlForDisplay('ssh://git@github.com/acme/infra.git')).toBe('https://github.com/acme/infra');
    expect(normalizeRepoUrlForDisplay('ssh://git@gitlab.example.com:2222/group/repo.git')).toBe(
      'https://gitlab.example.com:2222/group/repo',
    );
  });

  it('forces https even for a plain http:// remote — this is a link a human clicks, not a git operation', () => {
    expect(normalizeRepoUrlForDisplay('http://git.internal.company.local/org/repo.git')).toBe(
      'https://git.internal.company.local/org/repo',
    );
  });

  it('handles a trailing slash and a namespaced (group/subgroup) path', () => {
    expect(normalizeRepoUrlForDisplay('https://gitlab.com/group/subgroup/repo/')).toBe('https://gitlab.com/group/subgroup/repo');
  });

  it('returns null for a bare local filesystem path (used only as a dev/ops stand-in remote)', () => {
    expect(normalizeRepoUrlForDisplay('/Users/dev/tmp/bare-repo.git')).toBeNull();
  });

  it('returns null for file:// and other non-browsable schemes — same forms validateRepoUrl refuses server-side', () => {
    expect(normalizeRepoUrlForDisplay('file:///etc/passwd')).toBeNull();
    expect(normalizeRepoUrlForDisplay('ext::sh -c "evil"')).toBeNull();
  });

  it('returns null for garbage that is neither a url nor scp-like shorthand', () => {
    expect(normalizeRepoUrlForDisplay('not a url')).toBeNull();
    expect(normalizeRepoUrlForDisplay('')).toBeNull();
    expect(normalizeRepoUrlForDisplay('   ')).toBeNull();
  });

  it('returns null for a host with no repo path at all', () => {
    expect(normalizeRepoUrlForDisplay('https://github.com')).toBeNull();
    expect(normalizeRepoUrlForDisplay('https://github.com/')).toBeNull();
  });
});
