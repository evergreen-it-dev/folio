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
  | 'starterTemplate.meeting-notes'
  | 'starterTemplate.how-to'
  | 'starterTemplate.decision-record'
  | 'starterTemplate.meeting-notes.description'
  | 'starterTemplate.how-to.description'
  | 'starterTemplate.decision-record.description'
  | 'writingRules.template'
  | 'table.defaultView'
  | 'table.firstField'
  | 'import.emptyPage'
  | 'whiteboard.linksHeading'
  | 'audit.deletedUser'
  | 'ssoTest.title'
  | 'ssoTest.ok'
  | 'ssoTest.failed'
  | 'ssoTest.note'
  | 'oauth.title'
  | 'oauth.heading'
  | 'oauth.signedInAs'
  | 'oauth.willOpen'
  | 'oauth.unverifiedDcr'
  | 'oauth.unverifiedCimd'
  | 'oauth.internalClient'
  | 'oauth.canDo'
  | 'oauth.read'
  | 'oauth.write'
  | 'oauth.writeOptional'
  | 'oauth.sameRights'
  | 'oauth.allow'
  | 'oauth.deny'
  | 'oauth.errorTitle'
  | 'oauth.back'
  | 'gitRepos.tokenInvalid'
  | 'gitRepos.rateLimited'
  | 'gitRepos.ssoRequired'
  | 'gitRepos.ssoRequiredUrl'
  | 'gitRepos.forbidden'
  | 'gitRepos.unreachable'
  | 'gitRepos.failed'
  | 'chat.title'
  | 'chat.connectedHeading'
  | 'chat.connectedBody'
  | 'chat.teamsFinishing'
  | 'chat.failedHeading'
  | 'chat.notConfigured'
  | 'chat.expired'
  | 'chat.wrongWorkspace'
  | 'chat.denied'
  | 'chat.failed'
  | 'chat.teamsPasteAgain';

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
 * is a bundle for (Russian counts as Ukrainian), else English.
 */
export function resolveTextLanguage(preferred?: string | null, acceptLanguage?: string | null): string {
  if (preferred && BUNDLES.has(preferred)) return preferred;
  for (const part of (acceptLanguage ?? '').split(',')) {
    const tag = part.split(';')[0].trim().slice(0, 2).toLowerCase();
    // Russian is not a language of the app: a Russian browser gets Ukrainian.
    const base = tag === 'ru' ? 'uk' : tag;
    if (base && BUNDLES.has(base)) return base;
  }
  return FALLBACK_LANGUAGE;
}

export function serverText(key: ServerTextKey, language?: string | null): string {
  const bundle = (language && BUNDLES.get(language)) || BUNDLES.get(FALLBACK_LANGUAGE);
  return bundle?.[key] ?? BUNDLES.get(FALLBACK_LANGUAGE)?.[key] ?? key;
}
