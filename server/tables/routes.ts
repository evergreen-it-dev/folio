/**
 * Round 26 (DATA TABLES) route registration — see docs/spec-tables.md §8 for
 * the normative endpoint list. Registered once, by the orchestrator, from
 * server/index.ts's protectedScope (same scope as registerRoutes) so it
 * shares session auth without server/routes.ts itself growing a table-shaped
 * branch.
 *
 * Every handler here is a thin wrapper around server/tables/service.ts's
 * exported functions — same "thin route + directly-testable module
 * function" pattern server/access/routes.ts uses (see its own doc comment):
 * this codebase has no HTTP-level Fastify test harness, every test calls the
 * underlying function directly against a real PG test schema, so the actual
 * logic (limits, patch construction, filter/sort/search, import/export)
 * lives in service.ts, not here. Request-body/query validation, role checks,
 * and git attribution (recordEditor/noteActivity — service.ts itself is
 * request-identity-agnostic) are this file's own job.
 *
 * Body-shape zod schemas for rows/columns/views mutations are kept LOCAL to
 * this file rather than added to shared/contracts.ts: this round's brief
 * asks to touch contracts.ts only "additively... check twice", and these
 * shapes are pure server-side request validation with no client (wave-3)
 * consumer yet — see the round report for this trade-off.
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { tableColumnSchema, tableViewSchema, tableFilterRuleSchema, type TableCellValue } from '../../shared/contracts.js';
import * as gitSync from '../gitSync.js';
import * as session from '../auth/session.js';
import * as service from './service.js';
import { badRequest } from '../errors.js';
import { parseBody, queryString } from '../validate.js';
import { parseCsv, parseTsv } from '../../shared/tables/index.js';

// ---------------------------------------------------------------------------
// Local body/query schemas
// ---------------------------------------------------------------------------

const cellValueSchema: z.ZodType<TableCellValue> = z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]);
const cellValuesRecordSchema = z.record(z.string(), cellValueSchema);

const insertRowsBodySchema = z.object({ rows: z.array(cellValuesRecordSchema).min(1) });
const updateRowBodySchema = z.object({ values: cellValuesRecordSchema });
const bulkRowsBodySchema = z.object({ rowIds: z.array(z.string()).min(1), values: cellValuesRecordSchema.optional() });

export const newColumnBodySchema = tableColumnSchema.omit({ id: true }).extend({ id: tableColumnSchema.shape.id.optional() });
export const updateColumnBodySchema = tableColumnSchema.omit({ id: true }).partial();

// DELIBERATELY no `.partial()`: `columns`/`sort`/`filter`/`frozen`/`rowHeight` already
// accept an omitted key because tableViewSchema itself gives each a `.default(...)` —
// z.object(...).parse({}) fills those in on its own, no extra wrapper needed. Adding
// `.partial()` on top would ALSO still fill them in at runtime (ZodDefault handles
// undefined regardless of an outer ZodOptional — see updateViewBodySchema's doc comment
// for why that's true), but it widens the STATIC output type to `X | undefined`, which
// then fails to satisfy service.addView's `NewViewInput` (columns/sort/etc. are
// non-optional there, matching TableView). Omitting `.partial()` keeps the schema's
// inferred type honest: these fields are never actually undefined once parsed.
export const newViewBodySchema = tableViewSchema.omit({ id: true }).extend({ name: z.string().min(1), id: tableViewSchema.shape.id.optional() });

/**
 * DELIBERATELY NOT `tableViewSchema.omit({id:true}).partial()` (the naive
 * mirror of newViewBodySchema above): `tableViewSchema`'s `columns`/`sort`/
 * `filter`/`frozen`/`rowHeight` fields all carry an embedded `.default(...)`
 * (needed so newViewBodySchema fills in sensible defaults on CREATE), and —
 * confirmed empirically, not just in theory — a `.partial()`/`.optional()`
 * wrapper over a `ZodDefault` field resolves an OMITTED key to that default
 * value, not `undefined`. For a create body that's exactly what's wanted;
 * for a PATCH it is a real bug: a rename-only PATCH (`{ name: "New" }`) would
 * come back as `{ name: "New", columns: {...}, sort: [], filter: {...},
 * frozen: 0, rowHeight: 'short' }`, and service.ts's `{...oldView, ...patch}`
 * merge would then silently WIPE the view's real sort/filter/hidden-columns/
 * frozen/rowHeight. This schema is built field-by-field instead, so an
 * omitted field is genuinely `undefined` and the merge leaves it alone.
 *
 * The `columns`/`filter` SUB-objects are, deliberately, NOT deep-partial
 * either (every field of each is required WHEN THE PARENT KEY IS PRESENT) —
 * matching `Partial<Omit<TableView,'id'>>` exactly, which service.ts's
 * `updateView` is typed against. This also matches the actual merge
 * semantics: `{...oldView, ...patch}` is a SHALLOW merge, so a `columns`
 * patch that omitted `order`/`width` would silently drop them the same way
 * an omitted `filter` used to drop the whole view's filter — requiring the
 * full sub-object here makes that impossible to do by accident.
 */
