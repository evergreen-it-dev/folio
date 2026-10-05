/**
 * The few pieces of text the SERVER writes on a person's behalf: a default
 * name inside a new file, a note in an imported page, the OAuth consent page.
 * Everything else the
 * interface shows is translated on the client; these cannot be, because they
 * end up in the content itself.
 *
 * One JSON bundle per language in ./i18n/. Which languages exist is decided
 * by which files are there. English is the fallback.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export type ServerTextKey =
  | 'table.defaultView'
  | 'table.firstField'
  | 'import.emptyPage'
  | 'whiteboard.linksHeading'
  | 'audit.deletedUser'
  | 'oauth.title'
  | 'oauth.heading'
  | 'oauth.signedInAs'
  | 'oauth.willOpen'
  | 'oauth.unverifiedDcr'
  | 'oauth.unverifiedCimd'
  | 'oauth.canDo'
  | 'oauth.read'
  | 'oauth.write'
  | 'oauth.writeOptional'
  | 'oauth.sameRights'
  | 'oauth.allow'
  | 'oauth.deny'
  | 'oauth.errorTitle'
  | 'oauth.back';

const FALLBACK_LANGUAGE = 'en';
const BUNDLE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'i18n');

function loadBundles(): Map<string, Record<string, string>> {
  const bundles = new Map<string, Record<string, string>>();
  for (const file of fs.readdirSync(BUNDLE_DIR)) {
    if (!file.endsWith('.json')) continue;
    bundles.set(file.slice(0, -'.json'.length), JSON.parse(fs.readFileSync(path.join(BUNDLE_DIR, file), 'utf8')));
  }
  return bundles;
}

const BUNDLES = loadBundles();

export function serverTextLanguages(): string[] {
  return [...BUNDLES.keys()];
}

/**
 * The language to write in: the person's saved preference when there is a
 * bundle for it, else the first language their browser asks for that there
 * is a bundle for, else English.
 */
export function resolveTextLanguage(preferred?: string | null, acceptLanguage?: string | null): string {
  if (preferred && BUNDLES.has(preferred)) return preferred;
  for (const part of (acceptLanguage ?? '').split(',')) {
    const base = part.split(';')[0].trim().slice(0, 2).toLowerCase();
    if (base && BUNDLES.has(base)) return base;
  }
  return FALLBACK_LANGUAGE;
}

export function serverText(key: ServerTextKey, language?: string | null): string {
  const bundle = (language && BUNDLES.get(language)) || BUNDLES.get(FALLBACK_LANGUAGE);
  return bundle?.[key] ?? BUNDLES.get(FALLBACK_LANGUAGE)?.[key] ?? key;
}
