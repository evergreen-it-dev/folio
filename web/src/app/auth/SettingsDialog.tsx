import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { normalizeUsername } from '@shared/contracts';
import type { UiLanguage, User } from '@shared/contracts';
import { useSettings } from '../settings';
import { setUiLanguage } from '../../i18n';
import { Modal } from '../ui/Modal';
import { api, ApiError } from '../api';
import { useToast } from '../ui/Toast';
import '../i18n/register';
import { UI_LANGUAGES, languageName } from '../../i18n/languages';

// Each language's own endonym — never translated (a language's own name for
// itself stays fixed regardless of which language is currently active),
// matching how virtually every app's own language switcher labels its options.
// The list is whatever this build has bundles for.
const LANGUAGE_OPTIONS: Array<{ value: UiLanguage; label: string }> = UI_LANGUAGES.map((value) => ({
  value,
  label: languageName(value),
}));

export interface SettingsDialogProps {
  /** The signed-in user, straight from AuthProvider — `name`/`username` are the saved values both fields below reconcile against. */
  user: User;
  onClose: () => void;
}

/**
 * Round 28: the personal settings window.
 *
 * Everything here used to live inline in the user menu's personal section
 * (UserMenu.tsx), which had grown into four stacked controls inside a
 * dropdown — the owner asked for them in a window of their own, plus the one
 * thing the menu never offered: editing your own display NAME.
 *
 * The four moved controls are the same components as before, unchanged:
 * width/theme still write through useSettings (localStorage + <html> data-
 * attributes, applied instantly), language still goes through setUiLanguage
 * (i18next + a best-effort profile PATCH), and UsernameField moved here
 * wholesale, 409 handling and all. Only NameField is new.
 *
 * Order deliberately differs from the old menu's (width/theme/language/
 * username): the two IDENTITY fields — who you are (name) and how you're
 * @-mentioned (username) — lead, then the three appearance/locale
 * preferences. In a dropdown the ordering was arbitrary; in a dialog with a
 * title the grouping reads.
 */
export function SettingsDialog({ user, onClose }: SettingsDialogProps) {
  const { t, i18n } = useTranslation('app');
  const { width, setWidth, theme, setTheme } = useSettings();

  return (
    <Modal title={t('settings.title')} onClose={onClose}>
      <div className="flex flex-col gap-3.5">
        <Field label={t('settings.name.label')}>
          <NameField name={user.name} />
        </Field>
        <Field label={t('settings.username.label')}>
          <UsernameField username={user.username} />
        </Field>
        <Field label={t('settings.width.label')}>
          <SegmentedControl
            value={width}
            onChange={setWidth}
            options={[
              { value: 'narrow', label: t('settings.width.narrow') },
              { value: 'wide', label: t('settings.width.wide') },
            ]}
          />
        </Field>
        <Field label={t('settings.theme.label')}>
          <SegmentedControl
            value={theme}
            onChange={setTheme}
            options={[
              { value: 'light', label: t('settings.theme.light') },
              { value: 'dark', label: t('settings.theme.dark') },
              { value: 'system', label: t('settings.theme.system') },
            ]}
          />
        </Field>
        <Field label={t('settings.language.label')}>
          <SegmentedControl
            value={(i18n.language as UiLanguage) ?? 'uk'}
            onChange={(lang) => void setUiLanguage(lang)}
            options={LANGUAGE_OPTIONS}
          />
        </Field>
      </div>
    </Modal>
  );
}

/** Caption + control, the same small-grey-label look each of these controls already had in the menu — a <div>, not a <label>, because three of the five wrap a group of buttons rather than one form control (each field owns its own aria-label instead). */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-neutral-400 dark:text-neutral-500">{label}</div>
      {children}
    </div>
  );
}

