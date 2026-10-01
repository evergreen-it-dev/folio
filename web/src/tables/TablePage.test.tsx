// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import type { TableRow } from '@shared/contracts';
import { TablePage } from './TablePage';
import { STATUS_OPTIONS, makeMockTableDoc } from './fixtures';
import './i18n/register';

/**
 * Round 26 (DATA TABLES) — the assembled table surface.
 *
 * The real react-datasheet-grid is mocked out, following this project's
 * "heavy modules are mocked" convention (cf. `vi.mock('../../editor')` in
 * the markdown zone). It virtualises through @tanstack/react-virtual and
 * measures real element boxes — in jsdom every box is 0×0, so it would
 * render no rows and these assertions would test nothing. The stand-in
 * renders the rows it is handed, which is exactly the contract this file
 * cares about: that TablePage computes and passes the right rows, columns
 * and flags. The grid's own behaviour is the library's business; the
 * translation layer between it and us is covered by patch.test.ts.
 */
vi.mock('./TableGrid', () => ({
  default: ({
    rows,
    columns,
    readOnly,
    lockRows,
    deps,
  }: {
    rows: TableRow[];
    columns: { id: string; name: string }[];
    readOnly?: boolean;
    lockRows?: boolean;
    deps: { onResizeColumn?: (columnId: string, width: number) => void };
  }) => (
    <div
      data-testid="grid"
      data-readonly={String(Boolean(readOnly))}
      data-lockrows={String(Boolean(lockRows))}
      data-columns={columns.map((column) => column.id).join(',')}
    >
      {/* Stand-in for the header's resize handle: the real one is exercised in
          header/ColumnHeader.test.tsx, but the wire from `deps` into the view
          draft is TablePage's own contract and has to be checked here. */}
      <button type="button" data-testid="resize" onClick={() => deps.onResizeColumn?.('task', 420)}>
        resize
      </button>
      {rows.map((row) => (
        <div key={row.id} data-testid="grid-row" data-row-id={row.id}>
          {String(row.values.task ?? '')}
        </div>
      ))}
    </div>
  ),
}));

