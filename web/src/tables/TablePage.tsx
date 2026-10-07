import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Rows3, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TableCellValue, TableColumn, TableDoc, TableRow, TableView } from '@shared/contracts';
import './i18n/register';
import { track, trackEdit } from '../analytics';
import { ViewTabs } from './views/ViewTabs';
import { clearDraft, isDirty, loadDraft, makeView, saveDraft } from './views/viewDraft';
import { FilterPanel } from './panels/FilterPanel';
import { SortPanel } from './panels/SortPanel';
import { HidePanel } from './panels/HidePanel';
import { RowDetailPanel } from './RowDetailPanel';
import { SelectionBar } from './SelectionBar';
import { TableExportMenu } from './TableExportMenu';
import { PastePreview, parseClipboardGrid } from './PastePreview';
import { ColumnEditor } from './header/ColumnEditor';
import { AddColumnButton } from './header/AddColumnButton';
import type { ColumnMenuActions } from './header/ColumnMenu';
import { Button } from './ui/Button';
import { Select } from './ui/Select';
import { Tooltip } from './ui/Tooltip';
import { STATUS_OPTIONS } from './fixtures';
import { visibleColumns } from './gridColumns';
import { applyFilters, applySearch, applySort, parseCellText, uniqueColumnId } from './core';
import { applyPatches, makeEmptyRow, makeRowId } from './patch';
import { canSaveViews, canEdit } from './types';
import type { TableEditorProps, TablePatch } from './types';
import { exportFilename, exportMime, serializeExport } from './export';
import type { ExportFormat } from './export';
import { downloadBlob } from '../diagrams/download';

/**
 * Round 26 (DATA TABLES) — TablePage: the assembled data-table surface.
 *
 * ══════════════════════════════════════════════════════════════════════
 *  THIS IS THE ZONE'S ENTRY POINT. SHELL-TABLES mounts it (wave 3) from
 *  web/src/app/routes/PageContent.tsx's `kind === 'table'` branch and from
 *  app/share/SharedPageView.tsx — see DEV-PLAN R26, "Agent 5".
 *  Re-exported as `TableEditor` from ./index.tsx, mirroring how
 *  diagrams/index.tsx exposes BoardEditor.
 * ══════════════════════════════════════════════════════════════════════
 *
 * Composes: view tabs + draft (spec §5) · Filter/Sort/Hide panels with
 * counts · global search · the lazily-loaded grid · column header/menu/editor
 * · row detail panel (§4) · bulk-selection bar (§4) · export menu (§10) ·
 * paste-with-type-preview (§10.1) · mobile layout (§14).
 *
 * ─── State ownership, deliberately ───────────────────────────────────────
 * WAVE 1 (now): the doc is local state, and patches are applied by
 * ./patch.ts's reducer. Everything below the `onPatch` callback is already
 * written the way wave 3 needs it.
 * WAVE 3: `props.onPatch` is supplied by COLLAB-TABLES and `props.doc`
 * becomes the Y.Doc mirror; this component then stops owning the doc and
 * becomes fully controlled. That switch is the `controlled` branch in
 * `useDocState` below — it is already wired, not a future refactor.
 *
 * The read pipeline is filter → search → sort, in that order, matching what
 * the server does for `GET /rows` so the two cannot disagree (spec §12a: one
 * engine, in shared/tables — see core.ts's header for the wave-3 swap).
 */

// Own chunk: the grid, @tanstack/react-virtual and the library stylesheet
// only download on a page that actually shows a table (spec §12a, item 7).
const LazyGrid = lazy(() => import('./TableGrid'));

/**
 * Controlled when the parent passes `onPatch` (wave 3, CRDT-backed);
 * self-managed otherwise (wave 1 mocks, tests, storybook-ish usage).
 */
function useDocState(initial: TableDoc, onPatch?: (patch: TablePatch) => void, pageId?: string) {
  const [local, setLocal] = useState(initial);
  const controlled = Boolean(onPatch);

  // Keep the local mirror in step when the parent hands down a new doc
  // (a fresh page, or the CRDT mirror updating).
  useEffect(() => {
    if (controlled) setLocal(initial);
  }, [controlled, initial]);

  const doc = controlled ? initial : local;

  const dispatch = useCallback(
    (patches: TablePatch[]) => {
      if (patches.length === 0) return;
      // Optional analytics: that rows were added or the table was edited, never the values.
      if (patches.some((patch) => patch.kind === 'rows:create')) track('table_row_add');
      if (pageId && patches.some((patch) => patch.kind.startsWith('rows:') || patch.kind.startsWith('columns:'))) trackEdit('table', pageId);
      if (onPatch) {
        for (const patch of patches) onPatch(patch);
        return;
      }
      setLocal((previous) => applyPatches(previous, patches));
    },
    [onPatch, pageId],
  );

  return { doc, dispatch };
}

