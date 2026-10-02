import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Folder, Loader2 } from 'lucide-react';
import type { ImportJob, TreeNode } from '@shared/contracts';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { Modal } from '../ui/Modal';
import { LabeledInput } from '../ui/LabeledInput';
import { childDirOf, excludeAgentFolder, excludeTemplatesFolder, getTopLevelNodes, treeNodeDisplayTitle } from '../sidebar/treeUtils';
import { confluenceHostFromUrl } from './confluenceHost';
import '../i18n/register';

export interface ConfluenceImportDialogProps {
  onClose: () => void;
  /**
   * The space the dialog was opened from (Sidebar -> UserMenu), if any —
   * owner report 22.09.2026: the "existing space" picker always started
   * blank ("—"), forcing a manual pick even when there's an obvious answer.
   * Preselects both the target space AND the new/existing toggle itself
   * (defaults to "existing" whenever we know one — importing FROM inside a
   * space overwhelmingly means importing INTO it; "new space" stays one
   * click away via the toggle for the rarer case).
   */
  currentSpace?: string;
}

type AuthKind = 'pat' | 'basic';

interface PickableTarget {
  /** The node's own path — unique within a space's tree, used as the React key. */
  key: string;
  depth: number;
  label: string;
  /** What submitting this row actually sends as `targetPath` — childDirOf(node), i.e. "import as a child of this page/folder", the same rule the sidebar's own «+» button already uses (see treeUtils.ts's plusTargetDirFor). */
  dir: string;
  isFolder: boolean;
}

/** Flattens a tree into an indented, pickable list — every page AND folder is a valid import target, not just directories already in use (MoveDialog's narrower `collectDirectories` doesn't fit here: a leaf page with no children yet is still a perfectly good place to import "under"). */
function flattenPickableTargets(nodes: TreeNode[], depth = 0): PickableTarget[] {
  const out: PickableTarget[] = [];
  for (const node of nodes) {
    out.push({ key: node.path, depth, label: treeNodeDisplayTitle(node, nodes), dir: childDirOf(node), isFolder: node.kind === 'folder' });
    out.push(...flattenPickableTargets(node.children, depth + 1));
  }
  return out;
}

/**
 * Owner report 22.09.2026 (3/3): server/confluenceImport.ts used to throw
 * (and the job's `error` field then surfaced verbatim) raw strings like
 * "Confluence API 401 Unauthorized for /rest/api/content/123". ImportJob's
 * `errorCode` (set only for a failed Confluence REST/download call — see
 * that file's confluenceJobErrorCode) picks the human explanation here;
 * `job.error` keeps carrying the full technical detail, shown as a smaller
 * secondary line rather than leading with it.
 */
const CONFLUENCE_ERROR_KEYS: Record<NonNullable<ImportJob['errorCode']>, string> = {
  unauthorized: 'import.errors.confluence.unauthorized',
  forbidden: 'import.errors.confluence.forbidden',
  notFound: 'import.errors.confluence.notFound',
  rateLimited: 'import.errors.confluence.rateLimited',
  unavailable: 'import.errors.confluence.unavailable',
};

/** Shared with git/ConfluenceCredentialsSection.tsx by content (both key off the literal 'confluence-credentials' string) — react-query matches query keys structurally, so a separately-declared array here still hits the same cache entry. */
const CONFLUENCE_CREDENTIALS_QUERY_KEY = ['confluence-credentials'] as const;

/**
 * Built-in Confluence import (round 12): a page URL + on-prem PAT or cloud
 * email+API-token. Round 22b adds saved credentials: as soon as the typed
 * URL's host matches one already saved (see confluenceHost.ts), the auth
 * fields collapse into a one-line "use the saved token" summary — the
 * default whenever a match exists — with a way back to manual entry
 * ("Enter another one"). Manual entry (no match, or the user opted out of the
 * match) additionally offers "save for next time", which the server
 * persists under the URL's own host as a side effect of the import
 * (POST /api/import/confluence's `save`, see confluenceImportRequestSchema
 * in shared/contracts.ts) — no separate save call needed from here.
 */
