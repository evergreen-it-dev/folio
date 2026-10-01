/**
 * Round 26 (DATA TABLES) — public surface of the TABLES-UI zone.
 *
 * SHELL-TABLES (wave 3) imports from here and from nowhere deeper, mirroring
 * how web/src/diagrams/index.tsx exposes BoardEditor: the zone keeps the
 * freedom to move TablePage.tsx, split the grid chunk differently, or change
 * the internal file layout without touching app/**.
 *
 * Mount points per DEV-PLAN R26, "Agent 5":
 *   web/src/app/routes/PageContent.tsx     `kind === 'table'`, before the doc fall-through
 *   web/src/app/share/SharedPageView.tsx   the same branch for public shares
 */
export { TablePage, TablePage as TableEditor } from './TablePage';
export type { TableEditorProps, TablePatch, TablePatchSink, TableRole } from './types';
export { makeMockTableDoc, makeLargeMockTableDoc } from './fixtures';
