import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import type { AccessMatrixUser, SpaceRole } from '@shared/contracts';
import { roleLabel } from '../../auth/roles';
import '../../i18n/register';

export interface AccessBlockRow {
  id: number;
  space: string;
  role: SpaceRole;
}

let nextRowId = 0;
/** Fresh id for a new row — module-level counter, same pattern as invites/InviteDialog.tsx's own MembershipRow. */
export function nextAccessRowId(): number {
  return nextRowId++;
}

const ROLE_OPTIONS: SpaceRole[] = ['viewer', 'editor', 'admin'];

export interface AccessBlockEditorProps {
  rows: AccessBlockRow[];
  onChange: (rows: AccessBlockRow[]) => void;
  spaceOptions: { slug: string; name: string }[];
  disabled?: boolean;
  /**
   * Round 27 §6.4's "copy another user's access" — omitted
   * entirely (rather than shown disabled) when the caller has no matrix data
   * to copy from yet (e.g. still loading).
   */
  copyFrom?: {
    users: AccessMatrixUser[];
    roles: Record<string, Record<string, SpaceRole>>;
  };
}

/**
 * Repeatable "space + role" rows — round 27 §6.4: shared by AddPersonDialog
 * (the "Add a person" dialog's access block) and invites/InviteDialog.tsx's
 * own membership rows, per the spec's explicit "the same block is reused in
 * the invitation dialog".
 */
export function AccessBlockEditor({ rows, onChange, spaceOptions, disabled, copyFrom }: AccessBlockEditorProps) {
  const { t } = useTranslation('app');
  const [copySourceId, setCopySourceId] = useState('');

  function addRow() {
    onChange([...rows, { id: nextAccessRowId(), space: '', role: 'viewer' }]);
  }

  function updateRow(id: number, patch: Partial<AccessBlockRow>) {
    onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function removeRow(id: number) {
    onChange(rows.filter((r) => r.id !== id));
  }

  function applyCopy() {
    if (!copyFrom || !copySourceId) return;
    const sourceRoles = copyFrom.roles[copySourceId] ?? {};
    const existingSpaces = new Set(rows.map((r) => r.space).filter(Boolean));
    const copied = Object.entries(sourceRoles)
      .filter(([space]) => !existingSpaces.has(space))
      .map(([space, role]) => ({ id: nextAccessRowId(), space, role }));
    if (copied.length > 0) onChange([...rows, ...copied]);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-neutral-500 dark:text-neutral-400">{t('access.block.title')}</span>

      {rows.map((row) => (
        <div key={row.id} className="flex items-center gap-1.5">
          <select
            value={row.space}
            disabled={disabled}
            onChange={(e) => updateRow(row.id, { space: e.target.value })}
            aria-label={t('access.block.spaceLabel')}
            className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm text-neutral-800 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-200"
          >
            <option value="">{t('access.block.selectSpace')}</option>
            {spaceOptions.map((s) => (
              <option key={s.slug} value={s.slug}>
                {s.name}
              </option>
            ))}
          </select>
          <select
            value={row.role}
            disabled={disabled}
            onChange={(e) => updateRow(row.id, { role: e.target.value as SpaceRole })}
            aria-label={t('access.block.roleLabel')}
            className="rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm text-neutral-800 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-200"
          >
            {ROLE_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={disabled}
            onClick={() => removeRow(row.id)}
            aria-label={t('ui.remove')}
            className="shrink-0 rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-red-600 disabled:opacity-50 dark:hover:bg-neutral-800"
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}

      <button
        type="button"
        disabled={disabled}
        onClick={addRow}
        className="flex w-fit items-center gap-1 text-xs text-neutral-500 hover:text-neutral-700 disabled:opacity-50 dark:text-neutral-400 dark:hover:text-neutral-200"
      >
        <Plus size={12} /> {t('access.block.addSpace')}
      </button>

      {copyFrom && copyFrom.users.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5 border-t border-neutral-100 pt-2 dark:border-neutral-800">
          <label className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
            {t('access.block.copyFrom')}
            <select
              value={copySourceId}
              disabled={disabled}
              onChange={(e) => setCopySourceId(e.target.value)}
              className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-xs text-neutral-800 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-200"
            >
              <option value="">{t('access.block.selectUser')}</option>
              {copyFrom.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.email})
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={disabled || !copySourceId}
            onClick={applyCopy}
            className="shrink-0 rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            {t('access.block.copyApply')}
          </button>
        </div>
      )}
    </div>
  );
}
