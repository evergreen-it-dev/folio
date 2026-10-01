import { describe, expect, it } from 'vitest';
import { confluenceHostFromUrl } from './confluenceHost';

describe('confluenceHostFromUrl', () => {
  it('extracts a lower-cased host from a full https URL', () => {
    expect(confluenceHostFromUrl('https://Tracker.Example.com/wiki/spaces/DOCS/pages/123/Title')).toBe('tracker.example.com');
  });

  it('keeps a non-default port as part of the host', () => {
    expect(confluenceHostFromUrl('https://tracker.example.com:8443/wiki/pages/123')).toBe('tracker.example.com:8443');
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(confluenceHostFromUrl('  https://tracker.example.com/wiki/pages/123  ')).toBe('tracker.example.com');
  });

  it('is unaffected by a trailing slash or query string', () => {
    expect(confluenceHostFromUrl('https://tracker.example.com/')).toBe('tracker.example.com');
    expect(confluenceHostFromUrl('https://tracker.example.com/wiki?x=1')).toBe('tracker.example.com');
  });

  it('returns undefined for an empty string', () => {
    expect(confluenceHostFromUrl('')).toBeUndefined();
  });

  it('returns undefined for a partially-typed / schemeless value instead of throwing', () => {
    expect(confluenceHostFromUrl('tracker.example.com/wiki')).toBeUndefined();
    expect(confluenceHostFromUrl('https://')).toBeUndefined();
    expect(confluenceHostFromUrl('not a url at all')).toBeUndefined();
  });
});
