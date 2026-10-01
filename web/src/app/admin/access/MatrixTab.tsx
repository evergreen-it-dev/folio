import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { AccessMatrixResponse, SpaceRole, SpaceVisibility } from '@shared/contracts';
import { api } from '../../api';
import { useApiErrorText } from '../../errorText';
import { roleLabel } from '../../auth/roles';
import { useToast } from '../../ui/Toast';
import { Menu, MenuItem } from '../../ui/Menu';
import { copyMembershipsPlan, matchesSpaceQuery, matchesUserQuery, matrixCellState } from './logic';
import { VisibilityConfirmDialog } from './VisibilityConfirmDialog';
import '../../i18n/register';

export interface MatrixTabProps {
  matrix: AccessMatrixResponse;
}

const ROLE_OPTIONS: SpaceRole[] = ['viewer', 'editor', 'admin'];

/**
 * §6.2 — users x spaces grid, the "main answer to 'it must be convenient for me'".
 * No virtualization library (none is in package.json, and this round can't
 * add one — no npm install available); the frozen header/first-column trick
 * is plain CSS `sticky` inside one scroll container, which holds up fine at
 * the instance sizes this product actually runs at (see report). A future
 * agent with real large-instance data should revisit before assuming this
 * scales past a few hundred rows.
 */
