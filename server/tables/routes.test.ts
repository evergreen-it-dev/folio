/**
 * Round 26 (DATA TABLES) — targeted, DB-free unit tests for
 * server/tables/routes.ts's local zod body schemas. No Fastify harness, no
 * PG/fs (this codebase has neither for route-level tests) — these just
 * exercise the schemas directly, the same way a route handler's
 * `parseBody(schema, request.body)` would.
 *
 * MANDATORY regression coverage: a `.partial()`/`.optional()` wrapper over a
 * zod field that itself carries `.default(...)` does NOT leave an omitted
 * key as `undefined` — it resolves to that default (confirmed directly
 * against zod, not just asserted from memory). `newViewBodySchema` WANTS
 * that (a create body's omitted fields should genuinely default). A naive
 * `tableViewSchema.omit({id:true}).partial()` reused for the UPDATE body
 * would NOT want that — it would make a rename-only PATCH silently resolve
 * sort/filter/columns/frozen/rowHeight to their schema defaults, and
 * service.ts's `{...oldView, ...patch}` merge would then wipe the view's
 * real values. `updateViewBodySchema` is hand-built field-by-field
 * specifically to avoid this; this test is the regression guard.
 */
import { describe, expect, it } from 'vitest';
import { newViewBodySchema, updateViewBodySchema, updateColumnBodySchema } from './routes.js';

describe('server/tables/routes.ts — local zod schemas', () => {
  describe('newViewBodySchema (CREATE) — omitted fields SHOULD resolve to their sensible defaults', () => {
    it('fills in columns/sort/filter/frozen/rowHeight when the caller only sends a name', () => {
      const parsed = newViewBodySchema.parse({ name: 'My View' });
      expect(parsed.columns).toEqual({ hidden: [], order: [], width: {} });
      expect(parsed.sort).toEqual([]);
      expect(parsed.filter).toEqual({ op: 'and', rules: [] });
      expect(parsed.frozen).toBe(0);
      expect(parsed.rowHeight).toBe('short');
    });
  });

  describe('updateViewBodySchema (PATCH) — omitted fields MUST stay undefined, never silently resolve to a default', () => {
    it('a rename-only patch leaves every other field genuinely undefined', () => {
      const parsed = updateViewBodySchema.parse({ name: 'Renamed' });
      expect(parsed.name).toBe('Renamed');
      expect(parsed.columns).toBeUndefined();
      expect(parsed.sort).toBeUndefined();
      expect(parsed.filter).toBeUndefined();
      expect(parsed.frozen).toBeUndefined();
      expect(parsed.rowHeight).toBeUndefined();
      // the exact failure mode this test guards against: a naive
      // tableViewSchema.partial() would put `filter: { op: 'and', rules: [] }`
      // here instead of leaving it absent.
      expect('filter' in parsed).toBe(false);
    });

    it('an explicitly-provided field still parses and validates normally', () => {
      const parsed = updateViewBodySchema.parse({ frozen: 2, rowHeight: 'tall' });
      expect(parsed.frozen).toBe(2);
      expect(parsed.rowHeight).toBe('tall');
      expect(parsed.name).toBeUndefined();
    });

    it('rejects an out-of-range frozen value the same way the create schema would', () => {
      expect(() => updateViewBodySchema.parse({ frozen: 99 })).toThrow();
    });
  });

  describe('updateColumnBodySchema (PATCH) — no top-level `.default()` on TableColumn, so this one was never at risk, but confirm it too', () => {
    it('an omitted `options` stays undefined on a type-only patch', () => {
      const parsed = updateColumnBodySchema.parse({ type: 'number' });
      expect(parsed.type).toBe('number');
      expect(parsed.options).toBeUndefined();
      expect(parsed.name).toBeUndefined();
    });
  });
});