export function ConfluenceImportDialog({ onClose, currentSpace }: ConfluenceImportDialogProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [pageUrl, setPageUrl] = useState('');
  const [authKind, setAuthKind] = useState<AuthKind>('pat');
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [saveForNextTime, setSaveForNextTime] = useState(true);
  const [manualOverride, setManualOverride] = useState(false);
  const [target, setTarget] = useState<'new' | 'existing'>(currentSpace ? 'existing' : 'new');
  // Two different things used to share one `targetSpace` string: the SLUG of an existing
  // space (a <select> value) and the NAME of a space to create (free text). Opened from a
  // space, "New space" then showed that space's slug in the name field and typing appended
  // to it ("productAcme Handbook"). Each mode keeps its own value; `targetSpace` is the one
  // that applies right now.
  const [existingSpace, setExistingSpace] = useState(currentSpace ?? '');
  const [newSpaceName, setNewSpaceName] = useState('');
  const targetSpace = target === 'new' ? newSpaceName : existingSpace;
  const [targetPath, setTargetPath] = useState('');
  const [includeChildren, setIncludeChildren] = useState(true);

  const [jobId, setJobId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const { data: spacesData } = useQuery({ queryKey: ['spaces'], queryFn: api.listSpaces });
  const spaces = spacesData?.spaces ?? [];

  // Owner report 22.09.2026 (2/3): the target location used to be a free-text
  // path the user had to already know ("docs/imported"). It's now a picker
  // over the target space's own tree — same data Sidebar/PageTree already
  // fetch (['tree', space]), so this shares that cache rather than adding a
  // parallel fetch. Only relevant for "existing" (a "new" space has no tree
  // yet, and always imports at its own root, unchanged).
  const targetTree = useQuery({
    queryKey: ['tree', targetSpace],
    queryFn: () => api.getTree(targetSpace),
    enabled: target === 'existing' && !!targetSpace,
  });
  const pickableTargets = useMemo(() => {
    if (!targetTree.data) return [];
    const top = excludeAgentFolder(excludeTemplatesFolder(getTopLevelNodes(targetTree.data)));
    return flattenPickableTargets(top);
  }, [targetTree.data]);

  // Degrades silently (no banner) on a 404/error — the import stays fully
  // usable via manual auth either way, it just never offers a match.
  const credentials = useQuery({
    queryKey: CONFLUENCE_CREDENTIALS_QUERY_KEY,
    queryFn: api.getConfluenceCredentials,
    retry: false,
  });
  const savedCredentials = credentials.data?.credentials ?? [];

  // Only ever suggest a credential whose host matches what was actually
  // typed — offering an unrelated saved token would risk importing with the
  // wrong identity against a host the user didn't intend (server-side
  // reviewer's own note for this round).
  const detectedHost = useMemo(() => confluenceHostFromUrl(pageUrl), [pageUrl]);
  const matchedCredential = useMemo(
    () => (detectedHost ? savedCredentials.find((c) => c.host === detectedHost) : undefined),
    [detectedHost, savedCredentials],
  );

  // A newly detected host is a fresh decision point — any earlier "enter a
  // different one" override no longer applies to whatever now matches (or
  // doesn't). Keyed on the HOST rather than every keystroke so pasting a
  // full URL doesn't flicker mid-paste.
  useEffect(() => {
    setManualOverride(false);
  }, [detectedHost]);

  const usingSavedCredential = !!matchedCredential && !manualOverride;

  // Polls progress on the job once it's been created.
  const { data: job } = useQuery({
    queryKey: ['import-job', jobId],
    queryFn: () => api.getImportJob(jobId as string),
    enabled: !!jobId,
    refetchInterval: (q) => {
      const s = (q.state.data as ImportJob | undefined)?.status;
      return s === 'done' || s === 'error' ? false : 1000;
    },
  });

  const running = !!jobId && job?.status !== 'done' && job?.status !== 'error';

  async function submit() {
    setSubmitError(null);
    if (!pageUrl.trim()) {
      setSubmitError(t('import.errors.requiredUrl'));
      return;
    }
    if (!usingSavedCredential && (!token.trim() || (authKind === 'basic' && !email.trim()))) {
      setSubmitError(t('import.errors.required'));
      return;
    }
    if (target === 'new' && !targetSpace.trim()) {
      setSubmitError(t('import.errors.spaceName'));
      return;
    }
    setSubmitting(true);
    try {
      const base = {
        pageUrl: pageUrl.trim(),
        targetSpace: targetSpace.trim() || undefined,
        targetPath: target === 'existing' ? targetPath.trim() : '',
        includeChildren,
      };
      const created = await api.startConfluenceImport(
        usingSavedCredential
          ? { ...base, credentialId: matchedCredential!.id }
          : {
              ...base,
              auth:
                authKind === 'pat'
                  ? { kind: 'pat', token: token.trim() }
                  : { kind: 'basic', token: token.trim(), email: email.trim() },
              save: saveForNextTime,
            },
      );
      setJobId(created.id);
      // A fresh save should show up next time the credentials list/settings
      // dialog is opened, without waiting on its own query to happen to
      // refetch on its own.
      if (!usingSavedCredential && saveForNextTime) {
        void queryClient.invalidateQueries({ queryKey: CONFLUENCE_CREDENTIALS_QUERY_KEY });
      }
    } catch (e) {
      setSubmitError(errorText(e, 'import.errors.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  const pct = job && job.total > 0 ? Math.round((job.done / job.total) * 100) : running ? 5 : 0;

  return (
    <Modal title={t('import.title')} onClose={onClose} size="md">
      {!jobId && (
        <div className="flex flex-col gap-3">
          <LabeledInput
            label={t('import.pageUrl')}
            placeholder="https://tracker.example.com/wiki/spaces/DOCS/pages/123/…"
            value={pageUrl}
            onChange={(e) => setPageUrl(e.target.value)}
          />

          {usingSavedCredential ? (
            <div className="flex items-center justify-between gap-2 rounded-md border border-neutral-200 px-3 py-2 text-sm text-neutral-600 dark:border-neutral-700 dark:text-neutral-400">
              <span className="min-w-0 truncate">{t('import.savedCredential.using', { label: matchedCredential!.label })}</span>
              <button
                type="button"
                onClick={() => setManualOverride(true)}
                className="shrink-0 text-xs text-neutral-500 underline underline-offset-2 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
              >
                {t('import.savedCredential.useManual')}
              </button>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-1 text-sm">
                <span className="text-neutral-600 dark:text-neutral-400">{t('import.authKind.label')}</span>
                <div className="flex gap-2">
                  {(['pat', 'basic'] as const).map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setAuthKind(k)}
                      className={`flex-1 rounded-md border px-3 py-1.5 text-sm ${
                        authKind === k
                          ? 'border-neutral-800 bg-neutral-800 text-white dark:border-neutral-200 dark:bg-neutral-200 dark:text-neutral-900'
                          : 'border-neutral-300 text-neutral-700 dark:border-neutral-700 dark:text-neutral-300'
                      }`}
                    >
                      {t(`import.authKind.${k}`)}
                    </button>
                  ))}
                </div>
              </div>

              {authKind === 'basic' && (
                <LabeledInput label={t('import.email')} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              )}
              <LabeledInput
                label={authKind === 'pat' ? t('import.pat') : t('import.apiToken')}
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
                <input type="checkbox" checked={saveForNextTime} onChange={(e) => setSaveForNextTime(e.target.checked)} />
                {t('import.saveForNextTime')}
              </label>
            </>
          )}

          <div className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-600 dark:text-neutral-400">{t('import.target.label')}</span>
            <div className="flex gap-2">
              {(['new', 'existing'] as const).map((tt) => (
                <button
                  key={tt}
                  type="button"
                  onClick={() => setTarget(tt)}
                  className={`flex-1 rounded-md border px-3 py-1.5 text-sm ${
                    target === tt
                      ? 'border-neutral-800 bg-neutral-800 text-white dark:border-neutral-200 dark:bg-neutral-200 dark:text-neutral-900'
                      : 'border-neutral-300 text-neutral-700 dark:border-neutral-700 dark:text-neutral-300'
                  }`}
                >
                  {t(`import.target.${tt}`)}
                </button>
              ))}
            </div>
          </div>

          {target === 'new' ? (
            <LabeledInput label={t('import.newSpaceName')} value={newSpaceName} onChange={(e) => setNewSpaceName(e.target.value)} />
          ) : (
            <>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-neutral-600 dark:text-neutral-400">{t('import.existingSpace')}</span>
                <select
                  value={existingSpace}
                  onChange={(e) => {
                    setExistingSpace(e.target.value);
                    // A path picked in the PREVIOUS space's tree means nothing
                    // in a different one — back to that space's own root.
                    setTargetPath('');
                  }}
                  className="rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm dark:border-neutral-700"
                >
                  <option value="">—</option>
                  {spaces.map((s) => (
                    <option key={s.slug} value={s.slug}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>

              <div className="flex flex-col gap-1 text-sm">
                <span className="text-neutral-600 dark:text-neutral-400">{t('import.targetPath')}</span>
                <div className="max-h-48 overflow-y-auto rounded-md border border-neutral-200 dark:border-neutral-700">
                  <button
                    type="button"
                    onClick={() => setTargetPath('')}
                    className={`flex w-full items-center gap-2 border-b border-neutral-100 px-2.5 py-1.5 text-left last:border-b-0 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-800 ${
                      targetPath === '' ? 'bg-neutral-100 font-medium dark:bg-neutral-800' : ''
                    }`}
                  >
                    <Folder size={14} className="shrink-0 opacity-60" aria-hidden="true" />
                    <span className="truncate">{t('sidebar.move.spaceRoot')}</span>
                  </button>
                  {targetTree.isLoading && targetSpace && (
                    <p className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-neutral-400 dark:text-neutral-500">
                      <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                      {t('ui.loading')}
                    </p>
                  )}
                  {pickableTargets.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => setTargetPath(item.dir)}
                      title={item.label}
                      style={{ paddingLeft: `${10 + (item.depth + 1) * 14}px` }}
                      className={`flex w-full items-center gap-2 border-b border-neutral-100 px-2.5 py-1.5 text-left last:border-b-0 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-800 ${
                        targetPath === item.dir ? 'bg-neutral-100 font-medium dark:bg-neutral-800' : ''
                      }`}
                    >
                      {item.isFolder ? (
                        <Folder size={14} className="shrink-0 opacity-60" aria-hidden="true" />
                      ) : (
                        <FileText size={14} className="shrink-0 opacity-60" aria-hidden="true" />
                      )}
                      <span className="truncate">{item.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
            <input type="checkbox" checked={includeChildren} onChange={(e) => setIncludeChildren(e.target.checked)} />
            {t('import.includeChildren')}
          </label>

          {submitError && <p className="text-sm text-red-600 dark:text-red-400">{submitError}</p>}

          <div className="mt-1 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-sm text-neutral-600 dark:text-neutral-400"
            >
              {t('ui.cancel')}
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={submitting}
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
            >
              {submitting ? t('import.starting') : t('import.start')}
            </button>
          </div>
        </div>
      )}

      {jobId && (
        <div className="flex flex-col gap-3">
          {job?.status !== 'error' && (
            <>
              <div className="h-2 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
                <div className="h-full bg-emerald-600 transition-all" style={{ width: `${pct}%` }} />
              </div>
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                {job?.status === 'done'
                  ? t('import.doneCount', { count: job.done })
                  : t('import.progress', { done: job?.done ?? 0, total: job?.total ?? 0 })}
                {job?.currentTitle && job.status !== 'done' ? ` · ${job.currentTitle}` : ''}
              </p>
            </>
          )}

          {job?.status === 'error' && (
            <div className="flex flex-col gap-1">
              <p className="text-sm text-red-600 dark:text-red-400">
                {job.errorCode ? t(CONFLUENCE_ERROR_KEYS[job.errorCode]) : job.error || t('import.errors.generic')}
              </p>
              {/* Raw technical detail stays available for diagnosis, just not in the lead — see CONFLUENCE_ERROR_KEYS' docblock. */}
              {job.errorCode && job.error && <p className="text-xs text-neutral-400 dark:text-neutral-500">{job.error}</p>}
            </div>
          )}

          <div className="mt-1 flex justify-end gap-2">
            {job?.status === 'done' && job.targetSpace ? (
              <button
                type="button"
                onClick={() => {
                  navigate(`/s/${job.targetSpace}`);
                  onClose();
                }}
                className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900"
              >
                {t('import.openSpace')}
              </button>
            ) : (
              <button
                type="button"
                onClick={onClose}
                className="rounded-md px-3 py-1.5 text-sm text-neutral-600 dark:text-neutral-400"
              >
                {running ? t('import.runInBackground') : t('ui.close')}
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
