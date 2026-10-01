import { describe, expect, it } from 'vitest';
import { humanize, resolveRenameCommit } from './Breadcrumbs';

describe('humanize', () => {
  it('replaces hyphens and underscores with spaces', () => {
    expect(humanize('data-flow')).toBe('Data Flow');
    expect(humanize('data_flow')).toBe('Data Flow');
  });

  it('collapses runs of separators into one space', () => {
    expect(humanize('data--flow__diagram')).toBe('Data Flow Diagram');
  });

  it('title-cases each word', () => {
    expect(humanize('architecture')).toBe('Architecture');
    expect(humanize('onboarding-guide')).toBe('Onboarding Guide');
  });

  it('leaves an already-clean segment alone beyond casing', () => {
    expect(humanize('faq')).toBe('Faq');
  });

  it('handles an empty string', () => {
    expect(humanize('')).toBe('');
  });
});

describe('resolveRenameCommit', () => {
  it('returns the trimmed title for a real edit', () => {
    expect(resolveRenameCommit('New Title', 'Old Title')).toBe('New Title');
  });

  it('trims leading/trailing whitespace', () => {
    expect(resolveRenameCommit('  New Title  ', 'Old Title')).toBe('New Title');
  });

  it('returns null for a blank draft', () => {
    expect(resolveRenameCommit('', 'Old Title')).toBeNull();
    expect(resolveRenameCommit('   ', 'Old Title')).toBeNull();
  });

  it('returns null when the trimmed draft equals the current title (focus-then-blur, no real edit)', () => {
    expect(resolveRenameCommit('Old Title', 'Old Title')).toBeNull();
    expect(resolveRenameCommit('  Old Title  ', 'Old Title')).toBeNull();
  });

  it('treats a whitespace-only change as a real edit if it changes non-trimmed content', () => {
    // Internal whitespace changes ARE a real edit — only leading/trailing gets trimmed.
    expect(resolveRenameCommit('Old  Title', 'Old Title')).toBe('Old  Title');
  });
});
