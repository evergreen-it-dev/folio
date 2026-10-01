/**
 * Pure pieces for CreateSpaceDialog's git-branch combobox (round 5
 * follow-up: "it would be good if branches were pulled in automatically").
 */

export interface BranchFieldState {
  value: string;
  /** Once true, nothing but a direct user edit can ever change `value` again — an 'autofill' (the fetched repo's defaultBranch) is ignored from then on. */
  touched: boolean;
}

export type BranchFieldAction =
  /** The user typed in the field, or clicked a branch in the dropdown — both are "the user decided the value", same touched semantics. */
  | { type: 'edit'; value: string }
  /** The repo's defaultBranch arrived from POST /api/git/branches. */
  | { type: 'autofill'; value: string };

/**
 * A manual edit always wins and marks the field touched, so no later
 * autofill can silently overwrite a user's choice. An autofill only takes
 * effect while the field is still untouched — this is also how the "empty
 * repo -> keep main" requirement falls out for free: an empty repo's
 * defaultBranch is null, so callers simply never dispatch an autofill for
 * it, and the field just stays at whatever it already was (the 'main'
 * the field starts at, unless the user touched it).
 */
export function branchFieldReducer(state: BranchFieldState, action: BranchFieldAction): BranchFieldState {
  if (action.type === 'edit') return { value: action.value, touched: true };
  if (state.touched) return state;
  return { value: action.value, touched: false };
}

/** Case-insensitive substring filter for the branch dropdown ("filter as you type"). Empty query -> every branch, in the given order. */
export function filterBranches(query: string, branches: readonly string[]): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...branches];
  return branches.filter((b) => b.toLowerCase().includes(q));
}
