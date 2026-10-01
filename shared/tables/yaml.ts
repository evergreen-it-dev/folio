/**
 * Round 26 (DATA TABLES) — canonical YAML export/import, spec §10
 * (docs/spec-tables.md): "YAML is the canonical dump { meta, columns, views,
 * rows }; it is also the import format (round trip: export → import gives
 * byte for byte the same table)". Pure, no IO.
 *
 * Uses `js-yaml` (see js-yaml.d.ts for why this is a transitive, not
 * direct, dependency — flagged in the round report).
 */
import { z } from 'zod';
import * as yamlModule from 'js-yaml';
/**
 * js-yaml is a CJS package, and in ESM its named exports are determined by
 * cjs-module-lexer, whose behavior depends on the Node version. Because of
 * that `import * as yaml from 'js-yaml'` worked locally (Node 20) and gave an
 * object WITHOUT functions in the production image (Node 22) — the public
 * Markdown link to a whiteboard failed with a 500, and YAML export of tables
 * was broken the same way. Take `.default` when it is there, as
 * server/index.ts already does for
 * @fastify/* («this project has no esModuleInterop»).
 */
const yaml = (yamlModule as unknown as { default?: typeof yamlModule }).default ?? yamlModule;
import {
  tableColumnSchema,
  tableViewSchema,
  type TableCellValue,
  type TableColumn,
  type TableRow,
  type TableView,
} from '../contracts.js';
import { type TableParseError } from './codec.js';

export interface TableYamlDoc {
  meta: { id: string; version: 1; rowIds: 'column' | 'none' };
  columns: TableColumn[];
  views: TableView[];
  rows: TableRow[];
}

function mkError(message: string, cause?: unknown): TableParseError {
  return { kind: 'table-parse-error', message, cause };
}

const cellValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]) satisfies z.ZodType<TableCellValue>;

const rowSchema = z.object({
  id: z.string().min(1),
  values: z.record(z.string(), cellValueSchema),
});

const yamlDocSchema = z.object({
  meta: z.object({
    id: z.string().min(1),
    version: z.literal(1),
    rowIds: z.enum(['column', 'none']),
  }),
  columns: z.array(tableColumnSchema),
  views: z.array(tableViewSchema),
  rows: z.array(rowSchema),
});

/** Canonical YAML dump of `{ meta, columns, views, rows }` — no line-wrapping, so long descriptions/labels round-trip exactly. */
export function dumpTableYaml(doc: TableYamlDoc): string {
  return yaml.dump(doc, { lineWidth: -1, sortKeys: false, noRefs: true });
}

export function parseTableYaml(text: string): TableYamlDoc | TableParseError {
  let data: unknown;
  try {
    data = yaml.load(text);
  } catch (err) {
    return mkError('Malformed YAML', err);
  }
  const result = yamlDocSchema.safeParse(data);
  if (!result.success) {
    const message = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return mkError(`Invalid table YAML: ${message}`, result.error);
  }
  return result.data as TableYamlDoc;
}

export function isTableYamlParseError(x: TableYamlDoc | TableParseError): x is TableParseError {
  return (x as TableParseError).kind === 'table-parse-error';
}