export const updateViewBodySchema = z.object({
  name: z.string().min(1).optional(),
  icon: z.string().optional(),
  columns: z.object({ hidden: z.array(z.string()), order: z.array(z.string()), width: z.record(z.string(), z.number()) }).optional(),
  sort: z.array(z.object({ column: z.string(), dir: z.enum(['asc', 'desc']) })).optional(),
  filter: z.object({ op: z.enum(['and', 'or']), rules: z.array(tableFilterRuleSchema) }).optional(),
  frozen: z.number().int().min(0).max(4).optional(),
  rowHeight: z.enum(['short', 'medium', 'tall']).optional(),
});

const importBodySchema = z.object({
  format: z.enum(['csv', 'tsv', 'yaml']),
  data: z.string(),
  mode: z.enum(['append', 'replace']),
  mapping: z.record(z.string(), z.string()).optional(),
});

const inferBodySchema = z.object({
  data: z.string(),
  format: z.enum(['csv', 'tsv']).default('csv'),
  hasHeader: z.boolean().default(true),
});

const rowFilterSchema = tableViewSchema.shape.filter;
const rowSortSchema = tableViewSchema.shape.sort;

function parseJsonQueryParam<T>(raw: string, schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: unknown } }, label: string): T | undefined {
  if (!raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw badRequest(`invalid JSON in \`${label}\` query parameter`);
  }
  const result = schema.safeParse(value);
  if (!result.success) throw badRequest(`invalid \`${label}\` query parameter`);
  return result.data;
}

// ---------------------------------------------------------------------------
// Access helpers
// ---------------------------------------------------------------------------

async function requireTableRole(request: Parameters<typeof session.requirePageRole>[0], id: string, min: 'viewer' | 'editor') {
  const entry = await session.requirePageRole(request, id, min);
  if (entry.kind !== 'table') throw badRequest('page is not a data table');
  return entry;
}

