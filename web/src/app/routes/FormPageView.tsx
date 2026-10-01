import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { SubmitFormBody } from '@shared/contracts';
import { isFormParseError, parseFormFile } from '@shared/forms/codec';
import { FormRenderer } from '../../forms/FormRenderer';
import type { FormSubmitOutcome } from '../../forms/FormRenderer';
import { api, ApiError } from '../api';
import { useApiErrorText } from '../errorText';
import { FormDefinitionEditor } from './FormDefinitionEditor';
import '../i18n/register';

export interface FormPageViewProps {
  pageId: string;
  /** Undefined for a share guest (no session -> GET /api/forms/:id/table, editor-role-gated, would 401) — the "view paired table" link is editor-only anyway, so this simply never renders for them. */
  space?: string;
  /** The raw `.form.md` file, exactly as GET /api/pages/:id (or /api/share/:token) hands it back — parsed here with the same shared/forms/codec.ts the server itself uses. */
  markdown: string;
  canEdit: boolean;
  /** Present only for an anonymous share-link guest — forwarded to POST /api/forms/:id/submit. */
  shareToken?: string;
}

/**
 * Round FORMS — the form's own page (`kind: 'form'`). Deliberately does its
 * OWN parsing of `markdown` (shared/forms/codec.ts, the exact module the
 * server writes with) rather than a dedicated GET /api/forms/:id JSON
 * endpoint — see the round report for why that extra REST surface wasn't
 * worth adding: the generic page routes already hand back the whole file
 * for a table, and a form rides the same "content is `markdown`" contract.
 */
export function FormPageView({ pageId, space, markdown, canEdit, shareToken }: FormPageViewProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const parsed = useMemo(() => parseFormFile(markdown), [markdown]);

  // Editor-only: resolves the paired table's page id so "View the
  // table" can link straight to it and so FormDefinitionEditor can create
  // pending fields' columns on Save. Resolved SERVER-side (api.ts's own doc
  // comment) rather than by looking up the form's stored `table` path from
  // here — that path can go stale (a move/slug rename on either side of the
  // pair) and this used to have `retry: false`, so a single stale-path 404
  // stayed broken for the rest of the session; now the server self-heals a
  // stale path via the pair's tree position, and a real failure is retryable
  // (this is a plain GET, so react-query's default retry applies) instead of
  // permanent.
  const tableLink = useQuery({
    queryKey: ['form-table', pageId],
    queryFn: () => api.resolveFormTable(pageId),
    enabled: canEdit,
  });
  const tableLinkErrorText = tableLink.isError ? errorText(tableLink.error) : undefined;

  if (isFormParseError(parsed)) {
    return <div className="p-8 text-sm text-red-600 dark:text-red-400">{t('routes.form.invalid', { message: parsed.message })}</div>;
  }
  const form = parsed;

  async function handleSubmit(values: Record<string, unknown>): Promise<FormSubmitOutcome> {
    // FormRenderer's local state is intentionally untyped (a checkbox's bool,
    // a number input's string-until-parsed, …) — the server (shared/forms/
    // fields.ts#validateSubmission) is what actually coerces/validates per
    // field kind and is the source of truth; this cast just satisfies
    // SubmitFormBody's narrower wire type.
    const body: SubmitFormBody = { values: values as SubmitFormBody['values'], shareToken };
    try {
      await api.submitForm(pageId, body);
      return { ok: true };
    } catch (err) {
      if (err instanceof ApiError) {
        const fields = (err.body as { fields?: Record<string, string> } | undefined)?.fields;
        return { ok: false, message: err.message, fieldErrors: fields };
      }
      return { ok: false };
    }
  }

  return (
    <div className="mx-auto w-full max-w-xl p-6">
      {canEdit && (
        <div className="mb-4 flex items-center justify-between gap-3 text-xs">
          {tableLink.data ? (
            <Link to={`/s/${space}/p/${tableLink.data.id}`} className="text-blue-600 hover:underline dark:text-blue-400">
              {t('routes.form.viewTable')}
            </Link>
          ) : (
            <span />
          )}
          <button type="button" onClick={() => setEditing(true)} className="text-neutral-500 hover:underline dark:text-neutral-400">
            {t('routes.form.editDefinition')}
          </button>
        </div>
      )}

      <FormRenderer
        title={form.title}
        description={form.description}
        fields={form.fields}
        submitButtonLabel={form.submitButton}
        onSubmit={handleSubmit}
      />

      {editing && (
        <FormDefinitionEditor
          pageId={pageId}
          form={form}
          tableId={tableLink.data?.id}
          tableError={tableLinkErrorText}
          onClose={() => setEditing(false)}
          onSaved={() => {
            queryClient.invalidateQueries({ queryKey: ['page', pageId] });
            setEditing(false);
          }}
        />
      )}
    </div>
  );
}
