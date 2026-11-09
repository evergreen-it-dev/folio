// @vitest-environment jsdom
/**
 * The properties panel (Obsidian wave 3): collapsed by default, typed editors per
 * property type, whole-map optimistic saves, "foreign value" read-only rows, and the
 * 409 reload prompt. The network is a fetch stub keyed by method + URL.
 */
import { useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import type { PagePropertiesResponse } from '@shared/contracts';
import { ToastProvider } from '../ui/Toast';
import { PropertiesSlotContext } from '../header/propertiesSlot';
import { PagePropertiesPopover, PageTitleProperties, PropertiesPanel } from './PropertiesPanel';
import '../i18n/register';

const BASE: PagePropertiesResponse = {
  properties: { id: '01ABC', title: 'Roadmap', year: 2026, done: false, due: '2026-10-14', tags: ['plan'], meta: { a: 1 } },
  types: { id: 'text', title: 'text', year: 'number', done: 'checkbox', due: 'date', tags: 'tags', meta: 'text' },
  foreign: [],
  readOnly: ['id'],
  canEdit: true,
  etag: 'etag-1',
};

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A page whose GET returns `state`; a PUT is answered by `onPut` (default: the state with the sent map and etag-2). */
function stubNetwork(state: PagePropertiesResponse, onPut?: (body: { properties: Record<string, unknown>; etag?: string }) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      if (url === '/api/pages/p1/properties' && method === 'GET') return json(state);
      if (url === '/api/pages/p1/properties' && method === 'PUT') {
        return onPut ? onPut(body) : json({ ...state, properties: { id: '01ABC', ...body.properties }, etag: 'etag-2' });
      }
      if (url === '/api/spaces/demo/property-types') {
        return json({ types: { status: 'text' }, source: 'folio', known: [{ key: 'author', inferred: 'text', pages: 4 }] });
      }
      return json({ error: 'not found' }, 404);
    }),
  );
  return calls;
}

