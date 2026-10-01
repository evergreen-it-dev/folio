/**
 * QA-3 P2 #9 — server errors were being rendered verbatim, whatever the
 * language of the UI. These pin the resolution order errorText.ts promises:
 * named rule -> generic-by-status -> caller's fallback key -> raw message,
 * and that the three concrete examples from the bug report never reach the
 * screen verbatim again.
 */
import { describe, expect, it } from 'vitest';
import i18next from 'i18next';
import { ApiError } from './api';
import { apiErrorText, matchApiErrorRule } from './errorText';
import './i18n/register';
import { UI_LANGUAGES } from '../i18n/languages';

/** Real i18next lookup against the real bundle, in the given language. */
function translator(lang: string) {
  const fixed = i18next.getFixedT(lang, 'app');
  return (key: string, values?: Record<string, unknown>) => fixed(key, values ?? {}) as string;
}

const en = translator('en');

describe('matchApiErrorRule', () => {
  it('names the login failure the report opens with', () => {
    expect(matchApiErrorRule('invalid email or password')).toEqual({ key: 'errors.invalidCredentials', values: undefined });
  });

  it('captures the required role out of the role message', () => {
    expect(matchApiErrorRule('requires viewer+ role in this space')).toEqual({
      key: 'errors.requiresRole',
      values: { role: 'viewer' },
    });
  });

  it('does not confuse "requires instance admin" with the space-role message', () => {
    expect(matchApiErrorRule('requires instance admin')?.key).toBe('errors.requiresInstanceAdmin');
    expect(matchApiErrorRule('requires instance admin, or admin role in this space')?.key).toBe('errors.requiresSpaceAdmin');
    expect(matchApiErrorRule('requires admin role in this space, or instance admin')?.key).toBe('errors.requiresSpaceAdmin');
  });

  it('treats "remove" and "demote" of a last space admin as the same situation', () => {
    expect(matchApiErrorRule('cannot remove the last admin of this space')?.key).toBe('errors.lastSpaceAdmin');
    expect(matchApiErrorRule('cannot demote the last admin of this space')?.key).toBe('errors.lastSpaceAdmin');
  });

  it('returns null for a message it has never seen', () => {
    expect(matchApiErrorRule('could not clone repository: fatal: not found')).toBeNull();
  });

  // Bugfix (22.09.2026): a form's "Edit form" save used to say "try again in
  // a moment" even when the paired table was genuinely gone. Server/forms/
  // service.ts#resolvePairedTableId now names the path it looked for; this
  // pins that the client actually recognizes that message (not the generic
  // 404 bucket) and surfaces the path, localized, rather than raw English.
  it('captures the searched path out of a genuinely-missing paired-table message', () => {
    expect(matchApiErrorRule('the table paired with this form was not found (looked for "survey/answers.table.md")')).toEqual({
      key: 'errors.formTableNotFound',
      values: { path: 'survey/answers.table.md' },
    });
    expect(
      apiErrorText(en, new ApiError(404, 'the table paired with this form was not found (looked for "survey/answers.table.md")')),
    ).toBe('The table paired with this form was not found (looked for the path "survey/answers.table.md").');
  });
});

describe('apiErrorText — the three cases named in the QA report', () => {
  it('"invalid email or password" is localized', () => {
    const text = apiErrorText(en, new ApiError(401, 'invalid email or password'), 'auth.login.failed');
    expect(text).toBe('Wrong email or password.');
    expect(text).not.toContain('invalid email or password');
  });

  it('"requires viewer+ role in this space" is localized, role word included', () => {
    const text = apiErrorText(en, new ApiError(403, 'requires viewer+ role in this space'));
    expect(text).toBe('Needs the “Viewer” role or higher in this space.');
  });

  it('"cannot remove the last admin of this space" is localized', () => {
    expect(apiErrorText(en, new ApiError(409, 'cannot remove the last admin of this space'))).toBe(
      "That's the last admin of this space — appoint another one first.",
    );
  });
});

describe('apiErrorText — fallback ladder', () => {
  it('falls back to a generic localized string for an unnamed 403', () => {
    expect(apiErrorText(en, new ApiError(403, 'some brand new server wording'))).toBe("You don't have permission to do that.");
  });

  it('keeps the technical detail for 400/5xx, where hiding it would hide the only actionable information', () => {
    const text = apiErrorText(en, new ApiError(400, 'could not clone repository: fatal: repository not found'));
    expect(text).toContain('The server rejected the request');
    expect(text).toContain('could not clone repository');
    expect(apiErrorText(en, new ApiError(500, 'boom'))).toContain('Server error');
  });

  it("uses the caller's own fallback key for a non-ApiError", () => {
    expect(apiErrorText(en, new TypeError('Failed to fetch'), 'auth.login.failed')).toBe(en('auth.login.failed'));
  });

  it('falls back to the raw message only when nothing else applies', () => {
    // 418 has no generic string and no rule, and no fallback key was given.
    expect(apiErrorText(en, new ApiError(418, 'i am a teapot'))).toBe('i am a teapot');
  });

  it('translates into whatever language is asked for', () => {
    expect(apiErrorText(en, new ApiError(401, 'invalid email or password'))).toBe('Wrong email or password.');
    for (const lang of UI_LANGUAGES) {
      const t = translator(lang);
      expect(apiErrorText(t, new ApiError(401, 'invalid email or password'))).toBe(t('errors.invalidCredentials'));
    }
  });

  it('has every key it references present in every bundle', () => {
    const keys = [
      'errors.invalidCredentials',
      'errors.requiresRole',
      'errors.lastSpaceAdmin',
      'errors.status.badRequest',
      'errors.status.forbidden',
      'errors.status.server',
      'errors.status.unknown',
    ];
    for (const lang of UI_LANGUAGES) {
      const t = translator(lang);
      for (const key of keys) expect(t(key), `${lang}:${key}`).not.toBe(key);
    }
  });
});

/**
 * server/access/routes.ts reports per-row failures INSIDE a 200 response
 * body, so they never become an ApiError — and carried exactly the same
 * English, "cannot remove the last admin of this space" included (the third
 * example in the QA report). MatrixTab/PeopleTab now pass those strings
 * through here too.
 */
describe('apiErrorText — bare server-authored strings (bulk results)', () => {
  it('localizes a known bulk-row message', () => {
    expect(apiErrorText(en, 'cannot remove the last admin of this space')).toBe(
      "That's the last admin of this space — appoint another one first.",
    );
    expect(apiErrorText(en, 'requires instance admin, or admin role in this space')).toBe(
      'Needs the admin role in this space.',
    );
    expect(apiErrorText(en, 'user not found')).toBe('No such user.');
  });

  it('shows an unrecognized bulk-row message as written — there is no status to generalize from', () => {
    expect(apiErrorText(en, 'something entirely new')).toBe('something entirely new');
  });
});
