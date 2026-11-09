import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FocusEvent, Ref } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Plus, SlidersHorizontal, TriangleAlert } from 'lucide-react';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { useLocalStorage, useOutsideClick } from '../hooks';
import { PropertiesSlotContext } from '../header/propertiesSlot';
import { useToast } from '../ui/Toast';
import { VERIFICATION_KEYS } from '@shared/verification';
import { AddPropertyForm } from './AddPropertyForm';
import type { NewProperty } from './AddPropertyForm';
import { PropertyRow } from './PropertyRow';
import { countProperties, effectiveType, emptyValueFor } from './propertyValues';
import { usePageProperties } from './usePageProperties';
import { VerificationRows } from './VerificationRows';
import '../i18n/register';

export interface PropertiesPanelProps {
  pageId: string;
  space: string;
  /** The caller may edit this page (space role capped by the page's own role). The server's own `canEdit` must agree. */
  canEdit: boolean;
  /** Space admin: may keep a new key's type in the space (`.folio/properties.json`). */
  canManageTypes: boolean;
}

/** `labels:` is Obsidian's synonym of `tags:`; Folio reads it and never writes it. */
const SYNONYM_KEYS = ['labels'];

/**
 * The front matter of a document, above its body: collapsed to one line ("Properties (3)")
 * by default, the open state remembered per space. Rows are typed editors (text, number,
 * checkbox, date, list / tags / aliases as chips); a value Folio would not write itself shows
 * read-only with a "foreign value" badge, `id` is read-only, nested values are shown as JSON.
 *
 * Saving is optimistic and whole-map: every committed field (Enter or leaving it; Esc puts
 * the old value back) sends ONE PUT carrying all the editable properties (usePageProperties).
 * A 409 — the front matter changed under the editor — stops editing and offers a reload.
 */
/** The open state of the panel, remembered per space; the toggle and the body share it. */
export function usePropertiesOpen(space: string) {
  return useLocalStorage<boolean>(`folio:properties-open:${space}`, false);
}

/** What both halves need: the loaded front matter, the count, and whether there is anything to show at all. */
function useView(pageId: string, space: string, canEdit: boolean) {
  const state = usePageProperties(pageId, space);
  const data = state.data;
  const readOnlyKeys = useMemo(() => data?.readOnly ?? ['id'], [data]);
  if (!data) return { state, data, readOnlyKeys, count: 0, visible: false };
  const count = countProperties(state.properties, readOnlyKeys);
  // A viewer of a page without properties has nothing to look at, and nothing to add.
  const visible = canEdit || count > 0 || readOnlyKeys.some((key) => key in state.properties);
  return { state, data, readOnlyKeys, count, visible };
}

export interface PropertiesHalfProps extends PropertiesPanelProps {
  open: boolean;
  /**
   * 'column' (default): centred like the editor's text column (a document). 'popover': fills the popover it sits
   * in (PagePropertiesPopover — tables, forms, boards, files). 'title': inside the text column, under the page
   * title (PageTitleProperties) — no centring of its own and no inner scroll, the page scrolls.
   */
  layout?: 'column' | 'popover' | 'title';
  /** Changing it to a new non-zero value opens "Add property" (the ghost button under the title asked for it). */
  addSignal?: number;
  /** "Add property" was closed (or the new row dropped) while the page still has no properties. */
  onEmptyDone?: () => void;
  /**
   * Owner and review live in this section as their own rows (owner, verified, review_by -> VerificationRows) instead of
   * three plain ones. Set by PageTitleProperties only: the popover of tables and files has no owner / review UI.
   */
  withVerification?: boolean;
  /** Changing it to a new non-zero value shows the owner / review rows on a page that has none yet ("Owner and review" ghost). */
  assignSignal?: number;
}

export function propertiesBodyId(pageId: string): string {
  return `properties-${pageId}`;
}

