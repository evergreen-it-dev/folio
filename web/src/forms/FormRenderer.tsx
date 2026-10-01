import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { FormField } from '@shared/contracts';
import './i18n/register';

export interface FormSubmitOutcome {
  ok: boolean;
  /** Set on failure — a generic message shown above the form. */
  message?: string;
  /** Set on a 400 validation failure — columnId -> 'required' | 'invalid', rendered under each field. */
  fieldErrors?: Record<string, string>;
}

export interface FormRendererProps {
  title: string;
  description?: string;
  fields: readonly FormField[];
  submitButtonLabel?: string;
  /**
   * Deliberately IO-free (see this module's own header note): the page
   * route wires this to `api.submitForm` (app/api.ts), the `::form{id}`
   * embed widget wires it to a plain `fetch` — same "no app/ <-> markdown/
   * import edge" rule web/src/markdown/PageTree.tsx already follows.
   */
  onSubmit: (values: Record<string, unknown>) => Promise<FormSubmitOutcome>;
}

/**
 * Round FORMS — the one place that actually renders a form's fields and
 * collects a submission. Mounted from TWO places with otherwise nothing in
 * common (the form's own page route, and the `::form{id}` embed widget
 * inline in any other page) — kept in `web/src/forms/` rather than either
 * `app/` or `markdown/` so neither has to depend on the other to share it.
 *
 * Field KINDS not given their own input here (select/status's option list,
 * user's member picker, link's URL+label pair) fall back to a plain text
 * input — v1 scope cut, see the round report: `FormField` only carries
 * `kind` for coercion, not a full copy of the column's `options`/`multiple`.
 */
export function FormRenderer({ title, description, fields, submitButtonLabel, onSubmit }: FormRendererProps) {
  const { t } = useTranslation('forms');
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [succeeded, setSucceeded] = useState(false);

  function setValue(columnId: string, value: unknown) {
    setValues((prev) => ({ ...prev, [columnId]: value }));
    if (fieldErrors[columnId]) setFieldErrors((prev) => ({ ...prev, [columnId]: '' }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setFormError(undefined);
    try {
      const result = await onSubmit(values);
      if (result.ok) {
        setSucceeded(true);
      } else {
        setFormError(result.message ?? t('genericError'));
        setFieldErrors(result.fieldErrors ?? {});
      }
    } catch {
      setFormError(t('genericError'));
    } finally {
      setSubmitting(false);
    }
  }

  if (succeeded) {
    return (
      <div className="rounded-lg border border-green-200 bg-green-50 p-6 text-center dark:border-green-900 dark:bg-green-950/30">
        <p className="text-sm font-medium text-green-800 dark:text-green-200">{t('successTitle')}</p>
        <button
          type="button"
          onClick={() => {
            setValues({});
            setFieldErrors({});
            setSucceeded(false);
          }}
          className="mt-3 rounded-md border border-green-300 bg-white px-3 py-1.5 text-sm text-green-800 hover:bg-green-100 dark:border-green-800 dark:bg-neutral-900 dark:text-green-200 dark:hover:bg-green-950"
        >
          {t('submitAnother')}
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">{title}</h2>
        {description && <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">{description}</p>}
      </div>

      {formError && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          {formError}
        </p>
      )}

      {fields.map((field) => (
        <label key={field.columnId} className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-700 dark:text-neutral-300">
            {field.label}
            {field.required && <span className="ml-0.5 text-red-500" aria-hidden="true">*</span>}
          </span>
          {field.help && <span className="text-xs text-neutral-400 dark:text-neutral-500">{field.help}</span>}
          <FieldInput field={field} value={values[field.columnId]} onChange={(v) => setValue(field.columnId, v)} />
          {fieldErrors[field.columnId] && (
            <span className="text-xs text-red-600 dark:text-red-400">
              {fieldErrors[field.columnId] === 'required' ? t('fieldRequiredError') : t('fieldInvalidError')}
            </span>
          )}
        </label>
      ))}

      <button
        type="submit"
        disabled={submitting}
        className="mt-2 self-start rounded-md bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
      >
        {submitting ? t('submitting') : (submitButtonLabel?.trim() || t('submit'))}
      </button>
    </form>
  );
}

const inputClassName =
  'rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:text-neutral-100 dark:focus:border-neutral-500';

function FieldInput({ field, value, onChange }: { field: FormField; value: unknown; onChange: (v: unknown) => void }) {
  const { t } = useTranslation('forms');
  switch (field.kind) {
    case 'longtext':
      return (
        <textarea
          required={field.required}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          className={inputClassName}
        />
      );
    case 'number':
      return (
        <input
          type="number"
          required={field.required}
          value={(value as string | number) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          className={inputClassName}
        />
      );
    case 'checkbox':
      return (
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
          <span className="text-neutral-600 dark:text-neutral-400">{t('checkboxYes')}</span>
        </label>
      );
    case 'date':
      return (
        <input
          type="date"
          required={field.required}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          className={inputClassName}
        />
      );
    // 'select' | 'status' | 'user' | 'link' | 'text' — see module doc comment.
    default:
      return (
        <input
          type="text"
          required={field.required}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          className={inputClassName}
        />
      );
  }
}