export function registerTableRoutes(app: FastifyInstance): void {
  // --- Read -----------------------------------------------------------

  app.get('/api/tables/:pageId', async (request) => {
    const { pageId } = request.params as { pageId: string };
    await requireTableRole(request, pageId, 'viewer');
    return service.getTableSnapshot(pageId);
  });

  app.get('/api/tables/:pageId/rows', async (request) => {
    const { pageId } = request.params as { pageId: string };
    await requireTableRole(request, pageId, 'viewer');
    const view = queryString(request.query, 'view') || undefined;
    const q = queryString(request.query, 'q') || undefined;
    const filter = parseJsonQueryParam(queryString(request.query, 'filter'), rowFilterSchema, 'filter');
    const sort = parseJsonQueryParam(queryString(request.query, 'sort'), rowSortSchema, 'sort');
    const limitRaw = queryString(request.query, 'limit');
    const offsetRaw = queryString(request.query, 'offset');
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const offset = offsetRaw ? Number(offsetRaw) : undefined;
    if (limit !== undefined && (!Number.isFinite(limit) || limit < 0)) throw badRequest('invalid `limit` query parameter');
    if (offset !== undefined && (!Number.isFinite(offset) || offset < 0)) throw badRequest('invalid `offset` query parameter');
    return service.queryRows(pageId, { view, q, filter, sort, limit, offset, ctx: { currentUser: request.authUser?.username ?? undefined } });
  });

  app.get('/api/tables/:pageId/export', async (request, reply) => {
    const { pageId } = request.params as { pageId: string };
    await requireTableRole(request, pageId, 'viewer');
    const format = queryString(request.query, 'format') || 'csv';
    if (format !== 'csv' && format !== 'tsv' && format !== 'md' && format !== 'yaml' && format !== 'json') {
      throw badRequest('invalid `format` query parameter');
    }
    const view = queryString(request.query, 'view') || undefined;
    const scopeRaw = queryString(request.query, 'scope');
    const scope = scopeRaw === 'view' || scopeRaw === 'all' ? scopeRaw : undefined;
    const includeId = queryString(request.query, 'includeId') === '1';
    const result = await service.exportTable(pageId, { format, view, scope, includeId, ctx: { currentUser: request.authUser?.username ?? undefined } });
    reply.header('Content-Type', result.contentType);
    reply.header('Content-Disposition', `attachment; filename="${result.filename.replace(/"/g, '')}"`);
    return result.data;
  });

  // --- Rows -------------------------------------------------------------

  app.post('/api/tables/:pageId/rows', async (request, reply) => {
    const { pageId } = request.params as { pageId: string };
    const body = parseBody(insertRowsBodySchema, request.body);
    const entry = await requireTableRole(request, pageId, 'editor');
    session.requireWriteScope(request);
    gitSync.recordEditor(entry.space, { name: request.authUser!.name, email: request.authUser!.email });
    const result = await service.insertRows(pageId, body.rows);
    gitSync.noteActivity(entry.space);
    reply.status(201);
    return result;
  });

  app.patch('/api/tables/:pageId/rows/:rowId', async (request) => {
    const { pageId, rowId } = request.params as { pageId: string; rowId: string };
    const body = parseBody(updateRowBodySchema, request.body);
    const entry = await requireTableRole(request, pageId, 'editor');
    session.requireWriteScope(request);
    gitSync.recordEditor(entry.space, { name: request.authUser!.name, email: request.authUser!.email });
    const row = await service.updateRowCells(pageId, rowId, body.values);
    gitSync.noteActivity(entry.space);
    return row;
  });

  app.delete('/api/tables/:pageId/rows/:rowId', async (request) => {
    const { pageId, rowId } = request.params as { pageId: string; rowId: string };
    const entry = await requireTableRole(request, pageId, 'editor');
    session.requireWriteScope(request);
    gitSync.recordEditor(entry.space, { name: request.authUser!.name, email: request.authUser!.email });
    await service.deleteRow(pageId, rowId);
    gitSync.noteActivity(entry.space);
    return { ok: true };
  });

  app.post('/api/tables/:pageId/rows/bulk', async (request) => {
    const { pageId } = request.params as { pageId: string };
    const body = parseBody(bulkRowsBodySchema, request.body);
    const entry = await requireTableRole(request, pageId, 'editor');
    session.requireWriteScope(request);
    gitSync.recordEditor(entry.space, { name: request.authUser!.name, email: request.authUser!.email });
    const result = await service.bulkRows(pageId, body.rowIds, body.values);
    gitSync.noteActivity(entry.space);
    return result;
  });

  // --- Columns ------------------------------------------------------------

  app.post('/api/tables/:pageId/columns', async (request, reply) => {
    const { pageId } = request.params as { pageId: string };
    const body = parseBody(newColumnBodySchema, request.body);
    const entry = await requireTableRole(request, pageId, 'editor');
    session.requireWriteScope(request);
    gitSync.recordEditor(entry.space, { name: request.authUser!.name, email: request.authUser!.email });
    const column = await service.addColumn(pageId, body);
    gitSync.noteActivity(entry.space);
    reply.status(201);
    return column;
  });

  app.patch('/api/tables/:pageId/columns/:colId', async (request) => {
    const { pageId, colId } = request.params as { pageId: string; colId: string };
    const body = parseBody(updateColumnBodySchema, request.body);
    const entry = await requireTableRole(request, pageId, 'editor');
    session.requireWriteScope(request);
    gitSync.recordEditor(entry.space, { name: request.authUser!.name, email: request.authUser!.email });
    const result = await service.updateColumn(pageId, colId, body);
    gitSync.noteActivity(entry.space);
    return result;
  });

  app.delete('/api/tables/:pageId/columns/:colId', async (request) => {
    const { pageId, colId } = request.params as { pageId: string; colId: string };
    const entry = await requireTableRole(request, pageId, 'editor');
    session.requireWriteScope(request);
    gitSync.recordEditor(entry.space, { name: request.authUser!.name, email: request.authUser!.email });
    await service.deleteColumn(pageId, colId);
    gitSync.noteActivity(entry.space);
    return { ok: true };
  });

  // --- Views ----------------------------------------------------------------

  app.post('/api/tables/:pageId/views', async (request, reply) => {
    const { pageId } = request.params as { pageId: string };
    const body = parseBody(newViewBodySchema, request.body);
    const entry = await requireTableRole(request, pageId, 'editor');
    session.requireWriteScope(request);
    gitSync.recordEditor(entry.space, { name: request.authUser!.name, email: request.authUser!.email });
    const view = await service.addView(pageId, body);
    gitSync.noteActivity(entry.space);
    reply.status(201);
    return view;
  });

  app.patch('/api/tables/:pageId/views/:viewId', async (request) => {
    const { pageId, viewId } = request.params as { pageId: string; viewId: string };
    const body = parseBody(updateViewBodySchema, request.body);
    const entry = await requireTableRole(request, pageId, 'editor');
    session.requireWriteScope(request);
    gitSync.recordEditor(entry.space, { name: request.authUser!.name, email: request.authUser!.email });
    const view = await service.updateView(pageId, viewId, body);
    gitSync.noteActivity(entry.space);
    return view;
  });

  app.delete('/api/tables/:pageId/views/:viewId', async (request) => {
    const { pageId, viewId } = request.params as { pageId: string; viewId: string };
    const entry = await requireTableRole(request, pageId, 'editor');
    session.requireWriteScope(request);
    gitSync.recordEditor(entry.space, { name: request.authUser!.name, email: request.authUser!.email });
    await service.deleteView(pageId, viewId);
    gitSync.noteActivity(entry.space);
    return { ok: true };
  });

  // --- Import / infer -------------------------------------------------------

  app.post('/api/tables/:pageId/import', async (request) => {
    const { pageId } = request.params as { pageId: string };
    const body = parseBody(importBodySchema, request.body);
    const entry = await requireTableRole(request, pageId, 'editor');
    session.requireWriteScope(request);
    gitSync.recordEditor(entry.space, { name: request.authUser!.name, email: request.authUser!.email });
    const result = await service.importTable(pageId, body);
    gitSync.noteActivity(entry.space);
    return result;
  });

  app.post('/api/tables/:pageId/infer', async (request) => {
    const { pageId } = request.params as { pageId: string };
    const body = parseBody(inferBodySchema, request.body);
    await requireTableRole(request, pageId, 'editor');
    const grid = body.format === 'csv' ? parseCsv(body.data) : parseTsv(body.data);
    return { columns: service.inferImportColumns(grid, { hasHeader: body.hasHeader }) };
  });
}
