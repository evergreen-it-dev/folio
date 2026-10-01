import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ComboBox } from '../ui/ComboBox';
import { filterBranches } from './gitBranches';
import '../i18n/register';

export interface BranchFieldProps {
  value: string;
  onChange: (value: string) => void;
  loading: boolean;
  /** Present only once a fetch has actually resolved with a non-empty branch list. */
  branches: string[] | undefined;
  /** POST /api/git/branches succeeded and reported `empty: true` — no branches, none to pick from. */
  emptyRepo: boolean;
  /** The fetch itself failed (network error, non-2xx, or the endpoint 404ing because SERVER hasn't shipped it yet). */
  fetchError: boolean;
}

/**
 * The create-space git tab's branch field (round 5 follow-up: "it would be
 * good if branches were pulled in automatically"). Round 19 (#6-ux) pulled
 * the actual input+dropdown+keyboard-nav mechanics out into ui/ComboBox
 * once the repository field needed "the same combobox pattern" (DEV-PLAN's
 * Round 19 SHELL section) — this file now only owns branch-specific
 * filtering (gitBranches.ts's filterBranches, unchanged and still
 * independently tested there) and the emptyRepo/fetchError hints. Props and
 * behavior are otherwise identical to before this refactor.
 */
export function BranchField({ value, onChange, loading, branches, emptyRepo, fetchError }: BranchFieldProps) {
  const { t } = useTranslation('app');
  // undefined (not []) when `branches` itself is undefined -- matches
  // ComboBox's own "no suggestion source yet" vs. "filtered to nothing"
  // distinction, same as this field's pre-refactor showDropdown condition.
  const filtered = useMemo(() => (branches ? filterBranches(value, branches) : undefined), [branches, value]);
  const options = useMemo(() => filtered?.map((b) => ({ value: b, label: b })), [filtered]);

  return (
    <div>
      <ComboBox
        value={value}
        onChange={onChange}
        options={options}
        loading={loading}
        placeholder="main"
        listboxId="folio-branch-listbox"
        ariaLabel={t('sidebar.createSpace.branch')}
      />
      {emptyRepo && (
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{t('sidebar.branchField.emptyRepo')}</p>
      )}
      {fetchError && (
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{t('sidebar.branchField.fetchError')}</p>
      )}
    </div>
  );
}
