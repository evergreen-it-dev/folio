import { ZodError } from 'zod';
import { badRequest } from './errors.js';

/** Just enough of a zod issue for the message builder below — structural on purpose, so this file doesn't depend on where zod happens to export its issue type from. */
export interface ValidationIssue {
  message: string;
  path?: ReadonlyArray<PropertyKey>;
}

/**
 * `changes[0].space`, `memberships[2].role`, `name` — the path zod reports
 * for the failing field, in the shape a human (or an agent reading the 400)
 * would write it. Numeric segments become `[i]` so an array index never reads
 * as a property name.
 */
export function issuePath(path: ReadonlyArray<PropertyKey> | undefined): string {
  let out = '';
  for (const segment of path ?? []) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else out += out ? `.${String(segment)}` : String(segment);
  }
  return out;
}

/**
 * QA-3: this used to send zod's message ALONE, so a client/MCP/agent got
 * "Invalid input: expected string, received undefined" with no way to tell
 * WHICH field it was about — useless on any body with more than one required
 * field. The path goes in front now ("name: Invalid input: …"). Still the
 * first issue only: the 400 body is a single `error` string, and the first
 * failing field is the one worth fixing next.
 */
export function issueMessage(issue: ValidationIssue | undefined): string {
  if (!issue) return 'invalid request body';
  const where = issuePath(issue.path);
  return where ? `${where}: ${issue.message}` : issue.message;
}

export function parseBody<T>(schema: { parse: (v: unknown) => T }, body: unknown): T {
  try {
    return schema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) throw badRequest(issueMessage(err.issues[0]));
    throw err;
  }
}

export function queryString(query: unknown, key: string): string {
  const v = (query as Record<string, unknown> | null)?.[key];
  return typeof v === 'string' ? v : '';
}
