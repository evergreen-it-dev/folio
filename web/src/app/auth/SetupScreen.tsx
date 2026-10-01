import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { LabeledInput } from '../ui/LabeledInput';
import '../i18n/register';

export interface SetupScreenProps {
  /** Called after a successful setup so the caller re-fetches auth state and swaps to the app. */
  onDone: () => void;
}

/** "First run" — shown while GET /api/auth/state reports needsSetup, creates the instance admin. Localized from localStorage/browser language, same reasoning as LoginScreen. */
export function SetupScreen({ onDone }: SetupScreenProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const setup = useMutation({
    mutationFn: () => api.setupInstance({ name, email, password }),
    onSuccess: onDone,
  });

  return (
    <div className="flex h-full items-center justify-center bg-white p-4 dark:bg-neutral-950">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-xl font-semibold text-neutral-900 dark:text-neutral-100">{t('auth.setup.title')}</h1>
        <p className="mb-6 text-sm text-neutral-500 dark:text-neutral-400">{t('auth.setup.subtitle')}</p>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setup.mutate();
          }}
        >
          <LabeledInput
            label={t('auth.name')}
            required
            autoFocus
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <LabeledInput
            label="Email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <LabeledInput
            label={t('auth.setup.passwordLabel')}
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {setup.isError && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {errorText(setup.error, 'auth.setup.failed')}
            </p>
          )}
          <button
            type="submit"
            disabled={setup.isPending}
            className="mt-2 rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {setup.isPending ? t('auth.setup.creating') : t('auth.setup.submit')}
          </button>
        </form>
      </div>
    </div>
  );
}
