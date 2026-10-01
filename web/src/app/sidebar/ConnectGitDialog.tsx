import { useReducer, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { api, ApiError } from '../api';
import { useApiErrorText } from '../errorText';
import { useDebouncedValue } from '../hooks';
import { Modal } from '../ui/Modal';
import { LabeledInput } from '../ui/LabeledInput';
import { GitCredentialForm } from '../git/GitCredentialForm';
import { BranchField } from './BranchField';
import { branchFieldReducer } from './gitBranches';
import '../i18n/register';

const FORM_ID = 'connect-git-form';

export interface ConnectGitDialogProps {
  space: string;
  onClose: () => void;
  /** Called after a successful connect, alongside the ['spaces']/['auth','state'] invalidation this dialog already does itself. */
  onConnected?: () => void;
}

/**
 * "Connect git" on an already-existing LOCAL space (the owner's second
 * ask, this round) — reuses the exact same POST /api/git/branches probe
 * CreateSpaceDialog's git tab uses, but for a different purpose here: this
 * space already has its own content and git history, so the ONLY thing this
 * dialog is allowed to do is connect to a repository that has NONE of its
 * own yet. `branches.data.empty` from that same probe is reused as the
 * client-side gate (disables submit + shows an explanation) for exactly
 * that — server/storage.ts's connectSpaceToRepo re-checks and refuses
 * (409) regardless, so this is a UX head-start, not the actual guard.
 *
 * Deliberately much smaller than CreateSpaceDialog's git tab: no name field
 * (the space keeps its existing name) and no rootPath/tree picker (a local
 * space's content already lives at the repo root — there's nothing to pick,
 * the whole existing tree becomes the whole repo).
 */
export function ConnectGitDialog({ space, onClose, onConnected }: ConnectGitDialogProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const queryClient = useQueryClient();
  const [repoUrl, setRepoUrl] = useState('');
  const [branchState, dispatchBranch] = useReducer(branchFieldReducer, { value: 'main', touched: false });
  const branch = branchState.value;
  const [token, setToken] = useState('');
  const [addingCredential, setAddingCredential] = useState(false);

  const credentials = useQuery({ queryKey: ['git-credentials'], queryFn: api.getGitCredentials, retry: false });
  const savedCredentials = credentials.data?.credentials ?? [];

  const debouncedRepoUrl = useDebouncedValue(repoUrl, 600).trim();
  const debouncedToken = useDebouncedValue(token, 600).trim();
  const branches = useQuery({
    queryKey: ['git-branches', debouncedRepoUrl, debouncedToken],
    queryFn: () => api.listBranches({ repoUrl: debouncedRepoUrl, token: debouncedToken || undefined }),
    enabled: debouncedRepoUrl.length > 0,
    retry: false,
  });

  const repoIsEmpty = branches.data?.empty === true;
  const repoIsNonEmpty = branches.data !== undefined && branches.data.empty === false;
  /**
   * QA-3 P2 #5: the probe can simply fail to answer — a network blip, a
   * provider that won't serve an anonymous `ls-remote`, a token that has not
   * been pasted yet. That is NOT the same finding as "the repository is not
   * empty", but the old gate (`canSubmit = … && repoIsEmpty && …`) treated
   * the two identically and left the button disabled forever, explained only
   * by a small grey line under the branch field. A failed probe now means
   * "unknown", and unknown gets a way forward: the reason is stated, submit
   * is allowed, and server/storage.ts's connectSpaceToRepo — which re-checks
   * regardless and answers 409 — is what actually decides. `settledForUrl`
   * keeps a stale failure from unlocking a URL that has not been probed yet
   * (the field is debounced 600ms).
   */
  const settledForUrl = debouncedRepoUrl === repoUrl.trim();
  const probeUnavailable = branches.isError && settledForUrl && !branches.isFetching;

  const connect = useMutation({
    mutationFn: () =>
      api.connectGitSpace(space, {
        repoUrl: repoUrl.trim(),
        branch: branch.trim() || 'main',
        token: token.trim() || undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
      queryClient.invalidateQueries({ queryKey: ['auth', 'state'] });
      onConnected?.();
      onClose();
    },
  });

  // A POSITIVE "empty" still unlocks submit exactly as before; the only new
  // door is an unanswerable probe (see probeUnavailable). A probe that
  // positively says "not empty" keeps the door shut — that one is a real
  // finding, and the server would refuse anyway.
  const canSubmit = repoUrl.trim().length > 0 && (repoIsEmpty || probeUnavailable) && !connect.isPending;

  return (
    <Modal
      title={t('sidebar.connectGit.title')}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            {t('ui.cancel')}
          </button>
          <button
            type="submit"
            form={FORM_ID}
            disabled={!canSubmit}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {connect.isPending ? t('sidebar.connectGit.connecting') : t('sidebar.connectGit.action')}
          </button>
        </>
      }
    >
      <p className="mb-3 text-sm text-neutral-600 dark:text-neutral-400">{t('sidebar.connectGit.description')}</p>

      <form
        id={FORM_ID}
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) connect.mutate();
        }}
      >
        <LabeledInput
          label={t('sidebar.createSpace.repository')}
          required
          autoFocus
          placeholder="https://github.com/org/repo.git"
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
        />

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-600 dark:text-neutral-400">{t('sidebar.createSpace.branch')}</span>
          <BranchField
            value={branch}
            onChange={(value) => dispatchBranch({ type: 'edit', value })}
            loading={branches.isFetching}
            branches={branches.data && !branches.data.empty ? branches.data.branches : undefined}
            emptyRepo={repoIsEmpty}
            fetchError={branches.isError}
          />
        </label>

        {repoIsNonEmpty && (
          <p role="alert" className="rounded-md bg-amber-50 p-2.5 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            {t('sidebar.connectGit.notEmptyWarning')}
          </p>
        )}

        {probeUnavailable && (
          <p role="alert" className="rounded-md bg-amber-50 p-2.5 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            {/* Reason first, advice second, as two sentences rather than one
                interpolated string: the reason comes from the server and may
                or may not end in punctuation of its own. */}
            <span className="mb-1 block font-medium">{errorText(branches.error)}</span>
            {t('sidebar.connectGit.probeFailed')}
          </p>
        )}

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
            onSaved={() => {
              setAddingCredential(false);
              queryClient.invalidateQueries({ queryKey: ['git-credentials'] });
            }}
            onCancel={() => setAddingCredential(false)}
          />
        )}

        <LabeledInput
          label={t('git.credentials.token')}
          type="password"
          placeholder={t('sidebar.connectGit.tokenPlaceholder')}
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        {savedCredentials.length > 0 && (
          <p className="-mt-2 text-xs text-neutral-500 dark:text-neutral-400">{t('sidebar.connectGit.savedTokenHint')}</p>
        )}

        {connect.isError && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {errorText(connect.error, 'sidebar.connectGit.failed')}
          </p>
        )}
      </form>
    </Modal>
  );
}