beforeEach(async () => {
  await i18next.changeLanguage('en');
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

function renderPage(props: Partial<Parameters<typeof TablePage>[0]> = {}) {
  return render(<TablePage pageId="page-1" doc={makeMockTableDoc()} {...props} />);
}

/** The grid is lazy — every test has to wait for the chunk to resolve. */
async function grid() {
  return waitFor(() => screen.getByTestId('grid'));
}

describe('TablePage — views', () => {
  it('renders the saved views as tabs and selects the first', async () => {
    renderPage();
    await grid();
    expect(screen.getByRole('tab', { name: /All records/ })).toBeTruthy();
    const active = screen.getByRole('tab', { name: /All records/ });
    expect(active.getAttribute('aria-selected')).toBe('true');
  });

  it('applies the second view’s filter and hidden columns on switch', async () => {
    renderPage();
    await grid();
    // The "In progress" view filters status ∈ {IN PROG, PLANNING} and hides
    // the details/spec columns.
    fireEvent.click(screen.getByRole('tab', { name: /In progress/ }));
    await waitFor(() => {
      expect(screen.getAllByTestId('grid-row')).toHaveLength(3);
    });
    const columns = screen.getByTestId('grid').getAttribute('data-columns') ?? '';
    expect(columns).not.toContain('details');
    expect(columns).not.toContain('spec');
  });
});

describe('TablePage — draft (spec §5)', () => {
  it('shows no save buttons until the view is actually changed', async () => {
    renderPage();
    await grid();
    expect(screen.queryByText('Save changes')).toBeNull();
  });

  it('turning a filter into a draft offers Save / Save as new, and does not touch the saved view', async () => {
    renderPage();
    await grid();
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    fireEvent.click(await screen.findByText('Add filter'));

    await waitFor(() => expect(screen.getByText('Save changes')).toBeTruthy());
    expect(screen.getByText('Save as a new view')).toBeTruthy();
    expect(screen.getByText('Draft')).toBeTruthy();
    // The draft is local — persisted to localStorage, never to the doc.
    expect(window.localStorage.getItem('folio:table-draft:page-1:all')).not.toBeNull();
  });

  it('resetting the draft removes it and hides the buttons again', async () => {
    renderPage();
    await grid();
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    fireEvent.click(await screen.findByText('Add filter'));
    await waitFor(() => expect(screen.getByText('Reset')).toBeTruthy());

    fireEvent.click(screen.getByText('Reset'));
    await waitFor(() => expect(screen.queryByText('Save changes')).toBeNull());
    expect(window.localStorage.getItem('folio:table-draft:page-1:all')).toBeNull();
  });

  it('a viewer keeps the draft but is offered no way to save it (spec §12)', async () => {
    renderPage({ role: 'viewer' });
    await grid();
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    fireEvent.click(await screen.findByText('Add filter'));
    await waitFor(() => expect(screen.getByText('Draft')).toBeTruthy());
    expect(screen.queryByText('Save changes')).toBeNull();
    expect(screen.queryByText('Save as a new view')).toBeNull();
  });
});

describe('TablePage — panels and search', () => {
  it('counts hidden columns on the Hide button', async () => {
    renderPage();
    await grid();
    fireEvent.click(screen.getByRole('tab', { name: /In progress/ }));
    // That view hides two columns.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Columns (2)' })).toBeTruthy());
  });

  it('counts only COMPLETE filter rules', async () => {
    renderPage();
    await grid();
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    fireEvent.click(await screen.findByText('Add filter'));
    // A rule with a blank value is not applied, so it must not be counted —
    // otherwise the badge claims the table is filtered when it isn't.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Filter' })).toBeTruthy());
  });

  it('narrows the rows via the global search box', async () => {
    renderPage();
    await grid();
    expect(screen.getAllByTestId('grid-row')).toHaveLength(5);
    fireEvent.change(screen.getByLabelText('Search the table'), { target: { value: 'mobile' } });
    await waitFor(() => expect(screen.getAllByTestId('grid-row')).toHaveLength(1));
  });

  it('search is diacritic- and case-insensitive', async () => {
    renderPage();
    await grid();
    fireEvent.change(screen.getByLabelText('Search the table'), { target: { value: 'RETEST' } });
    await waitFor(() => expect(screen.getAllByTestId('grid-row')).toHaveLength(1));
  });

  it('shows the "nothing found" state rather than an empty grid with no explanation', async () => {
    renderPage();
    await grid();
    fireEvent.change(screen.getByLabelText('Search the table'), { target: { value: 'zzzzz' } });
    await waitFor(() => expect(screen.getByText('Nothing found')).toBeTruthy());
  });

  it('reports shown-of-total row counts', async () => {
    renderPage();
    await grid();
    expect(screen.getByText('5 of 5')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search the table'), { target: { value: 'mobile' } });
    await waitFor(() => expect(screen.getByText('1 of 5')).toBeTruthy());
  });
});

describe('TablePage — role gating (spec §12)', () => {
  it('passes readOnly to the grid and hides the add buttons for a viewer', async () => {
    renderPage({ role: 'viewer' });
    const node = await grid();
    expect(node.getAttribute('data-readonly')).toBe('true');
    expect(screen.queryByText('Row')).toBeNull();
    expect(screen.getByText('View only')).toBeTruthy();
  });

  it('an editor gets the add buttons and an editable grid', async () => {
    renderPage({ role: 'editor' });
    const node = await grid();
    expect(node.getAttribute('data-readonly')).toBe('false');
    expect(screen.getByText('Row')).toBeTruthy();
    expect(screen.getByText('Column')).toBeTruthy();
  });
});

describe('TablePage — rows', () => {
  it('adds a row through the toolbar', async () => {
    renderPage();
    await grid();
    fireEvent.click(screen.getByText('Row'));
    await waitFor(() => expect(screen.getAllByTestId('grid-row')).toHaveLength(6));
  });

  it('locks row add/remove while a sort is active (spec §4)', async () => {
    renderPage();
    await grid();
    // The "In progress" view sorts by due date.
    fireEvent.click(screen.getByRole('tab', { name: /In progress/ }));
    await waitFor(() => {
      expect(screen.getByTestId('grid').getAttribute('data-lockrows')).toBe('true');
    });
    expect((screen.getByText('Row').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('opens the row detail panel on a deep link and shows every column, hidden ones included', async () => {
    renderPage({ highlightRowId: 'r7k2mq4c' });
    await grid();
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Row panel' })).toBeTruthy());
    // `details` is hidden in the "In progress" view but must still be present
    // in the panel — that is the panel's whole point (spec §4).
    expect(screen.getByText('Details')).toBeTruthy();
    expect(screen.getByText(/r7k2mq4c/)).toBeTruthy();
  });
});

describe('TablePage — controlled mode (wave 3 seam)', () => {
  it('emits patches to onPatch instead of mutating its own state', async () => {
    const onPatch = vi.fn();
    const doc = makeMockTableDoc();
    render(<TablePage pageId="p" doc={doc} onPatch={onPatch} />);
    await grid();

    fireEvent.click(screen.getByText('Row'));
    await waitFor(() => expect(onPatch).toHaveBeenCalled());

    const patch = onPatch.mock.calls[0]?.[0];
    expect(patch.kind).toBe('rows:create');
    expect(patch.at).toBe(doc.rows.length);
    // Controlled: the parent owns the doc, so nothing changed locally.
    expect(screen.getAllByTestId('grid-row')).toHaveLength(5);
  });

  it('emits a columns:create patch carrying the type picked at creation', async () => {
    const onPatch = vi.fn();
    render(<TablePage pageId="p" doc={makeMockTableDoc()} onPatch={onPatch} />);
    await grid();

    // Adding a column now asks for its type first — one click creates it AND
    // sets it, instead of making a text column you then have to convert.
    fireEvent.click(screen.getByText('Column'));
    expect(onPatch).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole('option', { name: 'Date' }));
    await waitFor(() => expect(onPatch).toHaveBeenCalled());
    const patch = onPatch.mock.calls[0]?.[0];
    expect(patch.kind).toBe('columns:create');
    expect(patch.column.type).toBe('date');
    // Blank name falls back to the default rather than creating a nameless column.
    expect(patch.column.name).toBe('New column');
  });
});

describe('TablePage — adding a column with its type (owner request)', () => {
  async function openPicker() {
    const onPatch = vi.fn();
    render(<TablePage pageId="p" doc={makeMockTableDoc()} onPatch={onPatch} />);
    await grid();
    fireEvent.click(screen.getByText('Column'));
    return onPatch;
  }

  it('offers all nine types in one place', async () => {
    await openPicker();
    const listbox = await screen.findByRole('listbox', { name: 'Type' });
    expect(listbox.querySelectorAll('[role="option"]')).toHaveLength(9);
    for (const label of ['Text', 'Long text', 'Number', 'Date', 'Checkbox', 'Select', 'Status', 'Person', 'Link']) {
      expect(screen.getByRole('option', { name: label })).toBeTruthy();
    }
  });

  it('takes a name in the same popover, with no modal round-trip', async () => {
    const onPatch = await openPicker();
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: '  Budget  ' } });
    fireEvent.click(screen.getByRole('option', { name: 'Number' }));

    const patch = onPatch.mock.calls[0]?.[0];
    expect(patch.column).toMatchObject({ id: 'budget', name: 'Budget', type: 'number' });
    // No dialog was opened on the way.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Enter in the name field commits the default text type', async () => {
    const onPatch = await openPicker();
    const name = await screen.findByLabelText('Name');
    fireEvent.change(name, { target: { value: 'Remark' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(onPatch.mock.calls[0]?.[0].column).toMatchObject({ name: 'Remark', type: 'text' });
  });

  it('seeds a `status` column with the spec §3 preset instead of an empty list', async () => {
    const onPatch = await openPicker();
    fireEvent.click(await screen.findByRole('option', { name: 'Status' }));
    const { column } = onPatch.mock.calls[0]?.[0];
    expect(column.type).toBe('status');
    expect(column.options.map((option: { value: string }) => option.value)).toContain('IN PROG');
    // A copy, not the shared preset object.
    expect(column.options[0]).not.toBe(STATUS_OPTIONS[0]);
  });

  it('a `select` column starts with an empty, editable option list', async () => {
    const onPatch = await openPicker();
    fireEvent.click(await screen.findByRole('option', { name: 'Select' }));
    expect(onPatch.mock.calls[0]?.[0].column).toMatchObject({ type: 'select', options: [] });
  });

  it('never collides ids with an existing column', async () => {
    const onPatch = await openPicker();
    // The mock doc already has a column named «Status» → id `status`.
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Status' } });
    fireEvent.click(screen.getByRole('option', { name: 'Text' }));
    expect(onPatch.mock.calls[0]?.[0].column.id).toBe('status_2');
  });
});

describe('TablePage — column width (spec §5: per view, via the draft)', () => {
  it('a resize becomes a view DRAFT, not a silent write to the shared view', async () => {
    const onPatch = vi.fn();
    render(<TablePage pageId="p" doc={makeMockTableDoc()} onPatch={onPatch} />);
    await grid();

    fireEvent.click(screen.getByTestId('resize'));

    // Same flow as a filter change: "Save changes" appears, and the
    // width lives in localStorage until someone actually saves it.
    await waitFor(() => expect(screen.getByText('Save changes')).toBeTruthy());
    const draft = JSON.parse(window.localStorage.getItem('folio:table-draft:p:all') ?? '{}');
    expect(draft.columns.width.task).toBe(420);
    // Nothing was committed to the document.
    expect(onPatch).not.toHaveBeenCalled();
  });

  it('saving the draft is what writes the width to the view', async () => {
    const onPatch = vi.fn();
    render(<TablePage pageId="p" doc={makeMockTableDoc()} onPatch={onPatch} />);
    await grid();

    fireEvent.click(screen.getByTestId('resize'));
    fireEvent.click(await screen.findByText('Save changes'));

    await waitFor(() => expect(onPatch).toHaveBeenCalled());
    const patch = onPatch.mock.calls[0]?.[0];
    expect(patch.kind).toBe('views:update');
    expect(patch.patch.columns.width.task).toBe(420);
  });

  it('resetting the draft puts the width back', async () => {
    render(<TablePage pageId="p" doc={makeMockTableDoc()} onPatch={vi.fn()} />);
    await grid();
    fireEvent.click(screen.getByTestId('resize'));
    fireEvent.click(await screen.findByText('Reset'));
    await waitFor(() => expect(window.localStorage.getItem('folio:table-draft:p:all')).toBeNull());
  });
});
