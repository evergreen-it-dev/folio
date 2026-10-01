import { describe, expect, it } from 'vitest';
import { sanitizeMermaidId } from './mermaidId';

describe('sanitizeMermaidId', () => {
  it('strips characters that are unsafe as DOM ids (e.g. useId colons)', () => {
    expect(sanitizeMermaidId(':r3:')).toBe('mermaid-r3');
  });

  it('keeps alphanumerics, hyphens and underscores', () => {
    expect(sanitizeMermaidId('a1_b-2')).toBe('mermaid-a1_b-2');
  });

  it('falls back to a stable placeholder when nothing survives sanitization', () => {
    expect(sanitizeMermaidId(':::')).toBe('mermaid-diagram');
  });

  it('is stable for the same input (idempotent, no randomness)', () => {
    expect(sanitizeMermaidId(':r7:')).toBe(sanitizeMermaidId(':r7:'));
  });
});
