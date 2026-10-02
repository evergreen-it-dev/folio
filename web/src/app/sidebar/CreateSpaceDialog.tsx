import { useEffect, useMemo, useReducer, useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import type { GitCredentialInfo, SpaceImportProgress } from '@shared/contracts';
import { api, ApiError } from '../api';
import { useApiErrorText } from '../errorText';
import { useDebouncedValue } from '../hooks';
import { Modal } from '../ui/Modal';
import { LabeledInput } from '../ui/LabeledInput';
import { ComboBox } from '../ui/ComboBox';
import { GitCredentialForm } from '../git/GitCredentialForm';
import { BranchField } from './BranchField';
import { branchFieldReducer } from './gitBranches';
import { filterProviderRepos, humanizeRepoName } from './gitRepos';
import { GitRepoTreePicker } from './GitRepoTreePicker';
import '../i18n/register';

const FORM_ID = 'create-space-form';

type Tab = 'empty' | 'git';

export interface CreateSpaceDialogProps {
  onClose: () => void;
  /** Which tab is open first; the welcome wizard's "connect a repository" link starts on `git`. */
  initialTab?: 'empty' | 'git';
}

/**
 * Space creation — two tabs: an empty space (name only, git init with no
 * remote happens server-side regardless) or a space backed by an existing
 * git repository. Same POST /api/spaces endpoint either way, richer body on
 * the git tab. Used both from the space switcher and from the first-run
 * empty state (RootRedirect), so navigation on success lives here rather
 * than in either caller.
 *
 * Round 19 (#6-ux, QA polish): the git tab was reworked per owner feedback —
 * (a) repository first, name second (auto-suggested from the picked repo,
 * still freely editable — see nameTouched below); (b)/(c) the repository
 * and branch fields are now the same searchable-combobox pattern (35+ repos
 * made the old <select> unusable — see ui/ComboBox.tsx, generalized out of
 * BranchField's original round-5 implementation); (d) rootPath grew an
 * optional, lazy, visual directory-tree picker (GitRepoTreePicker.tsx)
 * alongside the always-present manual text field, degrading silently to
 * just that field on any failure.
 */
export function CreateSpaceDialog({ onClose, initialTab = 'empty' }: CreateSpaceDialogProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [name, setName] = useState('');
  // Round 19: once the user edits Name by hand, picking a (different) repo
  // must never clobber it again — same "manual edit always wins" contract
  // as repoUrlTouched below.
  const [nameTouched, setNameTouched] = useState(false);
  const [repoUrl, setRepoUrl] = useState('');
  const [repoUrlTouched, setRepoUrlTouched] = useState(false);
  const [branchState, dispatchBranch] = useReducer(branchFieldReducer, { value: 'main', touched: false });
  const branch = branchState.value;
  // QA-3 P2 #4 (RISK TO SOMEONE ELSE'S REPOSITORY): this used to auto-fill
  // with translitSlug(name) — see the removed effect below — so pointing
  // Folio at a ready-made docs repository defaulted the content root to a
  // folder that repository does not have. server/storage.ts's
  // createSpaceFromRepo treats a missing rootPath as "bootstrap it": it
  // mkdir's the folder, writes a starter index.md, commits, and PUSHES that
  // commit to the user's repository (verified against a real bare repo). The
  // space then also looks empty, because none of the repo's actual content is
  // under the invented root. Empty = the repository root is both the correct
  // default for the common case and the only one that cannot write to a
  // stranger's repo by accident; the tree picker and the "one repo, several
  // spaces" hint below remain for the deliberate sub-folder case.
  const [rootPath, setRootPath] = useState('');
  const [token, setToken] = useState('');
  const [importId, setImportId] = useState<string | null>(null);
  const [progress, setProgress] = useState<SpaceImportProgress | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);

  function handleNameChange(value: string) {
    setName(value);
    setNameTouched(true);
  }

  // Round 11: repo-dropdown-by-saved-credential. Degrades to the plain
  // free-text URL/token fields above whenever there's nothing to offer —
  // no saved credentials, or the endpoint 404s/errors (SERVER building this
  // in parallel) — retry:false, same as this file's existing `config` query.
  const credentials = useQuery({ queryKey: ['git-credentials'], queryFn: api.getGitCredentials, retry: false });
  const savedCredentials = credentials.data?.credentials ?? [];
  const [selectedCredentialId, setSelectedCredentialId] = useState<string | null>(null);
  const selectedCredential = savedCredentials.find((c) => c.id === selectedCredentialId) ?? savedCredentials[0];
  const [addingCredential, setAddingCredential] = useState(false);
  // True once a repo was picked from the combobox's suggestions — hides the
  // token field (SERVER substitutes the saved token by matching repoUrl's
  // host at create time regardless of how repoUrl got filled in, so nothing
  // extra needs to be sent here; this only controls what the FORM shows).
  // Editing the URL text directly always resets it back to false.
  const [usingSavedToken, setUsingSavedToken] = useState(false);

  const providerRepos = useQuery({
    queryKey: ['git-provider-repos', selectedCredential?.host],
    queryFn: () => api.getGitProviderRepos(selectedCredential!.host),
    enabled: tab === 'git' && !!selectedCredential,
    retry: false,
  });

  // Round 19 (#6-ux): repoUrl IS the combobox's own text value (typing a url
  // directly still works with zero suggestions, same "always-editable
  // input" contract BranchField established) — filtering matches on EITHER
  // a repo's name or its url (see gitRepos.ts's own docblock for why: once
  // a repo has been picked, this text IS a url, not a name).
  const repoOptions = useMemo(() => {
    if (!selectedCredential || !providerRepos.data) return undefined;
    return filterProviderRepos(repoUrl, providerRepos.data.repos).map((repo) => ({
      value: repo.url,
      label: repo.name,
      hint: repo.description,
    }));
  }, [selectedCredential, providerRepos.data, repoUrl]);

  // Round 5 follow-up: prefill from GET /api/config (SERVER adding it —
  // { defaultRepoUrl }). Degrades silently: retry:false so a 404/error
  // just leaves `data` undefined forever, no toast, fields stay empty
  // exactly as before this endpoint existed.
  const config = useQuery({ queryKey: ['config'], queryFn: api.getConfig, retry: false });

  useEffect(() => {
    if (!repoUrlTouched && config.data?.defaultRepoUrl) setRepoUrl(config.data.defaultRepoUrl);
  }, [config.data, repoUrlTouched]);

  // Round 5 follow-up ("it would be good if branches were pulled in automatically"): debounce ~600ms
  // after EITHER repoUrl or token changes, then POST /api/git/branches.
  // Debouncing both independently and keying the query on both debounced
  // values gets "restart the wait on either changing" for free — and it's
  // also exactly how a token added *after* a first failed private-repo
  // attempt naturally triggers a refetch (new query key, once it settles).
  const debouncedRepoUrl = useDebouncedValue(repoUrl, 600).trim();
  const debouncedToken = useDebouncedValue(token, 600).trim();
  const branches = useQuery({
    queryKey: ['git-branches', debouncedRepoUrl, debouncedToken],
    queryFn: () => api.listBranches({ repoUrl: debouncedRepoUrl, token: debouncedToken || undefined }),
    enabled: tab === 'git' && debouncedRepoUrl.length > 0,
    retry: false,
  });

  useEffect(() => {
    // null for an empty repo (nothing to default to) -> simply never
    // dispatched, which is exactly the "keep main" requirement: the field
    // just stays whatever it already was.
    if (branches.data?.defaultBranch) dispatchBranch({ type: 'autofill', value: branches.data.defaultBranch });
  }, [branches.data]);

  // Round 19 (#6-ux): debounced the same way as the branches fetch above —
  // GitRepoTreePicker's root-level fetch is backed by a real (if cached)
  // shallow clone server-side, not free, so this shouldn't re-request on
  // every keystroke while the url/branch are still being typed.
  const debouncedBranch = useDebouncedValue(branch, 600).trim() || 'main';
  const canBrowseTree = tab === 'git' && debouncedRepoUrl.length > 0 && debouncedBranch.length > 0;
  const treeCredentialId = usingSavedToken ? selectedCredential?.id : undefined;

  const create = useMutation({
    mutationFn: (jobId?: string) =>
      api.createSpace(
        tab === 'git'
          ? {
              name: name.trim(),
              repoUrl: repoUrl.trim(),
              branch: branch.trim() || 'main',
              rootPath: rootPath.trim(),
              token: token.trim() || undefined,
              importId: jobId,
            }
          : { name: name.trim() },
      ),
    onSuccess: (space) => {
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
      // Round 7 prod-bug fix: without this, AuthProvider's `memberships`
      // map still doesn't know about the new space until some *other*
      // event happens to refetch ['auth','state'] (e.g. a manual reload) —
      // useSpaceRole's spaces-list fallback covers most of the gap already,
      // but refreshing the actual source of truth here closes it properly
      // rather than leaning on the fallback indefinitely.
      queryClient.invalidateQueries({ queryKey: ['auth', 'state'] });
      onClose();
      navigate(`/s/${space.slug}`);
    },
  });

  useEffect(() => {
    if (!create.isPending || !importId || startedAt === null) return;
    let cancelled = false;
    async function poll() {
      try {
        const next = await api.getSpaceImportProgress(importId!);
        if (!cancelled) setProgress(next);
      } catch {
        // The POST and the first GET can cross before the server-side job is created.
      }
    }
    void poll();
    const pollTimer = window.setInterval(() => void poll(), 500);
    const clockTimer = window.setInterval(() => setElapsedMs(Date.now() - startedAt), 250);
    return () => {
      cancelled = true;
      window.clearInterval(pollTimer);
      window.clearInterval(clockTimer);
    };
  }, [create.isPending, importId, startedAt]);

  const canSubmit = name.trim().length > 0 && (tab === 'empty' || repoUrl.trim().length > 0);

  return (
    <Modal
      title={t('sidebar.createSpace.title')}
      onClose={create.isPending ? () => {} : onClose}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={create.isPending}
            className="rounded-md px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            {t('ui.cancel')}
          </button>
          <button
            type="submit"
            form={FORM_ID}
            disabled={create.isPending || !canSubmit}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {create.isPending ? t('sidebar.createSpace.creating') : t('ui.create')}
          </button>
        </>
      }
    >
      <div role="tablist" className="mb-4 flex gap-1 rounded-md bg-neutral-100 p-1 dark:bg-neutral-800">
        <TabButton active={tab === 'empty'} onClick={() => setTab('empty')}>
          {t('sidebar.createSpace.tabEmpty')}
        </TabButton>
        <TabButton active={tab === 'git'} onClick={() => setTab('git')}>
          {t('sidebar.createSpace.tabGit')}
        </TabButton>
      </div>

      <form
        id={FORM_ID}
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSubmit) return;
          if (tab === 'git') {
            const id = crypto.randomUUID();
            setImportId(id);
            setProgress(null);
            setStartedAt(Date.now());
            setElapsedMs(0);
            create.mutate(id);
          } else {
            create.mutate(undefined);
          }
        }}
      >
        {tab === 'empty' && (
          <LabeledInput
            label={t('sidebar.createSpace.name')}
            required
            autoFocus
            value={name}
            onChange={(e) => handleNameChange(e.target.value)}
          />
        )}

        {tab === 'git' && (
          <>
            {savedCredentials.length > 1 && (
              <div className="flex flex-col gap-2 rounded-md bg-neutral-50 p-2.5 dark:bg-neutral-900">
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-neutral-600 dark:text-neutral-400">{t('sidebar.createSpace.credential')}</span>
                  <select
                    value={selectedCredential?.id ?? ''}
                    onChange={(e) => setSelectedCredentialId(e.target.value)}
                    className="rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 text-sm text-neutral-800 dark:border-neutral-700 dark:text-neutral-200"
                  >
                    {savedCredentials.map((cred) => (
                      <option key={cred.id} value={cred.id}>
                        {cred.label || cred.host} ({cred.host})
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-neutral-600 dark:text-neutral-400">{t('sidebar.createSpace.repository')}</span>
              <ComboBox
                value={repoUrl}
                onChange={(value) => {
                  setRepoUrl(value);
                  setRepoUrlTouched(true);
                  setUsingSavedToken(false);
                }}
                onSelect={(option) => {
                  const repo = providerRepos.data?.repos.find((r) => r.url === option.value);
                  setUsingSavedToken(true);
                  if (repo?.defaultBranch) dispatchBranch({ type: 'autofill', value: repo.defaultBranch });
                  if (repo && !nameTouched) setName(humanizeRepoName(repo.name));
                }}
                options={repoOptions}
                loading={!!selectedCredential && providerRepos.isFetching}
                placeholder="https://github.com/org/repo.git"
                listboxId="folio-repo-listbox"
                ariaLabel={t('sidebar.createSpace.repository')}
                required
                autoFocus
              />
            </label>
            {selectedCredential && providerRepos.isError && (
              <p className="-mt-2 text-xs text-neutral-500 dark:text-neutral-400">{t('sidebar.createSpace.reposFailed')}</p>
            )}
            {selectedCredential && providerRepos.data && providerRepos.data.repos.length === 0 && (
              <p className="-mt-2 text-xs text-neutral-500 dark:text-neutral-400">{t('sidebar.createSpace.noRepos')}</p>
            )}

            <LabeledInput
              label={t('sidebar.createSpace.name')}
              required
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
            />

            {!addingCredential ? (
              <button
                type="button"
                onClick={() => setAddingCredential(true)}
                className="-mt-1 flex items-center gap-1.5 self-start text-xs text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
              >
                <Plus size={12} />
                {t('git.credentials.connectPrompt')}
              </button>
            ) : (
              <GitCredentialForm
                onSaved={(cred: GitCredentialInfo) => {
                  setAddingCredential(false);
                  setSelectedCredentialId(cred.id);
                  queryClient.invalidateQueries({ queryKey: ['git-credentials'] });
                }}
                onCancel={() => setAddingCredential(false)}
              />
            )}

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-neutral-600 dark:text-neutral-400">{t('sidebar.createSpace.branch')}</span>
              <BranchField
                value={branch}
                onChange={(value) => dispatchBranch({ type: 'edit', value })}
                loading={branches.isFetching}
                branches={branches.data && !branches.data.empty ? branches.data.branches : undefined}
                emptyRepo={branches.data?.empty === true}
                fetchError={branches.isError}
              />
            </label>
            <LabeledInput
              label={t('sidebar.createSpace.rootPath')}
              placeholder={t('sidebar.createSpace.rootPathPlaceholder')}
              value={rootPath}
              onChange={(e) => setRootPath(e.target.value)}
            />
            <p className="-mt-2 text-xs text-neutral-500 dark:text-neutral-400">{t('sidebar.createSpace.rootPathHint')}</p>
            {canBrowseTree && (
              // key: a genuinely different (repo, branch, credential) is a
              // different tree — remount cleanly rather than trying to
              // reconcile every already-expanded node's stale children
              // against a new repo (same "identity change -> remount"
              // precedent as BoardEditor's key={shareToken || pageId}).
              <GitRepoTreePicker
                key={`${treeCredentialId ?? ''}:${debouncedRepoUrl}:${debouncedBranch}`}
                repoUrl={debouncedRepoUrl}
                branch={debouncedBranch}
                credentialId={treeCredentialId}
                selectedPath={rootPath}
                onSelect={(path) => setRootPath(path)}
              />
            )}
            {usingSavedToken ? (
              <div className="flex items-center justify-between gap-2 rounded-md border border-neutral-200 px-3 py-2 text-sm text-neutral-600 dark:border-neutral-700 dark:text-neutral-400">
                <span>{t('sidebar.createSpace.usingSavedToken')}</span>
                <button
                  type="button"
                  onClick={() => setUsingSavedToken(false)}
                  className="shrink-0 text-xs text-neutral-500 underline underline-offset-2 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
                >
                  {t('sidebar.createSpace.enterManually')}
                </button>
              </div>
            ) : (
              <LabeledInput
                label={t('git.credentials.token')}
                type="password"
                placeholder={t('sidebar.createSpace.tokenPlaceholder')}
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            )}
            <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('sidebar.createSpace.multiSpaceHint')}</p>
          </>
        )}

        {create.isError && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {errorText(create.error, 'sidebar.createSpace.failed')}
          </p>
        )}

        {create.isPending && tab === 'git' && (
          <div aria-live="polite" className="rounded-md border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-700 dark:bg-neutral-900">
            <div className="mb-2 flex items-center justify-between gap-3 text-xs">
              <span className="font-medium text-neutral-700 dark:text-neutral-200">
                {t(`sidebar.createSpace.progress.${progress?.phase ?? 'preparing'}`)}
              </span>
              <span className="tabular-nums text-neutral-500">
                {Math.floor(elapsedMs / 60_000)}:{String(Math.floor(elapsedMs / 1000) % 60).padStart(2, '0')}
              </span>
            </div>
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress?.percent ?? 1}
              className="h-2 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700"
            >
              <div className="h-full rounded-full bg-blue-600 transition-[width] duration-300" style={{ width: `${progress?.percent ?? 1}%` }} />
            </div>
            <div className="mt-1.5 flex justify-between text-[11px] text-neutral-500">
              <span>
                {progress?.totalFiles
                  ? t('sidebar.createSpace.progress.files', { done: progress.processedFiles, total: progress.totalFiles })
                  : t('sidebar.createSpace.progress.waiting')}
              </span>
              <span className="tabular-nums">{progress?.percent ?? 1}%</span>
            </div>
          </div>
        )}
      </form>
    </Modal>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex-1 rounded px-3 py-1.5 text-sm font-medium transition-colors ${
        active
          ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-neutral-100'
          : 'text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200'
      }`}
    >
      {children}
    </button>
  );
}
