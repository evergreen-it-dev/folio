import { useTranslation } from 'react-i18next';
import { ApiError } from './api';
import './i18n/register';

/**
 * QA-3 P2 #9 — server error texts were surfacing verbatim, in English, on top
 * of a Ukrainian UI: a Ukrainian sign-in heading + "invalid email or password",
 * "requires viewer+ role in this space" after a Ukrainian prefix, "cannot remove the
 * last admin of this space". The shape that produced it was copy-pasted into
 * ~49 places across web/src/app/**:
 *
 *     err instanceof ApiError ? err.message : t('some.localized.key')
 *
 * i.e. the localized string was used ONLY when the error did NOT come from the
 * server — precisely backwards. This module is the one place that turns an
 * ApiError into a localized string, so those call sites become:
 *
 *     const errorText = useApiErrorText();
 *     ... errorText(err, 'some.localized.key')
 *
 * Resolution order (DEV-PLAN Round 10: no raw English in a localized UI):
 *   1. a RULE matching the server's message text -> a specific localized string;
 *   2. otherwise a generic localized string for the HTTP status;
 *   3. otherwise the caller's own fallback key, then the raw server message.
 *
 * Step 2's 400/500 strings deliberately keep a `{{detail}}` slot: those two
 * buckets carry technically detailed, open-ended messages ("could not clone
 * repository: ..."), and a bare "Invalid request" would hide the only
 * information the user could act on or report. Every closed-set status
 * (401/403/404/409/410/429) resolves to localized text with no English left.
 */

/** A localized message to render: an i18n key plus any interpolation values. */
export interface ApiErrorMessage {
  key: string;
  values?: Record<string, string>;
}

/** Minimal shape of i18next's `t`, so the resolver stays testable without React. */
export type Translate = (key: string, values?: Record<string, unknown>) => string;

/**
 * Server messages worth naming individually, matched in order. Keep these
 * anchored: `requires editor+ role in this space` and `requires instance
 * admin` must not collide.
 */