/**
 * Round 28: your own display name (users.name) — the one personal field the
 * old menu had no editor for, so PATCH /api/me/preferences learned a `name`
 * this round (contract + route + store; see updateMyPreferencesBodySchema).
 *
 * Saves on blur/Enter with Escape reverting, exactly like UsernameField
 * below — same reasoning, and the same skipNextCommitRef trick for Escape
 * (see that component's comments, which apply verbatim here).
 *
 * Differs from the username in one way that matters: a name cannot be
 * UNSET. users.name is NOT NULL and the name is what the menu, avatar
 * initials, member lists and git commit authorship all render, so an empty
 * draft is refused client-side (toast + revert to the saved value) instead
 * of being sent as a blank — the server would reject it anyway.
 *
 * Everything already showing the OLD name updates the moment the save
 * lands: invalidating ['auth', 'state'] refetches the one query AuthProvider
 * holds the user in, so the menu label and the avatar initials re-render
 * without a reload. Copies of the name held by OTHER queries (the admin user
 * list, a space's member list) refresh on their own next fetch, and names
 * already written into git history stay as they were — a commit's author is
 * a fact about the past, not a live reference to the profile.
 */
export function NameField({ name }: { name: string }) {
  const { t } = useTranslation('app');
  const showToast = useToast();
  const queryClient = useQueryClient();
  const saved = name;
  const [value, setValue] = useState(saved);
  const skipNextCommitRef = useRef(false);

  // Stay in sync with the server value (the save below refetches auth/state,
  // and an admin renaming you in another tab shows up the same way).
  useEffect(() => setValue(saved), [saved]);

  const mutation = useMutation({
    mutationFn: (next: string) => api.updateMyPreferences({ name: next }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['auth', 'state'] });
    },
    onError: (err) => {
      setValue(saved); // the write failed — don't leave the field showing an unsaved value as if it stuck
      showToast(err instanceof ApiError && err.status === 400 ? t('settings.name.required') : t('settings.name.saveFailed'));
    },
  });

  function commit() {
    const trimmed = value.trim();
    if (trimmed === '') {
      // No "unset" for a name — say so and put the saved one back, rather
      // than PATCHing a blank the server would 400 anyway.
      setValue(saved);
      showToast(t('settings.name.required'));
      return;
    }
    setValue(trimmed); // always reflect the trimmed form, whether or not it needs saving
    if (trimmed === saved) return; // unchanged — nothing to save
    mutation.mutate(trimmed);
  }

  return (
    <div className="flex items-center gap-1 rounded-md border border-neutral-200 bg-white px-2 py-1 text-sm focus-within:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:focus-within:border-neutral-500">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          if (skipNextCommitRef.current) {
            skipNextCommitRef.current = false;
            return;
          }
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation(); // Modal closes on Escape — reverting the draft shouldn't also close the window
            skipNextCommitRef.current = true;
            setValue(saved);
            e.currentTarget.blur();
          }
        }}
        placeholder={t('settings.name.placeholder')}
        maxLength={80} // matches updateMyPreferencesBodySchema's own max
        aria-label={t('settings.name.label')}
        className="w-full min-w-0 bg-transparent text-neutral-800 outline-none dark:text-neutral-200"
      />
    </div>
  );
}

/**
 * Round 15 (moved here from UserMenu.tsx in round 28, unchanged): the
 * `@handle` used for @mentions (usernameSchema in shared/contracts.ts —
 * 2-32 chars, `[a-z0-9][a-z0-9._-]*`, always stored lower-case). Saves on
 * blur/Enter rather than needing an explicit button, matching how every
 * other field in this dialog applies immediately. Server normalizes before
 * validating (usernameSchema's transform, see shared/contracts.ts), so a
 * mixed-case or `@`-prefixed value the user typed is still accepted — this
 * also normalizes client-side via the same `normalizeUsername` helper so the
 * field's own display matches what actually gets stored once the save
 * round-trips.
 *
 * 08.09.2026 (owner request): people sometimes paste their handle WITH the
 * leading `@` (there's already a fixed "@" shown before the input) — that
 * used to slip through untouched and get saved as `@ivan.k`. normalizeUsername
 * strips any leading '@'s (plus trims/lower-cases), same as the invite-accept
 * screen and the server.
 */