function renderPanel(props: { canEdit?: boolean; canManageTypes?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <PropertiesPanel pageId="p1" space="demo" canEdit={props.canEdit ?? true} canManageTypes={props.canManageTypes ?? false} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openPanel() {
  const toggle = await screen.findByRole('button', { name: /^(Properties \(\d+\)|Add property)$/ });
  await userEvent.click(toggle);
  return toggle;
}

describe('PropertiesPanel', () => {
  it('is collapsed by default, counts the editable properties, opens on click and remembers it per space', async () => {
    stubNetwork(BASE);
    renderPanel();

    const toggle = await screen.findByRole('button', { name: 'Properties (6)' }); // `id` is not counted
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('textbox', { name: 'title' })).toBeNull();

    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('textbox', { name: 'title' })).toBeTruthy();
    expect(localStorage.getItem('folio:properties-open:demo')).toBe('true');
  });

  it('renders an editor per type and sends the WHOLE editable map in one PUT, with the etag', async () => {
    const calls = stubNetwork(BASE);
    renderPanel();
    await openPanel();

    expect((screen.getByRole('textbox', { name: 'title' }) as HTMLInputElement).value).toBe('Roadmap');
    expect((screen.getByRole('spinbutton', { name: 'year' }) as HTMLInputElement).value).toBe('2026');
    expect((screen.getByRole('checkbox', { name: 'done' }) as HTMLInputElement).checked).toBe(false);
    const due = within(screen.getByRole('group', { name: 'due' })).getByLabelText('due') as HTMLInputElement;
    expect(due.type).toBe('date');
    expect(due.value).toBe('2026-10-14');
    expect(screen.getByRole('button', { name: 'Remove plan' })).toBeTruthy(); // tags are chips
    expect(screen.getByText(/"a": 1/)).toBeTruthy(); // a nested map is read-only JSON
    // `id` is shown, locked: no editor, no remove button
    const idRow = screen.getByRole('group', { name: 'id' });
    expect(within(idRow).queryByRole('textbox')).toBeNull();
    expect(within(idRow).queryByRole('button')).toBeNull();

    await userEvent.type(screen.getByRole('textbox', { name: 'title' }), ' v2{Enter}');
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1));
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      properties: { title: 'Roadmap v2', year: 2026, done: false, due: '2026-10-14', tags: ['plan'], meta: { a: 1 } },
      etag: 'etag-1',
    });

    // The answer's etag rides on the next save, and it keeps the first edit.
    await userEvent.click(screen.getByRole('checkbox', { name: 'done' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2));
    const second = calls.filter((c) => c.method === 'PUT')[1].body as { properties: Record<string, unknown>; etag: string };
    expect(second.etag).toBe('etag-2');
    expect(second.properties).toMatchObject({ title: 'Roadmap v2', done: true });
  });

  it('Esc puts the old value back and sends nothing; tag chips are normalized when added', async () => {
    const calls = stubNetwork(BASE);
    renderPanel();
    await openPanel();

    const title = screen.getByRole('textbox', { name: 'title' }) as HTMLInputElement;
    await userEvent.type(title, 'zzz{Escape}');
    expect(title.value).toBe('Roadmap');
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);

    await userEvent.type(screen.getByRole('textbox', { name: 'tags' }), '#Plan/Q4{Enter}');
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect((calls.find((c) => c.method === 'PUT')?.body as { properties: { tags: string[] } }).properties.tags).toEqual(['plan', 'plan/q4']);
  });

  it('shows a Folio key with a foreign value read-only, with a badge, and still sends it back unchanged', async () => {
    const calls = stubNetwork({
      ...BASE,
      properties: { id: '01ABC', status: 'deprecated', title: 'Roadmap' },
      types: { id: 'text', status: 'text', title: 'text' },
      foreign: ['status'],
    });
    renderPanel();
    await openPanel();

    const row = screen.getByRole('group', { name: 'status' });
    expect(within(row).getByText('deprecated')).toBeTruthy();
    const badge = within(row).getByText('foreign value');
    expect(badge.getAttribute('title')).toBe('Written by another tool; Folio keeps it as is');
    expect(within(row).queryByRole('textbox')).toBeNull();
    expect(within(row).queryByRole('combobox')).toBeNull();
    expect(within(row).queryByRole('button')).toBeNull();

    await userEvent.type(screen.getByRole('textbox', { name: 'title' }), '!{Enter}');
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect((calls.find((c) => c.method === 'PUT')?.body as { properties: Record<string, unknown> }).properties).toEqual({
      status: 'deprecated',
      title: 'Roadmap!',
    });
  });

  it('is read-only for a viewer: no editors, no add button', async () => {
    stubNetwork({ ...BASE, canEdit: false });
    renderPanel({ canEdit: false });
    await openPanel();

    expect(screen.getByText('Roadmap')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add property' })).toBeNull();
  });

  it('on a 409 stops editing, shows the reload prompt, and Reload reads the front matter again', async () => {
    const calls = stubNetwork(BASE, () => json({ error: 'front matter changed' }, 409));
    renderPanel();
    await openPanel();

    await userEvent.type(screen.getByRole('textbox', { name: 'title' }), '!{Enter}');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('changed elsewhere');
    // Editing stops until the reload: the rows turn read-only.
    expect(screen.queryByRole('textbox', { name: 'title' })).toBeNull();

    const getsBefore = calls.filter((c) => c.method === 'GET').length;
    await userEvent.click(within(alert).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET').length).toBeGreaterThan(getsBefore));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect((screen.getByRole('textbox', { name: 'title' }) as HTMLInputElement).value).toBe('Roadmap');
  });

  it('reading mode: an editor of the page gets values only — no editors, no add, no remove, no type picker', async () => {
    stubNetwork(BASE); // the server says the caller may edit
    renderPanel({ canEdit: false }); // PageContent passes canEdit=false in reading mode
    await openPanel();

    expect(screen.getByText('Roadmap')).toBeTruthy();
    expect(screen.getByText('plan')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add property' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull();
  });
});

describe('PagePropertiesPopover (tables, forms, boards, files)', () => {
  const TABLE: PagePropertiesResponse = { properties: { owner: 'ann', tags: ['q3'] }, types: { owner: 'text', tags: 'tags' }, foreign: [], readOnly: [], canEdit: true, etag: 'e1' };

  /** A stand-in for the shell: a header with the slot, a page area beside it, and something outside both. */
  function renderPopover(canEdit: boolean, slotMode: 'ready' | 'none' | 'pending' = 'ready') {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    function Harness() {
      const [slot, setSlot] = useState<HTMLElement | null>(null);
      const popover = (
        <main data-testid="page">
          <PagePropertiesPopover pageId="p1" space="demo" canEdit={canEdit} canManageTypes={false} />
        </main>
      );
      return (
        <QueryClientProvider client={client}>
          <ToastProvider>
            <header data-testid="header">
              <nav>Breadcrumbs</nav>
              <div ref={setSlot} data-testid="slot" />
            </header>
            {slotMode === 'ready' ? (
              <PropertiesSlotContext.Provider value={slot}>{popover}</PropertiesSlotContext.Provider>
            ) : slotMode === 'pending' ? (
              <PropertiesSlotContext.Provider value={null}>{popover}</PropertiesSlotContext.Provider>
            ) : (
              popover
            )}
            <button type="button">outside</button>
          </ToastProvider>
        </QueryClientProvider>
      );
    }
    return render(<Harness />);
  }

  it('puts the toggle in the header, closed, and takes no room in the page', async () => {
    stubNetwork(TABLE);
    renderPopover(true);
    const toggle = await screen.findByRole('button', { name: 'Properties (2)' });
    expect(screen.getByTestId('slot').contains(toggle)).toBe(true);
    expect(screen.getByTestId('page').contains(toggle)).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('page').textContent).toBe('');
  });

  it('says "Add property" when the page has none and the user may edit; a reader sees no toggle', async () => {
    stubNetwork({ ...TABLE, properties: {} });
    const { unmount } = renderPopover(true);
    const toggle = await screen.findByRole('button', { name: 'Add property' });
    expect(screen.getByTestId('slot').contains(toggle)).toBe(true);
    unmount();
    stubNetwork({ ...TABLE, properties: {}, canEdit: false });
    renderPopover(false);
    await waitFor(() => expect(screen.queryByRole('button', { name: /Properties|Add property/ })).toBeNull());
  });

  it('opens a popover under the toggle with the editors; a save sends the page\'s own keys only', async () => {
    const calls = stubNetwork(TABLE, (body) => json({ ...TABLE, properties: body.properties, etag: 'e2' }));
    renderPopover(true);
    const toggle = await screen.findByRole('button', { name: 'Properties (2)' });
    await userEvent.click(toggle);
    const dialog = screen.getByRole('dialog', { name: 'Page properties' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBeTruthy();
    expect(dialog.querySelector(`[id="${toggle.getAttribute('aria-controls')}"]`)).toBeTruthy();
    expect(screen.getByTestId('slot').contains(dialog)).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(dialog));
    const owner = screen.getByRole('textbox', { name: 'owner' });
    await userEvent.clear(owner);
    await userEvent.type(owner, 'bob{Enter}');
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ properties: { owner: 'bob', tags: ['q3'] }, etag: 'e1' });
  });

  it('closes on Escape (focus back on the toggle), on a click outside, and on the toggle itself', async () => {
    stubNetwork(TABLE);
    renderPopover(true);
    const toggle = await screen.findByRole('button', { name: 'Properties (2)' });

    await userEvent.click(toggle);
    expect(screen.getByRole('dialog')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(toggle);

    await userEvent.click(toggle);
    expect(screen.getByRole('dialog')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'outside' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    await userEvent.click(toggle);
    expect(screen.getByRole('dialog')).toBeTruthy();
    await userEvent.click(toggle);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Escape inside a field only cancels that edit and keeps the popover open', async () => {
    stubNetwork(TABLE);
    renderPopover(true);
    await userEvent.click(await screen.findByRole('button', { name: 'Properties (2)' }));
    const owner = screen.getByRole('textbox', { name: 'owner' });
    await userEvent.clear(owner);
    await userEvent.type(owner, 'zzz{Escape}');
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'owner' }) as HTMLInputElement).value).toBe('ann');
  });

  it('is read-only without edit rights, and shows nothing at all on a page without properties', async () => {
    stubNetwork({ ...TABLE, canEdit: false });
    renderPopover(false);
    await userEvent.click(await screen.findByRole('button', { name: 'Properties (2)' }));
    expect(screen.getByText('ann')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add property' })).toBeNull();
    cleanup();
    vi.unstubAllGlobals();

    stubNetwork({ ...TABLE, properties: {}, types: {}, canEdit: false });
    renderPopover(false);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('button', { name: /Properties/ })).toBeNull();
    expect(screen.getByTestId('slot').textContent).toBe('');
  });

  it('renders where it stands without a shell, and nothing while the shell\'s slot is not mounted yet', async () => {
    stubNetwork(TABLE);
    renderPopover(true, 'none');
    const toggle = await screen.findByRole('button', { name: 'Properties (2)' });
    expect(screen.getByTestId('page').contains(toggle)).toBe(true);
    cleanup();

    renderPopover(true, 'pending');
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('button', { name: /Properties/ })).toBeNull();
  });
});

