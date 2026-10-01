import { describe, expect, it } from 'vitest';
import { branchFieldReducer, filterBranches } from './gitBranches';
import type { BranchFieldState } from './gitBranches';

describe('branchFieldReducer', () => {
  const initial: BranchFieldState = { value: 'main', touched: false };

  it('an edit sets the value and marks the field touched', () => {
    expect(branchFieldReducer(initial, { type: 'edit', value: 'develop' })).toEqual({
      value: 'develop',
      touched: true,
    });
  });

  it('an autofill sets the value while untouched, and stays untouched', () => {
    expect(branchFieldReducer(initial, { type: 'autofill', value: 'master' })).toEqual({
      value: 'master',
      touched: false,
    });
  });

  it('an autofill is ignored once the field has been touched', () => {
    const touched: BranchFieldState = { value: 'develop', touched: true };
    expect(branchFieldReducer(touched, { type: 'autofill', value: 'master' })).toBe(touched);
  });

  it('a later edit always wins even after an earlier autofill', () => {
    const afterAutofill = branchFieldReducer(initial, { type: 'autofill', value: 'master' });
    expect(branchFieldReducer(afterAutofill, { type: 'edit', value: 'feature/x' })).toEqual({
      value: 'feature/x',
      touched: true,
    });
  });

  it('a second autofill after touch still has no effect (empty-repo "keep main" falls out of simply never dispatching)', () => {
    const touched = branchFieldReducer(initial, { type: 'edit', value: 'main' });
    expect(touched).toEqual({ value: 'main', touched: true });
    expect(branchFieldReducer(touched, { type: 'autofill', value: 'develop' })).toBe(touched);
  });
});

describe('filterBranches', () => {
  const branches = ['main', 'develop', 'feature/login', 'feature/logout', 'release/1.0'];

  it('returns every branch, in order, for an empty query', () => {
    expect(filterBranches('', branches)).toEqual(branches);
    expect(filterBranches('   ', branches)).toEqual(branches);
  });

  it('filters case-insensitively by substring', () => {
    expect(filterBranches('FEAT', branches)).toEqual(['feature/login', 'feature/logout']);
  });

  it('matches a substring anywhere, not just a prefix', () => {
    expect(filterBranches('log', branches)).toEqual(['feature/login', 'feature/logout']);
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterBranches('zzz', branches)).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const copy = [...branches];
    filterBranches('main', branches);
    expect(branches).toEqual(copy);
  });
});
