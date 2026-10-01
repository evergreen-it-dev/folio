import { beforeAll, describe, expect, it } from 'vitest';
import i18next from 'i18next';
import { buildMcpJson, buildMcpSnippet, formatScopes } from './mcpSnippet';
import '../i18n/register';

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

describe('formatScopes', () => {
  it('formats a single scope', () => {
    expect(formatScopes(['read'])).toBe('Read');
    expect(formatScopes(['write'])).toBe('Write');
  });

  it('always orders read before write, regardless of input order', () => {
    expect(formatScopes(['write', 'read'])).toBe('Read, Write');
    expect(formatScopes(['read', 'write'])).toBe('Read, Write');
  });

  it('returns an empty string for an empty scope list', () => {
    expect(formatScopes([])).toBe('');
  });
});

describe('buildMcpSnippet', () => {
  it('builds the exact DEV-PLAN command shape with a real token', () => {
    expect(buildMcpSnippet('https://folio.example.com', 'folio_pat_abc123')).toBe(
      'claude mcp add folio --transport http https://folio.example.com/mcp --header "Authorization: Bearer folio_pat_abc123"',
    );
  });

  it('substitutes a placeholder when no fresh token is on screen', () => {
    const snippet = buildMcpSnippet('https://folio.example.com', null);
    expect(snippet).toContain('Bearer <your token>');
    expect(snippet).not.toContain('folio_pat_');
  });

  it('uses the given origin verbatim, including a non-default port', () => {
    expect(buildMcpSnippet('http://localhost:4871', null)).toContain('http://localhost:4871/mcp');
  });
});

describe('buildMcpJson (round 9: Cursor/"Other" preset)', () => {
  it('builds the exact ~/.cursor/mcp.json shape with a real token', () => {
    const json = buildMcpJson('https://folio.example.com', 'folio_pat_abc123');
    expect(JSON.parse(json)).toEqual({
      mcpServers: { folio: { url: 'https://folio.example.com/mcp', headers: { Authorization: 'Bearer folio_pat_abc123' } } },
    });
  });

  it('substitutes a placeholder when no fresh token is on screen', () => {
    const json = buildMcpJson('https://folio.example.com', null);
    expect(json).toContain('Bearer <your token>');
  });
});