export function TablePage({
  pageId,
  doc: incoming,
  role = 'editor',
  highlightRowId,
  onPatch,
  mentionable,
  rowLinkFor,
  onActiveViewChange,
}: TableEditorProps) {
  const { t } = useTranslation('tables');
  const { doc, dispatch } = useDocState(incoming, onPatch, pageId);

  const readOnly = !canEdit(role);
  const maySaveViews = canSaveViews(role);

  // ---------------------------------------------------------------- views

  const [activeViewId, setActiveViewId] = useState(() => doc.views[0]?.id ?? 'all');
  const savedView = useMemo(
    () => doc.views.find((view) => view.id === activeViewId) ?? doc.views[0],
    [doc.views, activeViewId],
  );

  // R23 tail: report the RESOLVED saved view (post-fallback), not the raw
  // selection — see TableEditorProps.onActiveViewChange.
  useEffect(() => {
    if (savedView) onActiveViewChange?.(savedView.id);
  }, [savedView?.id, onActiveViewChange]); // eslint-disable-line react-hooks/exhaustive-deps

  // The local, unsaved copy of the active view (spec §5). `null` = clean.
  const [draft, setDraft] = useState<TableView | null>(null);

  // Rehydrate the persisted draft when the active view changes. A viewer
  // gets drafts too — they just can't save them (spec §12).
  useEffect(() => {
    if (!savedView) return;
    setDraft(loadDraft(pageId, savedView));
  }, [pageId, savedView]);

  const view = draft ?? savedView;
  const dirty = Boolean(savedView && draft && isDirty(savedView, draft));

  /** Every view mutation goes through here so persistence is never forgotten. */
  const updateView = useCallback(
    (patch: Partial<TableView>) => {
      if (!savedView) return;
      const next: TableView = { ...(draft ?? savedView), ...patch };
      setDraft(next);
      saveDraft(pageId, savedView, next);
    },
    [draft, savedView, pageId],
  );

  // ----------------------------------------------------------- read model

  const [search, setSearch] = useState('');
  const [ignoreFilters, setIgnoreFilters] = useState(false);

  const shownColumns = useMemo(
    () => (view ? visibleColumns(doc.columns, view) : doc.columns),
    [doc.columns, view],
  );

  const rows = useMemo(() => {
    if (!view) return doc.rows;
    // filter → search → sort, matching the server's own order.
    const filtered = ignoreFilters ? doc.rows : applyFilters(doc.rows, doc.columns, view.filter);
    const searched = applySearch(filtered, doc.columns, search);
    return applySort(searched, doc.columns, view.sort);
  }, [doc.rows, doc.columns, view, search, ignoreFilters]);

  // ------------------------------------------------------------ selection

  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  // Rows that scrolled out of the current view must not stay selected
  // invisibly — a later "delete selected" would then hit rows the user
  // cannot see, which is exactly the sort of surprise the bulk bar must not
  // produce.
  useEffect(() => {
    setSelected((previous) => {
      if (previous.size === 0) return previous;
      const visible = new Set(rows.map((row) => row.id));
      const next = new Set([...previous].filter((id) => visible.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [rows]);

  const toggleRow = useCallback((rowId: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (!next.delete(rowId)) next.add(rowId);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected((previous) =>
      previous.size === rows.length ? new Set() : new Set(rows.map((row) => row.id)),
    );
  }, [rows]);

  // ------------------------------------------------------------ row panel

  const [openRowId, setOpenRowId] = useState<string | null>(highlightRowId ?? null);

  // Deep link from Cmd+K / `?row=<id>` (spec §11): open the row's panel, and
  // if the current view filters it out, offer to drop the filters rather
  // than showing an empty table and no explanation.
  useEffect(() => {
    if (!highlightRowId) return;
    setOpenRowId(highlightRowId);
    const visible = rows.some((row) => row.id === highlightRowId);
    const exists = doc.rows.some((row) => row.id === highlightRowId);
    if (!visible && exists) setIgnoreFilters(true);
    // Intentionally keyed on the link only: re-running this when `rows`
    // changes would fight the user's own later filter changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightRowId]);

  const openRowIndex = rows.findIndex((row) => row.id === openRowId);
  const openRow = openRowIndex >= 0 ? rows[openRowIndex] : undefined;

  // ------------------------------------------------------------- mutation

  const setCell = useCallback(
    (rowId: string, columnId: string, value: TableCellValue) => {
      dispatch([{ kind: 'rows:update', rows: [{ id: rowId, values: { [columnId]: value } }] }]);
    },
    [dispatch],
  );

  const createRow = useCallback(() => makeEmptyRow(doc, makeRowId()), [doc]);

  const addRow = useCallback(() => {
    dispatch([{ kind: 'rows:create', at: doc.rows.length, rows: [createRow()] }]);
  }, [dispatch, doc.rows.length, createRow]);

  const addOption = useCallback(
    (columnId: string, value: string) => {
      const column = doc.columns.find((c) => c.id === columnId);
      if (!column) return;
      if ((column.options ?? []).some((option) => option.value === value)) return;
      dispatch([
        {
          kind: 'columns:update',
          id: columnId,
          patch: { options: [...(column.options ?? []), { value, color: 'gray' }] },
        },
      ]);
    },
    [dispatch, doc.columns],
  );

  // --------------------------------------------------------- column edits

  const [editingColumn, setEditingColumn] = useState<TableColumn | null>(null);

  const columnActions = useMemo<ColumnMenuActions>(
    () => ({
      onEdit: (column) => setEditingColumn(column),
      onDuplicate: (column) => {
        const used = new Set(doc.columns.map((c) => c.id));
        const id = uniqueColumnId(`${column.name} 2`, doc.columns.length, used);
        const at = doc.columns.findIndex((c) => c.id === column.id) + 1;
        dispatch([{ kind: 'columns:create', at, column: { ...column, id, name: `${column.name} 2` } }]);
      },
      onInsertAfter: (column) => {
        const used = new Set(doc.columns.map((c) => c.id));
        const name = t('column.newName');
        const id = uniqueColumnId(name, doc.columns.length, used);
        const at = doc.columns.findIndex((c) => c.id === column.id) + 1;
        dispatch([{ kind: 'columns:create', at, column: { id, name, type: 'text' } }]);
      },
      onHide: (columnId) => {
        if (!view) return;
        updateView({ columns: { ...view.columns, hidden: [...view.columns.hidden, columnId] } });
      },
      onDelete: (column) => {
        // Deleting a column destroys every value in it, so it asks — the one
        // place in this zone that uses a blocking confirm rather than undo.
        if (!window.confirm(t('column.deleteConfirm', { name: column.name }))) return;
        dispatch([{ kind: 'columns:delete', id: column.id }]);
      },
      onSort: (columnId, dir) => updateView({ sort: [{ column: columnId, dir }] }),
    }),
    [doc.columns, dispatch, t, view, updateView],
  );

  /**
   * Creates a column with its type already set (owner: "the dropdown with
   * the type has to be there at once"). Both add-column affordances — the "+" after the
   * last column header and the "+ Column" button under the grid — route
   * here, so they cannot drift apart.
   *
   * Always a patch, never local state: in controlled mode (`onPatch`
   * supplied, i.e. the real CRDT-backed page) this component does not own the
   * doc at all, and a local mutation would be silently dropped.
   */
  const addColumn = useCallback(
    (name: string, type: TableColumn['type']) => {
      const used = new Set(doc.columns.map((c) => c.id));
      const finalName = name.trim() === '' ? t('column.newName') : name.trim();
      const id = uniqueColumnId(finalName, doc.columns.length, used);
      const column: TableColumn = { id, name: finalName, type };
      // `status` arrives with the normative preset from spec §3 rather than
      // an empty list the user has to type out — the same seeding
      // ColumnEditor.changeType does, so the two agree.
      if (type === 'status') column.options = STATUS_OPTIONS.map((option) => ({ ...option }));
      else if (type === 'select') column.options = [];
      dispatch([{ kind: 'columns:create', at: doc.columns.length, column }]);
    },
    [dispatch, doc.columns, t],
  );

  /**
   * Column widths live in the VIEW, not on the column (spec §5 stores
   * `columns.width` per view, and `tableColumnSchema.width` is the schema-wide
   * default that a view overrides). Two reasons that is the right target:
   * a width is a per-person, per-view display choice — one view can want a
   * wide «Task» and another a narrow one — and going through `updateView`
   * means a resize lands in the local DRAFT and shows up under "Save
   * changes" like every other view change, instead of silently rewriting a
   * shared view (and producing a commit) the moment someone drags an edge.
   */
  const resizeColumn = useCallback(
    (columnId: string, width: number) => {
      if (!view) return;
      if (view.columns.width[columnId] === width) return;
      updateView({ columns: { ...view.columns, width: { ...view.columns.width, [columnId]: width } } });
    },
    [view, updateView],
  );

  // ----------------------------------------------------------------- view
  //                                                          save / create

  function saveDraftToView() {
    if (!savedView || !draft) return;
    const { id, name, icon, ...rest } = draft;
    void id;
    void name;
    void icon;
    dispatch([{ kind: 'views:update', id: savedView.id, patch: rest }]);
    clearDraft(pageId, savedView.id);
    setDraft(null);
  }

  function saveDraftAsNewView() {
    if (!draft) return;
    const id = `view-${makeRowId()}`;
    const name = window.prompt(t('view.renamePrompt'), t('view.newName'))?.trim();
    if (!name) return;
    dispatch([{ kind: 'views:create', view: { ...draft, id, name } }]);
    if (savedView) clearDraft(pageId, savedView.id);
    setDraft(null);
    setActiveViewId(id);
  }

  function resetDraft() {
    if (savedView) clearDraft(pageId, savedView.id);
    setDraft(null);
  }

  // ---------------------------------------------------------------- paste

  const [pasteRows, setPasteRows] = useState<string[][] | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  /**
   * Ctrl+V into the page (rather than into an editing cell) opens the type
   * preview — the Google Sheets migration path from spec §10/§17.3. A paste
   * landing INSIDE a cell editor is the grid's own business (its
   * prePasteValues hook), so those are ignored here.
   */
  useEffect(() => {
    if (readOnly) return;
    function onPaste(event: ClipboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      if (!rootRef.current?.contains(target ?? null)) return;
      const text = event.clipboardData?.getData('text/plain') ?? '';
      const grid = parseClipboardGrid(text);
      // A single cell is an ordinary paste, not an import.
      if (grid.length < 2 && (grid[0]?.length ?? 0) < 2) return;
      event.preventDefault();
      setPasteRows(grid);
    }
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [readOnly]);

  function confirmPaste(result: { columns: TableColumn[] | null; rows: string[][]; mode: 'append' | 'replace' }) {
    const patches: TablePatch[] = [];
    let columns = doc.columns;

    if (result.columns) {
      columns = result.columns;
      // A brand-new schema: drop the placeholder columns, add the inferred
      // ones. Emitted as individual patches so the CRDT sees real
      // operations in wave 3, not a wholesale replacement.
      for (const column of doc.columns) patches.push({ kind: 'columns:delete', id: column.id });
      result.columns.forEach((column, index) =>
        patches.push({ kind: 'columns:create', at: index, column }),
      );
    }

    if (result.mode === 'replace') {
      patches.push({ kind: 'rows:delete', ids: doc.rows.map((row) => row.id) });
    }

    const newRows: TableRow[] = result.rows.map((line) => {
      const values: Record<string, TableCellValue> = {};
      columns.forEach((column, index) => {
        values[column.id] = parseCellText(column, line[index] ?? '');
      });
      return { id: makeRowId(), values };
    });

    patches.push({
      kind: 'rows:create',
      at: result.mode === 'replace' ? 0 : doc.rows.length,
      rows: newRows,
    });

    dispatch(patches);
    setPasteRows(null);
  }

  // --------------------------------------------------------------- export

  const handleExport = useCallback(
    async (format: ExportFormat, options: { scope: 'view' | 'all'; includeIds: boolean }) => {
      // Kept async and allowed to throw: TableExportMenu's contract is that
      // it surfaces a rejection instead of failing silently, and wave 3 may
      // route the 'all' scope through the server endpoint, which is async.
      const exportRows = options.scope === 'all' ? doc.rows : rows;
      const exportColumns = options.scope === 'all' ? doc.columns : shownColumns;
      const text = serializeExport(format, {
        doc,
        rows: exportRows,
        columns: exportColumns,
        includeIds: options.includeIds,
      });
      const title = doc.head.match(/^#\s+(.+)$/m)?.[1] ?? 'table';
      downloadBlob(new Blob([text], { type: exportMime(format) }), exportFilename(title, format));
    },
    [doc, rows, shownColumns],
  );

  function exportSelection() {
    const chosen = rows.filter((row) => selected.has(row.id));
    const text = serializeExport('csv', { doc, rows: chosen, columns: shownColumns });
    const title = doc.head.match(/^#\s+(.+)$/m)?.[1] ?? 'table';
    downloadBlob(new Blob([text], { type: exportMime('csv') }), exportFilename(`${title}-selection`, 'csv'));
  }

  if (!view || !savedView) return null;

  const filtersActive = view.filter.rules.length > 0 || search !== '';
  const gridDeps = {
    mentionable,
    search,
    onOpenRow: setOpenRowId,
    onCreateOption: addOption,
    actions: columnActions,
    // Grows the add-column slot after the last column header (gridColumns).
    onAddColumn: addColumn,
    onResizeColumn: resizeColumn,
  };

  return (
    <div ref={rootRef} className="relative flex h-full min-h-0 w-full flex-col">
      <ViewTabs
        views={doc.views}
        activeId={activeViewId}
        dirty={dirty}
        canSave={maySaveViews}
        onSelect={setActiveViewId}
        onSaveDraft={saveDraftToView}
        onSaveAsNew={saveDraftAsNewView}
        onResetDraft={resetDraft}
        onCreate={(copyCurrent) => {
          const id = `view-${makeRowId()}`;
          const name = window.prompt(t('view.renamePrompt'), t('view.newName'))?.trim();
          if (!name) return;
          dispatch([{ kind: 'views:create', view: makeView(id, name, copyCurrent ? view : undefined) }]);
          setActiveViewId(id);
        }}
        onRename={(target) => {
          const name = window.prompt(t('view.renamePrompt'), target.name)?.trim();
          if (!name) return;
          dispatch([{ kind: 'views:update', id: target.id, patch: { name } }]);
        }}
        onDuplicate={(target) => {
          const id = `view-${makeRowId()}`;
          dispatch([{ kind: 'views:create', view: makeView(id, `${target.name} 2`, target) }]);
          setActiveViewId(id);
        }}
        onDelete={(target) => {
          if (doc.views.length <= 1) return;
          if (!window.confirm(t('view.deleteConfirm', { name: target.name }))) return;
          clearDraft(pageId, target.id);
          dispatch([{ kind: 'views:delete', id: target.id }]);
          const fallback = doc.views.find((candidate) => candidate.id !== target.id);
          if (fallback) setActiveViewId(fallback.id);
        }}
      />

      {/* Toolbar. Scrolls horizontally rather than wrapping on a phone
          (spec §14) so it always stays one row tall. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200 px-2 py-1.5 dark:border-neutral-700">
        <FilterPanel
          columns={doc.columns}
          filter={view.filter}
          mentionable={mentionable}
          onChange={(filter) => updateView({ filter })}
        />
        <SortPanel columns={doc.columns} sort={view.sort} onChange={(sort) => updateView({ sort })} />
        <HidePanel
          columns={doc.columns}
          hidden={view.columns.hidden}
          onChange={(hidden) => updateView({ columns: { ...view.columns, hidden } })}
        />

        <label className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-600">
          <Search size={12} aria-hidden className="shrink-0 text-neutral-400" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('toolbar.searchPlaceholder')}
            aria-label={t('toolbar.search')}
            className="w-full min-w-0 bg-transparent text-xs outline-none placeholder:text-neutral-400"
          />
          {search !== '' && (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label={t('common.close')}
              className="shrink-0 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
            >
              <X size={12} />
            </button>
          )}
        </label>

        <span className="shrink-0 text-[11px] text-neutral-400">
          {t('toolbar.rowCount', { shown: rows.length, total: doc.rows.length })}
        </span>

        {/* Row height. It used to be a bare dropdown reading
            "Low/Medium/High" with nothing to say what it controlled
            ("it is unclear what this is" — owner). The toolbar is already
            crowded and §14 keeps it one row tall on a phone, so a permanent
            "Row height:" label is too heavy: the icon supplies the noun,
            the tooltip and the control's accessible name supply the words,
            and both hover AND keyboard focus open the tooltip. */}
        <Tooltip content={t('toolbar.rowHeight')} className="shrink-0 items-center gap-1">
          <Rows3 size={13} aria-hidden className="shrink-0 text-neutral-400" />
          <Select
            hideLabel
            label={t('toolbar.rowHeight')}
            value={view.rowHeight}
            onChange={(rowHeight) => updateView({ rowHeight: rowHeight as TableView['rowHeight'] })}
            options={[
              { value: 'short', label: t('rowHeight.short') },
              { value: 'medium', label: t('rowHeight.medium') },
              { value: 'tall', label: t('rowHeight.tall') },
            ]}
            className="shrink-0"
          />
        </Tooltip>

        <TableExportMenu onExport={handleExport} viewCount={rows.length} totalCount={doc.rows.length} />

        {readOnly && (
          <span className="shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
            {t('toolbar.readOnly')}
          </span>
        )}
      </div>

      {ignoreFilters && filtersActive && (
        <p className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-1 text-[11px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          {t('grid.clearFilters')}
          <Button size="sm" variant="ghost" onClick={() => setIgnoreFilters(false)}>
            {t('common.close')}
          </Button>
        </p>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-auto">
          <Suspense
            fallback={<p className="p-4 text-sm text-neutral-400">{t('grid.loading')}</p>}
          >
            <LazyGrid
              rows={rows}
              columns={shownColumns}
              view={view}
              onPatch={dispatch}
              readOnly={readOnly}
              // Spec §4: with a sort active the visible order isn't the file
              // order, so positional row add/remove would land somewhere the
              // user didn't point at.
              lockRows={view.sort.length > 0}
              createRow={createRow}
              deps={gridDeps}
              selectedIds={selected}
              onToggleRow={toggleRow}
              onToggleAll={toggleAll}
              selectAllLabel={t('row.selectAll')}
              selectRowLabel={t('row.select')}
            />
          </Suspense>

          {rows.length === 0 && (
            <p className="p-4 text-center text-sm text-neutral-400">
              {doc.rows.length === 0 ? t('grid.empty') : t('grid.noMatches')}
            </p>
          )}

          {!readOnly && (
            <div className="flex gap-2 p-2">
              <Button size="sm" icon={<Plus size={12} />} onClick={addRow} disabled={view.sort.length > 0}>
                {t('toolbar.addRow')}
              </Button>
              {/* KEPT alongside the grid's own «+» on purpose, not by
                  oversight. The in-grid slot sits after the LAST column, so
                  on a wide table you have to scroll to the end to reach it —
                  and on a phone (§14) horizontal scrolling is exactly what
                  this button spares you. Both open the same picker and go
                  through the same `addColumn`, so they can't drift. */}
              <AddColumnButton variant="full" onCreate={addColumn} />
            </div>
          )}
        </div>

        {openRow && (
          <RowDetailPanel
            row={openRow}
            // Every column, including ones the current view hides — that is
            // the point of the panel (spec §4).
            columns={doc.columns}
            index={openRowIndex}
            total={rows.length}
            readOnly={readOnly}
            mentionable={mentionable}
            onChange={(columnId, value) => setCell(openRow.id, columnId, value)}
            onNavigate={(delta) => {
              const next = rows[openRowIndex + delta];
              if (next) setOpenRowId(next.id);
            }}
            onClose={() => setOpenRowId(null)}
            onCreateOption={addOption}
            onCopyLink={(rowId) => {
              // Wave 3: the shell hands down a router-aware absolute URL; the
              // window.location fallback is the mock/test path.
              const link = rowLinkFor
                ? rowLinkFor(rowId)
                : `${window.location.origin}${window.location.pathname}?row=${encodeURIComponent(rowId)}`;
              void navigator.clipboard?.writeText(link);
            }}
          />
        )}
      </div>

      <SelectionBar
        count={selected.size}
        columns={doc.columns}
        readOnly={readOnly}
        mentionable={mentionable}
        onClear={() => setSelected(new Set())}
        onDelete={() => {
          if (!window.confirm(t('selection.deleteConfirm'))) return;
          dispatch([{ kind: 'rows:delete', ids: [...selected] }]);
          setSelected(new Set());
        }}
        onSetValue={(columnId, value) => {
          dispatch([
            {
              kind: 'rows:update',
              rows: [...selected].map((id) => ({ id, values: { [columnId]: value } })),
            },
          ]);
        }}
        onExport={exportSelection}
      />

      {editingColumn && (
        <ColumnEditor
          column={editingColumn}
          rows={doc.rows}
          onClose={() => setEditingColumn(null)}
          onSave={(patch) => dispatch([{ kind: 'columns:update', id: editingColumn.id, patch }])}
        />
      )}

      {pasteRows && (
        <PastePreview
          rows={pasteRows}
          existingColumns={doc.columns}
          onCancel={() => setPasteRows(null)}
          onConfirm={confirmPaste}
        />
      )}
    </div>
  );
}
