import type { TableColumn, TableDoc, TableRow } from '@shared/contracts';

/**
 * Round 26 (DATA TABLES) — mock TableDoc for wave 1.
 *
 * TABLES-UI is built and tested with no network, no server and no CRDT (see
 * DEV-PLAN R26, "The first stage is on mocks"). This fixture is the stand-in for
 * what the collab mirror will hand the UI in wave 3, and it deliberately
 * exercises ALL NINE column types plus the awkward cases the spec calls out:
 * a `multiple` select, an out-of-list status value (§2.4), an empty cell of
 * every type, and prose above/below the table (§2.2).
 *
 * It models the owner's actual use case — the weekly-planning Google Sheet
 * named in spec §0.3 — so that eyeballing the UI shows something realistic.
 */

/** The normative status preset from spec §3, in its normative order. */
export const STATUS_OPTIONS: NonNullable<TableColumn['options']> = [
  { value: 'PLANNING', color: 'purple', description: 'planned' },
  { value: 'WAITING', color: 'gray', description: 'waiting on others' },
  { value: 'QUESTIONS', color: 'orange', description: 'answers needed' },
  { value: 'IN PROG', color: 'blue', description: 'in progress' },
  { value: 'DONE', color: 'green', description: 'done' },
  { value: 'REPLAN', color: 'yellow', description: 'being moved' },
  { value: 'FAILED', color: 'red', description: 'failed' },
  { value: 'CANCELLED', color: 'gray', description: 'cancelled' },
];

export const MOCK_COLUMNS: TableColumn[] = [
  {
    id: 'week',
    name: 'Week',
    type: 'select',
    description: 'Sprint week.\nFormat: W<number> dd-dd.mm',
    width: 150,
    allowCreate: true,
    options: [
      { value: 'W8 17-21.08', color: 'blue' },
      { value: 'W9 24-28.08', color: 'green', description: 'current' },
      { value: 'W10 31.08-04.09', color: 'teal' },
    ],
  },
  {
    id: 'unit',
    name: 'Unit',
    type: 'select',
    description: 'The product team that owns the task',
    width: 140,
    options: [
      { value: 'Acme', color: 'purple' },
      { value: 'Folio', color: 'orange' },
    ],
  },
  {
    id: 'owner',
    name: 'Owner',
    type: 'user',
    description: 'Owner. There can be several.',
    width: 130,
    multiple: true,
  },
  { id: 'task', name: 'Goal/Subgoal/Task', type: 'text', width: 320 },
  {
    id: 'details',
    name: 'Details',
    type: 'longtext',
    description: 'Expands in the row panel',
    width: 220,
  },
  { id: 'estimate', name: 'Estimate, d', type: 'number', width: 110, precision: 1, align: 'right' },
  { id: 'due', name: 'Due', type: 'date', width: 130 },
  { id: 'blocked', name: 'Blocked', type: 'checkbox', width: 90, align: 'center' },
  {
    id: 'status',
    name: 'Status',
    type: 'status',
    description: 'Progress state',
    width: 140,
    options: STATUS_OPTIONS,
  },
  { id: 'spec', name: 'Spec', type: 'link', width: 180 },
];

export const MOCK_ROWS: TableRow[] = [
  {
    id: 'r7k2mq4a',
    values: {
      week: 'W8 17-21.08',
      unit: 'Acme',
      owner: ['@sk'],
      task: 'Hand over the rollout project',
      details: 'The handover includes access, repositories\nand a demo for the team.',
      estimate: 3,
      due: '2026-08-21',
      blocked: false,
      status: 'DONE',
      spec: '[Handover](https://example.com/handoff)',
    },
  },
  {
    id: 'r7k2mq4b',
    values: {
      week: 'W9 24-28.08',
      unit: 'Acme',
      owner: ['@va', '@sk'],
      task: 'Launch of the rollout project',
      details: 'Waiting for the final look of the dashboard.',
      estimate: 5,
      due: '2026-08-28',
      blocked: true,
      status: 'IN PROG',
      spec: 'https://example.com/hub',
    },
  },
  {
    id: 'r7k2mq4c',
    values: {
      week: 'W9 24-28.08',
      unit: 'Folio',
      owner: ['@dm'],
      task: 'Data tables: file codec',
      details: '',
      estimate: 2.5,
      due: '2026-08-27',
      blocked: false,
      status: 'IN PROG',
      spec: '',
    },
  },
  {
    id: 'r7k2mq4d',
    values: {
      week: 'W10 31.08-04.09',
      unit: 'Folio',
      owner: [],
      task: 'Retest production after the release',
      details: '',
      estimate: null,
      due: null,
      blocked: false,
      // Deliberately NOT in STATUS_OPTIONS — exercises the "outside the list"
      // path from spec §2.4 (file edited by hand, value must not be lost).
      status: 'ON HOLD',
      spec: '',
    },
  },
  {
    id: 'r7k2mq4e',
    values: {
      week: 'W8 17-21.08',
      unit: 'Folio',
      owner: ['@sk'],
      task: 'Mobile view of the table',
      details: 'A full-screen row panel, a bottom sheet for filters.',
      estimate: 1,
      due: '2026-08-20',
      blocked: false,
      status: 'PLANNING',
      spec: '',
    },
  },
];

export function makeMockTableDoc(): TableDoc {
  return {
    meta: { id: '01JCXYZ8Q0W3M4E5R6', version: 1, rowIds: 'column' },
    head: '# Weekly plan\n\nOptional descriptive text above the table.',
    tail: 'The text below the table is kept too.',
    columns: MOCK_COLUMNS.map((column) => ({ ...column })),
    rows: MOCK_ROWS.map((row) => ({ id: row.id, values: { ...row.values } })),
    views: [
      {
        id: 'all',
        name: 'All records',
        columns: { hidden: [], order: [], width: {} },
        sort: [],
        filter: { op: 'and', rules: [] },
        frozen: 1,
        rowHeight: 'short',
      },
      {
        id: 'active',
        name: 'In progress',
        columns: { hidden: ['details', 'spec'], order: [], width: {} },
        sort: [{ column: 'due', dir: 'asc' }],
        filter: { op: 'and', rules: [{ column: 'status', operator: 'is_any_of', value: ['IN PROG', 'PLANNING'] }] },
        frozen: 1,
        rowHeight: 'medium',
      },
    ],
  };
}

/**
 * A big doc for eyeballing virtualisation against the spec §13 soft limit.
 * Not used by the tests (5 000 rows × 10 columns in jsdom is pointless) —
 * it exists for manual profiling once the page is wired up in wave 3.
 */
export function makeLargeMockTableDoc(rowCount = 5000): TableDoc {
  const base = makeMockTableDoc();
  const rows: TableRow[] = [];
  for (let index = 0; index < rowCount; index += 1) {
    const template = MOCK_ROWS[index % MOCK_ROWS.length];
    rows.push({
      id: `row${index.toString(36).padStart(6, '0')}`,
      values: { ...template.values, task: `${String(template.values.task)} #${index + 1}` },
    });
  }
  return { ...base, rows };
}
