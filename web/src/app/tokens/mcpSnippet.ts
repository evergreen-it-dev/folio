import type { ApiTokenScope } from '@shared/contracts';
import { t } from '../i18n/register';
import '../i18n/register';

/** Live lookup (not a static object) so it re-resolves on a language switch — see app/i18n/*.json's tokens.scope.* keys. */
export function scopeLabel(scope: ApiTokenScope): string {
  return t(`tokens.scope.${scope}`);
}

/** "Read, Write" — in the fixed read-then-write order regardless of how `scopes` is ordered, for a stable, predictable chip/label order everywhere it's shown. */
export function formatScopes(scopes: readonly ApiTokenScope[]): string {
  return (['read', 'write'] as const).filter((s) => scopes.includes(s)).map((s) => scopeLabel(s)).join(', ');
}

/**
 * The "Connect MCP" block's ready-to-run snippet (DEV-PLAN Round 7,
 * verbatim command shape). `origin` is always `location.origin` in
 * practice (passed in rather than read here to keep this pure/testable).
 * `token` is the real, just-created token when one is on screen (so the
 * snippet is instantly usable/copyable without hand-editing), or a plain
 * placeholder otherwise — never a *previous*, no-longer-visible token,
 * since we only ever hold the plaintext value for the one reveal.
 */
export function buildMcpSnippet(origin: string, token: string | null): string {
  return `claude mcp add folio --transport http ${origin}/mcp --header "Authorization: Bearer ${token ?? t('tokens.tokenPlaceholder')}"`;
}

/**
 * Round 9: the same MCP connection, as raw JSON for clients that read a
 * config file directly instead of a CLI installer — Cursor's
 * ~/.cursor/mcp.json, Claude Desktop, Windsurf (the "Other" tab).
 */
export function buildMcpJson(origin: string, token: string | null): string {
  return JSON.stringify(
    { mcpServers: { folio: { url: `${origin}/mcp`, headers: { Authorization: `Bearer ${token ?? t('tokens.tokenPlaceholder')}` } } } },
    null,
    2,
  );
}