export interface PropertiesToggleProps extends Omit<PropertiesHalfProps, 'canManageTypes' | 'layout'> {
  onToggle: () => void;
  /**
   * 'chrome' (default): a row of chrome, 13px. 'header': the shell's top bar, after the breadcrumbs — the
   * label is the header's own muted text size and shrinks to an icon with the count on a narrow screen, so it never
   * wraps the header or pushes the action icons. 'title': under the page title, as faint as the ghost "+ Property"
   * it replaces once there are properties.
   */
  variant?: 'chrome' | 'header' | 'title';
  buttonRef?: Ref<HTMLButtonElement>;
}

/** The "Properties (3)" toggle: small enough to ride in the editor's chrome row, or in the page header. */
export function PropertiesToggle({ pageId, space, canEdit, open, onToggle, variant = 'chrome', buttonRef }: PropertiesToggleProps) {
  const { t } = useTranslation('app');
  const { count, visible } = useView(pageId, space, canEdit);
  if (!visible) return null;
  // Nothing to show yet but the user may add: the toggle says what clicking it does (owner, 16.10).
  const empty = count === 0 && canEdit;
  const label = empty ? t('properties.add') : t('properties.title', { n: count });
  if (variant === 'header') {
    return (
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={propertiesBodyId(pageId)}
        aria-haspopup="dialog"
        aria-label={label}
        title={label}
        onClick={onToggle}
        className="ph-mask flex min-w-0 items-center gap-1 rounded px-1.5 py-1 text-sm text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 max-md:min-h-10 max-md:min-w-10 max-md:justify-center dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
      >
        <ChevronRight size={13} className={`shrink-0 transition-transform max-md:hidden ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
        {empty ? (
          <Plus size={14} className="shrink-0 md:hidden" aria-hidden="true" />
        ) : (
          <SlidersHorizontal size={14} className="shrink-0 md:hidden" aria-hidden="true" />
        )}
        <span className="hidden truncate md:inline">{label}</span>
        {!empty && (
          <span className="text-xs md:hidden" aria-hidden="true">
            {count}
          </span>
        )}
      </button>
    );
  }
  if (variant === 'title') {
    return (
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={propertiesBodyId(pageId)}
        onClick={onToggle}
        className={TITLE_BUTTON}
      >
        <ChevronRight size={13} className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
        <span className="truncate">{label}</span>
      </button>
    );
  }
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-expanded={open}
      aria-controls={propertiesBodyId(pageId)}
      onClick={onToggle}
      className="ph-mask flex min-w-0 max-w-full items-center gap-1 rounded py-1 text-[13px] text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200"
    >
      <ChevronRight size={14} className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
      <span className="truncate">{label}</span>
    </button>
  );
}

/** The editors, shown under the chrome row while the toggle is open. */
export function PropertiesBody({ pageId, space, canEdit, canManageTypes, open, layout = 'column', addSignal = 0, onEmptyDone, withVerification = false, assignSignal = 0 }: PropertiesHalfProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const showToast = useToast();
  const queryClient = useQueryClient();
  const { state, data, visible } = useView(pageId, space, canEdit);
  const [draft, setDraft] = useState<NewProperty | null>(null);
  const [adding, setAdding] = useState(false);
  const [assigning, setAssigning] = useState(false);
  // The row whose field has focus, and the last value/type each row showed: a property another user removes while it
  // is being edited here stays on screen (saying so) instead of vanishing under the caret (propertiesLive.ts).
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const lastSeen = useRef(new Map<string, { value: unknown; type: ReturnType<typeof effectiveType> }>());

  const editable = canEdit && data?.canEdit !== false && !state.conflict;

  useEffect(() => {
    if (addSignal > 0) setAdding(true);
  }, [addSignal]);
  useEffect(() => {
    if (assignSignal > 0) setAssigning(true);
  }, [assignSignal]);

  const saveTypes = useMutation({
    mutationFn: async (property: NewProperty) => {
      // The PUT replaces the whole file: send the merged view (Obsidian's defaults included) plus the new key.
      const current = await api.getSpacePropertyTypes(space);
      return api.updateSpacePropertyTypes(space, { types: { ...current.types, [property.key]: property.type } });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['property-types', space] });
      showToast(t('properties.typeSaved'), 'info');
    },
    onError: (err) => showToast(errorText(err, 'properties.typeSaveFailed')),
  });

  if (!data || !visible || !open) return null;

  const readOnlyKeys = data.readOnly;
  const keys = Object.keys(state.properties);
  const ownKeys = withVerification ? keys.filter((key) => !(VERIFICATION_KEYS as readonly string[]).includes(key)) : keys;
  const hasVerificationKeys = ownKeys.length !== keys.length;
  const visibleKeys = ownKeys.filter((key) => !readOnlyKeys.includes(key));
  const lockedKeys = ownKeys.filter((key) => readOnlyKeys.includes(key));
  const removedKey =
    editingKey !== null && !(editingKey in state.properties) && lastSeen.current.has(editingKey) && !(draft && draft.key === editingKey) ? editingKey : null;
  const listedKeys = removedKey !== null ? [...visibleKeys, removedKey] : visibleKeys;
  const rowKeys = draft && !(draft.key in state.properties) ? [...listedKeys, draft.key] : listedKeys;
  for (const key of visibleKeys) lastSeen.current.set(key, { value: state.properties[key], type: effectiveType(key, state.properties[key], data.types) });
  const folioStatus = data.folioKeys?.includes('status') ?? true;

  function trackFocus(event: FocusEvent<HTMLElement>, focused: boolean) {
    const key = (event.target as HTMLElement).closest('[data-property]')?.getAttribute('data-property') ?? null;
    if (focused) setEditingKey(key);
    else setEditingKey((current) => (current === key ? null : current));
  }

  async function handleCommit(key: string, value: unknown) {
    const next = { ...state.properties, [key]: value };
    const pending = draft && draft.key === key ? draft : null;
    if (pending) setDraft(null);
    const ok = await state.commit(next);
    if (ok && pending?.saveType) saveTypes.mutate(pending);
  }

  function handleRemove(key: string) {
    // Removed HERE: not a row to keep alive as "removed by someone else".
    lastSeen.current.delete(key);
    setEditingKey(null);
    const next = { ...state.properties };
    delete next[key];
    void state.commit(next);
  }

  function handleAdd(property: NewProperty) {
    setAdding(false);
    setDraft(property);
  }

  return (
    <section aria-label={t('properties.label')} className="ph-mask shrink-0" onFocus={(e) => trackFocus(e, true)} onBlur={(e) => trackFocus(e, false)}>
      <div className={layout === 'column' ? 'folio-props-body' : ''}>
        <div
          id={propertiesBodyId(pageId)}
          className={layout === 'popover' ? 'max-h-[min(60vh,32rem)] overflow-y-auto' : layout === 'title' ? 'pt-0.5' : 'max-h-[45vh] overflow-y-auto pb-2'}
        >
            {state.conflict && (
              <div role="alert" className="mb-2 flex flex-wrap items-center gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                <TriangleAlert size={14} className="shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1">{t('properties.conflict')}</span>
                <button
                  type="button"
                  onClick={() => void state.reload()}
                  className="rounded-md bg-amber-200/70 px-2.5 py-1 text-sm font-medium hover:bg-amber-200 dark:bg-amber-900/60 dark:hover:bg-amber-900"
                >
                  {t('properties.reload')}
                </button>
              </div>
            )}

            {withVerification && <VerificationRows space={space} pageId={pageId} editable={editable} forceShow={assigning} />}

            {/* One keyed list for stored rows and the row being added: the new row keeps its place (and the caret) once its first value is saved. */}
            {rowKeys.map((key) => (
              <PropertyRow
                key={key}
                name={key}
                value={
                  key in state.properties ? state.properties[key] : key === removedKey ? lastSeen.current.get(key)!.value : emptyValueFor(draft?.type ?? 'text')
                }
                type={
                  key in state.properties
                    ? effectiveType(key, state.properties[key], data.types)
                    : key === removedKey
                      ? lastSeen.current.get(key)!.type
                      : (draft?.type ?? 'text')
                }
                foreign={data.foreign.includes(key)}
                locked={SYNONYM_KEYS.includes(key)}
                canEdit={editable}
                draft={!(key in state.properties) && key !== removedKey}
                folioStatus={folioStatus}
                removedRemotely={key === removedKey}
                onCommit={(k, v) => void handleCommit(k, v)}
                onRemove={handleRemove}
                onCancelDraft={() => {
                  setDraft(null);
                  if (visibleKeys.length === 0) onEmptyDone?.();
                }}
              />
            ))}

            {visibleKeys.length === 0 && !draft && !(layout === 'title' && adding) && !hasVerificationKeys && !assigning && <p className="px-1.5 py-1 text-sm text-neutral-400">{t('properties.empty')}</p>}

            {lockedKeys.map((key) => (
              <PropertyRow
                key={key}
                name={key}
                value={state.properties[key]}
                type={effectiveType(key, state.properties[key], data.types)}
                locked
                canEdit={false}
                onCommit={() => undefined}
                onRemove={() => undefined}
                onCancelDraft={() => undefined}
              />
            ))}

            {editable && withVerification && !hasVerificationKeys && !assigning && !adding && (
              <button
                type="button"
                onClick={() => setAssigning(true)}
                className="mt-1 flex items-center gap-1.5 rounded px-1.5 py-1 text-sm text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
              >
                <Plus size={13} aria-hidden="true" />
                {t('verification.assign')}
              </button>
            )}

            {editable &&
              (adding ? (
                <AddPropertyForm
                  space={space}
                  existingKeys={keys}
                  canManageTypes={canManageTypes}
                  onAdd={handleAdd}
                  onClose={() => {
                    setAdding(false);
                    if (visibleKeys.length === 0 && !draft) onEmptyDone?.();
                  }}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setAdding(true)}
                  className="mt-1 flex items-center gap-1.5 rounded px-1.5 py-1 text-sm text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
                >
                  <Plus size={13} aria-hidden="true" />
                  {t('properties.add')}
                </button>
              ))}
        </div>
      </div>
    </section>
  );
}

/** The faint 24px buttons under the page title: the ghost "+ Property" and the "Properties (3)" toggle. */
const TITLE_BUTTON =
  'ph-mask -ml-1.5 inline-flex h-6 min-w-0 max-w-full items-center gap-1 rounded-md pl-1.5 pr-2 text-[12.5px] text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300';

/** Pages whose next mount in an editing mode opens "Add property" at once: the ghost was clicked in reading mode. */
const addWhenEditing = new Set<string>();

export interface PageTitlePropertiesProps extends PropertiesPanelProps {
  /** Reading mode for someone who may edit: the ghost "+ Property" switches to Live edit and opens "Add property" there. */
  onStartEditing?: () => void;
}

/**
 * A document's properties under its title (owner, 07.11.2026 — out of the chrome row, Notion-like). With none, a
 * faint "+ Property" for whoever may add one (a viewer sees nothing); clicking it opens "Add property" right there —
 * from reading mode it first switches to Live edit, since reading is reading. With some, the "Properties (3)"
 * toggle, its open state remembered per space (usePropertiesOpen) as in the old chrome-row toggle.
 */
export function PageTitleProperties({ pageId, space, canEdit, canManageTypes, onStartEditing }: PageTitlePropertiesProps) {
  const { t } = useTranslation('app');
  const [open, setOpen] = usePropertiesOpen(space);
  const { data, count } = useView(pageId, space, canEdit);
  // Adding the first property: the body is open although the remembered state may say closed.
  const [adding, setAdding] = useState(false);
  const [addSignal, setAddSignal] = useState(0);
  const [assignSignal, setAssignSignal] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  function startAdding() {
    setOpen(true);
    setAdding(true);
    setAddSignal((n) => n + 1);
  }

  function startAssigning() {
    setOpen(true);
    setAdding(true);
    setAssignSignal((n) => n + 1);
  }

  // Arrived from the reading-mode ghost: open the form, and take focus once the editor has drawn this slot (the
  // CodeMirror view mounts after us and focuses itself, so the form's autoFocus alone loses).
  useEffect(() => {
    if (!canEdit || !addWhenEditing.delete(pageId)) return;
    startAdding();
    const timer = setTimeout(() => rootRef.current?.querySelector<HTMLInputElement>('input')?.focus(), 60);
    return () => clearTimeout(timer);
    // On mount (and when editing becomes possible) only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canEdit, pageId]);

  const empty = count === 0;
  // Once the first property is in, the remembered open state takes over again.
  useEffect(() => {
    if (!empty) setAdding(false);
  }, [empty]);

  if (!data) return null;
  const mayAdd = canEdit || onStartEditing !== undefined;
  if (empty && !adding && !mayAdd) return null;

  const ghost = (
    <button
      type="button"
      className={TITLE_BUTTON}
      aria-label={t('properties.add')}
      onClick={() => {
        if (canEdit) startAdding();
        else if (onStartEditing) {
          addWhenEditing.add(pageId);
          onStartEditing();
        }
      }}
    >
      <Plus size={13} className="shrink-0" aria-hidden="true" />
      <span className="truncate">{t('properties.addShort')}</span>
    </button>
  );
  // Only for someone who may edit right now (Live / Source): reading mode shows, never sets, an owner.
  const assignGhost = canEdit && (
    <button type="button" className={TITLE_BUTTON} onClick={startAssigning}>
      <Plus size={13} className="shrink-0" aria-hidden="true" />
      <span className="truncate">{t('verification.assign')}</span>
    </button>
  );

  return (
    <div ref={rootRef} className="folio-title-props" data-empty={empty ? '' : undefined}>
      {empty ? (
        !adding && (
          <div className="flex flex-wrap items-center gap-x-1">
            {ghost}
            {assignGhost}
          </div>
        )
      ) : (
        <PropertiesToggle pageId={pageId} space={space} canEdit={canEdit} open={open} onToggle={() => setOpen((v) => !v)} variant="title" />
      )}
      <PropertiesBody
        pageId={pageId}
        space={space}
        canEdit={canEdit}
        canManageTypes={canManageTypes}
        open={empty ? adding : open}
        layout="title"
        withVerification
        addSignal={addSignal}
        assignSignal={assignSignal}
        onEmptyDone={() => setAdding(false)}
      />
    </div>
  );
}

/** The popover's width cap, px (a phone gets the viewport minus its margins). */
const POPOVER_WIDTH = 420;
const POPOVER_MARGIN = 8;

/**
 * The properties of a page without the document editor's chrome row — a data table, a form, a board, a PDF or
 * an Office file — as a toggle in the page HEADER, right after the breadcrumbs (owner, 15.10.2026: a strip above the
 * board "takes a lot of space"), and the editors in a popover under it that overlays the page instead of pushing it down.
 * The toggle is portaled into the header's slot (PropertiesSlotContext); with no header around (a test) it renders where
 * it stands. Closed by default and not remembered: it is a look-and-edit, not a mode. Escape, a click outside or the
 * toggle again closes it; Escape hands focus back to the toggle. A viewer of a page without properties sees nothing.
 *
 * Who may edit (owner's rule: reading is reading): these pages have no reading / editing modes of their own —
 * the table, the board and the file viewer are the same surface for every role — so the properties are editable
 * exactly for the people who may edit the page (`canEdit`, the page role, as for the page itself), read-only
 * for everyone else. A form's "Edit form" dialog changes the definition, not the page's metadata, so it is not
 * a mode either.
 */
export function PagePropertiesPopover(props: PropertiesPanelProps) {
  const { t } = useTranslation('app');
  const slot = useContext(PropertiesSlotContext);
  const { visible } = useView(props.pageId, props.space, props.canEdit);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ left: number; top: number; width: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const shown = open && visible;

  useOutsideClick([rootRef], close);

  // The panel hangs under the toggle (absolute inside the slot, so Tab reaches it naturally), clamped to the viewport.
  useLayoutEffect(() => {
    if (!shown) {
      setCoords(null);
      return;
    }
    function place() {
      const trigger = triggerRef.current;
      const root = rootRef.current;
      if (!trigger || !root) return;
      const triggerRect = trigger.getBoundingClientRect();
      const rootRect = root.getBoundingClientRect();
      const viewport = document.documentElement.clientWidth;
      const width = Math.min(POPOVER_WIDTH, viewport - 2 * POPOVER_MARGIN);
      const left = Math.max(POPOVER_MARGIN, Math.min(triggerRect.left, viewport - width - POPOVER_MARGIN));
      setCoords({ left: left - rootRect.left, top: triggerRect.bottom + 4 - rootRect.top, width });
    }
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [shown]);

  // Focus moves into the panel once it is placed; Escape closes it and returns focus to the toggle.
  useEffect(() => {
    if (shown && coords && !panelRef.current?.contains(document.activeElement)) panelRef.current?.focus({ preventScroll: true });
    // Only when the panel first appears, not on every re-place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, coords === null]);

  useEffect(() => {
    if (!shown) return;
    function onKey(event: KeyboardEvent) {
      // A field inside the panel handles its own Escape (cancel the edit) and stops it before it gets here.
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      setOpen(false);
      triggerRef.current?.focus();
    }
    // A click into an iframe (the PDF viewer) never reaches this document's pointerdown; the window loses focus to the frame instead.
    function onBlur() {
      if (document.activeElement instanceof HTMLIFrameElement) setOpen(false);
    }
    document.addEventListener('keydown', onKey);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onBlur);
    };
  }, [shown]);

  const content = (
    <div ref={rootRef} className="relative ml-1 shrink-0" data-page-properties="">
      <PropertiesToggle
        pageId={props.pageId}
        space={props.space}
        canEdit={props.canEdit}
        open={shown}
        onToggle={() => setOpen((v) => !v)}
        variant="header"
        buttonRef={triggerRef}
      />
      {shown && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label={t('properties.label')}
          tabIndex={-1}
          style={{ left: coords?.left ?? 0, top: coords?.top ?? 0, width: coords?.width ?? POPOVER_WIDTH, visibility: coords ? 'visible' : 'hidden' }}
          className="absolute z-50 max-h-[calc(100dvh-5rem)] overflow-y-auto rounded-lg border border-neutral-200 bg-white p-3 shadow-lg outline-none dark:border-neutral-700 dark:bg-neutral-900"
        >
          <PropertiesBody {...props} open layout="popover" />
        </div>
      )}
    </div>
  );
  if (slot === undefined) return content;
  return slot ? createPortal(content, slot) : null;
}

/** Toggle and body together (the standalone layout; PageContent splits them across the editor's chrome). */
export function PropertiesPanel(props: PropertiesPanelProps) {
  const [open, setOpen] = usePropertiesOpen(props.space);
  return (
    <>
      <PropertiesToggle pageId={props.pageId} space={props.space} canEdit={props.canEdit} open={open} onToggle={() => setOpen((v) => !v)} />
      <PropertiesBody {...props} open={open} />
    </>
  );
}
