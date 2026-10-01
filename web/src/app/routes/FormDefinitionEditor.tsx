import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import type { FormDoc, FormField, TableColumn } from '@shared/contracts';
import { serializeFormFile } from '@shared/forms/codec';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { Modal } from '../ui/Modal';
import { COLUMN_TYPES, ColumnTypeIcon, typeLabelKey } from '../../tables/cells/typeMeta';
import { STATUS_OPTIONS } from '../../tables/fixtures';
import '../i18n/register';
import '../../tables/i18n/register';

export interface FormDefinitionEditorProps {
  pageId: string;
  form: FormDoc;
  /**
   * The paired table's own page id — resolved by FormPageView the same way
   * it resolves "View the table" (`api.resolveFormTable(pageId)`, GET
   * /api/forms/:id/table — server-side, self-healing; see that endpoint's
   * doc comment), a query FormPageView starts on mount rather than only
   * once this dialog opens, so in practice it has already resolved by the
   * time anyone adds a field. Still possibly undefined while that query is
   * still in flight — `save`'s mutationFn checks it right before it would
   * need it (creating the pending fields' columns) and surfaces
   * `tableNotReady` (still loading, worth a retry) or, when `tableError` is
   * set, `tableNotFound` (the resolution genuinely failed — telling the
   * user to wait would be a lie) rather than adding fields the save can
   * never actually commit.
   */
  tableId?: string;
  /** Set when FormPageView's own resolution of `tableId` is in an ERROR state (not just still pending) — the real reason, already localized, to show instead of `tableNotReady`'s "try again" if Save is hit before it recovers. */
  tableError?: string;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Round FORMS follow-up — owner finding #1: the dialog had no way to add a
 * field at all. A field mirrors ONE COLUMN of the paired table (spec: "a
 * form field IS a column"), so "+ Add field" both appends a `FormField` here
 * AND creates the matching column on the table — through
 * `api.addTableColumn`, i.e. `server/tables/service.ts#addColumn`, the SAME
 * writer the table's own AddColumnButton uses (never a second one).
 *
 * The column is created lazily, only on Save (not the instant "+ Add field"
 * is clicked): a newly-added field is held with a local placeholder
 * `columnId` (PENDING_PREFIX-tagged) until then, so hitting Cancel after
 * adding one leaves no orphan column on the table. `save`'s mutationFn walks
 * `fields` and creates a real column for every still-pending one, in order,
 * before writing the form file — see there for why that has to be
 * sequential rather than Promise.all'd.
 *
 * Deleting a field is the opposite trade-off, DELIBERATELY one-directional:
 * it only removes the field from the form's own list (never calls
 * DELETE .../columns/:colId) — answers already collected for that column
 * must not be lost just because the field was removed from the form. Spelled
 * out in the UI itself (deleteFieldHint) so nobody assumes the column is
 * gone too.
 */
const PENDING_PREFIX = 'pending-column:';

const inputClassName =
  'rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:text-neutral-100 dark:focus:border-neutral-500';

/**
 * "A React form over the frontmatter, saved through the normal page PUT"
 * (owner brief) — plain and small on purpose: title/description/public/
 * submitButton plus each field's label/help/required/order. `id`/`table`/
 * `body` are round-tripped untouched (server/storage.ts#writeFormDoc
 * re-stamps id/table from the file itself regardless, but `body` — the
 * form's own free prose, if it has any — is this editor's job to preserve).
 */
export function FormDefinitionEditor({ pageId, form, tableId, tableError, onClose, onSaved }: FormDefinitionEditorProps) {
  const { t } = useTranslation('app');
  const { t: tTables } = useTranslation('tables');
  const errorText = useApiErrorText();
  const [title, setTitle] = useState(form.title);
  const [description, setDescription] = useState(form.description ?? '');
  const [isPublic, setIsPublic] = useState(form.public);
  const [submitButton, setSubmitButton] = useState(form.submitButton ?? '');
  const [fields, setFields] = useState<FormField[]>(form.fields);
  const [addingField, setAddingField] = useState(false);
  const [newFieldName, setNewFieldName] = useState('');
  const pendingCounterRef = useRef(0);

  function updateField(index: number, patch: Partial<FormField>) {
    setFields((prev) => prev.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  }
  function moveField(index: number, dir: -1 | 1) {
    setFields((prev) => {
      const next = [...prev];
      const target = index + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }
  function deleteField(index: number) {
    // Form-side only — see this file's own doc comment for why the column
    // (and any answers already in it) is deliberately left alone.
    setFields((prev) => prev.filter((_, i) => i !== index));
  }
  function addField(type: TableColumn['type']) {
    pendingCounterRef.current += 1;
    const label = newFieldName.trim() || tTables('column.newName');
    setFields((prev) => [...prev, { columnId: `${PENDING_PREFIX}${pendingCounterRef.current}`, label, required: false, kind: type }]);
    setAddingField(false);
    setNewFieldName('');
  }

  const save = useMutation({
    mutationFn: async () => {
      // Create a real column for every still-pending field, IN ORDER (a
      // sequential loop, not Promise.all — two pending fields hitting
      // POST .../columns concurrently could race server-side id generation,
      // and the fields list is short enough that this costs nothing worth
      // parallelising for).
      const resolved: FormField[] = [];
      for (const field of fields) {
        if (field.columnId.startsWith(PENDING_PREFIX)) {
          if (!tableId) throw new Error(tableError ? t('routes.form.tableNotFound', { message: tableError }) : t('routes.form.tableNotReady'));
          // Same default-options seeding TablePage.tsx's own live addColumn
          // does for these two types (spec §3's normative status preset,
          // and an empty-but-present list for select) — so a field added
          // here behaves like one added on the table itself, not a
          // second, poorer path.
          const options = field.kind === 'status' ? STATUS_OPTIONS.map((o) => ({ ...o })) : field.kind === 'select' ? [] : undefined;
          // eslint-disable-next-line no-await-in-loop -- sequential on purpose, see above
          const column = await api.addTableColumn(tableId, field.label, field.kind, options);
          resolved.push({ ...field, columnId: column.id });
        } else {
          resolved.push(field);
        }
      }
      const doc: FormDoc = {
        ...form,
        title: title.trim() || form.title,
        description: description.trim() || undefined,
        public: isPublic,
        submitButton: submitButton.trim() || undefined,
        fields: resolved,
      };
      return api.updatePage(pageId, { markdown: serializeFormFile(doc) });
    },
    onSuccess: onSaved,
  });

  return (
    <Modal
      title={t('routes.form.editDefinition')}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800">
            {t('ui.cancel')}
          </button>
          <button
            type="button"
            disabled={save.isPending}
            onClick={() => save.mutate()}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {save.isPending ? t('routes.form.saving') : t('routes.form.save')}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {save.isError && (
          <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
            {errorText(save.error)}
          </p>
        )}
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-600 dark:text-neutral-400">{t('routes.form.fieldTitle')}</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputClassName} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-600 dark:text-neutral-400">{t('routes.form.fieldDescription')}</span>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className={inputClassName} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-600 dark:text-neutral-400">{t('routes.form.fieldSubmitButton')}</span>
          <input value={submitButton} onChange={(e) => setSubmitButton(e.target.value)} className={inputClassName} placeholder={t('routes.form.submitButtonPlaceholder')} />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
          <span className="text-neutral-700 dark:text-neutral-300">{t('routes.form.fieldPublic')}</span>
        </label>
        <p className="text-xs text-neutral-400 dark:text-neutral-500">{t('routes.form.publicHint')}</p>

        <div className="mt-2 flex flex-col gap-2">
          <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">{t('routes.form.fieldsHeading')}</span>
          {fields.map((field, index) => (
            <div key={field.columnId} className="flex flex-col gap-2 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
              <div className="flex items-center gap-2">
                <ColumnTypeIcon type={field.kind} />
                <input
                  value={field.label}
                  onChange={(e) => updateField(index, { label: e.target.value })}
                  className={`${inputClassName} flex-1`}
                />
                <button type="button" disabled={index === 0} onClick={() => moveField(index, -1)} className="rounded p-1 text-neutral-400 hover:bg-neutral-100 disabled:opacity-30 dark:hover:bg-neutral-800">
                  <ArrowUp size={14} />
                </button>
                <button type="button" disabled={index === fields.length - 1} onClick={() => moveField(index, 1)} className="rounded p-1 text-neutral-400 hover:bg-neutral-100 disabled:opacity-30 dark:hover:bg-neutral-800">
                  <ArrowDown size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => deleteField(index)}
                  title={t('routes.form.deleteFieldHint')}
                  aria-label={t('routes.form.deleteField')}
                  className="rounded p-1 text-neutral-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/30 dark:hover:text-red-400"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <input
                value={field.help ?? ''}
                onChange={(e) => updateField(index, { help: e.target.value || undefined })}
                placeholder={t('routes.form.fieldHelpPlaceholder')}
                className={inputClassName}
              />
              <label className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-400">
                <input type="checkbox" checked={field.required} onChange={(e) => updateField(index, { required: e.target.checked })} />
                {t('routes.form.fieldRequired')}
              </label>
            </div>
          ))}

          {addingField ? (
            <div className="flex flex-col gap-2 rounded-md border border-dashed border-neutral-300 p-3 dark:border-neutral-700">
              <input
                autoFocus
                value={newFieldName}
                onChange={(e) => setNewFieldName(e.target.value)}
                placeholder={t('routes.form.newFieldNamePlaceholder')}
                className={inputClassName}
              />
              <p className="text-[11px] text-neutral-400 dark:text-neutral-500">{tTables('column.type')}</p>
              <div role="listbox" aria-label={tTables('column.type')} className="grid grid-cols-3 gap-1">
                {COLUMN_TYPES.map((type) => (
                  <button
                    key={type}
                    type="button"
                    role="option"
                    aria-selected={false}
                    onClick={() => addField(type)}
                    className="flex items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800"
                  >
                    <ColumnTypeIcon type={type} />
                    <span className="truncate">{tTables(typeLabelKey(type))}</span>
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => {
                  setAddingField(false);
                  setNewFieldName('');
                }}
                className="self-start text-xs text-neutral-500 hover:underline dark:text-neutral-400"
              >
                {t('ui.cancel')}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setAddingField(true)}
              className="flex items-center justify-center gap-1 rounded-md border border-dashed border-neutral-300 py-1.5 text-xs text-neutral-500 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
            >
              <Plus size={12} aria-hidden />
              {t('routes.form.addField')}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
