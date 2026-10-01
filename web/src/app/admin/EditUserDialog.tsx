import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { normalizeUsername } from '@shared/contracts';
import type { User } from '@shared/contracts';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { Modal } from '../ui/Modal';
import { LabeledInput } from '../ui/LabeledInput';
import '../i18n/register';

const FORM_ID = 'edit-user-form';

export interface EditUserDialogProps {
  user: User;
  onClose: () => void;
}

/** PATCH /api/users/:id — name, isAdmin, disabled, and an optional password reset (blank = unchanged). */
export function EditUserDialog({ user, onClose }: EditUserDialogProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const queryClient = useQueryClient();
  const [name, setName] = useState(user.name);
  const [username, setUsername] = useState(user.username ?? '');
  const [isAdmin, setIsAdmin] = useState(user.isAdmin);
  const [disabled, setDisabled] = useState(user.disabled ?? false);
  const [password, setPassword] = useState('');

  const update = useMutation({
    mutationFn: () =>
      api.updateUser(user.id, {
        name: name.trim(),
        username: username.trim() ? normalizeUsername(username) : null,
        isAdmin,
        disabled,
        ...(password.trim() ? { password: password.trim() } : {}),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.invalidateQueries({ queryKey: ['access', 'matrix'] });
      onClose();
    },
  });

  return (
    <Modal
      title={t('admin.editUser.title', { name: user.name })}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            {t('ui.cancel')}
          </button>
          <button
            type="submit"
            form={FORM_ID}
            disabled={update.isPending || !name.trim()}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {update.isPending ? t('admin.editUser.saving') : t('admin.editUser.save')}
          </button>
        </>
      }
    >
      <form
        id={FORM_ID}
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          update.mutate();
        }}
      >
        <p className="text-neutral-500 dark:text-neutral-400">{user.email}</p>
        <LabeledInput label={t('auth.name')} required autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        <LabeledInput
          label={t('settings.username.label')}
          placeholder={t('settings.username.placeholder')}
          minLength={2}
          maxLength={40} // a few chars of slack over the server's 32 so a pasted "@@…" prefix isn't cut before normalizing
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        {username.trim() !== '' && normalizeUsername(username) !== username.trim() && (
          <p className="-mt-2 text-xs text-neutral-500 dark:text-neutral-400">
            {t('settings.username.willBeSaved', { username: normalizeUsername(username) })}
          </p>
        )}
        <LabeledInput
          label={t('admin.editUser.newPassword')}
          type="password"
          minLength={8}
          placeholder={t('admin.editUser.newPasswordPlaceholder')}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
          <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
          {t('admin.isAdmin')}
        </label>
        <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
          <input type="checkbox" checked={disabled} onChange={(e) => setDisabled(e.target.checked)} />
          {t('admin.editUser.disabled')}
        </label>
        {update.isError && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {errorText(update.error, 'admin.editUser.failed')}
          </p>
        )}
      </form>
    </Modal>
  );
}
