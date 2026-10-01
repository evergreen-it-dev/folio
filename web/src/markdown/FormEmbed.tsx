import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PageDoc } from '@shared/contracts';
import { isFormParseError, parseFormFile } from '@shared/forms/codec';
import { FormRenderer } from '../forms/FormRenderer';
import type { FormSubmitOutcome } from '../forms/FormRenderer';
import '../forms/i18n/register';
import './i18n/register';

export interface FormEmbedProps {
  /** The embedded FORM page's own id (`::form{id=<page-id>}`'s `id` attribute). */
  pageId: string;
}

type LoadState = { status: 'loading' } | { status: 'error' } | { status: 'ok'; doc: ReturnType<typeof parseFormFile> };

/**
 * Round FORMS — renders a `::form{id}` directive inline: fetches the form's
 * own page and its fields, submits through the same public endpoint the
 * form's own page uses. A plain `fetch`, not react-query or app/'s `api`
 * client — same reason PageTree.tsx (the `::pagetree` island) gives: this
 * has to work wherever it's mounted, with no assumption of an ambient
 * QueryClientProvider, and no app/ <-> markdown/ import edge.
 */
export function FormEmbed({ pageId }: FormEmbedProps) {
  const { t } = useTranslation('markdown');
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    fetch(`/api/pages/${encodeURIComponent(pageId)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`page ${res.status}`);
        return res.json() as Promise<PageDoc>;
      })
      .then((page) => {
        if (cancelled) return;
        if (page.kind !== 'form') {
          setState({ status: 'error' });
          return;
        }
        setState({ status: 'ok', doc: parseFormFile(page.markdown ?? '') });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [pageId]);

  if (state.status === 'loading') {
    return <p className="text-sm text-neutral-400 dark:text-neutral-500">{t('form.loading')}</p>;
  }
  if (state.status === 'error' || isFormParseError(state.doc)) {
    return <p className="text-sm text-neutral-400 dark:text-neutral-500">{t('form.notFound')}</p>;
  }

  const form = state.doc;

  async function handleSubmit(values: Record<string, unknown>): Promise<FormSubmitOutcome> {
    const res = await fetch(`/api/forms/${encodeURIComponent(pageId)}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values }),
    });
    if (res.ok) return { ok: true };
    let message: string | undefined;
    let fieldErrors: Record<string, string> | undefined;
    try {
      const body = (await res.json()) as { error?: string; fields?: Record<string, string> };
      message = body.error;
      fieldErrors = body.fields;
    } catch {
      /* not JSON — generic message falls through */
    }
    return { ok: false, message, fieldErrors };
  }

  return (
    <div className="folio-form-embed rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <FormRenderer
        title={form.title}
        description={form.description}
        fields={form.fields}
        submitButtonLabel={form.submitButton}
        onSubmit={handleSubmit}
      />
    </div>
  );
}
