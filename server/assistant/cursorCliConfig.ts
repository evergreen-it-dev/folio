/**
 * AI assistant (Cursor SDK) — ported near-verbatim from a sibling project's
 * server/assistant/cursor-cli-config.ts. Headless Cursor blocks a synthetic
 * MCP server without an explicit allow entry; the config is augmented, not
 * overwritten, and typical shell escape hatches are denied — this in-product
 * agent runs without a sandbox (see cursorRuntime.ts's sandboxOptions
 * comment), so its ONLY tool surface must be the in-process custom-user
 * tools built in tools.ts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

type CursorCliConfig = {
  permissions?: { allow?: string[]; deny?: string[] };
  [key: string]: unknown;
};

function configPath(): string {
  const home = (process.env.HOME || process.env.USERPROFILE || homedir()).trim() || homedir();
  return join(home, '.cursor', 'cli-config.json');
}

function readConfig(file: string): CursorCliConfig {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as CursorCliConfig;
  } catch {
    return {};
  }
}

export function ensureAssistantCursorPermissions(): void {
  const file = configPath();
  const current = readConfig(file);
  const permissions = current.permissions ?? {};
  const allow = Array.isArray(permissions.allow) ? [...permissions.allow] : [];
  const deny = Array.isArray(permissions.deny) ? [...permissions.deny] : [];
  const add = (items: string[], value: string) => {
    if (!items.includes(value)) items.push(value);
  };

  add(allow, 'Mcp(custom-user-tools:*)');
  for (const rule of [
    'Shell(bash)',
    'Shell(bash*)',
    'Shell(sh)',
    'Shell(sh*)',
    'Shell(zsh)',
    'Shell(zsh*)',
    'Shell(docker)',
    'Shell(docker*)',
    'Shell(psql*)',
    'Shell(curl*)',
  ]) {
    add(deny, rule);
  }

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        ...current,
        permissions: { ...permissions, allow, deny },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}
