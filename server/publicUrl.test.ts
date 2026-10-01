import { afterEach, describe, expect, it } from 'vitest';
import { normalizePublicUrl, publicUrlOrOrigin } from './publicUrl.js';

describe('normalizePublicUrl (round 19 point 1)', () => {
  it('leaves an already-schemed URL untouched (http, https, and a non-http scheme)', () => {
    expect(normalizePublicUrl('https://folio.example.com')).toBe('https://folio.example.com');
    expect(normalizePublicUrl('http://folio.example.com')).toBe('http://folio.example.com');
    expect(normalizePublicUrl('custom-scheme://folio.example.com')).toBe('custom-scheme://folio.example.com');
  });

  it('adds https:// to a bare host — the Coolify SERVICE_FQDN_APP shape that started this round', () => {
    expect(normalizePublicUrl('folio.example.com')).toBe('https://folio.example.com');
  });

  it('adds http:// (not https://) for localhost and 127.0.0.1, with or without a port', () => {
    expect(normalizePublicUrl('localhost')).toBe('http://localhost');
    expect(normalizePublicUrl('localhost:4871')).toBe('http://localhost:4871');
    expect(normalizePublicUrl('127.0.0.1')).toBe('http://127.0.0.1');
    expect(normalizePublicUrl('127.0.0.1:4871')).toBe('http://127.0.0.1:4871');
  });

  it('trims surrounding whitespace and a stray leading slash before deciding', () => {
    expect(normalizePublicUrl('  folio.example.com  ')).toBe('https://folio.example.com');
    expect(normalizePublicUrl('//folio.example.com')).toBe('https://folio.example.com');
  });
});

describe('publicUrlOrOrigin', () => {
  const original = process.env.PUBLIC_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = original;
  });

  it('falls back to originFallback (untouched) when PUBLIC_URL is unset or empty', () => {
    delete process.env.PUBLIC_URL;
    expect(publicUrlOrOrigin('http://fallback.test')).toBe('http://fallback.test');
    process.env.PUBLIC_URL = '';
    expect(publicUrlOrOrigin('http://fallback.test')).toBe('http://fallback.test');
  });

  it('normalizes a schemeless PUBLIC_URL instead of using it verbatim', () => {
    process.env.PUBLIC_URL = 'folio.example.com';
    expect(publicUrlOrOrigin('http://fallback.test')).toBe('https://folio.example.com');
  });

  it('strips a trailing slash regardless of which source (PUBLIC_URL or fallback) was used', () => {
    process.env.PUBLIC_URL = 'https://folio.example.com/';
    expect(publicUrlOrOrigin('http://fallback.test')).toBe('https://folio.example.com');
    delete process.env.PUBLIC_URL;
    expect(publicUrlOrOrigin('http://fallback.test/')).toBe('http://fallback.test');
  });
});