describe('PageTitleProperties (under the page title)', () => {
  const EMPTY: PagePropertiesResponse = { ...BASE, properties: { id: '01ABC' }, types: { id: 'text' } };

  function renderTitle(props: { canEdit: boolean; onStartEditing?: () => void }) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <PageTitleProperties pageId="p1" space="demo" canEdit={props.canEdit} canManageTypes={false} onStartEditing={props.onStartEditing} />
        </ToastProvider>
      </QueryClientProvider>,
    );
  }

  it('shows the count toggle when the page has properties, to a viewer too', async () => {
    stubNetwork(BASE);
    renderTitle({ canEdit: false });
    const toggle = await screen.findByRole('button', { name: 'Properties (6)' });
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('group', { name: 'id' })).toBeTruthy();
  });

  it('offers a faint "+ Property" on an empty page that opens "Add property" and folds back on cancel', async () => {
    stubNetwork(EMPTY);
    renderTitle({ canEdit: true });
    const ghost = await screen.findByRole('button', { name: 'Add property' });
    expect(ghost.textContent).toBe('Property');
    await userEvent.click(ghost);
    const name = screen.getByRole('combobox', { name: 'Property name' });
    expect(document.activeElement).toBe(name);
    expect(screen.queryByText('No properties yet.')).toBeNull();
    await userEvent.keyboard('{Escape}');
    expect(await screen.findByRole('button', { name: 'Add property' })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Property name' })).toBeNull();
  });

  it('shows a viewer nothing on an empty page, and sends an editor in reading mode to Live edit', async () => {
    stubNetwork(EMPTY);
    const { container, unmount } = renderTitle({ canEdit: false });
    await waitFor(() => expect(container.querySelector('.folio-title-props')).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('button')).toBeNull();
    unmount();

    const startEditing = vi.fn();
    renderTitle({ canEdit: false, onStartEditing: startEditing });
    await userEvent.click(await screen.findByRole('button', { name: 'Add property' }));
    expect(startEditing).toHaveBeenCalledTimes(1);
  });

  /** The page's own query (verification) and the people picker, on top of the properties stub; returns the verification PUT bodies. */
  function stubVerification(state: PagePropertiesResponse, verification: Record<string, unknown> | null) {
    const calls = stubNetwork(state);
    const base = globalThis.fetch;
    const puts: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/pages/p1' && (init?.method ?? 'GET') === 'GET') return json({ id: 'p1', kind: 'doc', verification });
        if (url === '/api/spaces/demo/mentionable') return json({ users: [{ username: 'ann', name: 'Ann' }] });
        if (url === '/api/pages/p1/verification' && init?.method === 'PUT') {
          puts.push(JSON.parse(String(init.body)));
          return json({ written: true, verification });
        }
        return base(input, init);
      }),
    );
    return { calls, puts };
  }

  async function openToggle(name: string) {
    const toggle = await screen.findByRole('button', { name });
    if (toggle.getAttribute('aria-expanded') !== 'true') await userEvent.click(toggle);
  }

  const WITH_OWNER: PagePropertiesResponse = {
    ...BASE,
    properties: { id: '01ABC', owner: 'ann', verified: '2026-10-01', review_by: '2026-12-01' },
    types: { id: 'text', owner: 'text', verified: 'date', review_by: 'date' },
  };
  const VERIFICATION = { state: 'verified', owner: 'ann', verified: '2026-10-01', reviewBy: '2026-12-01' };

  it('reading mode shows owner, verified and review values without fields or the button, and counts them once', async () => {
    stubVerification(WITH_OWNER, VERIFICATION);
    renderTitle({ canEdit: false });
    await openToggle('Properties (3)');
    const rows = await screen.findByTestId('verification-rows');
    expect(within(rows).getByText('@ann')).toBeTruthy();
    expect(within(rows).queryByRole('combobox')).toBeNull();
    expect(within(rows).queryByRole('button')).toBeNull();
    expect(rows.querySelector('input')).toBeNull();
    // Not drawn a second time as ordinary rows.
    expect(screen.getAllByRole('group', { name: 'Owner' })).toHaveLength(1);
    expect(screen.queryByRole('group', { name: 'owner' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'review_by' })).toBeNull();
  });

  it('Live mode: owner picker, review date and "Mark as verified" write through the verification endpoint', async () => {
    const { puts } = stubVerification(WITH_OWNER, VERIFICATION);
    renderTitle({ canEdit: true });
    await openToggle('Properties (3)');
    const rows = await screen.findByTestId('verification-rows');
    await userEvent.click(within(rows).getByRole('button', { name: 'Mark as verified' }));
    await waitFor(() => expect(puts).toContainEqual({ markVerified: true }));
    await userEvent.selectOptions(await within(rows).findByRole('combobox', { name: 'Owner' }), '');
    await waitFor(() => expect(puts).toContainEqual({ owner: null }));
    fireEvent.change(rows.querySelector('input[type="date"]')!, { target: { value: '2027-01-15' } });
    await waitFor(() => expect(puts).toContainEqual({ reviewBy: '2027-01-15' }));
  });

  it('a page without them: the editor gets "Owner and review" and sets the owner; a reader sees no trace', async () => {
    const { puts } = stubVerification(EMPTY, null);
    renderTitle({ canEdit: true });
    await userEvent.click(await screen.findByRole('button', { name: 'Owner and review' }));
    const rows = await screen.findByTestId('verification-rows');
    await userEvent.selectOptions(await within(rows).findByRole('option', { name: 'Ann (@ann)' }).then((o) => o.parentElement as HTMLSelectElement), 'ann');
    await waitFor(() => expect(puts).toContainEqual({ owner: 'ann' }));
    cleanup();

    stubVerification(EMPTY, null);
    const { container } = renderTitle({ canEdit: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container.querySelector('[data-testid="verification-rows"]')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