const RULES: { test: RegExp; key: string; values?: (m: RegExpMatchArray) => Record<string, string> }[] = [
  // --- auth ---------------------------------------------------------------
  { test: /^invalid email or password$/i, key: 'errors.invalidCredentials' },
  { test: /^authentication required$/i, key: 'errors.authRequired' },
  { test: /^too many attempts/i, key: 'errors.tooManyAttempts' },
  { test: /^setup has already been completed$/i, key: 'errors.setupDone' },

  // --- roles / scopes -----------------------------------------------------
  { test: /^requires (\w+)\+ role in this space$/i, key: 'errors.requiresRole', values: (m) => ({ role: m[1] }) },
  { test: /^requires (\w+)\+ role in this page's space$/i, key: 'errors.requiresRolePage', values: (m) => ({ role: m[1] }) },
  { test: /^requires (?:instance admin, or )?admin role in this space(?:, or instance admin)?$/i, key: 'errors.requiresSpaceAdmin' },
  { test: /^requires instance admin/i, key: 'errors.requiresInstanceAdmin' },
  { test: /^this action requires a token with write scope$/i, key: 'errors.tokenWriteScope' },
  { test: /^not available via API token$/i, key: 'errors.notViaToken' },
  { test: /is disabled in the public demo$/i, key: 'errors.demoDisabled' },
  { test: /^only the (?:link|invite) creator/i, key: 'errors.onlyCreator' },

  // --- missing things -----------------------------------------------------
  { test: /^space not found$/i, key: 'errors.spaceNotFound' },
  { test: /^page not found$/i, key: 'errors.pageNotFound' },
  { test: /^user not found$/i, key: 'errors.userNotFound' },
  { test: /^share link not found$/i, key: 'errors.shareNotFound' },
  { test: /^invite not found$/i, key: 'errors.inviteNotFound' },
  { test: /^revision not found$/i, key: 'errors.revisionNotFound' },
  { test: /^asset not found$/i, key: 'errors.assetNotFound' },
  { test: /^trash item(?: content)? not found$/i, key: 'errors.trashItemNotFound' },
  { test: /^this invite is no longer valid/i, key: 'errors.inviteInvalid' },
  {
    test: /^the table paired with this form was not found \(looked for "(.+)"\)$/i,
    key: 'errors.formTableNotFound',
    values: (m) => ({ path: m[1] }),
  },

  // --- conflicts ----------------------------------------------------------
  { test: /^cannot remove the last admin of this space$/i, key: 'errors.lastSpaceAdmin' },
  { test: /^cannot demote the last admin of this space$/i, key: 'errors.lastSpaceAdmin' },
  { test: /^cannot demote or disable the last active instance admin$/i, key: 'errors.lastInstanceAdmin' },
  { test: /^a page already exists with this slug at this location$/i, key: 'errors.pageSlugTaken' },
  { test: /^a page already exists at the destination$/i, key: 'errors.pageExistsAtDestination' },
  { test: /^a user with this email already exists$/i, key: 'errors.emailTaken' },
  { test: /^this username is already taken$/i, key: 'errors.usernameTaken' },
  { test: /^a space with this slug already exists/i, key: 'errors.spaceSlugTaken' },
  { test: /^page changed after this action; undo is no longer safe$/i, key: 'errors.undoUnsafe' },
  { test: /^this change cannot be undone$/i, key: 'errors.undoUnavailable' },

  // --- git probes -------------------------------------------------------
  { test: /^could not list branches$/i, key: 'errors.gitBranchesFailed' },
  { test: /^could not list directories/i, key: 'errors.gitDirsFailed' },
  { test: /^space is already connected to a git repository$/i, key: 'errors.spaceAlreadyConnected' },
  { test: /^repository is not empty/i, key: 'errors.repoNotEmpty' },

  // --- whiteboards --------------------------------------------------------
  { test: /^empty scene over a non-empty board/i, key: 'errors.emptyBoardOverwrite' },

  // --- bad input ----------------------------------------------------------
  { test: /^invalid repository URL$/i, key: 'errors.invalidRepoUrl' },
  { test: /^(?:repository URL|repoUrl) is required$/i, key: 'errors.repoUrlRequired' },
  { test: /^title is required$/i, key: 'errors.titleRequired' },
  { test: /^space name is required$/i, key: 'errors.spaceNameRequired' },
  { test: /^slug must match/i, key: 'errors.invalidSlug' },
  { test: /^path escapes the space root$/i, key: 'errors.pathEscapes' },
  { test: /^not a page id \(synthetic folder node\)$/i, key: 'errors.notAPageId' },
];

const STATUS_KEYS: Record<number, string> = {
  400: 'errors.status.badRequest',
  401: 'errors.status.unauthorized',
  403: 'errors.status.forbidden',
  404: 'errors.status.notFound',
  409: 'errors.status.conflict',
  410: 'errors.status.gone',
  413: 'errors.status.tooLarge',
  429: 'errors.status.tooManyRequests',
  // 502/503/504: api.ts's request() already retries these a few times (PaaS
  // proxy hiccups during a redeploy restart window) before ever surfacing
  // one here, so by the time a caller sees this the retries were exhausted
  // — still worth a specific, reassuring message rather than the generic
  // 5xx "server error" bucket below.
  502: 'errors.unavailable',
  503: 'errors.unavailable',
  504: 'errors.unavailable',
};

/** The rule (if any) that names this server message. Exported for tests. */
export function matchApiErrorRule(message: string): ApiErrorMessage | null {
  const text = message.trim();
  for (const rule of RULES) {
    const m = text.match(rule.test);
    if (m) return { key: rule.key, values: rule.values?.(m) };
  }
  return null;
}

/** A matched rule, rendered. A role name inside the message is itself UI vocabulary the app already translates. */
function renderRule(t: Translate, named: ApiErrorMessage): string {
  const values = named.values?.role ? { ...named.values, role: t(`roles.${named.values.role}`) } : named.values;
  return t(named.key, values);
}

/**
 * Localized text for anything a call site might have to show: a thrown
 * ApiError, a thrown non-Error, or a bare server-authored STRING — the last
 * being the per-row `error` fields inside a 200 bulk result
 * (server/access/routes.ts), which never pass through ApiError at all and
 * carry exactly the same English as everything else, "cannot remove the last
 * admin of this space" included.
 *
 * `fallbackKey` is the caller's own "this particular action failed" copy,
 * used when nothing more specific is known — pass one wherever the old code
 * had `: t('some.key')`.
 */
export function apiErrorText(t: Translate, error: unknown, fallbackKey?: string): string {
  if (typeof error === 'string') {
    const named = matchApiErrorRule(error);
    // No status to generalize from — a message this module has never seen is
    // shown as the server wrote it rather than replaced by something vaguer.
    return named ? renderRule(t, named) : error;
  }

  if (!(error instanceof ApiError)) {
    if (fallbackKey) return t(fallbackKey);
    return error instanceof Error && error.message ? error.message : t('errors.status.unknown');
  }

  const named = matchApiErrorRule(error.message);
  if (named) return renderRule(t, named);

  const statusKey = STATUS_KEYS[error.status] ?? (error.status >= 500 ? 'errors.status.server' : undefined);
  if (statusKey) return t(statusKey, { detail: error.message });

  if (fallbackKey) return t(fallbackKey);
  return error.message;
}

/** Hook form — `const errorText = useApiErrorText();` then `errorText(err, 'some.key')`. */
export function useApiErrorText(): (error: unknown, fallbackKey?: string) => string {
  const { t } = useTranslation('app');
  return (error, fallbackKey) => apiErrorText(t as Translate, error, fallbackKey);
}