export function UsernameField({ username }: { username?: string | null }) {
  const { t } = useTranslation('app');
  const showToast = useToast();
  const queryClient = useQueryClient();
  const saved = username ?? '';
  const [value, setValue] = useState(saved);
  // Round 19 QA fix (F3): set just before the Escape handler blurs the
  // field, so the onBlur this triggers can skip commit() entirely instead
  // of running it. commit() closes over `value` from THIS render — calling
  // setValue(saved) and then blur() synchronously in the same handler does
  // NOT make commit() see the reverted value (React hasn't re-rendered yet
  // within that one synchronous call), so without this guard the blur would
  // still commit() the stale pre-revert draft, PATCHing the very value
  // Escape was supposed to discard.
  const skipNextCommitRef = useRef(false);

  // Stay in sync with the server value (e.g. after a successful save
  // refetches auth/state, or another tab changed it) — same "re-read on
  // prop change" reasoning as markdown/index.tsx's collapsedSlugs effect.
  useEffect(() => setValue(saved), [saved]);

  const mutation = useMutation({
    mutationFn: (next: string | null) => api.updateMyPreferences({ username: next }),
    onSuccess: () => {
      // DEV-PLAN round 15: explicit invalidation rather than relying on the
      // mutation's own returned user — every OTHER reader of `user` (the
      // menu, admin lists, …) is keyed off this one query.
      void queryClient.invalidateQueries({ queryKey: ['auth', 'state'] });
    },
    onError: (err) => {
      setValue(saved); // the write failed — don't leave the field showing an unsaved value as if it stuck
      showToast(err instanceof ApiError && err.status === 409 ? t('settings.username.taken') : t('settings.username.saveFailed'));
    },
  });

  function commit() {
    const normalized = normalizeUsername(value);
    setValue(normalized); // always reflect the normalized form, whether or not it needs saving
    const next = normalized === '' ? null : normalized;
    if (next === (saved === '' ? null : saved)) return; // unchanged — nothing to save
    mutation.mutate(next);
  }

  const normalizedPreview = normalizeUsername(value);
  const showPreview = value.trim() !== '' && normalizedPreview !== value.trim();

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1 rounded-md border border-neutral-200 bg-white px-2 py-1 text-sm focus-within:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:focus-within:border-neutral-500">
        <span className="text-neutral-400 dark:text-neutral-500" aria-hidden="true">@</span>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => {
            if (skipNextCommitRef.current) {
              skipNextCommitRef.current = false;
              return;
            }
            commit();
          }}
          onKeyDown={(e) => {
            // Round 19 QA fix (F3): Enter still commits via the blur it
            // triggers (not a direct commit() call here) — calling commit()
            // AND blurring separately would run it twice in the same
            // synchronous pass (React batches the setValue from the first
            // call, so the second would still read the pre-commit `value`
            // closure), double-PATCHing the same change. Routing it through
            // the one onBlur handler keeps it a single commit, same as
            // clicking away. Escape is genuinely new — see skipNextCommitRef's
            // own comment for why reverting the draft here needs that guard
            // rather than just setValue(saved) + blur().
            if (e.key === 'Enter') {
              e.preventDefault();
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation(); // round 28: inside a Modal now — reverting the draft shouldn't also close the window
              skipNextCommitRef.current = true;
              setValue(saved);
              e.currentTarget.blur();
            }
          }}
          placeholder={t('settings.username.placeholder')}
          maxLength={40} // a few chars of slack over the server's 32 so a pasted "@@…" prefix isn't cut before normalizing
          aria-label={t('settings.username.label')}
          className="w-full min-w-0 bg-transparent text-neutral-800 outline-none dark:text-neutral-200"
        />
      </div>
      {showPreview && (
        <p className="text-xs text-neutral-500 dark:text-neutral-500">{t('settings.username.willBeSaved', { username: normalizedPreview })}</p>
      )}
    </div>
  );
}

/** Moved here from UserMenu.tsx (round 28) along with the three preference controls that are its only users. */
function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string }>;
}) {
  return (
    <div className="flex gap-0.5 rounded-md bg-neutral-100 p-0.5 dark:bg-neutral-800">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={(e) => {
            e.stopPropagation();
            onChange(option.value);
          }}
          className={`flex-1 rounded px-1.5 py-1 text-xs font-medium transition-colors ${
            value === option.value
              ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-600 dark:text-neutral-50'
              : 'text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