export function MatrixTab({ matrix }: MatrixTabProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const queryClient = useQueryClient();
  const showToast = useToast();

  const [userQuery, setUserQuery] = useState('');
  const [spaceQuery, setSpaceQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkSpace, setBulkSpace] = useState('');
  const [bulkRole, setBulkRole] = useState<SpaceRole | ''>('');
  const [visibilityTarget, setVisibilityTarget] = useState<{ slug: string; name: string; next: SpaceVisibility } | null>(null);

  const users = useMemo(() => matrix.users.filter((u) => matchesUserQuery(u, userQuery)), [matrix.users, userQuery]);
  const spaces = useMemo(() => matrix.spaces.filter((s) => matchesSpaceQuery(s, spaceQuery)), [matrix.spaces, spaceQuery]);

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['access', 'matrix'] });
    queryClient.invalidateQueries({ queryKey: ['admin', 'spaces'] });
  }

  const cellChange = useMutation({
    mutationFn: (vars: { userId: string; space: string; role: SpaceRole | null }) =>
      api.applyAccessBulk({ changes: [vars] }),
    onSuccess: (result) => {
      invalidate();
      // The per-row error is a server-authored string inside a 200 body, not
      // an ApiError — same English, same treatment (QA-3 #9).
      if (result.errors[0]) showToast(errorText(result.errors[0].error));
    },
    onError: (err) => showToast(errorText(err, 'access.matrix.changeFailed')),
  });

  const bulkChange = useMutation({
    mutationFn: async (vars: { changes: { userId: string; space: string; role: SpaceRole | null }[] }) => {
      // Captures the pre-change role of every affected cell so a follow-up
      // "Undo" can restore it with one more bulk call — spec §6.2:
      // "all changes... with a toast and the possibility to undo".
      const previous = vars.changes.map((c) => ({ userId: c.userId, space: c.space, role: matrix.roles[c.userId]?.[c.space] ?? null }));
      const result = await api.applyAccessBulk({ changes: vars.changes });
      return { result, previous };
    },
    onSuccess: ({ result, previous }) => {
      invalidate();
      if (result.errors.length > 0) {
        showToast(t('access.matrix.bulkPartialFailure', { count: result.errors.length }));
      } else {
        showToast(t('access.matrix.bulkApplied', { count: result.applied.length }), 'info');
      }
      setSelected(new Set());
      setBulkSpace('');
      setBulkRole('');
      // Spec §6.2: "with a toast and the possibility to undo" — the pre-change role
      // of every affected cell, captured before this batch applied, so one
      // more bulk call can restore it exactly (see the `undo` mutation below).
      setLastBulk(previous);
    },
    onError: (err) => showToast(errorText(err, 'access.matrix.changeFailed')),
  });

  const undo = useMutation({
    mutationFn: (changes: { userId: string; space: string; role: SpaceRole | null }[]) => api.applyAccessBulk({ changes }),
    onSuccess: (result) => {
      invalidate();
      if (result.errors.length > 0) showToast(t('access.matrix.bulkPartialFailure', { count: result.errors.length }));
      else showToast(t('access.matrix.undone'), 'info');
    },
  });

  const copyMembers = useMutation({
    mutationFn: (vars: { source: string; target: string }) =>
      api.applyAccessBulk({ changes: copyMembershipsPlan(matrix, vars.source, vars.target) }),
    onSuccess: (result) => {
      invalidate();
      if (result.errors.length > 0) showToast(t('access.matrix.bulkPartialFailure', { count: result.errors.length }));
      else showToast(t('access.matrix.bulkApplied', { count: result.applied.length }), 'info');
    },
    onError: (err) => showToast(errorText(err, 'access.matrix.changeFailed')),
  });

  const setVisibility = useMutation({
    mutationFn: (vars: { slug: string; visibility: SpaceVisibility }) => api.setSpaceVisibility(vars.slug, { visibility: vars.visibility }),
    onSuccess: () => {
      invalidate();
      setVisibilityTarget(null);
    },
    onError: (err) => showToast(errorText(err, 'access.spaces.visibilityFailed')),
  });

  function toggleSelected(userId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  function applyBulk() {
    if (!bulkSpace || selected.size === 0) return;
    const role = bulkRole === '' ? null : bulkRole;
    const changes = [...selected].map((userId) => ({ userId, space: bulkSpace, role }));
    bulkChange.mutate({ changes });
  }

  const [lastBulk, setLastBulk] = useState<{ userId: string; space: string; role: SpaceRole | null }[] | null>(null);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={userQuery}
          onChange={(e) => setUserQuery(e.target.value)}
          placeholder={t('access.matrix.searchUsers')}
          aria-label={t('access.matrix.searchUsers')}
          className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-transparent px-2.5 py-1.5 text-sm text-neutral-800 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:text-neutral-200"
        />
        <input
          value={spaceQuery}
          onChange={(e) => setSpaceQuery(e.target.value)}
          placeholder={t('access.matrix.searchSpaces')}
          aria-label={t('access.matrix.searchSpaces')}
          className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-transparent px-2.5 py-1.5 text-sm text-neutral-800 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:text-neutral-200"
        />
      </div>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-neutral-300 bg-neutral-50 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-900">
          <span className="text-xs text-neutral-600 dark:text-neutral-400">{t('access.matrix.selectedCount', { count: selected.size })}</span>
          <select
            value={bulkSpace}
            onChange={(e) => setBulkSpace(e.target.value)}
            className="rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-xs text-neutral-800 dark:border-neutral-700 dark:text-neutral-200"
          >
            <option value="">{t('access.block.selectSpace')}</option>
            {matrix.spaces.map((s) => (
              <option key={s.slug} value={s.slug}>
                {s.name}
              </option>
            ))}
          </select>
          <select
            value={bulkRole}
            onChange={(e) => setBulkRole(e.target.value as SpaceRole | '')}
            className="rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-xs text-neutral-800 dark:border-neutral-700 dark:text-neutral-200"
          >
            <option value="">{t('access.matrix.revoke')}</option>
            {ROLE_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!bulkSpace || bulkChange.isPending}
            onClick={applyBulk}
            className="rounded-md bg-neutral-900 px-2.5 py-1 text-xs text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {t('access.matrix.applyBulk')}
          </button>
          {lastBulk && (
            <button
              type="button"
              disabled={undo.isPending}
              onClick={() => {
                undo.mutate(lastBulk);
                setLastBulk(null);
              }}
              className="text-xs text-neutral-600 underline underline-offset-2 hover:text-neutral-900 disabled:opacity-50 dark:text-neutral-400 dark:hover:text-neutral-100"
            >
              {t('access.matrix.undo')}
            </button>
          )}
        </div>
      )}

      <div className="max-h-[70vh] overflow-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-20 min-w-[200px] border-b border-r border-neutral-200 bg-neutral-50 px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
                {t('access.matrix.person')}
              </th>
              {spaces.map((s) => (
                <th
                  key={s.slug}
                  className="sticky top-0 z-10 min-w-[140px] border-b border-neutral-200 bg-neutral-50 px-2 py-1 text-left align-top text-xs font-medium text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300"
                >
                  <SpaceHeaderCell
                    space={s}
                    onSetVisibility={(next) => setVisibilityTarget({ slug: s.slug, name: s.name, next })}
                    onCopyFrom={(source) => copyMembers.mutate({ source, target: s.slug })}
                    allSpaces={matrix.spaces}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-b border-neutral-100 last:border-b-0 dark:border-neutral-800/60">
                <td className="sticky left-0 z-10 min-w-[200px] border-r border-neutral-200 bg-white px-3 py-1.5 dark:border-neutral-800 dark:bg-neutral-950">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={selected.has(u.id)} onChange={() => toggleSelected(u.id)} aria-label={u.name} />
                    <span className="min-w-0 flex-1 truncate text-sm text-neutral-800 dark:text-neutral-200">{u.name}</span>
                  </label>
                </td>
                {spaces.map((s) => {
                  const state = matrixCellState(s, matrix.roles[u.id]?.[s.slug]);
                  return (
                    <td key={s.slug} className="px-2 py-1">
                      {state.kind === 'implicit-viewer' ? (
                        <span className="block rounded-md bg-neutral-100 px-2 py-1 text-center text-xs text-neutral-400 dark:bg-neutral-800 dark:text-neutral-500">
                          {t('access.matrix.implicitViewer')}
                        </span>
                      ) : (
                        <select
                          value={state.kind === 'explicit' ? state.role : ''}
                          disabled={cellChange.isPending}
                          onChange={(e) =>
                            cellChange.mutate({ userId: u.id, space: s.slug, role: (e.target.value || null) as SpaceRole | null })
                          }
                          className="w-full rounded-md border border-neutral-300 bg-transparent px-1.5 py-1 text-xs text-neutral-800 dark:border-neutral-700 dark:text-neutral-200"
                        >
                          <option value="">—</option>
                          {ROLE_OPTIONS.map((r) => (
                            <option key={r} value={r}>
                              {roleLabel(r)}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {visibilityTarget && (
        <VisibilityConfirmDialog
          matrix={matrix}
          space={visibilityTarget.slug}
          spaceName={visibilityTarget.name}
          next={visibilityTarget.next}
          busy={setVisibility.isPending}
          onCancel={() => setVisibilityTarget(null)}
          onConfirm={() => setVisibility.mutate({ slug: visibilityTarget.slug, visibility: visibilityTarget.next })}
        />
      )}
    </div>
  );
}

function SpaceHeaderCell({
  space,
  onSetVisibility,
  onCopyFrom,
  allSpaces,
}: {
  space: AccessMatrixResponse['spaces'][number];
  onSetVisibility: (next: SpaceVisibility) => void;
  onCopyFrom: (source: string) => void;
  allSpaces: AccessMatrixResponse['spaces'];
}) {
  const { t } = useTranslation('app');
  const otherSpaces = allSpaces.filter((s) => s.slug !== space.slug);

  return (
    <div className="flex items-center justify-between gap-1">
      <span className="truncate" title={space.name}>
        {space.name}
      </span>
      <Menu
        trigger={<span aria-hidden="true">···</span>}
        triggerLabel={t('access.matrix.spaceActions', { name: space.name })}
        align="right"
      >
        {(close) => (
          <>
            <MenuItem
              onSelect={() => {
                onSetVisibility(space.visibility === 'instance' ? 'private' : 'instance');
                close();
              }}
            >
              {space.visibility === 'instance' ? t('access.spaces.makePrivate') : t('access.spaces.makeInstance')}
            </MenuItem>
            {otherSpaces.length > 0 && (
              <CopyMembersSubmenu spaces={otherSpaces} onPick={(source) => (onCopyFrom(source), close())} />
            )}
            {/* A plain Link (renders <a>), not MenuItem (renders <button>) — nesting an
                anchor inside a button is invalid HTML, so this is styled to match
                MenuItem's own classes instead of wrapping one. */}
            <Link
              to={`/s/${space.slug}`}
              onClick={close}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              {t('access.matrix.goToSpace')}
            </Link>
          </>
        )}
      </Menu>
    </div>
  );
}

function CopyMembersSubmenu({ spaces, onPick }: { spaces: AccessMatrixResponse['spaces']; onPick: (source: string) => void }) {
  const { t } = useTranslation('app');
  const [open, setOpen] = useState(false);
  return (
    <div>
      <MenuItem onSelect={() => setOpen((o) => !o)}>{t('access.matrix.copyMembersFrom')}</MenuItem>
      {open && (
        <div className="max-h-40 overflow-y-auto border-t border-neutral-100 pl-2 dark:border-neutral-800">
          {spaces.map((s) => (
            <MenuItem key={s.slug} onSelect={() => onPick(s.slug)}>
              {s.name}
            </MenuItem>
          ))}
        </div>
      )}
    </div>
  );
}
